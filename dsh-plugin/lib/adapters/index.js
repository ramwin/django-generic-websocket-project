/**
 * 适配器注册表与并行评审。
 *
 * 关键设计：**单个评审模型失败不能拖垮整轮**。
 * 一个模型超时、没配 key、CLI 挂了，都会被收敛成一条
 * `verdict: 'error'` 的评审结果，连同失败原因一起回帖到会议室并交给
 * DeepSeek 决策 —— 而不是让整个工具调用抛异常。
 *
 * @module dsh-plugin-ai-council/adapters
 */

import { callClaudeApi } from './claude-api.js';
import { callKimiCli } from './kimi-cli.js';
import { callOpenAiApi } from './openai-api.js';
import { buildReviewPrompt, parseVerdict } from '../prompts.js';

/** 适配器实现表。 */
export const ADAPTERS = {
    'kimi-cli': callKimiCli,
    'claude-api': callClaudeApi,
    'openai-api': callOpenAiApi,
};

/**
 * 让一个参与者完成一次评审。
 *
 * @param {object} options 参数。
 * @returns {Promise<object>} 评审结果（永不抛出，失败收敛成 error 字段）。
 */
export async function reviewWithParticipant({
    participant,
    task = '',
    step = '',
    artifact = '',
    transcript = '',
    focus = '',
    round = 1,
    humanSuggestion = '',
    systemPrompt = '',
    timeoutMs = 180_000,
    fetchImpl,
    spawnImpl,
    env,
}) {
    const label = participant.label ?? participant.name;
    const startedAt = Date.now();
    const base = {
        name: participant.name,
        label,
        adapter: participant.adapter,
    };
    const implementation = ADAPTERS[participant.adapter];
    if (implementation === undefined) {
        return {
            ...base,
            verdict: 'error',
            text: '',
            error: `不认识的适配器 "${participant.adapter}"，可选：`
                + `${Object.keys(ADAPTERS).join(', ')}`,
            duration_ms: 0,
        };
    }
    const prompt = buildReviewPrompt({
        label,
        task,
        step,
        artifact,
        transcript,
        focus,
        round,
        humanSuggestion,
    });
    try {
        const result = await implementation({
            prompt,
            participant,
            timeoutMs,
            systemPrompt,
            fetchImpl,
            spawnImpl,
            env,
        });
        const text = String(result.text ?? '');
        return {
            ...base,
            verdict: parseVerdict(text),
            text,
            usage: result.usage ?? {},
            duration_ms: Date.now() - startedAt,
        };
    } catch (error) {
        return {
            ...base,
            verdict: 'error',
            text: '',
            error: error?.message ?? String(error),
            duration_ms: Date.now() - startedAt,
        };
    }
}

/**
 * 并行让所有参与者评审同一份产物。
 *
 * 并行意味着同一轮里它们看不到彼此**本轮**的意见（但能看到之前所有轮次
 * 的会议室记录）。想要它们互相迭代，就由 DeepSeek 再发起下一轮
 * council_review —— 这正是「循环到都满意」的实现方式。
 *
 * @param {object} options 参数。
 * @returns {Promise<object[]>} 评审结果数组，顺序与输入一致。
 */
export async function collectReviews(options) {
    const { participants, ...rest } = options;
    return Promise.all(participants.map(
        participant => reviewWithParticipant({ participant, ...rest })));
}
