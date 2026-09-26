/**
 * 会议室客户端（HTTP 通道）的单元测试。
 *
 * 全部用假的 fetch，不碰网络，也不依赖 Django 服务在跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CouncilBus, CouncilBusError } from '../lib/council-client.js';

/** 造一个记录请求的假 fetch。 */
function recordingFetch(handler) {
    const calls = [];
    const impl = async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method, body: init.body });
        return handler(String(url), init);
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

test('busUrl 为空直接报错，且提示怎么写', () => {
    assert.throws(() => new CouncilBus({ busUrl: '' }),
        /busUrl 不能为空/);
});

test('createSession 打到正确的路径，并把 session_id 一起带上', async () => {
    const fetchImpl = recordingFetch(() => jsonResponse({
        session_id: 'council_x', page_url: 'http://h/p/', ws_path: '/ws/generic/council_x/',
    }, 201));
    const bus = new CouncilBus({ busUrl: 'http://127.0.0.1:7420/', fetchImpl });
    const result = await bus.createSession({
        task: 't', participants: ['kimi'], sessionId: 'council_x',
    });
    assert.equal(result.session_id, 'council_x');
    assert.equal(fetchImpl.calls[0].url,
        'http://127.0.0.1:7420/ws/generic/council/sessions/');
    assert.equal(fetchImpl.calls[0].method, 'POST');
    assert.deepEqual(JSON.parse(fetchImpl.calls[0].body), {
        task: 't', participants: ['kimi'], session_id: 'council_x',
    });
});

test('getMessages 把 roles 数组拼成逗号串，并预留长轮询超时', async () => {
    const fetchImpl = recordingFetch(() => jsonResponse({
        messages: [], latest_seq: 0, timed_out: true,
    }));
    const bus = new CouncilBus({ busUrl: 'http://h', fetchImpl });
    await bus.getMessages('council_x', {
        after: 7, wait: 3, roles: ['interrupt', 'resume'],
    });
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.pathname, '/ws/generic/council/sessions/council_x/messages/');
    assert.equal(url.searchParams.get('after'), '7');
    assert.equal(url.searchParams.get('wait'), '3');
    assert.equal(url.searchParams.get('roles'), 'interrupt,resume');
});

test('没指定 wait/roles 时不会塞进 query（after 默认 0 会显式带上）', async () => {
    const fetchImpl = recordingFetch(() => jsonResponse({ messages: [] }));
    const bus = new CouncilBus({ busUrl: 'http://h', fetchImpl });
    await bus.getMessages('council_x');
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.searchParams.get('after'), '0');
    assert.equal(url.searchParams.has('wait'), false);
    assert.equal(url.searchParams.has('roles'), false);
});

test('humanAction 的 kind 原样送到 /human/', async () => {
    const fetchImpl = recordingFetch(() => jsonResponse({ role: 'suggest' }, 201));
    const bus = new CouncilBus({ busUrl: 'http://h', fetchImpl });
    await bus.humanAction('council_x', { kind: 'suggest', content: '先写测试' });
    assert.equal(fetchImpl.calls[0].url, 'http://h/ws/generic/council/sessions/council_x/human/');
    assert.deepEqual(JSON.parse(fetchImpl.calls[0].body), {
        kind: 'suggest', content: '先写测试',
    });
});

test('HTTP 非 2xx 抛 CouncilBusError，带上状态码和服务端说明', async () => {
    const fetchImpl = recordingFetch(() => jsonResponse(
        { error: 'sender 必填' }, 400));
    const bus = new CouncilBus({ busUrl: 'http://h', fetchImpl });
    await assert.rejects(
        () => bus.postMessage('council_x', { sender: '' }),
        (error) => {
            assert.ok(error instanceof CouncilBusError);
            assert.equal(error.status, 400);
            assert.match(error.message, /HTTP 400/);
            assert.match(error.message, /sender 必填/);
            return true;
        });
});

test('连不上服务时给出「先把 Django 服务起起来」的提示', async () => {
    const fetchImpl = recordingFetch(() => {
        throw new Error('connect ECONNREFUSED');
    });
    const bus = new CouncilBus({ busUrl: 'http://127.0.0.1:7420', fetchImpl });
    await assert.rejects(
        () => bus.getSession('council_x'),
        /连不上 AI 会议室服务.*runserver 7420/s);
});

test('pageUrl 与 websocketUrl 的推导', () => {
    const bus = new CouncilBus({ busUrl: 'http://127.0.0.1:7420', fetchImpl: async () => {} });
    assert.equal(bus.pageUrl('council_x'),
        'http://127.0.0.1:7420/ws/generic/council/room/council_x/');
    assert.equal(bus.websocketUrl('council_x'),
        'ws://127.0.0.1:7420/ws/generic/council_x/');
    const secure = new CouncilBus({ busUrl: 'https://ws.example.com', fetchImpl: async () => {} });
    assert.equal(secure.websocketUrl('council_x'),
        'wss://ws.example.com/ws/generic/council_x/');
});
