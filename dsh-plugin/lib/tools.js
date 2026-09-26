/**
 * council_* 工具的注册。
 *
 * 这是插件与 DSH 的接缝：工具注册进 `ctx.tools`，模型就能在对话里
 * 直接调用。除了这一个文件（和 index.js），插件其余部分都不依赖 DSH，
 * 因此可以脱离 DSH 用 `node --test` 跑。
 *
 * @module dsh-plugin-ai-council/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { collectReviews } from './adapters/index.js';
import { CouncilBus } from './council-client.js';
import { selectParticipants } from './config.js';
import { openHumanWindow } from './human-window.js';
import { compact } from './json-safe.js';
import { formatTranscript, summarizeReview } from './prompts.js';

/** 单个产物的最大字符数，避免把命令行参数撑爆（Linux 单参数上限约 128KB）。 */
export const MAX_ARTIFACT_CHARS = 60_000;

/** 允许的步骤。 */
export const STEPS = ['plan', 'coding', 'execute', 'evaluate'];

/** 步骤的中文名，仅用于展示。 */
const STEP_LABELS = {
    plan: '计划',
    coding: '编码',
    execute: '执行',
    evaluate: '评价',
};

function clampText(text, max = MAX_ARTIFACT_CHARS) {
    const value = String(text ?? '');
    if (value.length <= max) {
        return { text: value, truncated: false };
    }
    return {
        text: `${value.slice(0, max)}\n…（产物过长已截断，原文 ${value.length} 字）`,
        truncated: true,
    };
}

function requireSessionId(args) {
    const sessionId = String(args.session_id ?? '').trim();
    if (sessionId === '') {
        throw new Error('session_id 必填；先用 council_start 创建一次会议室。');
    }
    if (!/^\w+$/.test(sessionId)) {
        throw new Error(`session_id "${sessionId}" 不合法：只能用字母、数字、下划线`
            + '（它同时是 WebSocket 房间名）。');
    }
    return sessionId;
}

/**
 * 注册工具前先包一层，保证返回值是无损 JSON。
 *
 * DSH 会用工具自己声明的 ``output.schema`` 校验返回值，而 JS 里顺手写出的
 * `undefined` 可选字段会让校验挂掉（详见 lib/json-safe.js）。包一层比在
 * 五个工具里各自记得清理要可靠。
 *
 * @param {object} definition defineTool 的定义。
 * @returns {object} 包好之后的工具定义。
 */
function safeTool(definition) {
    const run = definition.execute;
    return defineTool({
        ...definition,
        async execute(args, exec) {
            return compact(await run(args, exec));
        },
    });
}

/**
 * 注册全部 council 工具。
 *
 * @param {object} ctx cordis 上下文（需要 ctx.tools）。
 * @param {object} config 运行时配置。
 * @param {object} [deps] 测试注入点。
 * @returns {object} 运行期句柄。
 */
export function registerCouncilTools(ctx, config, deps = {}) {
    const bus = deps.bus ?? new CouncilBus({
        busUrl: config.busUrl,
        requestTimeoutMs: config.requestTimeoutMs,
        fetchImpl: deps.fetchImpl,
    });
    const runtime = { bus, config, deps };
    // 提示词/工具描述里的窗口时长必须跟着配置走，否则改了配置提示词还在说旧数字
    const windowSpan = `${Math.round(config.humanWindowMs / 1000)} 秒`;

    ctx.tools.register(safeTool({
        name: 'council_start',
        description: '创建一个 AI 会议室并把它作为这次任务的评审通道。'
            + '会议室里 DeepSeek、外部异模型（Kimi/Claude…）和人类共享同一份记录，'
            + `人类可以打开返回的 page_url 实时围观并用 ${windowSpan}窗口打断。`
            + '做完后每一步产物都用 council_review 送审。',
        parameters: {
            task: { type: 'string', required: true, description: '这次任务的完整描述。' },
            participants: {
                type: 'array', items: { type: 'string' },
                description: '参与评审的模型名（默认取配置里所有启用的）。',
            },
            session_id: {
                type: 'string',
                description: '自定义会话 ID（会同时作为 WebSocket 房间名）；省略则自动生成。',
            },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    session_id: { type: 'string', required: true },
                    page_url: { type: 'string', required: true },
                    ws_path: { type: 'string', required: true },
                    task: { type: 'string' },
                    participants: { type: 'array', items: { type: 'string' } },
                },
            },
            render: (args, value) => [{
                type: 'text',
                text: `AI 会议室已创建：${value.session_id}\n`
                    + `参与者：${(value.participants ?? []).join('、') || '(空)'}\n`
                    + `人类围观地址：${value.page_url}\n`
                    + `（房间 ${value.ws_path}，走的是 django-generic-websocket-project `
                    + '原有的 WebSocket 广播）\n\n'
                    + '现在开始第一步：调 council_review(step="plan", artifact=你的计划)。',
            }],
        },
        async execute(args, exec) {
            const task = String(args.task ?? '').trim();
            if (task === '') {
                throw new Error('task 不能为空');
            }
            const selected = selectParticipants(config, args.participants);
            const session = await bus.createSession({
                task,
                participants: selected.map(item => item.name),
                sessionId: args.session_id,
            }, { signal: exec?.signal });
            await bus.postMessage(session.session_id, {
                sender: 'deepseek',
                role: 'task',
                content: task,
                payload: { participants: selected.map(item => item.name) },
            }, { signal: exec?.signal });
            return {
                session_id: session.session_id,
                page_url: session.page_url,
                ws_path: session.ws_path,
                task,
                participants: selected.map(item => item.name),
            };
        },
    }));

    ctx.tools.register(safeTool({
        name: 'council_review',
        description: '把某一步的产物发进会议室，让外部异模型并行评审，'
            + `然后自动打开 ${windowSpan}人工窗口：人类可以在这几秒里点「打断」让循环停下来。`
            + '返回每个模型的 approve/revise 结论和人工结果。'
            + '有 revise 就改完再调一次；直到所有模型 approve 才能进入下一步。',
        parameters: {
            session_id: { type: 'string', required: true, description: 'council_start 返回的会话 ID。' },
            step: {
                type: 'string', required: true, enum: STEPS,
                description: '当前是四步里的哪一步。',
            },
            artifact: {
                type: 'string', required: true,
                description: '这一步你产出的内容：计划文本 / 代码 diff / 命令与输出 / 评价结论。',
            },
            focus: { type: 'string', description: '本次特别希望对方看的地方。' },
            participants: {
                type: 'array', items: { type: 'string' },
                description: '本次只叫这几个模型（默认全部）。',
            },
            human_window_ms: {
                type: 'number',
                description: `人工打断窗口时长，默认取配置（${config.humanWindowMs} 毫秒）。`,
            },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    session_id: { type: 'string', required: true },
                    step: { type: 'string', required: true },
                    round: { type: 'number', required: true },
                    artifact_seq: { type: 'number', required: true },
                    converged: { type: 'boolean', required: true },
                    blocking: { type: 'array', items: { type: 'string' }, required: true },
                    reviews: {
                        type: 'array', required: true,
                        items: {
                            type: 'object', additionalProperties: false,
                            properties: {
                                name: { type: 'string', required: true },
                                label: { type: 'string', required: true },
                                adapter: { type: 'string' },
                                verdict: { type: 'string', required: true },
                                summary: { type: 'string', required: true },
                                text: { type: 'string' },
                                error: { type: 'string' },
                                duration_ms: { type: 'number' },
                            },
                        },
                    },
                    human: {
                        type: 'object', required: true, additionalProperties: false,
                        properties: {
                            status: { type: 'string', required: true },
                            suggestion: { type: 'string' },
                            error: { type: 'string' },
                            window_ms: { type: 'number' },
                            notes: { type: 'array', items: { type: 'string' } },
                        },
                    },
                    page_url: { type: 'string', required: true },
                },
            },
            render: (args, value) => [{ type: 'text', text: renderReviewResult(value) }],
        },
        async execute(args, exec) {
            const sessionId = requireSessionId(args);
            const step = String(args.step ?? '').trim();
            if (!STEPS.includes(step)) {
                throw new Error(`step 必须是 ${STEPS.join('/')} 之一，收到 "${step}"`);
            }
            const rawArtifact = String(args.artifact ?? '');
            if (rawArtifact.trim() === '') {
                throw new Error('artifact 不能为空；把这一步的产物原文放进来。');
            }
            const artifact = clampText(rawArtifact);
            const signal = exec?.signal;

            const session = await bus.getSession(sessionId, { signal });
            const history = await bus.getMessages(sessionId, { after: 0 }, { signal });
            const round = (session.round_index ?? 0) + 1;

            // 1. 先把产物发进会议室（人类和其他模型都能立刻看到）
            const posted = await bus.postMessage(sessionId, {
                sender: 'deepseek',
                role: step,
                step,
                content: artifact.text,
                payload: { round, truncated: artifact.truncated },
            }, { signal });

            // 2. 外部模型并行评审。注意 transcript 已经在里面了，
            //    所以每个模型都能看到之前所有轮次别人说过什么。
            const participants = selectParticipants(config, args.participants);
            const transcript = formatTranscript(history.messages, {
                limit: config.transcriptLimit,
            });
            const reviews = await collectReviews({
                participants,
                task: session.task,
                step: STEP_LABELS[step] ?? step,
                artifact: artifact.text,
                transcript,
                focus: args.focus ?? '',
                round,
                systemPrompt: config.systemPrompt,
                timeoutMs: config.reviewTimeoutMs,
                fetchImpl: deps.fetchImpl,
                spawnImpl: deps.spawnImpl,
            });

            // 3. 每条评审都回帖到会议室（失败也回帖，不吞掉）
            for (const review of reviews) {
                await bus.postMessage(sessionId, {
                    sender: review.name,
                    role: 'review',
                    step,
                    content: review.text !== '' && review.text !== undefined
                        ? review.text
                        : `（调用失败：${review.error}）`,
                    payload: {
                        verdict: review.verdict,
                        adapter: review.adapter,
                        error: review.error,
                        duration_ms: review.duration_ms,
                        usage: review.usage,
                        round,
                    },
                }, { signal });
            }

            // 4. 3 秒人工窗口。
            //    窗口本身失败（总线抖了、工具被取消）**不能**把上面辛苦拿到的
            //    评审意见一起丢掉 —— 那些意见已经落进会议室了，必须照常返回。
            const usedWindowMs = Number(args.human_window_ms) > 0
                ? Number(args.human_window_ms)
                : config.humanWindowMs;
            let human;
            try {
                human = await openHumanWindow({
                    bus,
                    sessionId,
                    windowMs: usedWindowMs,
                    waitMs: config.humanWaitMs,
                    pollWindowMs: config.pollWindowMs,
                    targetSeq: posted.seq,
                    reason: `${STEP_LABELS[step] ?? step}这一步的模型意见已经出来了，`
                        + '需要打断就点下面的按钮。',
                    signal,
                    // 测试接缝：等待是循环长轮询，必须有可控时钟才能测
                    now: deps.now,
                });
            } catch (error) {
                human = {
                    status: 'aborted',
                    error: String(error?.message ?? error),
                    human_notes: [],
                };
            }

            const blocking = reviews
                .filter(review => review.verdict !== 'approve')
                .map(review => review.label);
            return {
                session_id: sessionId,
                step,
                round,
                artifact_seq: posted.seq,
                converged: reviews.length > 0 && blocking.length === 0,
                blocking,
                reviews: reviews.map(review => ({
                    name: review.name,
                    label: review.label,
                    adapter: review.adapter,
                    verdict: review.verdict,
                    summary: summarizeReview(review),
                    text: review.text ?? '',
                    error: review.error,
                    duration_ms: review.duration_ms,
                })),
                human: {
                    status: human.status,
                    suggestion: human.suggestion,
                    error: human.error,
                    window_ms: usedWindowMs,
                    notes: (human.human_notes ?? []).map(note => note.content),
                },
                page_url: bus.pageUrl(sessionId),
            };
        },
    }));

    ctx.tools.register(safeTool({
        name: 'council_status',
        description: '读回会议室里已经发生的事：任务、当前轮次、每个模型最近一次的结论，'
            + '以及完整的对话记录。用来在被打断之后重新掌握局面。',
        parameters: {
            session_id: { type: 'string', required: true, description: '会话 ID。' },
            limit: { type: 'number', description: '最多回放多少条消息（默认 40）。' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    session_id: { type: 'string', required: true },
                    task: { type: 'string' },
                    status: { type: 'string', required: true },
                    round_index: { type: 'number' },
                    latest_seq: { type: 'number' },
                    message_count: { type: 'number', required: true },
                    last_verdicts: {
                        type: 'array', items: {
                            type: 'object', additionalProperties: false,
                            properties: {
                                sender: { type: 'string', required: true },
                                verdict: { type: 'string' },
                            },
                        },
                    },
                    transcript: { type: 'string', required: true },
                    page_url: { type: 'string', required: true },
                },
            },
            render: (args, value) => [{
                type: 'text',
                text: `会议室 ${value.session_id}（${value.status}，第 `
                    + `${value.round_index ?? 0} 轮，共 ${value.message_count} 条消息）\n`
                    + `任务：${value.task || '(未记录)'}\n`
                    + `最近结论：${(value.last_verdicts ?? [])
                        .map(item => `${item.sender}=${item.verdict}`).join('、') || '(还没有)'}\n`
                    + `围观地址：${value.page_url}\n\n`
                    + `--- 会议记录 ---\n${value.transcript}`,
            }],
        },
        async execute(args, exec) {
            const sessionId = requireSessionId(args);
            const session = await bus.getSession(sessionId, { signal: exec?.signal });
            const history = await bus.getMessages(sessionId, { after: 0 }, { signal: exec?.signal });
            const messages = history.messages ?? [];
            const verdicts = messages
                .filter(item => item.role === 'review')
                .slice(-8)
                .map(item => ({
                    sender: item.sender,
                    verdict: item.payload?.verdict ?? 'unknown',
                }));
            const limit = Number(args.limit) > 0 ? Number(args.limit) : config.transcriptLimit;
            return {
                session_id: session.session_id,
                task: session.task,
                status: session.status,
                round_index: session.round_index,
                latest_seq: session.latest_seq,
                message_count: messages.length,
                last_verdicts: verdicts,
                transcript: formatTranscript(messages, {
                    limit,
                    maxTotalChars: 60_000,
                }),
                page_url: bus.pageUrl(sessionId),
            };
        },
    }));

    ctx.tools.register(safeTool({
        name: 'council_note',
        description: '往会议室里留一条你自己的消息（例如「我按 Kimi 的意见改了，'
            + '这是新的 diff」），会广播给人类和所有订阅者。'
            + '这不是送审，不会触发模型评审。',
        parameters: {
            session_id: { type: 'string', required: true, description: '会话 ID。' },
            content: { type: 'string', required: true, description: '要说的话。' },
            role: {
                type: 'string',
                description: '消息角色，默认 note；也可以用 coding/execute/evaluate 等。',
            },
            step: { type: 'string', description: '关联的步骤。' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    session_id: { type: 'string', required: true },
                    seq: { type: 'number', required: true },
                    role: { type: 'string' },
                },
            },
            render: (args, value) => [{
                type: 'text',
                text: `已广播到会议室 ${value.session_id}（#${value.seq}，role=${value.role}）。`,
            }],
        },
        async execute(args, exec) {
            const sessionId = requireSessionId(args);
            const content = String(args.content ?? '');
            if (content.trim() === '') {
                throw new Error('content 不能为空');
            }
            const message = await bus.postMessage(sessionId, {
                sender: 'deepseek',
                role: args.role ?? 'note',
                step: args.step ?? '',
                content,
            }, { signal: exec?.signal });
            return { session_id: sessionId, seq: message.seq, role: message.role };
        },
    }));

    ctx.tools.register(safeTool({
        name: 'council_finish',
        description: '结束这次 AI 会议室：写下最终结论，状态置为 finished，'
            + '并把结论广播给房间里的所有人。任务真正做完（或明确放弃）时才调用。',
        parameters: {
            session_id: { type: 'string', required: true, description: '会话 ID。' },
            conclusion: { type: 'string', required: true, description: '最终结论 / 交付说明。' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    session_id: { type: 'string', required: true },
                    status: { type: 'string', required: true },
                    conclusion: { type: 'string' },
                },
            },
            render: (args, value) => [{
                type: 'text',
                text: `会议室 ${value.session_id} 已结束（${value.status}）。\n结论：${value.conclusion}`,
            }],
        },
        async execute(args, exec) {
            const sessionId = requireSessionId(args);
            const conclusion = String(args.conclusion ?? '');
            if (conclusion.trim() === '') {
                throw new Error('conclusion 不能为空');
            }
            const result = await bus.finish(sessionId, { conclusion }, { signal: exec?.signal });
            return {
                session_id: sessionId,
                status: result.session?.status ?? 'finished',
                conclusion,
            };
        },
    }));

    return runtime;
}

/**
 * 把一次评审结果渲染成给模型看的文本。
 *
 * 刻意把「谁要改」「人类说了什么」放在最前面：这是 DeepSeek 接下来
 * 唯一需要立刻决策的信息。
 *
 * @param {object} value council_review 的返回值。
 * @returns {string} 文本。
 */
export function renderReviewResult(value) {
    const lines = [];
    lines.push(`会议室 ${value.session_id}｜${STEP_LABELS[value.step] ?? value.step}`
        + `｜第 ${value.round} 轮｜产物 #${value.artifact_seq}`);
    lines.push(value.converged
        ? '外部模型全部 approve。'
        : `还没有全部通过，需要改：${value.blocking.join('、') || '(见下)'}`);
    lines.push('');
    lines.push('--- 外部模型意见 ---');
    for (const review of value.reviews) {
        lines.push(`* ${review.summary}`);
        if (review.error) {
            lines.push(`  [调用失败] ${review.error}`);
            continue;
        }
        const body = String(review.text ?? '').trim();
        if (body !== '') {
            lines.push(body.split('\n').map(line => `  ${line}`).join('\n'));
        }
    }
    lines.push('');
    lines.push('--- 人工窗口 ---');
    const human = value.human ?? {};
    if (human.status === 'timeout') {
        const usedWindow = Number(value.human?.window_ms) > 0
            ? Math.round(value.human.window_ms / 1000) : null;
        lines.push(usedWindow === null
            ? '没有人打断，自动继续。'
            : `${usedWindow} 秒内没有人打断，自动继续。`);
    } else if (human.status === 'resumed') {
        lines.push('人类选择继续循环。');
    } else if (human.status === 'suggested') {
        lines.push('人类加入了建议（优先级高于上面所有模型意见）：');
        lines.push(`  ${human.suggestion}`);
    } else if (human.status === 'paused') {
        lines.push('人类按了打断但还没决定。**停下来**，在对话里把上面的局面讲清楚，'
            + '问他接下来怎么走，不要擅自继续。');
    } else if (human.status === 'aborted') {
        lines.push('人工窗口异常关闭，**没有拿到人工结论**'
            + (human.error ? `（${human.error}）` : '')
            + '。上面的模型意见已经记进会议室了；要不要继续往下走，'
            + '请先问一下用户，不要默认他同意了。');
    } else {
        lines.push(`人工窗口结果：${human.status}`);
    }
    for (const note of human.notes ?? []) {
        lines.push(`（人类在窗口里的留言：${note}）`);
    }
    lines.push('');
    lines.push(`人类围观地址：${value.page_url}`);
    return lines.join('\n');
}
