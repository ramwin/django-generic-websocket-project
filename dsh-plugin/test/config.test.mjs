/**
 * 配置解析的单元测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULTS,
    resolveApiKey,
    resolveConfig,
    selectParticipants,
} from '../lib/config.js';

test('默认就带上了 kimi 和 claude 两个异模型', () => {
    const config = resolveConfig({});
    assert.deepEqual(Object.keys(config.participants).sort(), ['claude', 'kimi']);
    assert.equal(config.participants.kimi.adapter, 'kimi-cli');
    assert.equal(config.participants.claude.adapter, 'claude-api');
    assert.equal(config.humanWindowMs, 3000);
});

test('用户配置逐字段覆盖默认值', () => {
    const config = resolveConfig({
        busUrl: 'http://example.com:9000/',
        humanWindowMs: 7000,
        participants: {
            claude: { model: 'claude-opus-4-1', baseUrl: 'https://relay.internal' },
        },
    });
    assert.equal(config.busUrl, 'http://example.com:9000', '尾部斜杠应被去掉');
    assert.equal(config.humanWindowMs, 7000);
    // 覆盖的字段生效
    assert.equal(config.participants.claude.model, 'claude-opus-4-1');
    assert.equal(config.participants.claude.baseUrl, 'https://relay.internal');
    // 没覆盖的字段保留默认
    assert.equal(config.participants.claude.apiKeyEnv, 'ANTHROPIC_API_KEY');
    assert.equal(config.participants.claude.adapter, 'claude-api');
});

test('可以加一个全新的 OpenAI 兼容参与者（不改代码）', () => {
    const config = resolveConfig({
        participants: {
            glm: {
                adapter: 'openai-api',
                label: 'GLM',
                baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
                apiKeyEnv: 'ZHIPU_API_KEY',
                model: 'glm-4.6',
            },
        },
    });
    assert.equal(config.participants.glm.adapter, 'openai-api');
    assert.equal(config.participants.glm.model, 'glm-4.6');
    // 默认的两个还在
    assert.equal(config.participants.kimi.adapter, 'kimi-cli');
});

test('enabled: false 的参与者默认不参与', () => {
    const config = resolveConfig({
        participants: { claude: { enabled: false } },
    });
    const names = selectParticipants(config).map(item => item.name);
    assert.deepEqual(names, ['kimi']);
    // 但显式点名还是能叫上它
    const forced = selectParticipants(config, ['claude']).map(item => item.name);
    assert.deepEqual(forced, ['claude']);
});

test('点名一个没配置过的参与者要报错，并列出可选项', () => {
    const config = resolveConfig({});
    assert.throws(
        () => selectParticipants(config, ['gpt5']),
        /未配置的参与者：gpt5.*kimi.*claude/s);
});

test('非法的窗口时长回落到默认值，而不是变成 NaN', () => {
    const config = resolveConfig({ humanWindowMs: 'abc', humanWaitMs: -5 });
    assert.equal(config.humanWindowMs, DEFAULTS.humanWindowMs);
    assert.equal(config.humanWaitMs, DEFAULTS.humanWaitMs);
});

test('解析 API key：显式写的优先于环境变量', () => {
    const env = { ANTHROPIC_API_KEY: 'from-env' };
    assert.equal(
        resolveApiKey({ apiKey: 'explicit', apiKeyEnv: 'ANTHROPIC_API_KEY' }, env),
        'explicit');
    assert.equal(
        resolveApiKey({ apiKey: '  ', apiKeyEnv: 'ANTHROPIC_API_KEY' }, env),
        'from-env');
    assert.equal(resolveApiKey({ apiKeyEnv: 'MISSING' }, env), '');
});
