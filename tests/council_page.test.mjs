#!/usr/bin/env node
/**
 * 会议室页面（generic/templates/generic/council.html）里那段内联 JS 的测试。
 *
 * 为什么值得单独测：**3 秒人工打断条是人类唯一直接操作的界面**，它的状态机
 * 一旦写错，表现出来就是「界面说暂停了，循环其实在往下走」这种骗人行为。
 *
 * 这里不引入 jsdom 之类的依赖：页面的 JS 只用到了很小一部分 DOM，
 * 手写一个最小桩反而更可控——尤其是时间，可以完全由测试驱动，
 * 不用真的等 3 秒。
 *
 * 跑法：node --test tests/council_page.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, '..', 'generic', 'templates', 'generic', 'council.html');
const SESSION_ID = 'council_pagetest';

/** 把页面里那段真实的内联 JS 抠出来。 */
function pageScript() {
    const html = readFileSync(TEMPLATE, 'utf8');
    // 只匹配没有属性的 <script>；json_script 生成的那些带 id/type，不会被误抓
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(blocks.length >= 1, '模板里没找到内联脚本');
    return blocks[blocks.length - 1][1];
}

// ------------------------------------------------------------------ DOM 桩

class FakeElement {
    constructor(tag = 'div', id = '') {
        this.tagName = tag.toUpperCase();
        this.id = id;
        this.className = '';
        this.textContent = '';
        this.value = '';
        this.children = [];
        this.style = { display: '' };
        this.listeners = {};
        this.scrollTop = 0;
        this.scrollHeight = 0;
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    addEventListener(type, handler) {
        (this.listeners[type] ??= []).push(handler);
    }

    focus() {}

    /** 触发一次事件（只支持同步 handler，够用了）。 */
    fire(type) {
        for (const handler of this.listeners[type] ?? []) {
            handler({ key: 'Enter', isComposing: false, preventDefault() {} });
        }
    }

    /** 递归取出这个子树里的全部文字，用来断言界面上到底显示了什么。 */
    text() {
        const own = this.textContent === undefined || this.textContent === null
            ? ''
            : String(this.textContent);
        return [own, ...this.children.map(child => child.text())].join(' ');
    }
}

/** 页面用到的元素 id 全在这里；多一个少一个都会在测试里立刻暴露。 */
const ELEMENT_IDS = [
    'session-id', 'session-url', 'messages-url', 'human-url',
    'chat-log', 'status', 'round', 'task', 'chat-message-input',
    'interrupt-bar', 'bar-waiting', 'bar-paused', 'countdown', 'countdown-fill',
    'suggest-box', 'suggest-text', 'chat-clear', 'chat-message-submit',
    'btn-interrupt', 'btn-resume', 'btn-suggest', 'btn-suggest-send',
    'btn-suggest-cancel',
];

/** json_script 生成的元素内容。 */
const JSON_SCRIPTS = {
    'session-id': JSON.stringify(SESSION_ID),
    'session-url': JSON.stringify(`/ws/generic/council/sessions/${SESSION_ID}/`),
    'messages-url': JSON.stringify(`/ws/generic/council/sessions/${SESSION_ID}/messages/`),
    'human-url': JSON.stringify(`/ws/generic/council/sessions/${SESSION_ID}/human/`),
};

/**
 * 搭一个能跑这个页面的最小环境。
 *
 * @returns {object} 测试夹具。
 */
function makePage() {
    const elements = new Map();
    for (const id of ELEMENT_IDS) {
        const element = new FakeElement('div', id);
        if (id in JSON_SCRIPTS) {
            element.textContent = JSON_SCRIPTS[id];
        }
        elements.set(id, element);
    }

    const clock = { now: Date.UTC(2026, 8, 27, 0, 0, 0) };
    class FakeDate extends Date {
        static now() { return clock.now; }
    }

    const timers = { intervals: new Map(), nextId: 1 };
    const sockets = [];
    const requests = [];

    const document = {
        getElementById: id => {
            const element = elements.get(id);
            assert.ok(element !== undefined, `页面引用了不存在的元素 #${id}`);
            return element;
        },
        createElement: tag => new FakeElement(tag),
    };

    const sandbox = {
        document,
        Date: FakeDate,
        JSON,
        Math,
        Object,
        Number,
        String,
        Array,
        URLSearchParams,
        console,
        setInterval: (fn, ms) => {
            const id = timers.nextId;
            timers.nextId += 1;
            timers.intervals.set(id, { fn, ms });
            return id;
        },
        clearInterval: id => timers.intervals.delete(id),
        setTimeout: () => 1,
        clearTimeout: () => {},
        fetch: async (url, options = {}) => {
            requests.push({ url: String(url), options });
            return {
                ok: true,
                status: 200,
                json: async () => ({ messages: [], session: null }),
                text: async () => '{}',
            };
        },
    };
    sandbox.window = {
        location: { protocol: 'http:', host: 'localhost:7420', search: '' },
        setInterval: sandbox.setInterval,
        clearInterval: sandbox.clearInterval,
        setTimeout: sandbox.setTimeout,
        clearTimeout: sandbox.clearTimeout,
        addEventListener: () => {},
    };
    class FakeWebSocket {
        constructor(url) {
            this.url = url;
            this.readyState = 1;
            this.sent = [];
            sockets.push(this);
        }
        send(payload) { this.sent.push(payload); }
        close() {}
    }
    sandbox.WebSocket = FakeWebSocket;
    FakeWebSocket.OPEN = 1;

    const context = vm.createContext(sandbox);
    vm.runInContext(pageScript(), context, { filename: 'council.html' });

    const api = {
        elements,
        element: id => elements.get(id),
        sockets,
        requests,
        /** 把时间往前推 ms 毫秒，并触发所有已注册的定时器回调。 */
        advance(ms) {
            clock.now += ms;
            for (const { fn } of [...timers.intervals.values()]) {
                fn();
            }
        },
        /** 模拟服务端通过 WebSocket 推来一条会议室事件。 */
        push(event) {
            assert.ok(sockets.length > 0, '页面还没有建立 WebSocket 连接');
            const at = new Date(clock.now).toISOString();
            sockets[0].onmessage({
                data: JSON.stringify({ council: true, at, ...event }),
            });
        },
        /** 推一条原生负载（例如项目原有的 {"message": "..."} 格式）。 */
        pushRaw(payload) {
            assert.ok(sockets.length > 0, '页面还没有建立 WebSocket 连接');
            sockets[0].onmessage({ data: JSON.stringify(payload) });
        },
        /**
         * 模拟「服务端已发出、页面隔了一会儿才收到」。
         *
         * 顺序很关键：`at` 必须是**发出时刻**，然后才把时钟往前推，
         * 否则就不是在模拟延迟，而是在伪造一条未来的消息。
         */
        pushDelayed(event, delayMs) {
            const at = new Date(clock.now).toISOString();
            clock.now += delayMs;
            assert.ok(sockets.length > 0, '页面还没有建立 WebSocket 连接');
            sockets[0].onmessage({
                data: JSON.stringify({ council: true, at, ...event }),
            });
        },
        logText: () => elements.get('chat-log').text(),
        /** 点一下某个按钮，并等它内部的 await 走完。 */
        async click(id) {
            elements.get(id).fire('click');
            // postHuman 是 async 的，让它把 fetch 的 promise 决议掉
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setImmediate(resolve));
        },
        humanPosts: () => requests.filter(item => item.url.includes('/human/')),
        console,
    };
    return api;
}

const WINDOW_OPEN = { role: 'human_window_open', seq: 1, sender: 'deepseek',
                      content: '模型已给出意见', payload: { deadline_ms: 3000, target_seq: 1 } };
const WINDOW_CLOSE = outcome => ({ role: 'human_window_close', seq: 2, sender: 'system',
                                   content: '', payload: { outcome } });

// ------------------------------------------------------------------ 用例

test('收到窗口开启后进入倒计时；倒计时走完自动清空并提示', () => {
    const page = makePage();
    page.push(WINDOW_OPEN);
    assert.equal(page.element('bar-waiting').style.display, 'flex', '倒计时条应该出现');
    assert.equal(page.element('interrupt-bar').className, 'active');

    page.advance(1000);
    assert.equal(page.element('countdown').textContent, '2.0', '剩余时间应该按服务端时间戳算');

    page.advance(2500);
    assert.equal(page.element('bar-waiting').style.display, 'none', '超时后倒计时条要收起');
    assert.match(page.logText(), /自动继续/);
});

test('历史回放里已经过期的窗口不会弹出一个假的倒计时', () => {
    const page = makePage();
    // 服务端 5 秒前就发了这条窗口开启，页面现在才收到
    page.pushDelayed(WINDOW_OPEN, 5000);
    assert.equal(page.element('bar-waiting').style.display, '', '过期窗口不能出现倒计时条');
    assert.equal(page.element('interrupt-bar').className, '');
});

test('点「打断」会提交 interrupt，并进入暂停面板', async () => {
    const page = makePage();
    page.push(WINDOW_OPEN);
    await page.click('btn-interrupt');
    assert.equal(page.element('bar-paused').style.display, 'flex');
    assert.equal(page.element('bar-waiting').style.display, 'none');
    const posted = page.humanPosts();
    assert.equal(posted.length, 1);
    assert.equal(JSON.parse(posted[0].options.body).kind, 'interrupt');
    assert.match(page.logText(), /已打断循环/);
});

test('打断来晚了（窗口已过期）不能假装循环停了', async () => {
    const page = makePage();
    page.push(WINDOW_OPEN);
    page.advance(3100);                       // 倒计时自然走完，循环已经继续
    assert.equal(page.element('bar-waiting').style.display, 'none');

    await page.click('btn-interrupt');
    assert.notEqual(page.element('bar-paused').style.display, 'flex',
        '循环并没有停，绝不能显示暂停面板');
    assert.match(page.logText(), /来晚了/);
});

test('服务端关窗（outcome=paused）时暂停面板要留着', () => {
    const page = makePage();
    page.push(WINDOW_OPEN);
    page.push({ role: 'interrupt', seq: 2, sender: 'human', content: '' });
    page.push(WINDOW_CLOSE('paused'));
    assert.equal(page.element('bar-paused').style.display, 'flex',
        '打断后关窗，暂停面板必须继续显示等他决定');
});

test('服务端关窗（outcome=timeout）时清空整条横条', () => {
    const page = makePage();
    page.push(WINDOW_OPEN);
    page.push(WINDOW_CLOSE('timeout'));
    assert.equal(page.element('interrupt-bar').className, '');
    assert.equal(page.element('bar-waiting').style.display, 'none');
    assert.equal(page.element('bar-paused').style.display, 'none');
});

test('关窗结果把已暂停的界面恢复到正常', () => {
    const page = makePage();
    page.push(WINDOW_OPEN);
    page.push({ role: 'interrupt', seq: 2, sender: 'human', content: '' });
    page.push(WINDOW_CLOSE('paused'));
    page.push({ role: 'resume', seq: 3, sender: 'human', content: '' });
    assert.equal(page.element('interrupt-bar').className, '');
    assert.equal(page.element('bar-paused').style.display, 'none');
});

test('自己点打断之后收到自己那条广播，不能弹「来晚了」', async () => {
    const page = makePage();
    page.push(WINDOW_OPEN);
    await page.click('btn-interrupt');
    // 服务端把这条 interrupt 广播回来（页面自己也在房间里）
    page.push({ role: 'interrupt', seq: 2, sender: 'human', content: '' });
    assert.equal(page.element('bar-paused').style.display, 'flex');
    assert.doesNotMatch(page.logText(), /来晚了/);
});

test('提交人类建议会带上正文并收起横条', async () => {
    const page = makePage();
    page.push(WINDOW_OPEN);
    page.element('suggest-text').value = '记得把 Redis 多实例也测一遍';
    await page.click('btn-suggest-send');
    const posted = page.humanPosts();
    assert.equal(posted.length, 1);
    const body = JSON.parse(posted[0].options.body);
    assert.equal(body.kind, 'suggest');
    assert.equal(body.content, '记得把 Redis 多实例也测一遍');
    assert.equal(page.element('bar-paused').style.display, 'none');
    assert.match(page.logText(), /建议已提交/);
});

test('空白建议不会被提交', async () => {
    const page = makePage();
    page.push(WINDOW_OPEN);
    page.element('suggest-text').value = '   ';
    await page.click('btn-suggest-send');
    assert.equal(page.humanPosts().length, 0);
});

test('页面订阅的地址与 session_id 一致', () => {
    const page = makePage();
    assert.equal(page.sockets.length, 1);
    assert.equal(page.sockets[0].url,
        `ws://localhost:7420/ws/generic/${SESSION_ID}/`);
});

test('打开页面会先拉一次历史', () => {
    const page = makePage();
    const loads = page.requests.map(item => item.url);
    assert.ok(loads.some(url => url.includes('/messages/?after=0')));
    assert.ok(loads.some(url => url.endsWith(`/sessions/${SESSION_ID}/`)));
});

test('非会议室格式的消息（项目原有推送）不会让页面崩', () => {
    const page = makePage();
    page.pushRaw({ message: 'hello' });
    assert.match(page.logText(), /hello/);
});

test('倒计时文案跟着 deadline_ms 走，不是写死的 3 秒', () => {
    // 窗口时长是可配的（默认已从 3 秒改成 10 秒）。页面文案必须跟着来，
    // 否则用户看到的数字和实际行为对不上。
    const tenSeconds = makePage();
    tenSeconds.push({ ...WINDOW_OPEN, payload: { deadline_ms: 10000, target_seq: 1 } });
    tenSeconds.advance(10500);
    assert.match(tenSeconds.logText(), /10 秒内没有人打断/);
    assert.doesNotMatch(tenSeconds.logText(), /3 秒内没有人打断/);

    const threeSeconds = makePage();
    threeSeconds.push({ ...WINDOW_OPEN, payload: { deadline_ms: 3000, target_seq: 1 } });
    threeSeconds.advance(3500);
    assert.match(threeSeconds.logText(), /3 秒内没有人打断/);
});

test('打断来晚了的提示也用实际窗口秒数', async () => {
    const page = makePage();
    page.push({ ...WINDOW_OPEN, payload: { deadline_ms: 10000, target_seq: 1 } });
    page.advance(10500);
    await page.click('btn-interrupt');
    assert.match(page.logText(), /10 秒窗口会重新给你/);
});
