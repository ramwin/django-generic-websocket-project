/**
 * 通往 django-generic-websocket-project「AI 会议室」的 HTTP 客户端。
 *
 * 这个客户端是整个插件唯一与 Django 服务耦合的地方，而且只走公开的
 * HTTP 接口 —— 所以那个 Django 项目可以完全脱离 DSH 单独部署，插件的
 * 存在与否对它没有任何影响。
 *
 * 它不做 WebSocket：本插件是「在某个 AI 回合里同步提问、同步拿答案」的
 * 使用方式，而会议室服务提供的**带 roles 过滤的长轮询**恰好就是实现
 * 「等几秒看有没有人打断」最省事、最可靠的通道（一次 HTTP 请求搞定，
 * 不需要自己管重连/心跳）。
 *
 * @module dsh-plugin-ai-council/council-client
 */

/** 总线调用失败。 */
export class CouncilBusError extends Error {
    constructor(message, { status, body, url } = {}) {
        super(message);
        this.name = 'CouncilBusError';
        this.status = status;
        this.body = body;
        this.url = url;
    }
}

/**
 * 会议室总线客户端。
 */
export class CouncilBus {
    /**
     * @param {object} options 构造参数。
     * @param {string} options.busUrl Django 服务地址，例如 http://127.0.0.1:7420
     * @param {number} [options.requestTimeoutMs] 单次请求超时
     * @param {typeof fetch} [options.fetchImpl] 便于测试注入
     */
    constructor({ busUrl, requestTimeoutMs = 30_000, fetchImpl } = {}) {
        if (typeof busUrl !== 'string' || busUrl.trim() === '') {
            throw new Error('busUrl 不能为空（例如 http://127.0.0.1:7420）');
        }
        this.baseUrl = busUrl.replace(/\/+$/, '');
        this.apiRoot = `${this.baseUrl}/ws/generic/council`;
        this.requestTimeoutMs = requestTimeoutMs;
        this.fetchImpl = fetchImpl ?? globalThis.fetch;
        if (typeof this.fetchImpl !== 'function') {
            throw new Error('当前运行环境没有 fetch，请注入 fetchImpl');
        }
    }

    /** 会议室页面地址。 */
    pageUrl(sessionId) {
        return `${this.apiRoot}/room/${sessionId}/`;
    }

    /** WebSocket 地址（人用浏览器看，插件不用）。 */
    websocketUrl(sessionId, { httpUrl } = {}) {
        const base = httpUrl ?? this.baseUrl;
        const scheme = base.startsWith('https://') ? 'wss://' : 'ws://';
        return `${scheme}${base.replace(/^https?:\/\//, '')}/ws/generic/${sessionId}/`;
    }

    async _request(method, path, { body, query, timeoutMs, signal } = {}) {
        const url = new URL(`${this.apiRoot}${path}`);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, String(value));
            }
        }
        // 超时和调用方（工具执行的 signal）谁先来就听谁的。
        const timeoutSignal = AbortSignal.timeout(timeoutMs ?? this.requestTimeoutMs);
        const combined = signal === undefined
            ? timeoutSignal
            : AbortSignal.any([timeoutSignal, signal]);
        let response;
        try {
            response = await this.fetchImpl(url, {
                method,
                headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: combined,
            });
        } catch (error) {
            throw new CouncilBusError(
                `连不上 AI 会议室服务 ${url.origin}：${error.message}。`
                + '请确认 django-generic-websocket-project 已经启动'
                + `（例如 python manage.py runserver 7420）。`,
                { url: String(url) });
        }
        const text = await response.text();
        let data;
        try {
            data = text === '' ? {} : JSON.parse(text);
        } catch {
            data = { raw: text };
        }
        if (!response.ok) {
            throw new CouncilBusError(
                `AI 会议室接口 ${method} ${url.pathname} 返回 HTTP ${response.status}：`
                + `${text.slice(0, 300)}`,
                { status: response.status, body: data, url: String(url) });
        }
        return data;
    }

    /** 创建会话。 */
    async createSession({ task = '', participants = [], sessionId } = {}, { signal } = {}) {
        const body = { task, participants };
        if (sessionId !== undefined && sessionId !== '') {
            body.session_id = sessionId;
        }
        return this._request('POST', '/sessions/', { body, signal });
    }

    /** 会话快照。 */
    async getSession(sessionId, { signal } = {}) {
        return this._request('GET', `/sessions/${sessionId}/`, { signal });
    }

    /** 发言（默认会广播给房间内所有订阅者）。 */
    async postMessage(sessionId, { sender, role = '', step = '', content = '', payload = {}, broadcast = true } = {}, { signal } = {}) {
        return this._request('POST', `/sessions/${sessionId}/messages/`, {
            body: { sender, role, step, content, payload, broadcast },
            signal,
        });
    }

    /** 拉消息，`wait` 秒内出现新消息就立刻返回。 */
    async getMessages(sessionId, { after = 0, wait = 0, roles } = {}, { signal } = {}) {
        return this._request('GET', `/sessions/${sessionId}/messages/`, {
            query: {
                after,
                // wait=0 是服务端默认值，不必显式带上
                wait: wait > 0 ? wait : undefined,
                roles: Array.isArray(roles) ? roles.join(',') : roles,
            },
            // 长轮询的请求超时必须比等待时间长一点，否则会自己把自己掐断。
            timeoutMs: (wait * 1000) + this.requestTimeoutMs,
            signal,
        });
    }

    /** 人类动作：interrupt / resume / suggest / note。 */
    async humanAction(sessionId, { kind, content = '', targetSeq } = {}, { signal } = {}) {
        const body = { kind, content };
        if (targetSeq !== undefined) {
            body.target_seq = targetSeq;
        }
        return this._request('POST', `/sessions/${sessionId}/human/`, { body, signal });
    }

    /** 结束会话。 */
    async finish(sessionId, { conclusion = '' } = {}, { signal } = {}) {
        return this._request('POST', `/sessions/${sessionId}/finish/`, {
            body: { conclusion },
            signal,
        });
    }
}
