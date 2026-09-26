/**
 * Claude 适配器（Anthropic Messages API）。
 *
 * 这是**对外暴露的接口**：`baseUrl` / `apiKeyEnv` / `model` 全都可以替换，
 * 别人要接自己的中转或别的模型，只改配置即可，不用动代码。
 * 所以本机这份 claude 当前指向哪儿，对插件没有影响。
 *
 * 走纯 HTTP，没有文件系统访问 —— 评审模型物理上不可能改到代码。
 *
 * @module dsh-plugin-ai-council/adapters/claude-api
 */

import { resolveApiKey } from '../config.js';

/** 拼出 messages 端点，兼容 baseUrl 已经带 /v1 的情况。 */
export function messagesEndpoint(baseUrl) {
    const base = String(baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

/**
 * 按配置挑一种鉴权头。
 *
 * Anthropic 官方用 `x-api-key`，但很多中转（以及 Claude Code 自己配的
 * `ANTHROPIC_AUTH_TOKEN`）用的是 `Authorization: Bearer`。两种都得支持，
 * 否则接上中转会被判成「没配 key」。
 *
 * @param {object} participant 参与者配置。
 * @param {string} apiKey 已解析出的 key。
 * @returns {Record<string,string>} 请求头片段。
 */
export function authHeaders(participant, apiKey) {
    return (participant.authStyle ?? 'api-key') === 'bearer'
        ? { Authorization: `Bearer ${apiKey}` }
        : { 'x-api-key': apiKey };
}

/**
 * 调用 Anthropic Messages API。
 *
 * @param {object} options 调用参数。
 * @param {string} options.prompt 提示词。
 * @param {object} options.participant 参与者配置。
 * @param {number} [options.timeoutMs] 超时。
 * @param {object} [options.systemPrompt] system 提示。
 * @param {typeof fetch} [options.fetchImpl] 便于测试注入。
 * @param {Record<string,string|undefined>} [options.env] 便于测试注入。
 * @returns {Promise<{text: string, usage: object, raw: object}>} 结果。
 */
export async function callClaudeApi({
    prompt,
    participant,
    timeoutMs = 180_000,
    systemPrompt = '',
    fetchImpl,
    env = process.env,
}) {
    const doFetch = fetchImpl ?? globalThis.fetch;
    const url = messagesEndpoint(participant.baseUrl);
    const apiKey = resolveApiKey(participant, env);
    if (apiKey === '') {
        throw new Error(
            '没有找到 API key：请在配置里写 apiKey、用 apiKeyFile 指向一个'
            + '含该变量的文件（ssh 的 bashrc 片段也行），或设置环境变量 '
            + `${participant.apiKeyEnv || 'ANTHROPIC_API_KEY'}`);
    }

    const headers = {
        'Content-Type': 'application/json',
        ...authHeaders(participant, apiKey),
        'anthropic-version': participant.anthropicVersion ?? '2023-06-01',
        ...(participant.headers ?? {}),
    };

    /** 发一次请求。`thinkingOverride` 用来做「关掉思考再试一次」。 */
    const send = async thinkingOverride => {
        const payload = {
            model: participant.model,
            max_tokens: participant.maxTokens ?? 8192,
            messages: [{ role: 'user', content: prompt }],
        };
        if (systemPrompt !== '') {
            payload.system = systemPrompt;
        }
        const thinking = thinkingConfig(participant, thinkingOverride);
        if (thinking !== undefined) {
            payload.thinking = thinking;
        }
        const response = await doFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const raw = await response.text();
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            parsed = { raw };
        }
        if (!response.ok) {
            const detail = parsed?.error?.message ?? raw.slice(0, 300);
            throw new Error(
                `${participant.label ?? 'Claude'} 返回 HTTP ${response.status}：${detail}`);
        }
        const blocks = Array.isArray(parsed.content) ? parsed.content : [];
        const answer = blocks
            .filter(block => block?.type === 'text')
            .map(block => block.text)
            .join('\n')
            .trim();
        return {
            answer,
            data: parsed,
            hasThinking: blocks.some(block => block?.type === 'thinking'),
        };
    };

    let result = await send(undefined);
    if (result.answer === '' && result.hasThinking) {
        // 只有 thinking、没有正文：输出预算被思考过程吃完了 —— 而且这个行为
        // **不确定**（实测同一个 max_tokens 有时出正文、有时全花在思考上）。
        // 与其调大预算（实测反而更糟：预算越大它想得越久，照样不出正文），
        // 不如直接关掉思考重试一次。评审要的是可靠拿到结论。
        result = await send('disabled');
    }
    if (result.answer === '') {
        if (result.hasThinking) {
            throw new Error(
                `${participant.label ?? 'Claude'} 即使关掉 thinking 仍然只返回思考、没有正文`
                + `（max_tokens=${participant.maxTokens ?? 8192}）。请调大 maxTokens。`);
        }
        throw new Error(
            `${participant.label ?? 'Claude'} 返回了空内容：`
            + `${JSON.stringify(result.data).slice(0, 200)}`);
    }
    return { text: result.answer, usage: result.data.usage ?? {}, raw: result.data };
}

/**
 * 把参与者的 thinking 配置翻译成请求体里的 `thinking` 字段。
 *
 * - `auto`（默认）：不传，由模型/端点自己决定。
 * - `disabled`：显式关掉。对「开了思考就爱把预算用完」的模型最可靠，也最省。
 * - `budget`：开思考但设上限（`thinkingBudgetTokens`，默认 2048）。
 *
 * 注意 YAML 里 `off`/`on` 会被解析成布尔值，所以取值用 `disabled` 而不是 `off`。
 *
 * @param {object} participant 参与者配置。
 * @param {string} [override] 临时覆盖模式。
 * @returns {object|undefined} 请求体片段。
 */
export function thinkingConfig(participant, override) {
    const mode = override ?? participant.thinking ?? 'auto';
    if (mode === 'disabled') {
        return { type: 'disabled' };
    }
    if (mode === 'budget') {
        return {
            type: 'enabled',
            budget_tokens: participant.thinkingBudgetTokens ?? 2048,
        };
    }
    return undefined;
}
