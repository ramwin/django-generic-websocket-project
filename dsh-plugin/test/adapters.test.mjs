/**
 * AI 适配器的单元测试。
 *
 * 全部用假的 fetch / 假的子进程，不真的调用任何模型。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { authHeaders, callClaudeApi, messagesEndpoint } from '../lib/adapters/claude-api.js';
import { callKimiCli, stripBullet } from '../lib/adapters/kimi-cli.js';
import { callOpenAiApi, chatEndpoint } from '../lib/adapters/openai-api.js';
import { collectReviews, reviewWithParticipant } from '../lib/adapters/index.js';
import { parseVerdict, summarizeReview } from '../lib/prompts.js';

/** 假 spawn：立刻吐出给定的 stdout/stderr 然后 close。 */
function fakeSpawn({ stdout = '', stderr = '', code = 0, error } = {}) {
    const calls = [];
    const impl = (command, args, options) => {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        process.nextTick(() => {
            if (error) {
                child.emit('error', error);
                return;
            }
            if (stdout) {
                child.stdout.emit('data', Buffer.from(stdout));
            }
            if (stderr) {
                child.stderr.emit('data', Buffer.from(stderr));
            }
            child.emit('close', code);
        });
        return child;
    };
    impl.calls = calls;
    return impl;
}

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

// ---------------------------------------------------------------- 端点拼接

test('Anthropic 端点兼容 baseUrl 已带 /v1 的情况', () => {
    assert.equal(messagesEndpoint('https://api.anthropic.com'),
        'https://api.anthropic.com/v1/messages');
    assert.equal(messagesEndpoint('https://relay.internal/anthropic/v1'),
        'https://relay.internal/anthropic/v1/messages');
    assert.equal(messagesEndpoint(undefined),
        'https://api.anthropic.com/v1/messages');
});

test('OpenAI 兼容端点同理', () => {
    assert.equal(chatEndpoint('https://api.moonshot.cn/v1'),
        'https://api.moonshot.cn/v1/chat/completions');
    assert.equal(chatEndpoint('https://open.bigmodel.cn/api/paas/v4'),
        'https://open.bigmodel.cn/api/paas/v4/v1/chat/completions');
    assert.throws(() => chatEndpoint(''), /需要配置 baseUrl/);
});

// ---------------------------------------------------------------- claude-api

test('claude-api 取 text 块并带上正确的请求头', async () => {
    let seen = null;
    const fetchImpl = async (url, init) => {
        seen = { url: String(url), init };
        return jsonResponse({
            content: [{ type: 'text', text: '第一条意见' }, { type: 'text', text: 'VERDICT: revise' }],
            usage: { input_tokens: 10, output_tokens: 5 },
        });
    };
    const result = await callClaudeApi({
        prompt: '请评审',
        participant: {
            baseUrl: 'https://relay.internal/v1',
            model: 'claude-sonnet-4-5',
            apiKey: 'sk-test',
            maxTokens: 1024,
        },
        systemPrompt: '你是评审',
        fetchImpl,
    });
    assert.equal(seen.url, 'https://relay.internal/v1/messages');
    assert.equal(seen.init.headers['x-api-key'], 'sk-test');
    assert.equal(seen.init.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(seen.init.body);
    assert.equal(body.model, 'claude-sonnet-4-5');
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.system, '你是评审');
    assert.equal(result.text, '第一条意见\nVERDICT: revise');
    assert.equal(result.usage.output_tokens, 5);
});

test('claude-api 缺 key 时报出要设哪个环境变量', async () => {
    await assert.rejects(
        () => callClaudeApi({
            prompt: 'x',
            participant: { baseUrl: 'https://h', model: 'm', apiKeyEnv: 'MY_KEY' },
            fetchImpl: async () => jsonResponse({}),
            env: {},
        }),
        /没有找到 API key.*MY_KEY/s);
});

test('claude-api 把服务端错误信息透出来', async () => {
    await assert.rejects(
        () => callClaudeApi({
            prompt: 'x',
            participant: { baseUrl: 'https://h', model: 'm', apiKey: 'k', label: 'Claude' },
            fetchImpl: async () => jsonResponse({ error: { message: 'invalid api key' } }, 401),
        }),
        /Claude 返回 HTTP 401：invalid api key/);
});

// ---------------------------------------------------------------- openai-api

test('openai-api 取 choices[0].message.content', async () => {
    let seen = null;
    const fetchImpl = async (url, init) => {
        seen = { url: String(url), init };
        return jsonResponse({
            choices: [{ message: { content: '我看不出问题\nVERDICT: approve' } }],
            usage: { total_tokens: 42 },
        });
    };
    const result = await callOpenAiApi({
        prompt: '请评审',
        participant: {
            baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
            model: 'glm-4.6',
            apiKey: 'k',
        },
        fetchImpl,
    });
    assert.equal(seen.url, 'https://open.bigmodel.cn/api/paas/v4/v1/chat/completions');
    assert.equal(seen.init.headers.Authorization, 'Bearer k');
    assert.equal(result.text, '我看不出问题\nVERDICT: approve');
});

test('openai-api 返回空内容要报错，而不是当成 approve', async () => {
    await assert.rejects(
        () => callOpenAiApi({
            prompt: 'x',
            participant: { baseUrl: 'https://h/v1', model: 'm', apiKey: 'k' },
            fetchImpl: async () => jsonResponse({ choices: [{ message: { content: '' } }] }),
        }),
        /返回了空内容/);
});

// ---------------------------------------------------------------- kimi-cli

test('kimi-cli 从 stdout 取答案并剥掉 UI 圆点，stderr 不进答案', async () => {
    const spawnImpl = fakeSpawn({
        stdout: '• 建议先补测试\n',
        stderr: 'kimi version 2.1.1\n• thinking...\nTo resume this session: kimi -r s1\n',
    });
    const result = await callKimiCli({
        prompt: '请评审',
        participant: { command: 'kimi', cwd: process.cwd() },
        spawnImpl,
    });
    assert.equal(result.text, '建议先补测试');
    assert.equal(result.code, 0);
    const [call] = spawnImpl.calls;
    assert.equal(call.command, 'kimi');
    assert.deepEqual(call.args, ['-p', '请评审', '--output-format', 'text']);
});

test('kimi-cli 支持通过 homeDir 覆盖 KIMI_CODE_HOME（沙箱场景）', async () => {
    const spawnImpl = fakeSpawn({ stdout: '• ok' });
    await callKimiCli({
        prompt: 'x',
        participant: { command: 'kimi', cwd: '/tmp', homeDir: '/work/.kimi-home' },
        spawnImpl,
    });
    assert.equal(spawnImpl.calls[0].options.env.KIMI_CODE_HOME, '/work/.kimi-home');
});

test('kimi-cli 非 0 退出码要把 stderr 尾部的错误带出来', async () => {
    const spawnImpl = fakeSpawn({ code: 2, stderr: 'storage write failed' });
    await assert.rejects(
        () => callKimiCli({
            prompt: 'x',
            participant: { command: 'kimi', cwd: '/tmp' },
            spawnImpl,
        }),
        /退出码 2：storage write failed/);
});

test('stripBullet 只剥开头那一个圆点', () => {
    assert.equal(stripBullet('• hello'), 'hello');
    assert.equal(stripBullet('·hello'), 'hello');
    assert.equal(stripBullet('a • b'), 'a • b');
});

// ---------------------------------------------------------------- 失败隔离

test('单个模型失败被收敛成 verdict=error，不抛出', async () => {
    const result = await reviewWithParticipant({
        participant: { name: 'claude', label: 'Claude', adapter: 'claude-api', baseUrl: 'https://h', model: 'm', apiKey: 'k' },
        task: 't', step: 'plan', artifact: 'a',
        fetchImpl: async () => { throw new Error('boom'); },
    });
    assert.equal(result.verdict, 'error');
    assert.match(result.error, /boom/);
    assert.equal(result.name, 'claude');
});

test('缺 key 也是一种 error 结果，而不是抛出去打断整轮', async () => {
    const result = await reviewWithParticipant({
        participant: { name: 'claude', label: 'Claude', adapter: 'claude-api', baseUrl: 'https://h', model: 'm' },
        task: 't', step: 'plan', artifact: 'a',
        env: {},
    });
    assert.equal(result.verdict, 'error');
    assert.match(result.error, /没有找到 API key/);
});

test('不认识的适配器也被收敛，并列出可选适配器', async () => {
    const result = await reviewWithParticipant({
        participant: { name: 'x', adapter: 'telepathy' },
    });
    assert.equal(result.verdict, 'error');
    assert.match(result.error, /不认识的适配器 "telepathy".*kimi-cli/s);
});

test('collectReviews 并行跑且保持顺序，一个挂掉不影响别的', async () => {
    const fetchImpl = async (url) => {
        if (String(url).includes('bad.example')) {
            return jsonResponse({ error: { message: 'nope' } }, 500);
        }
        return jsonResponse({ content: [{ type: 'text', text: 'ok\nVERDICT: approve' }] });
    };
    const results = await collectReviews({
        participants: [
            { name: 'good', label: 'Good', adapter: 'claude-api', baseUrl: 'https://good.example', model: 'm', apiKey: 'k' },
            { name: 'bad', label: 'Bad', adapter: 'claude-api', baseUrl: 'https://bad.example', model: 'm', apiKey: 'k' },
        ],
        task: 't', step: 'plan', artifact: 'a', fetchImpl,
    });
    assert.deepEqual(results.map(item => item.name), ['good', 'bad']);
    assert.equal(results[0].verdict, 'approve');
    assert.equal(results[1].verdict, 'error');
});

// ---------------------------------------------------------------- 结论解析

test('parseVerdict 取最后一个 VERDICT，且容忍中文冒号', () => {
    assert.equal(parseVerdict('问题\nVERDICT: approve'), 'approve');
    assert.equal(parseVerdict('VERDICT: approve\n\n后来想想\nVERDICT: revise'), 'revise');
    assert.equal(parseVerdict('VERDICT：approve'), 'approve');
    assert.equal(parseVerdict('我觉得还行'), 'unknown');
    assert.equal(parseVerdict(''), 'unknown');
});

test('summarizeReview 给出一句话摘要', () => {
    assert.equal(
        summarizeReview({ label: 'Kimi', verdict: 'revise', text: '这里会死锁\nVERDICT: revise' }),
        'Kimi：要改｜这里会死锁');
    assert.equal(
        summarizeReview({ label: 'Claude', verdict: 'error', error: 'timeout' }),
        'Claude：调用失败（timeout）');
});

// ---------------------------------------------------------------- 鉴权风格

test('authHeaders：默认用 x-api-key', () => {
    assert.deepEqual(authHeaders({}, 'sk-1'), { 'x-api-key': 'sk-1' });
    assert.deepEqual(authHeaders({ authStyle: 'api-key' }, 'sk-1'), { 'x-api-key': 'sk-1' });
});

test('authHeaders：authStyle=bearer 时改用 Authorization（中转/Claude Code 风格）', () => {
    assert.deepEqual(authHeaders({ authStyle: 'bearer' }, 'sk-1'),
        { Authorization: 'Bearer sk-1' });
});

test('claude-api：bearer 风格发出去的是 Authorization，且不带 x-api-key', async () => {
    let seen = null;
    const fetchImpl = async (url, init) => {
        seen = init;
        return jsonResponse({ content: [{ type: 'text', text: 'ok\nVERDICT: approve' }] });
    };
    await callClaudeApi({
        prompt: 'x',
        participant: {
            baseUrl: 'https://relay.internal/anthropic',
            model: 'deepseek-v4-pro[1m]',
            apiKey: 'sk-1',
            authStyle: 'bearer',
        },
        fetchImpl,
    });
    assert.equal(seen.headers.Authorization, 'Bearer sk-1');
    assert.equal('x-api-key' in seen.headers, false);
    // thinking 块要被忽略，只取 text
    const result = await callClaudeApi({
        prompt: 'x',
        participant: { baseUrl: 'https://h', model: 'm', apiKey: 'k', authStyle: 'bearer' },
        fetchImpl: async () => jsonResponse({
            content: [{ type: 'thinking', thinking: '想一下' }, { type: 'text', text: '答案' }],
        }),
    });
    assert.equal(result.text, '答案');
});

test('claude-api：缺 key 时的报错要提到 apiKeyFile 这条出路', async () => {
    await assert.rejects(
        () => callClaudeApi({
            prompt: 'x',
            participant: { baseUrl: 'https://h', model: 'm', apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN' },
            fetchImpl: async () => jsonResponse({}),
            env: {},
        }),
        /apiKeyFile.*ANTHROPIC_AUTH_TOKEN/s);
});
