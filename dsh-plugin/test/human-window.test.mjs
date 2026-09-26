/**
 * 「3 秒人工打断窗口」的单元测试。
 *
 * 这是整个插件里语义最容易写错的一块，所以把四种结果、两个阶段、
 * 以及留言收集都单独钉死。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    collectHumanNotes,
    dedupeNotes,
    describeOutcome,
    openHumanWindow,
    pickHumanAction,
    WINDOW_ROLES,
} from '../lib/human-window.js';

/**
 * 假会议室：按脚本依次返回长轮询结果。
 *
 * 它同时记录每次 getMessages 的查询参数，用来断言「3 秒窗口真的就是
 * 一次 wait=3 的长轮询」，以及每一段等的是哪些角色。
 */
class FakeBus {
    constructor(batches = [], { failGet = null, failPostRoles = [] } = {}) {
        this.batches = [...batches];
        this.posted = [];
        this.calls = [];
        this.seq = 0;
        //: 第几次 getMessages 开始抛错（1 基）；null 表示不抛。
        this.failGet = failGet;
        this.getCount = 0;
        //: 对这些 role 的 postMessage 抛错。
        this.failPostRoles = failPostRoles;
    }

    async postMessage(sessionId, message) {
        if (this.failPostRoles.includes(message.role)) {
            throw new Error(`postMessage 拒绝写入 ${message.role}`);
        }
        this.seq += 1;
        const event = { seq: this.seq, session_id: sessionId, sender: 'x', role: '', ...message };
        this.posted.push(event);
        return event;
    }

    async getMessages(sessionId, options) {
        this.calls.push(options);
        this.getCount += 1;
        if (this.failGet !== null && this.getCount >= this.failGet) {
            throw new Error('总线连接中断');
        }
        return this.batches.shift() ?? { messages: [], timed_out: true };
    }
}

/** 造一条消息。 */
function message(seq, role, content = '') {
    return { seq, role, sender: role === 'note' ? 'human' : 'human', content, session_id: 'c1' };
}

test('没人打断：3 秒后自动继续，并回帖一条 outcome=timeout', async () => {
    const bus = new FakeBus([{ messages: [], timed_out: true }]);
    const result = await openHumanWindow({
        bus, sessionId: 'c1', windowMs: 3000, waitMs: 600000, targetSeq: 7,
    });
    assert.equal(result.status, 'timeout');
    // 第一次是 3 秒长轮询，第二次是不等待的竞态兜底补查
    assert.equal(bus.calls.length, 2);
    assert.equal(bus.calls[0].wait, 3);
    assert.deepEqual(bus.calls[0].roles, WINDOW_ROLES);
    assert.equal(bus.calls[0].after, 1, '应该从窗口开启那条消息之后开始等');
    assert.equal(bus.calls[1].wait, 0, '兜底补查不能等待');
    assert.equal(bus.calls[1].after, 1);
    // 窗口开启 + 窗口关闭，两条都广播了
    assert.equal(bus.posted[0].role, 'human_window_open');
    assert.equal(bus.posted[0].payload.deadline_ms, 3000);
    assert.equal(bus.posted[0].payload.target_seq, 7);
    assert.equal(bus.posted[1].role, 'human_window_close');
    assert.equal(bus.posted[1].payload.outcome, 'timeout');
});

test('竞态兜底：窗口刚过期那一瞬间到达的打断仍然算数', async () => {
    // 第一次长轮询什么也没等到，补查时才发现人类其实按了打断
    const bus = new FakeBus([
        { messages: [], timed_out: true },
        { messages: [message(2, 'interrupt')] },
        { messages: [message(3, 'suggest', '别用 sqlite')] },
    ]);
    const result = await openHumanWindow({ bus, sessionId: 'c1', windowMs: 3000 });
    assert.equal(result.status, 'suggested',
        '补查抓到的打断必须被当成真的打断，而不是 timeout');
    assert.equal(result.suggestion, '别用 sqlite');
    assert.equal(bus.posted.at(-1).payload.outcome, 'suggested');
});

test('总线出错：窗口照样会被关上，状态是 aborted 而不是 timeout', async () => {
    const bus = new FakeBus([], { failGet: 1 });
    const result = await openHumanWindow({ bus, sessionId: 'c1' });
    assert.equal(result.status, 'aborted');
    assert.match(result.error, /总线连接中断/);
    // 关键：会议室不能永远停在「等人工确认」
    assert.equal(bus.posted.at(-1).role, 'human_window_close');
    assert.equal(bus.posted.at(-1).payload.outcome, 'aborted');
});

test('关窗本身失败也不能抛出去（否则会盖掉已经拿到的评审结果）', async () => {
    const bus = new FakeBus([], { failGet: 1, failPostRoles: ['human_window_close'] });
    const result = await openHumanWindow({ bus, sessionId: 'c1' });
    assert.equal(result.status, 'aborted');
});

test('阶段 2 出错也要关窗', async () => {
    const bus = new FakeBus([{ messages: [message(2, 'interrupt')] }], { failGet: 2 });
    const result = await openHumanWindow({ bus, sessionId: 'c1' });
    assert.equal(result.status, 'aborted');
    assert.equal(bus.posted.at(-1).payload.outcome, 'aborted');
});

test('打断后选择恢复：status=resumed', async () => {
    const bus = new FakeBus([
        { messages: [message(2, 'interrupt')] },
        { messages: [message(3, 'resume')] },
    ]);
    const result = await openHumanWindow({ bus, sessionId: 'c1', windowMs: 3000 });
    assert.equal(result.status, 'resumed');
    // 阶段 2 等的是「恢复 / 建议」，时长用 waitMs
    assert.equal(bus.calls.length, 2);
    assert.deepEqual(bus.calls[1].roles, ['resume', 'suggest']);
    assert.equal(bus.calls[1].after, 2);
    assert.equal(bus.posted.at(-1).payload.outcome, 'resumed');
});

test('打断后注入建议：status=suggested，建议正文带出来', async () => {
    const bus = new FakeBus([
        { messages: [message(2, 'interrupt')] },
        { messages: [message(3, 'suggest', '先把 Redis 多实例也测一遍')] },
    ]);
    const result = await openHumanWindow({ bus, sessionId: 'c1' });
    assert.equal(result.status, 'suggested');
    assert.equal(result.suggestion, '先把 Redis 多实例也测一遍');
    assert.equal(bus.posted.at(-1).payload.outcome, 'suggested');
});

test('打断后一直不决定：status=paused，把控制权交回 DeepSeek', async () => {
    const bus = new FakeBus([
        { messages: [message(2, 'interrupt')] },
        { messages: [], timed_out: true },
    ]);
    const result = await openHumanWindow({ bus, sessionId: 'c1', waitMs: 600000 });
    assert.equal(result.status, 'paused');
    assert.equal(bus.posted.at(-1).payload.outcome, 'paused');
});

test('窗口内直接点「加入建议」也算，不必先打断', async () => {
    const bus = new FakeBus([{ messages: [message(2, 'suggest', '别用 sqlite')] }]);
    const result = await openHumanWindow({ bus, sessionId: 'c1' });
    assert.equal(result.status, 'suggested');
    assert.equal(result.suggestion, '别用 sqlite');
    // 没有进入阶段 2
    assert.equal(bus.calls.length, 1);
});

test('窗口内直接点「恢复循环」', async () => {
    const bus = new FakeBus([{ messages: [message(2, 'resume')] }]);
    const result = await openHumanWindow({ bus, sessionId: 'c1' });
    assert.equal(result.status, 'resumed');
    assert.equal(bus.calls.length, 1);
});

test('窗口里的普通留言被收集，但不改变状态', async () => {
    const bus = new FakeBus([{
        messages: [message(2, 'note', '我在看，稍等'), message(3, 'note', '  ')],
    }]);
    const result = await openHumanWindow({ bus, sessionId: 'c1' });
    assert.equal(result.status, 'timeout');
    assert.deepEqual(result.human_notes.map(item => item.content), ['我在看，稍等']);
});

test('pickHumanAction 只看 afterSeq 之后的，且认角色', () => {
    const messages = [
        message(1, 'interrupt'),
        message(2, 'note'),
        message(3, 'suggest', 'x'),
    ];
    assert.equal(pickHumanAction(messages, 0, ['interrupt']).seq, 1);
    assert.equal(pickHumanAction(messages, 1, ['interrupt']), undefined);
    assert.equal(pickHumanAction(messages, 2, ['interrupt', 'suggest']).seq, 3);
    assert.equal(pickHumanAction([], 0, ['interrupt']), undefined);
});

test('collectHumanNotes 丢掉空留言', () => {
    const notes = collectHumanNotes([
        message(1, 'note', '有内容'),
        message(2, 'note', '   '),
        message(3, 'interrupt'),
    ], 0);
    assert.deepEqual(notes, [{ seq: 1, content: '有内容' }]);
});

test('竞态补查不会把同一条留言重复收集', async () => {
    const note = message(2, 'note', '我在看，稍等');
    const bus = new FakeBus([
        { messages: [note] },
        { messages: [note] },
    ]);
    const result = await openHumanWindow({ bus, sessionId: 'c1' });
    assert.equal(result.status, 'timeout');
    assert.deepEqual(result.human_notes, [{ seq: 2, content: '我在看，稍等' }]);
});

test('dedupeNotes 按 seq 去重并保持顺序', () => {
    assert.deepEqual(
        dedupeNotes([{ seq: 3, content: 'c' }, { seq: 1, content: 'a' }, { seq: 3, content: 'c' }]),
        [{ seq: 3, content: 'c' }, { seq: 1, content: 'a' }]);
    assert.deepEqual(dedupeNotes(undefined), []);
});

test('窗口开启说明里带上秒数', async () => {
    const bus = new FakeBus([{ messages: [], timed_out: true }]);
    await openHumanWindow({ bus, sessionId: 'c1', windowMs: 5000 });
    assert.match(bus.posted[0].content, /5 秒/);
});

test('describeOutcome 覆盖四种结果', () => {
    assert.match(describeOutcome('timeout'), /自动继续/);
    assert.match(describeOutcome('resumed'), /恢复循环/);
    assert.match(describeOutcome('suggested'), /加入.*建议/);
    assert.match(describeOutcome('paused'), /等待/);
    assert.match(describeOutcome('aborted'), /异常关闭/);
});
