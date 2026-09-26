/**
 * 「AI 给出反馈后，留 3 秒给人类打断」的语义。
 *
 * 实现上只有一个技巧：**这 3 秒就是一次带 roles 过滤的长轮询**。
 * 工具调用的时候 AI 回合本来就是开着等结果的，所以
 *
 *     等 3 秒看有没有人打断
 *
 * 就是一次 `GET /messages?after=N&wait=3&roles=interrupt,resume,suggest`：
 * 有人打断就立刻返回，没人打断就在 3 秒后超时返回。不需要定时器、
 * 不需要外部调度器、不需要插件自己维护状态机。
 *
 * 阶段划分：
 *
 *   阶段 1（humanWindowMs，默认 3 秒）
 *     人类点「打断」 -> 进入阶段 2
 *     人类点「恢复」 -> 直接继续循环
 *     人类点「加入建议」 -> 带着建议继续循环
 *     什么都没发生 -> 自动继续循环（status: timeout）
 *
 *   阶段 2（humanWaitMs，默认 10 分钟）
 *     人类点「恢复循环」   -> status: resumed
 *     人类点「加入我的建议」-> status: suggested，带上建议正文
 *     一直没决定           -> status: paused，把控制权交回 DeepSeek，
 *                             由它在对话里继续问人
 *
 * @module dsh-plugin-ai-council/human-window
 */

/** 能影响循环的人类动作角色。 */
export const WINDOW_ROLES = ['interrupt', 'resume', 'suggest'];

/**
 * 从一批消息里挑出第一条满足条件的动作。
 *
 * @param {object[]} messages 消息数组。
 * @param {number} afterSeq 只看 seq 大于它的。
 * @param {string[]} roles 关心的角色。
 * @returns {object|undefined} 命中的消息。
 */
export function pickHumanAction(messages, afterSeq, roles) {
    const wanted = new Set(roles);
    return (messages ?? []).find(
        item => item !== null && item !== undefined
            && typeof item.seq === 'number'
            && item.seq > afterSeq
            && wanted.has(item.role));
}

/** 把人类在窗口期留下的普通留言挑出来，一并交给 DeepSeek 看。 */
export function collectHumanNotes(messages, afterSeq) {
    return (messages ?? [])
        .filter(item => item !== null && item !== undefined
            && typeof item.seq === 'number'
            && item.seq > afterSeq
            && item.role === 'note'
            && String(item.content ?? '').trim() !== '')
        .map(item => ({ seq: item.seq, content: item.content }));
}

/**
 * 单次长轮询请求最多阻塞多久。
 *
 * **这个值必须小于服务端的上限**：`generic/council.py` 的 `MAX_WAIT_SECONDS = 60`
 * 会把 `?wait=` 静默截断到 60 秒。所以客户端不能指望「一次请求等满
 * humanWaitMs」，必须自己循环。留 5 秒余量，避免正好卡在服务端边界上。
 */
export const MAX_SINGLE_POLL_MS = 55_000;

/**
 * 反复长轮询，直到命中人类动作或到达自己的截止时间。
 *
 * 为什么需要它：这里原先只发**一次** `?wait=humanWaitMs` 的请求，而服务端把它
 * 截断成 60 秒，于是「打断后最多等你 10 分钟」实际上只等了 60 秒 —— 人在 60 秒
 * 之后写的建议/恢复就没人接了（**真实踩过**：用户在会议室留言，插件却早已返回）。
 * 循环到自己的 deadline 才是对的，顺便也避免单个 HTTP 请求长时间挂着被中间层掐断。
 *
 * @param {object} options 参数。
 * @param {object} options.bus 会议室客户端。
 * @param {string} options.sessionId 会话 ID。
 * @param {number} options.afterSeq 只看 seq 大于它的消息。
 * @param {string[]} options.roles 命中的角色。
 * @param {number} options.timeoutMs 客户端自己的总等待上限。
 * @param {number} [options.maxSinglePollMs] 单次请求上限。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @param {Function} [options.now] 取当前时间的函数，默认 `Date.now`（测试注入用）。
 * @returns {Promise<{action: object|undefined, messages: object[], timedOut: boolean}>} 结果。
 */
export async function waitForHumanAction({
    bus,
    sessionId,
    afterSeq,
    roles,
    timeoutMs,
    maxSinglePollMs = MAX_SINGLE_POLL_MS,
    signal,
    now = Date.now,
}) {
    const deadline = now() + Math.max(0, timeoutMs);
    const messages = [];
    let cursor = afterSeq;
    for (;;) {
        const remaining = deadline - now();
        if (remaining <= 0) {
            return { action: undefined, messages, timedOut: true };
        }
        const batch = await bus.getMessages(sessionId, {
            // 推进游标，避免每轮把同样的消息重复取回来
            after: cursor,
            wait: Math.min(remaining, maxSinglePollMs) / 1000,
            roles,
        }, { signal });
        for (const item of batch?.messages ?? []) {
            messages.push(item);
            if (typeof item?.seq === 'number' && item.seq > cursor) {
                cursor = item.seq;
            }
        }
        const action = pickHumanAction(messages, afterSeq, roles);
        if (action !== undefined) {
            return { action, messages, timedOut: false };
        }
        // 没命中就继续 —— 直到自己的 deadline，而不是信一次请求的返回值
    }
}

/**
 * 打开一次人工窗口，并按上面描述的阶段推进。
 *
 * @param {object} options 参数。
 * @param {object} options.bus 会议室客户端（有 postMessage/getMessages 即可，便于测试）。
 * @param {string} options.sessionId 会话 ID。
 * @param {number} [options.windowMs] 阶段 1 时长，默认 3000。
 * @param {number} [options.waitMs] 阶段 2 时长，默认 600000。
 * @param {number} [options.targetSeq] 这次窗口针对哪一轮产物。
 * @param {string} [options.reason] 窗口开启时展示给人类的说明。
 * @param {number} [options.pollWindowMs] 单次长轮询请求的上限，默认
 *   :data:`MAX_SINGLE_POLL_MS`。**必须小于服务端上限**，见该常量的说明。
 * @param {AbortSignal} [options.signal] 工具执行的取消信号。
 * @param {Function} [options.now] 取当前时间的函数，默认 `Date.now`（测试注入用）。
 * @returns {Promise<object>} 窗口结果。
 */
export async function openHumanWindow({
    bus,
    sessionId,
    windowMs = 3000,
    waitMs = 600_000,
    targetSeq = 0,
    reason = '',
    pollWindowMs = MAX_SINGLE_POLL_MS,
    signal,
    now = Date.now,
}) {
    const seconds = Math.max(1, Math.round(windowMs / 1000));
    const opened = await bus.postMessage(sessionId, {
        sender: 'deepseek',
        role: 'human_window_open',
        content: reason || `模型已给出意见，${seconds} 秒内可以打断，我会停下来等你。`,
        payload: { deadline_ms: windowMs, target_seq: targetSeq },
    }, { signal });

    // 窗口**必须**被关上：否则会议室会永远停在「等人工确认」，round_index
    // 也不会增长，页面上的倒计时条会一直挂着。所以关闭动作：
    //   1. 只执行一次；
    //   2. 刻意**不**带 signal —— 即使工具被取消，清理也要能写进去；
    //   3. 自身失败不抛，避免盖掉已经拿到的评审结论。
    let closed = false;
    const closeWindow = async (outcome, extra = {}) => {
        if (closed) {
            return;
        }
        closed = true;
        try {
            await bus.postMessage(sessionId, {
                sender: 'system',
                role: 'human_window_close',
                content: describeOutcome(outcome),
                payload: { outcome, target_seq: targetSeq, ...extra },
            });
        } catch {
            // 关窗失败只能忍了，但绝不能因此丢掉这一轮的评审结果
        }
    };

    /** 推进两个阶段，返回 {outcome, extra, result}。 */
    const runPhases = async () => {
        // ---- 阶段 1：3 秒窗口 ----
        const during = await waitForHumanAction({
            bus,
            sessionId,
            afterSeq: opened.seq,
            roles: WINDOW_ROLES,
            timeoutMs: windowMs,
            maxSinglePollMs: pollWindowMs,
            signal,
            now,
        });
        const notes = collectHumanNotes(during.messages, opened.seq);
        let action = during.action;

        if (action === undefined) {
            // 竞态兜底：页面上的倒计时是从「收到广播」那一刻开始算的，和服务端
            // 的 3 秒窗口存在毫秒级偏差。窗口刚过期这一瞬间到达的打断不能丢，
            // 否则用户会看到界面进入「已暂停」，而循环其实已经往下走了。
            // 这里补一次不等待的查询，代价是一次 HTTP 请求。
            const sweep = await bus.getMessages(sessionId, {
                after: opened.seq,
                wait: 0,
                roles: WINDOW_ROLES,
            }, { signal });
            action = pickHumanAction(sweep.messages, opened.seq, WINDOW_ROLES);
            notes.push(...collectHumanNotes(sweep.messages, opened.seq));
        }

        if (action === undefined) {
            return {
                outcome: 'timeout',
                extra: {},
                result: {
                    status: 'timeout',
                    window_seq: opened.seq,
                    human_notes: dedupeNotes(notes),
                },
            };
        }
        if (action.role === 'resume') {
            return {
                outcome: 'resumed',
                extra: { at_seq: action.seq },
                result: {
                    status: 'resumed',
                    window_seq: opened.seq,
                    action_seq: action.seq,
                    human_notes: dedupeNotes(notes),
                },
            };
        }
        if (action.role === 'suggest') {
            return {
                outcome: 'suggested',
                extra: { at_seq: action.seq },
                result: {
                    status: 'suggested',
                    window_seq: opened.seq,
                    action_seq: action.seq,
                    suggestion: String(action.content ?? ''),
                    human_notes: dedupeNotes(notes),
                },
            };
        }

        // ---- 阶段 2：人类按了打断，等他慢慢看、再决定 ----
        // 这里同样要循环：waitMs 默认 10 分钟，远超单次请求上限。
        const decisionWait = await waitForHumanAction({
            bus,
            sessionId,
            afterSeq: action.seq,
            roles: ['resume', 'suggest'],
            timeoutMs: waitMs,
            maxSinglePollMs: pollWindowMs,
            signal,
            now,
        });
        const decision = decisionWait.action;
        const allNotes = dedupeNotes([
            ...notes,
            ...collectHumanNotes(decisionWait.messages, action.seq),
        ]);

        if (decision === undefined) {
            return {
                outcome: 'paused',
                extra: { at_seq: action.seq },
                result: {
                    status: 'paused',
                    window_seq: opened.seq,
                    action_seq: action.seq,
                    human_notes: allNotes,
                },
            };
        }
        if (decision.role === 'resume') {
            return {
                outcome: 'resumed',
                extra: { at_seq: decision.seq },
                result: {
                    status: 'resumed',
                    window_seq: opened.seq,
                    action_seq: decision.seq,
                    human_notes: allNotes,
                },
            };
        }
        return {
            outcome: 'suggested',
            extra: { at_seq: decision.seq },
            result: {
                status: 'suggested',
                window_seq: opened.seq,
                action_seq: decision.seq,
                suggestion: String(decision.content ?? ''),
                human_notes: allNotes,
            },
        };
    };

    let decided;
    try {
        decided = await runPhases();
    } catch (error) {
        // 总线出错 / 工具被取消：也要如实关窗，并把「没等到人工结论」这件事
        // 明确返回给 DeepSeek，而不是让它以为人工通过了。
        const message = String(error?.message ?? error);
        decided = {
            outcome: 'aborted',
            extra: { reason: message },
            result: {
                status: 'aborted',
                window_seq: opened.seq,
                error: message,
                human_notes: [],
            },
        };
    }
    await closeWindow(decided.outcome, decided.extra);
    return decided.result;
}

/** 按 seq 去重（竞态兜底那次补查可能把同一条留言取回来两遍）。 */
export function dedupeNotes(notes) {
    const seen = new Set();
    const unique = [];
    for (const note of notes ?? []) {
        if (seen.has(note.seq)) {
            continue;
        }
        seen.add(note.seq);
        unique.push(note);
    }
    return unique;
}

/** 给人类看的结果说明。 */
export function describeOutcome(outcome) {
    switch (outcome) {
        case 'timeout':
            return '3 秒内没有人打断，循环自动继续。';
        case 'resumed':
            return '人类选择恢复循环。';
        case 'suggested':
            return '人类加入了建议，循环带着建议继续。';
        case 'paused':
            return '人类打断了循环，等待他的下一步决定。';
        case 'aborted':
            return '人工窗口异常关闭（评审结果已保留，但没等到人工结论）。';
        default:
            return `人工窗口关闭：${outcome}`;
    }
}
