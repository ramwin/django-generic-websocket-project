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
            `没有找到 API key：请在配置里写 apiKey，或设置环境变量 `
            + `${participant.apiKeyEnv || 'ANTHROPIC_API_KEY'}`);
    }
    const payload = {
        model: participant.model,
        max_tokens: participant.maxTokens ?? 4096,
        messages: [{ role: 'user', content: prompt }],
    };
    if (systemPrompt !== '') {
        payload.system = systemPrompt;
    }
    const response = await doFetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': participant.anthropicVersion ?? '2023-06-01',
            ...(participant.headers ?? {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = { raw: text };
    }
    if (!response.ok) {
        const detail = data?.error?.message ?? text.slice(0, 300);
        throw new Error(`${participant.label ?? 'Claude'} 返回 HTTP ${response.status}：${detail}`);
    }
    const blocks = Array.isArray(data.content) ? data.content : [];
    const answer = blocks
        .filter(block => block?.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim();
    if (answer === '') {
        throw new Error(`${participant.label ?? 'Claude'} 返回了空内容：${text.slice(0, 200)}`);
    }
    return { text: answer, usage: data.usage ?? {}, raw: data };
}
