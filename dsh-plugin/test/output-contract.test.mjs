/**
 * 工具**输出契约**的测试。
 *
 * 为什么单独一个文件：DSH 的工具执行管道会用工具自己声明的
 * `output.schema` 校验返回值，不符合就抛 `ToolOutputError`
 * （INVALID_TOOL_OUTPUT）。而直接调 `tool.execute()` 是**绕过**这个校验的
 * —— 所以「本地测试全绿、装进 DSH 就炸」是完全可能的。
 *
 * 这里用 **DSH 自己的校验器** `validateJsonSchemaValue`，把每个工具在
 * 每条分支上的真实返回值都验一遍，把这个风险提前到测试里。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

import { resolveConfig } from '../lib/config.js';
import { compact, losslessJsonProblems } from '../lib/json-safe.js';
import { registerCouncilTools } from '../lib/tools.js';
import { FakeCouncilBus } from './helpers/fake-bus.mjs';

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

const approveAll = async () => jsonResponse({
    content: [{ type: 'text', text: '没问题\nVERDICT: approve' }],
});
const reviseOne = async url => jsonResponse({
    content: [{
        type: 'text',
        text: String(url).includes('strict.example')
            ? '会死锁\nVERDICT: revise'
            : '没问题\nVERDICT: approve',
    }],
});

function testConfig() {
    return resolveConfig({
        participants: {
            kimi: { enabled: false },
            claude: { adapter: 'claude-api', label: 'Claude',
                      baseUrl: 'https://good.example', model: 'm', apiKey: 'k' },
            strict: { adapter: 'claude-api', label: 'Strict',
                      baseUrl: 'https://strict.example', model: 'm', apiKey: 'k' },
        },
    });
}

function setup({ fetchImpl = approveAll, bus = new FakeCouncilBus() } = {}) {
    const registered = new Map();
    const ctx = {
        tools: { register: tool => registered.set(tool.name, tool) },
        systemPrompt: { section: () => {} },
    };
    registerCouncilTools(ctx, testConfig(), { bus, fetchImpl, now: () => bus.clock.t });
    return { tools: registered, bus };
}

/**
 * 按 DSH 管道的做法校验一个返回值。
 *
 * 快照步骤用 JSON 往返近似：DSH 的 `snapshotJsonValue` 同样会丢掉
 * `undefined` 属性，而 `compact()` 保证本来就没有 undefined 可丢。
 */
function assertOutputContract(tool, value, { label = '' } = {}) {
    const where = `${tool.name}${label === '' ? '' : `（${label}）`}`;

    const bad = losslessJsonProblems(value);
    assert.deepEqual(bad, [], `${where} 的返回值不是无损 JSON：${bad.join('; ')}`);

    const snapshot = JSON.parse(JSON.stringify(value));
    const violations = validateJsonSchemaValue(tool.output.schema, snapshot, 'value');
    assert.deepEqual(violations, [],
        `${where} 的返回值不符合它自己声明的 output.schema：${violations.join('; ')}`);

    // render 也会在管道里被调用，抛异常同样是 INVALID_TOOL_OUTPUT
    const rendered = tool.output.render({}, snapshot);
    assert.ok(Array.isArray(rendered) && rendered.length > 0,
        `${where} 的 render 没有返回内容块`);
    for (const block of rendered) {
        assert.equal(block.type, 'text');
        assert.equal(typeof block.text, 'string');
    }
    return snapshot;
}

// ---------------------------------------------------------------- 辅助函数

test('compact 深度去掉 undefined，且不改变其它值', () => {
    const input = {
        a: 1,
        b: undefined,
        c: { d: undefined, e: 'x', f: [1, undefined, 2] },
        g: null,
        h: false,
        i: 0,
    };
    assert.deepEqual(compact(input), {
        a: 1,
        c: { e: 'x', f: [1, 2] },
        g: null,
        h: false,
        i: 0,
    });
});

test('compact 不动数组里的非法值类型之外的东西', () => {
    assert.deepEqual(compact([1, undefined, 'a', null]), [1, 'a', null]);
    assert.deepEqual(compact('plain'), 'plain');
    assert.equal(compact(undefined), undefined);
});

test('losslessJsonProblems 能抓出 undefined / NaN / 函数', () => {
    assert.deepEqual(losslessJsonProblems({ a: 1, b: 'x' }), []);
    assert.match(losslessJsonProblems({ a: undefined })[0], /undefined/);
    assert.match(losslessJsonProblems({ a: Number.NaN })[0], /不是 JSON 数字/);
    assert.match(losslessJsonProblems([1, () => {}])[0], /function/);
    assert.match(losslessJsonProblems({ a: { b: undefined } })[0], /a\.b/);
});

// ---------------------------------------------------------------- 每个工具

test('council_start 的输出符合声明', async () => {
    const { tools } = setup();
    const value = await tools.get('council_start').execute({ task: 't' }, {});
    const snapshot = assertOutputContract(tools.get('council_start'), value);
    assert.deepEqual(snapshot.participants, ['claude', 'strict']);
});

test('council_review：全部 approve（含超时窗口）的输出符合声明', async () => {
    const { tools, bus } = setup();
    const started = await tools.get('council_start').execute({ task: 't' }, {});
    const value = await tools.get('council_review').execute({
        session_id: started.session_id, step: 'plan', artifact: 'v1',
    }, {});
    const snapshot = assertOutputContract(tools.get('council_review'), value, { label: 'timeout' });
    assert.equal(snapshot.converged, true);
    assert.equal(snapshot.human.status, 'timeout');
    // 可选字段被省掉，而不是留一个 undefined
    assert.equal('suggestion' in snapshot.human, false);
    assert.equal('error' in snapshot.human, false);
    assert.ok(bus.messagesOf(started.session_id).length > 0);
});

test('council_review：有 revise（blocking 非空）的输出符合声明', async () => {
    const { tools } = setup({ fetchImpl: reviseOne });
    const started = await tools.get('council_start').execute({ task: 't' }, {});
    const value = await tools.get('council_review').execute({
        session_id: started.session_id, step: 'coding', artifact: 'diff',
    }, {});
    const snapshot = assertOutputContract(tools.get('council_review'), value, { label: 'revise' });
    assert.equal(snapshot.converged, false);
    assert.deepEqual(snapshot.blocking, ['Strict']);
});

test('council_review：人类注入建议的输出符合声明', async () => {
    const bus = new FakeCouncilBus();
    let done = false;
    bus.onPost = async event => {
        if (event.role === 'human_window_open' && !done) {
            done = true;
            await bus.humanAction(event.session_id, { kind: 'suggest', content: '先写测试' });
        }
    };
    const { tools } = setup({ bus });
    const started = await tools.get('council_start').execute({ task: 't' }, {});
    const value = await tools.get('council_review').execute({
        session_id: started.session_id, step: 'plan', artifact: 'v1',
    }, {});
    const snapshot = assertOutputContract(tools.get('council_review'), value, { label: 'suggested' });
    assert.equal(snapshot.human.status, 'suggested');
    assert.equal(snapshot.human.suggestion, '先写测试');
});

test('council_review：人打断但不决定（paused）的输出符合声明', async () => {
    const bus = new FakeCouncilBus();
    let done = false;
    bus.onPost = async event => {
        if (event.role === 'human_window_open' && !done) {
            done = true;
            await bus.humanAction(event.session_id, { kind: 'interrupt' });
        }
    };
    const { tools } = setup({ bus });
    const started = await tools.get('council_start').execute({ task: 't' }, {});
    const value = await tools.get('council_review').execute({
        session_id: started.session_id, step: 'plan', artifact: 'v1',
    }, {});
    const snapshot = assertOutputContract(tools.get('council_review'), value, { label: 'paused' });
    assert.equal(snapshot.human.status, 'paused');
});

test('council_review：窗口开不起来（aborted）的输出也符合声明', async () => {
    const bus = new FakeCouncilBus();
    bus.failPostRoles = ['human_window_open'];
    const { tools } = setup({ bus });
    const started = await tools.get('council_start').execute({ task: 't' }, {});
    const value = await tools.get('council_review').execute({
        session_id: started.session_id, step: 'plan', artifact: 'v1',
    }, {});
    const snapshot = assertOutputContract(tools.get('council_review'), value, { label: 'aborted' });
    assert.equal(snapshot.human.status, 'aborted');
    assert.match(snapshot.human.error, /human_window_open/);
    assert.equal(snapshot.reviews.length, 2);
});

test('council_review：模型失败（error 评审）的输出符合声明', async () => {
    const fetchImpl = async url => {
        if (String(url).includes('strict.example')) {
            throw new Error('ECONNREFUSED');
        }
        return approveAll();
    };
    const { tools } = setup({ fetchImpl });
    const started = await tools.get('council_start').execute({ task: 't' }, {});
    const value = await tools.get('council_review').execute({
        session_id: started.session_id, step: 'plan', artifact: 'v1',
    }, {});
    const snapshot = assertOutputContract(tools.get('council_review'), value, { label: 'error 评审' });
    const failed = snapshot.reviews.find(item => item.verdict === 'error');
    assert.match(failed.error, /ECONNREFUSED/);
    // 成功的评审不该带 error 字段
    const ok = snapshot.reviews.find(item => item.verdict === 'approve');
    assert.equal('error' in ok, false);
});

test('council_status 的输出符合声明', async () => {
    const { tools, bus } = setup({ fetchImpl: reviseOne });
    const started = await tools.get('council_start').execute({ task: '加超时' }, {});
    await tools.get('council_review').execute({
        session_id: started.session_id, step: 'plan', artifact: 'v1',
    }, {});
    const value = await tools.get('council_status').execute({
        session_id: started.session_id,
    }, {});
    const snapshot = assertOutputContract(tools.get('council_status'), value);
    assert.equal(snapshot.status, 'active');
    assert.ok(snapshot.message_count > 0);
    assert.ok(bus.messagesOf(started.session_id).length > 0);
});

test('council_note 的输出符合声明', async () => {
    const { tools } = setup();
    const started = await tools.get('council_start').execute({ task: 't' }, {});
    const value = await tools.get('council_note').execute({
        session_id: started.session_id, content: '我改了', role: 'coding',
    }, {});
    assertOutputContract(tools.get('council_note'), value);
});

test('council_finish 的输出符合声明', async () => {
    const { tools } = setup();
    const started = await tools.get('council_start').execute({ task: 't' }, {});
    const value = await tools.get('council_finish').execute({
        session_id: started.session_id, conclusion: '收工',
    }, {});
    const snapshot = assertOutputContract(tools.get('council_finish'), value);
    assert.equal(snapshot.status, 'finished');
});

test('每个工具声明的 output.schema 本身都是 DSH 支持的形式', () => {
    const { tools } = setup();
    // 用一个明显合规的值探测：schema 若含不支持的构造，校验器会直接抛
    for (const tool of tools.values()) {
        assert.doesNotThrow(
            () => validateJsonSchemaValue(tool.output.schema, {}, 'value'),
            `${tool.name} 的 output.schema 不被支持`);
        assert.doesNotThrow(
            () => validateJsonSchemaValue(tool.output.schema, null, 'value'),
            `${tool.name} 的 output.schema 不被支持`);
    }
});
