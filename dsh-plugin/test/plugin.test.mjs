/**
 * 插件与 DSH 的接缝测试。
 *
 * 这一层没法真的安装到 DSH 里跑（那需要用户在 profile 目录执行
 * `dsh plugin add` 并重启），但可以把真实的 cordis 配置喂给真实的
 * Config schema、用假的 ctx 调真实的 apply —— 足以覆盖「插件能不能被
 * 装载、工具名对不对、提示词段有没有注入」这些会在重启时才暴露的问题。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import yaml from 'js-yaml';

import { Config, apply, inject, name } from '../lib/index.js';
import { COUNCIL_TOOL_NAMES } from '../lib/usage.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');

/** 读出真实的 cordis.patch.yml 里本插件的 config。 */
function shippedConfig() {
    const raw = yaml.load(readFileSync(join(pluginRoot, 'cordis.patch.yml'), 'utf8'));
    assert.ok(Array.isArray(raw), 'cordis.patch.yml 应该是一个 patch 数组');
    const insert = raw[0]?.insert;
    assert.ok(Array.isArray(insert), '第一个 patch 应该有 insert 列表');
    const entry = insert.find(item => item.id === 'ai-council');
    assert.ok(entry !== undefined, 'cordis.patch.yml 里应该有 id=ai-council 的条目');
    assert.equal(entry.name, 'dsh-plugin-ai-council', 'patch 里的包名要与 package.json 一致');
    return entry.config ?? {};
}

function makeCtx() {
    const registered = [];
    const sections = [];
    return {
        ctx: {
            tools: { register: tool => registered.push(tool) },
            systemPrompt: { section: section => sections.push(section) },
        },
        registered,
        sections,
    };
}

test('插件的 name / inject 与 patch 的 id 一致', () => {
    assert.equal(name, 'ai-council');
    assert.deepEqual(inject, ['tools', 'systemPrompt']);
});

test('package.json 的 dsh.bundle.patch 指向真实存在的文件', () => {
    const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'dsh-plugin-ai-council');
    assert.equal(pkg.main, 'lib/index.js');
    assert.equal(pkg.type, 'module');
    assert.ok(pkg.dsh?.bundle?.patch, 'package.json 里缺少 dsh.bundle.patch');
    // 能读到就说明路径没写错
    assert.ok(readFileSync(join(pluginRoot, pkg.dsh.bundle.patch), 'utf8').length > 0);
});

test('随包发布的 cordis.patch.yml 能通过 Config 校验', () => {
    const config = shippedConfig();
    const validated = Config(config);
    assert.equal(validated.busUrl, 'http://127.0.0.1:7420');
    assert.equal(validated.humanWindowMs, 3000, '默认就是 3 秒');
    assert.equal(validated.participants.kimi.adapter, 'kimi-cli');
    assert.equal(validated.participants.claude.adapter, 'claude-api');
});

test('Config 会挡住写错的类型', () => {
    assert.throws(() => Config({ humanWindowMs: 'three seconds' }));
    assert.throws(() => Config({ participants: { kimi: { adapter: 123 } } }));
});

test('apply 注册全部工具并注入一段提示词说明', () => {
    const config = Config(shippedConfig());
    const { ctx, registered, sections } = makeCtx();
    const runtime = apply(ctx, config);

    assert.deepEqual(registered.map(tool => tool.name).sort(), [...COUNCIL_TOOL_NAMES].sort());
    assert.equal(registered.length, 5);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].name, 'ai-council:usage');
    assert.equal(sections[0].order, config.promptSectionOrder);
    assert.equal(typeof sections[0].text, 'function');
    assert.ok(runtime.bus !== undefined, 'apply 应该返回运行期句柄');
});

test('提示词段写清了「什么时候用」和「3 秒窗口怎么处理」', () => {
    const { ctx, sections } = makeCtx();
    apply(ctx, Config(shippedConfig()));
    const text = sections[0].text({});
    // 唤醒条件
    assert.match(text, /AI 审批/);
    assert.match(text, /人工审批/);
    // 固定工作流
    assert.match(text, /计划 → 编码 → 执行 → 评价/);
    // 四种人工结果都要有交代
    for (const status of ['timeout', 'resumed', 'suggested', 'paused']) {
        assert.match(text, new RegExp(status), `提示词里缺少 ${status} 的说明`);
    }
    // 只让 DeepSeek 改文件这条边界
    assert.match(text, /只有你改文件/);
    // 工具名要列出来
    for (const toolName of COUNCIL_TOOL_NAMES) {
        assert.match(text, new RegExp(toolName));
    }
    // 参与者名字要带上
    assert.match(text, /Kimi/);
    assert.match(text, /Claude/);
    // 连不上时要知道怎么办
    assert.match(text, /runserver 7420/);
});

test('apply 在没有用户配置时也能挂载（全部走默认值）', () => {
    const { ctx, registered, sections } = makeCtx();
    apply(ctx, {});
    assert.equal(registered.length, 5);
    assert.match(sections[0].text({}), /Kimi/);
});
