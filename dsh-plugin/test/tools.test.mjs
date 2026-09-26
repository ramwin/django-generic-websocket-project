/**
 * council_* 工具的行为测试。
 *
 * 用假的会议室 + 假的模型 HTTP 响应，把「计划 → 评审 → 3 秒窗口 →
 * 迭代」这条链路完整跑一遍，不依赖 DSH，也不依赖真实模型。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig } from '../lib/config.js';
import { registerCouncilTools, renderReviewResult } from '../lib/tools.js';
import { FakeCouncilBus } from './helpers/fake-bus.mjs';

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** 一个总是 approve 的假模型。 */
const alwaysApprove = async () => jsonResponse({
    content: [{ type: 'text', text: '我验证了 seq 分配和迁移，没问题\nVERDICT: approve' }],
});

/** strict.example 这个模型总会挑毛病。 */
const oneRevise = async (url) => {
    if (String(url).includes('strict.example')) {
        return jsonResponse({
            content: [{ type: 'text', text: 'sqlite 不支持 select_for_update，会直接抛错\nVERDICT: revise' }],
        });
    }
    return jsonResponse({
        content: [{ type: 'text', text: '没问题\nVERDICT: approve' }],
    });
};

/** 测试用配置：kimi 关掉，用两个可控的 claude-api 假模型。 */
function testConfig(extra = {}) {
    return resolveConfig({
        participants: {
            kimi: { enabled: false },
            claude: {
                adapter: 'claude-api', label: 'Claude',
                baseUrl: 'https://good.example', model: 'm', apiKey: 'k',
            },
            strict: {
                adapter: 'claude-api', label: 'Strict',
                baseUrl: 'https://strict.example', model: 'm', apiKey: 'k',
            },
        },
        ...extra,
    });
}

/** 假 cordis 上下文，只实现插件用到的那两个 seam。 */
function makeCtx() {
    const registered = [];
    const sections = [];
    const ctx = {
        tools: { register: tool => registered.push(tool) },
        systemPrompt: { section: section => sections.push(section) },
    };
    return { ctx, registered, sections };
}

function setup({ config = testConfig(), fetchImpl = alwaysApprove, bus = new FakeCouncilBus() } = {}) {
    const { ctx, registered, sections } = makeCtx();
    const runtime = registerCouncilTools(ctx, config, { bus, fetchImpl, now: () => bus.clock.t });
    const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]));
    return { ctx, registered, sections, runtime, bus, byName };
}

// ---------------------------------------------------------------- 注册形态

test('注册了五个 council_* 工具，且都带完整的 definition', () => {
    const { registered } = setup();
    assert.deepEqual(registered.map(tool => tool.name).sort(), [
        'council_finish', 'council_note', 'council_review', 'council_start', 'council_status',
    ]);
    for (const tool of registered) {
        assert.ok(tool.description.length > 20, `${tool.name} 的 description 太短`);
        assert.ok(tool.parameters !== undefined, `${tool.name} 缺少 parameters`);
        assert.equal(typeof tool.execute, 'function', `${tool.name} 缺少 execute`);
        assert.ok(tool.output?.schema !== undefined, `${tool.name} 缺少 output.schema`);
        assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺少 output.render`);
    }
});

// ---------------------------------------------------------------- start

test('council_start 建会话、把任务广播进房间，并返回围观地址', async () => {
    const { byName, bus } = setup();
    const result = await byName.council_start.execute({
        task: '给 health check 加超时',
    }, {});
    assert.match(result.session_id, /^council_/);
    assert.deepEqual(result.participants, ['claude', 'strict']);
    assert.match(result.page_url, /\/ws\/generic\/council\/room\/council_/);
    const taskMessages = bus.rolesOf(result.session_id, 'task');
    assert.equal(taskMessages.length, 1);
    assert.equal(taskMessages[0].content, '给 health check 加超时');
});

test('council_start 空任务要报错', async () => {
    const { byName } = setup();
    await assert.rejects(
        () => byName.council_start.execute({ task: '   ' }, {}),
        /task 不能为空/);
});

// ---------------------------------------------------------------- review

test('council_review：全部 approve 时 converged=true，人工窗口超时自动继续', async () => {
    const bus = new FakeCouncilBus();
    const { byName } = setup({ bus, fetchImpl: alwaysApprove });
    const started = await byName.council_start.execute({ task: 't' }, {});
    const result = await byName.council_review.execute({
        session_id: started.session_id,
        step: 'plan',
        artifact: '第一步：加模型和迁移',
    }, {});

    assert.equal(result.converged, true);
    assert.deepEqual(result.blocking, []);
    assert.equal(result.round, 1);
    assert.equal(result.human.status, 'timeout');
    assert.deepEqual(result.reviews.map(item => item.verdict), ['approve', 'approve']);

    // 产物本身、两个模型的评审、以及窗口的开与关，都落进了同一个房间
    const roles = bus.messagesOf(started.session_id).map(item => item.role);
    assert.deepEqual(roles, [
        'task', 'plan', 'review', 'review', 'human_window_open', 'human_window_close',
    ]);
    assert.equal(bus.rolesOf(started.session_id, 'review')[0].sender, 'claude');
    assert.equal(bus.rolesOf(started.session_id, 'review')[0].payload.verdict, 'approve');
});

test('council_review：有一个模型要改时 converged=false 并列出是谁', async () => {
    const { byName } = setup({ fetchImpl: oneRevise });
    const started = await byName.council_start.execute({ task: 't' }, {});
    const result = await byName.council_review.execute({
        session_id: started.session_id, step: 'coding', artifact: 'diff...',
    }, {});
    assert.equal(result.converged, false);
    assert.deepEqual(result.blocking, ['Strict']);
    const strict = result.reviews.find(item => item.name === 'strict');
    assert.equal(strict.verdict, 'revise');
    assert.match(strict.text, /select_for_update/);
});

test('council_review：第二轮会把 round 递增（靠 human_window_close 计数）', async () => {
    const { byName } = setup();
    const started = await byName.council_start.execute({ task: 't' }, {});
    const first = await byName.council_review.execute({
        session_id: started.session_id, step: 'plan', artifact: 'v1',
    }, {});
    const second = await byName.council_review.execute({
        session_id: started.session_id, step: 'plan', artifact: 'v2',
    }, {});
    assert.equal(first.round, 1);
    assert.equal(second.round, 2);
});

test('council_review：人类在窗口里注入建议 -> human.status=suggested', async () => {
    const bus = new FakeCouncilBus();
    let injected = false;
    bus.onPost = async event => {
        if (event.role === 'human_window_open' && !injected) {
            injected = true;
            await bus.humanAction(event.session_id, {
                kind: 'suggest', content: '记得把 Redis 多实例也测一遍',
            });
        }
    };
    const { byName } = setup({ bus });
    const started = await byName.council_start.execute({ task: 't' }, {});
    const result = await byName.council_review.execute({
        session_id: started.session_id, step: 'plan', artifact: 'v1',
    }, {});
    assert.equal(result.human.status, 'suggested');
    assert.equal(result.human.suggestion, '记得把 Redis 多实例也测一遍');
    // 渲染出来的文本要让人一眼看到「人类建议优先」
    const text = renderReviewResult(result);
    assert.match(text, /人类加入了建议/);
    assert.match(text, /Redis 多实例/);
});

test('council_review：人类按了打断但不决定 -> human.status=paused，并要求停下来问', async () => {
    const bus = new FakeCouncilBus();
    let injected = false;
    bus.onPost = async event => {
        if (event.role === 'human_window_open' && !injected) {
            injected = true;
            await bus.humanAction(event.session_id, { kind: 'interrupt' });
        }
    };
    const { byName } = setup({ bus });
    const started = await byName.council_start.execute({ task: 't' }, {});
    const result = await byName.council_review.execute({
        session_id: started.session_id, step: 'plan', artifact: 'v1',
    }, {});
    assert.equal(result.human.status, 'paused');
    const text = renderReviewResult(result);
    assert.match(text, /停下来/);
    assert.match(text, /不要擅自继续/);
});

test('council_review：人类打断后选择恢复 -> human.status=resumed', async () => {
    const bus = new FakeCouncilBus();
    let interrupted = false;
    let resumed = false;
    bus.onPost = async event => {
        if (event.role === 'human_window_open' && !interrupted) {
            interrupted = true;
            await bus.humanAction(event.session_id, { kind: 'interrupt' });
        }
    };
    // 人类看完之后，在阶段 2 的轮询期间才点「恢复循环」
    bus.onPoll = async (sessionId, options) => {
        if (!interrupted || resumed) {
            return;
        }
        if (Array.isArray(options.roles) && options.roles.includes('resume')) {
            resumed = true;
            await bus.humanAction(sessionId, { kind: 'resume' });
        }
    };
    const { byName } = setup({ bus });
    const started = await byName.council_start.execute({ task: 't' }, {});
    const result = await byName.council_review.execute({
        session_id: started.session_id, step: 'plan', artifact: 'v1',
    }, {});
    assert.equal(result.human.status, 'resumed');
});

test('council_review：参数校验', async () => {
    const { byName } = setup();
    const started = await byName.council_start.execute({ task: 't' }, {});
    await assert.rejects(
        () => byName.council_review.execute({
            session_id: 'bad-name', step: 'plan', artifact: 'x' }, {}),
        /不合法/);
    // step 的 enum 由 defineTool 在进入 execute 之前就挡掉了
    await assert.rejects(
        () => byName.council_review.execute({
            session_id: started.session_id, step: 'dreaming', artifact: 'x' }, {}),
        /must be one of/);
    await assert.rejects(
        () => byName.council_review.execute({
            session_id: started.session_id, step: 'plan', artifact: '  ' }, {}),
        /artifact 不能为空/);
    await assert.rejects(
        () => byName.council_review.execute({
            session_id: started.session_id, step: 'plan', artifact: 'x',
            participants: ['nobody'] }, {}),
        /未配置的参与者/);
});

test('council_review：某个模型挂了也要如实记进房间，不能悄悄吞掉', async () => {
    const fetchImpl = async url => {
        if (String(url).includes('strict.example')) {
            throw new Error('connect ECONNREFUSED');
        }
        return alwaysApprove();
    };
    const bus = new FakeCouncilBus();
    const { byName } = setup({ bus, fetchImpl });
    const started = await byName.council_start.execute({ task: 't' }, {});
    const result = await byName.council_review.execute({
        session_id: started.session_id, step: 'plan', artifact: 'v1',
    }, {});
    assert.equal(result.converged, false, '有模型没投票就不算收敛');
    const strict = result.reviews.find(item => item.name === 'strict');
    assert.equal(strict.verdict, 'error');
    const posted = bus.rolesOf(started.session_id, 'review')
        .find(item => item.sender === 'strict');
    assert.match(posted.content, /调用失败/);
    assert.match(posted.content, /ECONNREFUSED/);
});

test('council_review：产物过长会被截断并标注', async () => {
    const { byName } = setup();
    const started = await byName.council_start.execute({ task: 't' }, {});
    const result = await byName.council_review.execute({
        session_id: started.session_id, step: 'plan', artifact: 'x'.repeat(70_000),
    }, {});
    assert.equal(result.artifact_seq, 2);
    assert.ok(result.artifact_seq > 0);
});

test('council_review：人工窗口打不开时，已经拿到的评审意见不能丢', async () => {
    const bus = new FakeCouncilBus();
    bus.failPostRoles = ['human_window_open'];
    const { byName } = setup({ bus });
    const started = await byName.council_start.execute({ task: 't' }, {});
    const result = await byName.council_review.execute({
        session_id: started.session_id, step: 'plan', artifact: 'v1',
    }, {});
    // 两个模型的意见照常返回，而且已经落进会议室
    assert.deepEqual(result.reviews.map(item => item.verdict), ['approve', 'approve']);
    assert.equal(bus.rolesOf(started.session_id, 'review').length, 2);
    assert.equal(result.human.status, 'aborted');
    assert.match(result.human.error, /拒绝写入 human_window_open/);
    // 渲染文本要明确告诉 DeepSeek「没拿到人工结论，别默认他同意了」
    const text = renderReviewResult(result);
    assert.match(text, /没有拿到人工结论/);
    assert.match(text, /不要默认他同意了/);
});

test('council_review：关窗写不进去也不影响评审结果，且不会抛出去', async () => {
    const bus = new FakeCouncilBus();
    bus.failPostRoles = ['human_window_close'];
    const { byName } = setup({ bus });
    const started = await byName.council_start.execute({ task: 't' }, {});
    const result = await byName.council_review.execute({
        session_id: started.session_id, step: 'plan', artifact: 'v1',
    }, {});
    // 关窗只是清理动作：写失败不能把整轮结论一起毁掉
    assert.equal(result.reviews.length, 2);
    assert.equal(result.human.status, 'timeout',
        '人工窗口本身是正常超时的，只是「关窗」这条记录没写进去');
});

// ---------------------------------------------------------------- 其它工具

test('council_note 往房间广播一条消息', async () => {
    const bus = new FakeCouncilBus();
    const { byName } = setup({ bus });
    const started = await byName.council_start.execute({ task: 't' }, {});
    const result = await byName.council_note.execute({
        session_id: started.session_id,
        content: '我按 Kimi 的意见把迁移改了',
        role: 'coding',
    }, {});
    assert.equal(result.role, 'coding');
    assert.equal(bus.messagesOf(started.session_id).at(-1).content,
        '我按 Kimi 的意见把迁移改了');
    await assert.rejects(
        () => byName.council_note.execute({ session_id: started.session_id, content: ' ' }, {}),
        /content 不能为空/);
});

test('council_status 汇总最近结论与会议记录', async () => {
    const { byName } = setup({ fetchImpl: oneRevise });
    const started = await byName.council_start.execute({ task: '加超时' }, {});
    await byName.council_review.execute({
        session_id: started.session_id, step: 'plan', artifact: 'v1',
    }, {});
    const status = await byName.council_status.execute({
        session_id: started.session_id,
    }, {});
    assert.equal(status.task, '加超时');
    assert.equal(status.status, 'active');
    assert.equal(status.round_index, 1);
    assert.deepEqual(status.last_verdicts.map(item => item.sender), ['claude', 'strict']);
    assert.match(status.transcript, /sqlite 不支持/);
    assert.match(status.transcript, /加超时/);
});

test('council_finish 结束会话', async () => {
    const bus = new FakeCouncilBus();
    const { byName } = setup({ bus });
    const started = await byName.council_start.execute({ task: 't' }, {});
    const result = await byName.council_finish.execute({
        session_id: started.session_id, conclusion: '都满意了，收工',
    }, {});
    assert.equal(result.status, 'finished');
    await assert.rejects(
        () => byName.council_finish.execute({
            session_id: started.session_id, conclusion: '' }, {}),
        /conclusion 不能为空/);
});

// ---------------------------------------------------------------- 渲染

test('renderReviewResult 把「要改谁」「人类说了什么」放在显眼位置', () => {
    const text = renderReviewResult({
        session_id: 'c1',
        step: 'coding',
        round: 2,
        artifact_seq: 9,
        converged: false,
        blocking: ['Strict'],
        reviews: [
            { label: 'Claude', verdict: 'approve', summary: 'Claude：同意｜没问题', text: '没问题' },
            { label: 'Strict', verdict: 'revise', summary: 'Strict：要改｜会死锁', text: '会死锁\nVERDICT: revise' },
        ],
        human: { status: 'timeout', notes: ['我在看'] },
        page_url: 'http://h/p/',
    });
    assert.match(text, /第 2 轮/);
    assert.match(text, /需要改：Strict/);
    assert.match(text, /会死锁/);
    assert.match(text, /3 秒内没有人打断/);
    assert.match(text, /我在看/);
});
