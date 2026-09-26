/**
 * 配置解析的单元测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { homedir } from 'node:os';
import { join } from 'node:path';

import {
    DEFAULTS,
    expandHome,
    readApiKeyFile,
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

// ---------------------------------------------------------------- key 从文件读

const SHELL_RC = [
    '# 我的环境',
    'export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic',
    'export ANTHROPIC_AUTH_TOKEN=sk-from-file',
    'export OTHER=xxx',
].join('\n');

/** 假装读文件。 */
const reader = content => () => content;

test('readApiKeyFile：按变量名从 shell 片段里取值', () => {
    assert.equal(readApiKeyFile('~/rc', 'ANTHROPIC_AUTH_TOKEN', reader(SHELL_RC)),
        'sk-from-file');
    assert.equal(readApiKeyFile('~/rc', 'OTHER', reader(SHELL_RC)), 'xxx');
});

test('readApiKeyFile：容忍引号、空格、非 export 写法', () => {
    const content = '  ANTHROPIC_AUTH_TOKEN = "sk-quoted"  \n';
    assert.equal(readApiKeyFile('rc', 'ANTHROPIC_AUTH_TOKEN', reader(content)), 'sk-quoted');
    const single = "export ANTHROPIC_AUTH_TOKEN='sk-single'\n";
    assert.equal(readApiKeyFile('rc', 'ANTHROPIC_AUTH_TOKEN', reader(single)), 'sk-single');
});

test('readApiKeyFile：变量名找不到时返回空（不要退化成把整份文件当 key）', () => {
    assert.equal(readApiKeyFile('rc', 'NOT_THERE', reader(SHELL_RC)), '');
});

test('readApiKeyFile：不给变量名时，整份内容就是一个 key（Docker secret 风格）', () => {
    assert.equal(readApiKeyFile('secret', '', reader('sk-bare\n')), 'sk-bare');
    // 多行或含 = 的内容不是裸 key，宁可返回空也不要瞎猜
    assert.equal(readApiKeyFile('secret', '', reader('a\nb\n')), '');
    assert.equal(readApiKeyFile('secret', '', reader('A=1')), '');
});

test('readApiKeyFile：文件不存在或路径为空都不抛，返回空串', () => {
    const boom = () => { throw new Error('ENOENT'); };
    assert.equal(readApiKeyFile('/nope', 'X', boom), '');
    assert.equal(readApiKeyFile('', 'X', boom), '');
});

test('expandHome 展开开头的 ~', () => {
    const home = homedir();
    assert.equal(expandHome('~'), home);
    assert.equal(expandHome('~/a/b'), join(home, 'a/b'));
    assert.equal(expandHome('/abs/path'), '/abs/path');
    assert.equal(expandHome('relative'), 'relative');
});

test('resolveApiKey：优先级 显式 apiKey > apiKeyFile > 环境变量', () => {
    const participant = {
        apiKey: 'sk-explicit',
        apiKeyFile: '~/rc',
        apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN',
    };
    assert.equal(resolveApiKey(participant, { ANTHROPIC_AUTH_TOKEN: 'sk-env' },
        reader(SHELL_RC)), 'sk-explicit');

    const fromFile = { apiKey: '', apiKeyFile: '~/rc', apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN' };
    assert.equal(resolveApiKey(fromFile, { ANTHROPIC_AUTH_TOKEN: 'sk-env' },
        reader(SHELL_RC)), 'sk-from-file');

    // 文件里没有那个变量 -> 退回环境变量
    const fallback = { apiKeyFile: '~/rc', apiKeyEnv: 'NOT_THERE' };
    assert.equal(resolveApiKey(fallback, {}, reader(SHELL_RC)), '');

    // 没配文件就还是读环境变量
    assert.equal(resolveApiKey({ apiKeyEnv: 'K' }, { K: 'sk-env2' }), 'sk-env2');
});
