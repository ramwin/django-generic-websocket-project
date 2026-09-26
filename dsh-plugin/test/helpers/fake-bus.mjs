/**
 * 测试用的假会议室：在内存里模拟 django-generic-websocket-project 的
 * 会议室 HTTP 接口，语义与真实服务一致（seq 单调递增、消息不可变、
 * 支持 after/roles 过滤）。
 *
 * 它**不模拟等待**：长轮询立刻返回当前已有的消息。所以「3 秒窗口」在
 * 测试里表现为「没有人类动作 -> 立即得到 timeout」，不需要真的 sleep。
 */

/** 会话内 seq 从 1 开始，与真实服务一致。 */
export class FakeCouncilBus {
    constructor({ task = '' } = {}) {
        this.sessions = new Map();
        this.task = task;
        this.started = [];
        this.finished = [];
        this.sessionCounter = 0;
        //: 可选钩子：每条消息落库后调用，用来在测试里模拟「人类在窗口期
        //: 按下打断 / 注入建议」。会被 await。
        this.onPost = null;
        //: 可选钩子：每次长轮询之前调用，参数是 (sessionId, options)。
        //: 用来模拟「人类看完之后在第二次轮询期间才做决定」。会被 await。
        this.onPoll = null;
        //: 对这些 role 的 postMessage 抛错，用来模拟总线写入失败。
        this.failPostRoles = [];
        //: 从第几次 getMessages（1 基）开始抛错；null 表示不抛。
        this.failGetFrom = null;
        this.getCount = 0;
    }

    pageUrl(sessionId) {
        return `http://fake/ws/generic/council/room/${sessionId}/`;
    }

    websocketUrl(sessionId) {
        return `ws://fake/ws/generic/${sessionId}/`;
    }

    async createSession({ task = '', participants = [], sessionId } = {}) {
        this.sessionCounter += 1;
        const id = sessionId && sessionId !== ''
            ? sessionId
            : `council_fake${this.sessionCounter}`;
        if (this.sessions.has(id)) {
            throw new Error(`会话 ${id} 已存在`);
        }
        const session = {
            session_id: id,
            task,
            participants,
            status: 'active',
            conclusion: '',
            round_index: 0,
            messages: [],
            next_seq: 0,
        };
        this.sessions.set(id, session);
        this.started.push(session);
        return {
            ...this._snapshot(session),
            room: id,
            ws_path: `/ws/generic/${id}/`,
            page_url: this.pageUrl(id),
        };
    }

    async getSession(sessionId) {
        return this._snapshot(this._require(sessionId));
    }

    async postMessage(sessionId, message) {
        const session = this._require(sessionId);
        if (this.failPostRoles.includes(message.role)) {
            throw new Error(`fake bus 拒绝写入 ${message.role}`);
        }
        session.next_seq += 1;
        const event = {
            council: true,
            event: 'message',
            session_id: sessionId,
            seq: session.next_seq,
            sender: message.sender,
            role: message.role ?? '',
            step: message.step ?? '',
            content: message.content ?? '',
            payload: message.payload ?? {},
            at: new Date(0).toISOString(),
        };
        session.messages.push(event);
        if (event.role === 'human_window_close') {
            session.round_index += 1;
        }
        if (typeof this.onPost === 'function') {
            await this.onPost(event);
        }
        return event;
    }

    async getMessages(sessionId, { after = 0, roles } = {}) {
        const session = this._require(sessionId);
        this.getCount += 1;
        if (this.failGetFrom !== null && this.getCount >= this.failGetFrom) {
            throw new Error('fake bus 连接中断');
        }
        if (typeof this.onPoll === 'function') {
            await this.onPoll(sessionId, { after, roles });
        }
        const wanted = Array.isArray(roles) && roles.length > 0
            ? new Set(roles)
            : null;
        const messages = session.messages.filter(item => item.seq > after);
        const matched = wanted === null
            ? messages
            : messages.filter(item => wanted.has(item.role));
        return {
            messages: matched.length > 0 ? messages : [],
            latest_seq: session.next_seq,
            timed_out: matched.length === 0,
            session: this._snapshot(session),
        };
    }

    async humanAction(sessionId, { kind, content = '' }) {
        const roles = {
            interrupt: 'interrupt',
            resume: 'resume',
            suggest: 'suggest',
            note: 'note',
        };
        return this.postMessage(sessionId, {
            sender: 'human',
            role: roles[kind] ?? kind,
            content,
        });
    }

    async finish(sessionId, { conclusion = '' } = {}) {
        const session = this._require(sessionId);
        session.status = 'finished';
        session.conclusion = conclusion;
        await this.postMessage(sessionId, {
            sender: 'system',
            role: 'system',
            content: conclusion,
        });
        return { session: this._snapshot(session) };
    }

    // ---- 测试辅助 ----

    /** 取某个会话里指定角色的消息。 */
    rolesOf(sessionId, role) {
        return this._require(sessionId).messages.filter(item => item.role === role);
    }

    /** 取某个会话的全部消息。 */
    messagesOf(sessionId) {
        return this._require(sessionId).messages;
    }

    _require(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session === undefined) {
            throw new Error(`会话 ${sessionId} 不存在`);
        }
        return session;
    }

    _snapshot(session) {
        return {
            session_id: session.session_id,
            task: session.task,
            participants: session.participants,
            status: session.status,
            conclusion: session.conclusion,
            round_index: session.round_index,
            latest_seq: session.next_seq,
            created_at: new Date(0).toISOString(),
            updated_at: new Date(0).toISOString(),
        };
    }
}
