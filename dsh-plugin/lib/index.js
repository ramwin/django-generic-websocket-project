/**
 * AI Council —— DeepSeek Harness 插件入口。
 *
 * 它把三件事缝在一起：
 *
 *   1. **DeepSeek（你）** 负责计划 / 编码 / 执行 / 评价，并且是唯一改文件的人；
 *   2. **外部异模型**（Kimi、Claude…）在每一步给出评审，可以要求返工；
 *   3. **人类** 通过 3 秒打断窗口随时插手，选择继续、或者注入自己的建议。
 *
 * 三方的所有发言都通过 django-generic-websocket-project 的 HTTP + WebSocket
 * 广播落进同一个房间，所以那是个真正共享的通道，而不是两两私聊。
 *
 * 那个 Django 项目**不依赖本插件**，可以脱离 DSH 单独部署；
 * 本插件也只通过它的公开 HTTP 接口说话。
 *
 * 安装：`dsh plugin --profile <name> add <本目录>`，然后重启 dsh。
 *
 * @module dsh-plugin-ai-council
 */

import z from '@deepseek-ai/schemastery';

import { resolveConfig } from './config.js';
import { registerCouncilTools } from './tools.js';
import { COUNCIL_TOOL_NAMES, usageSectionText } from './usage.js';

/** cordis 插件名，必须与 cordis.patch.yml 里的 id 一致。 */
export const name = 'ai-council';

/** 依赖的服务。 */
export const inject = ['tools', 'systemPrompt'];

/** 单个参与者的配置。所有字段都可选，按适配器取用。 */
const participantConfig = z.object({
    enabled: z.boolean(),
    adapter: z.string(),
    label: z.string(),
    // kimi-cli
    command: z.string(),
    args: z.array(z.string()),
    outputFormat: z.string(),
    homeDir: z.string(),
    cwd: z.string(),
    env: z.dict(z.string()),
    // claude-api / openai-api
    baseUrl: z.string(),
    apiKey: z.string(),
    apiKeyEnv: z.string(),
    apiKeyFile: z.string(),
    authStyle: z.string(),
    thinking: z.string(),
    thinkingBudgetTokens: z.natural(),
    model: z.string(),
    maxTokens: z.natural(),
    anthropicVersion: z.string(),
    headers: z.dict(z.string()),
});

/** 插件配置。 */
export const Config = z.object({
    busUrl: z.string().default('http://127.0.0.1:7420'),
    humanWindowMs: z.natural().default(3000),
    humanWaitMs: z.natural().default(600_000),
    pollWindowMs: z.natural().default(55_000),
    reviewTimeoutMs: z.natural().default(180_000),
    requestTimeoutMs: z.natural().default(30_000),
    promptSectionOrder: z.natural().default(118),
    transcriptLimit: z.natural().default(40),
    systemPrompt: z.string(),
    participants: z.dict(participantConfig),
});

/**
 * 挂载插件。
 *
 * @param {object} ctx cordis 上下文。
 * @param {object} config 由 Config 校验后的配置。
 */
export function apply(ctx, config) {
    const resolved = resolveConfig(config ?? {});
    const runtime = registerCouncilTools(ctx, resolved);

    const enabled = Object.values(resolved.participants)
        .filter(item => item.enabled !== false)
        .map(item => item.label ?? item.name);

    ctx.systemPrompt.section({
        name: 'ai-council:usage',
        order: resolved.promptSectionOrder,
        text: () => usageSectionText({
            toolNames: COUNCIL_TOOL_NAMES,
            participants: enabled,
            pageHint: '会议室服务默认地址是 '
                + `${resolved.busUrl}（django-generic-websocket-project）。`
                + '如果工具报「连不上」，先提醒用户把这个服务起起来：'
                + '`python manage.py runserver 7420`，或者用仓库里的 '
                + 'docker / supervisor 部署方式。',
        }),
    });

    return runtime;
}

export { resolveConfig } from './config.js';
export { CouncilBus } from './council-client.js';
export { openHumanWindow, pickHumanAction } from './human-window.js';
export { ADAPTERS, collectReviews, reviewWithParticipant } from './adapters/index.js';
export { buildReviewPrompt, formatTranscript, parseVerdict } from './prompts.js';
