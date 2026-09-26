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
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

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
    const config = Config(shippedConfig());
    apply(ctx, config);
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
    // 已启用的参与者都要在提示词里露脸。
    // 刻意按配置里的 label 断言、而不是写死模型名 —— 换个中转或换个模型
    // 只是改配置，不该让测试红掉（真红过一次，就是改 claude 指向 DeepSeek 那次）。
    const enabled = Object.values(config.participants ?? {})
        .filter(participant => participant?.enabled !== false);
    assert.ok(enabled.length > 0, '至少应有一个默认启用的参与者');
    for (const participant of enabled) {
        assert.ok(text.includes(participant.label),
            `提示词里缺少参与者「${participant.label}」`);
    }
    // 连不上时要知道怎么办
    assert.match(text, /runserver 7420/);
});

test('apply 在没有用户配置时也能挂载（全部走默认值）', () => {
    const { ctx, registered, sections } = makeCtx();
    apply(ctx, {});
    assert.equal(registered.length, 5);
    assert.match(sections[0].text({}), /Kimi/);
});

test('lib/ 下的源码全部入库了（防止被 .gitignore 静默吃掉）', () => {
    // 真实踩过的坑：仓库 .gitignore（以及全局 excludesFile）里的 `lib/` 是给
    // Python 打包用的，却把 dsh-plugin/lib/ 整个吃掉了 —— commit 里的插件
    // 一行代码都没有，而本地测试全绿（工作区里文件还在）。别人 clone 下来
    // 会装出一个空壳。这条测试专门钉它。
    let repoRoot;
    try {
        repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'],
            { cwd: pluginRoot }).toString().trim();
    } catch {
        return; // 不在 git 工作区里（比如从 tarball 解出来的），跳过
    }
    // 只有从仓库里的规范位置运行时才检查，避免在别处的副本上误报
    if (resolve(repoRoot, 'dsh-plugin') !== resolve(pluginRoot)) {
        return;
    }

    const tracked = execFileSync('git', ['ls-files', 'dsh-plugin/lib'],
        { cwd: repoRoot }).toString().trim().split('\n').filter(Boolean);

    const onDisk = [];
    const walk = relative => {
        for (const entry of readdirSync(join(pluginRoot, relative), { withFileTypes: true })) {
            const child = `${relative}/${entry.name}`;
            if (entry.isDirectory()) {
                walk(child);
            } else {
                onDisk.push(`dsh-plugin/${child}`);
            }
        }
    };
    walk('lib');

    assert.ok(onDisk.length > 0, 'lib/ 下应该有源码');
    assert.deepEqual(
        tracked.sort(),
        onDisk.sort(),
        'dsh-plugin/lib 下有文件没入库 —— 别人 clone 下来的插件会缺代码');
});
