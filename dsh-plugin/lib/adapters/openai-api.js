/**
 * OpenAI 兼容适配器（/chat/completions）。
 *
 * 覆盖面最广的一条：Moonshot 开放平台、智谱 GLM、通义 Qwen、DeepSeek、
 * 以及各种 OpenAI 兼容中转，都是同一个协议。想再加一个异模型校验者，
 * 通常只要在 participants 里加一段配置，不用写代码。
 *
 * @module dsh-plugin-ai-council/adapters/openai-api
 */

import { resolveApiKey } from '../config.js';

/** 拼出 chat/completions 端点，兼容 baseUrl 已经带 /v1 的情况。 */
export function chatEndpoint(baseUrl) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    if (base === '') {
        throw new Error('openai-api 适配器需要配置 baseUrl');
    }
    return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

/**
 * 调用 OpenAI 兼容的 chat/completions。
 *
 * @param {object} options 调用参数。
 * @param {string} options.prompt 提示词。
 * @param {object} options.participant 参与者配置。
 * @param {number} [options.timeoutMs] 超时。
 * @param {string} [options.systemPrompt] system 提示。
 * @param {typeof fetch} [options.fetchImpl] 便于测试注入。
 * @param {Record<string,string|undefined>} [options.env] 便于测试注入。
 * @returns {Promise<{text: string, usage: object, raw: object}>} 结果。
 */
export async function callOpenAiApi({
    prompt,
    participant,
    timeoutMs = 180_000,
    systemPrompt = '',
    fetchImpl,
    env = process.env,
}) {
    const doFetch = fetchImpl ?? globalThis.fetch;
    const url = chatEndpoint(participant.baseUrl);
    const apiKey = resolveApiKey(participant, env);
    if (apiKey === '') {
        throw new Error(
            '没有找到 API key：请在配置里写 apiKey、用 apiKeyFile 指向一个'
            + '含该变量的文件，或设置环境变量 '
            + `${participant.apiKeyEnv || '(未指定 apiKeyEnv)'}`);
    }
    const messages = [];
    if (systemPrompt !== '') {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await doFetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...(participant.headers ?? {}),
        },
        body: JSON.stringify({
            model: participant.model,
            messages,
            max_tokens: participant.maxTokens ?? 4096,
        }),
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
        throw new Error(`${participant.label ?? 'OpenAI 兼容模型'} 返回 HTTP ${response.status}：${detail}`);
    }
    const answer = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (answer === '') {
        throw new Error(`${participant.label ?? 'OpenAI 兼容模型'} 返回了空内容：${text.slice(0, 200)}`);
    }
    return { text: answer, usage: data.usage ?? {}, raw: data };
}
