#!/usr/bin/env node
/**
 * AI Council 的端到端演示 / 冒烟脚本。
 *
 * 它**不经过 DSH**，直接用插件自己的库代码 + 真实的
 * django-generic-websocket-project 服务 + 真实的 kimi CLI 跑一遍，
 * 用来证明这条链路真的通：
 *
 *   1. 「3 秒人工打断窗口」的三种结局（自动通过 / 注入建议 / 暂停）
 *      —— 这里是真的在等 3 秒墙钟时间；
 *   2. 真实异模型评审：把一份计划交给 Kimi，拿回它的 VERDICT；
 *   3. 在真实 AI 评审之后触发人工打断，验证窗口和 AI 调用能拼在一起。
 *
 * 用法（先起 Django 服务）：
 *
 *   ALLOWED_HOSTS='localhost;127.0.0.1' python manage.py runserver 7420
 *   node dsh-plugin/scripts/e2e-demo.mjs --bus-url http://127.0.0.1:7420
 *
 * 沙箱里跑 kimi CLI 需要把它的家目录指到可写位置：
 *   node dsh-plugin/scripts/e2e-demo.mjs --kimi-home "$PWD/.kimi-home"
 *
 * 只想验窗口语义、不调模型：加 --skip-ai。
 */

import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CouncilBus } from '../lib/council-client.js';
import { resolveConfig } from '../lib/config.js';
import { openHumanWindow } from '../lib/human-window.js';
import { registerCouncilTools } from '../lib/tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const report = { passed: [], failed: [] };

function check(label, ok, detail = '') {
    if (ok) {
        report.passed.push(label);
        console.log(`  ${GREEN}PASS${RESET}  ${label}`);
    } else {
        report.failed.push({ label, detail });
        console.log(`  ${RED}FAIL${RESET}  ${label}${detail ? `\n         ${detail}` : ''}`);
    }
    return ok;
}

function section(title) {
    console.log(`\n${BOLD}${title}${RESET}`);
}

/**
 * 在后台盯着会议室，一旦出现「人工窗口开启」就模拟人类操作。
 *
 * 这是为了在真实 AI 评审（耗时几十秒）之后精确踩在窗口上。
 */
async function simulateHuman(bus, sessionId, { delayMs = 800, kind = 'suggest', content = '' } = {}) {
    let cursor = 0;
    for (;;) {
        let batch;
        try {
            batch = await bus.getMessages(sessionId, { after: cursor });
        } catch {
            return;
        }
        for (const message of batch.messages ?? []) {
            cursor = Math.max(cursor, message.seq);
            if (message.role !== 'human_window_open') {
                continue;
            }
            await sleep(delayMs);
            await bus.humanAction(sessionId, { kind: 'interrupt' });
            await sleep(300);
            if (kind === 'suggest') {
                await bus.humanAction(sessionId, { kind: 'suggest', content });
            }
            return;
        }
        await sleep(300);
    }
}

// ------------------------------------------------------------ 第一部分

async function demoWindowSemantics(bus) {
    section('1. 3 秒人工打断窗口的三种结局（真实墙钟时间）');
    const session = await bus.createSession({
        task: '窗口语义演示',
        participants: [],
    });
    const id = session.session_id;
    console.log(`${DIM}   会话 ${id}｜页面 ${session.page_url}${RESET}`);

    // ---- 结局一：没人打断 ----
    let startedAt = Date.now();
    const timeout = await openHumanWindow({ bus, sessionId: id, windowMs: 3000 });
    const elapsed = Date.now() - startedAt;
    check('没人打断：3 秒后自动继续（status=timeout）',
        timeout.status === 'timeout', `实际 status=${timeout.status}`);
    check('确实是等满了 3 秒才放行',
        elapsed >= 2900 && elapsed < 5000, `实际耗时 ${elapsed}ms`);
    console.log(`${DIM}   实际耗时 ${elapsed}ms${RESET}`);

    // ---- 结局二：打断后注入建议 ----
    setTimeout(() => { bus.humanAction(id, { kind: 'interrupt' }); }, 600);
    setTimeout(() => {
        bus.humanAction(id, { kind: 'suggest', content: '先把 Redis 多实例也测一遍' });
    }, 1800);
    startedAt = Date.now();
    const suggested = await openHumanWindow({ bus, sessionId: id, windowMs: 3000 });
    check('打断后注入建议：status=suggested 且带出建议正文',
        suggested.status === 'suggested'
        && suggested.suggestion === '先把 Redis 多实例也测一遍',
        JSON.stringify(suggested));
    check('打断能提前结束等待（不等满 3 秒）',
        Date.now() - startedAt < 3000, `实际耗时 ${Date.now() - startedAt}ms`);

    // ---- 结局三：打断后一直不决定 ----
    setTimeout(() => { bus.humanAction(id, { kind: 'interrupt' }); }, 400);
    const paused = await openHumanWindow({
        bus, sessionId: id, windowMs: 3000, waitMs: 2000,
    });
    check('打断后不决定：status=paused（把控制权交回 DeepSeek）',
        paused.status === 'paused', JSON.stringify(paused));

    // ---- 房间里的记录 ----
    const history = await bus.getMessages(id, { after: 0 });
    const windows = history.messages.filter(item => item.role === 'human_window_open');
    const closes = history.messages.filter(item => item.role === 'human_window_close');
    check('每次窗口的开与关都留在同一个房间的记录里',
        windows.length === 3 && closes.length === 3,
        `open=${windows.length} close=${closes.length}`);
    console.log(`${DIM}   房间共 ${history.messages.length} 条广播${RESET}`);
    return id;
}

// ------------------------------------------------------------ 第二部分

const DEMO_TASK = '给 django-generic-websocket-project 的 MyAuthMiddleware 加上真实用户鉴权';
const DEMO_PLAN = `## 计划

1. 在 project/asgi.py 里把 MyAuthMiddleware.get_user() 改成查数据库：
   从 Authorization header 或 ?token= 取 token，去 auth_token 表里查用户。
2. 新增 generic/models.py 的 AuthToken 模型（user FK + key + 过期时间）。
3. 写迁移，并在 ChatConsumer.need_auth 置 True 时用 3000 关闭码拒绝未认证连接。
4. 补测试：未带 token / 带过期 token / 带合法 token 三种情况。

风险点：现在 MessageView.post 完全没有鉴权，任何人都能往任意房间广播。`;

async function demoRealReview(bus, { kimiHome, interrupt }) {
    section('2. 真实异模型评审（Kimi CLI）');
    const config = resolveConfig({
        busUrl: bus.baseUrl,
        humanWindowMs: 3000,
        humanWaitMs: 120000,
        participants: {
            kimi: kimiHome ? { homeDir: kimiHome } : {},
            claude: { enabled: false },
        },
    });
    const tools = {};
    const ctx = {
        tools: { register: tool => { tools[tool.name] = tool; } },
        systemPrompt: { section: () => {} },
    };
    registerCouncilTools(ctx, config, { bus });

    const started = await tools.council_start.execute({ task: DEMO_TASK }, {});
    console.log(`${DIM}   评审者：${started.participants.join('、')}${RESET}`);
    console.log(`${DIM}   页面：${started.page_url}${RESET}`);

    if (interrupt) {
        console.log(`${DIM}   已安排：等窗口一开就模拟人类打断并注入建议${RESET}`);
        simulateHuman(bus, started.session_id, {
            delayMs: 700,
            kind: 'suggest',
            content: '（人类建议）别忘了一并修 MessageView.post 的裸奔问题',
        });
    }

    console.log(`${DIM}   正在等 Kimi 评审，可能要几十秒…${RESET}`);
    const startedAt = Date.now();
    const result = await tools.council_review.execute({
        session_id: started.session_id,
        step: 'plan',
        artifact: DEMO_PLAN,
    }, {});
    console.log(`${DIM}   评审耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒${RESET}`);

    const kimi = result.reviews.find(item => item.name === 'kimi');
    check('Kimi 真的返回了评审内容',
        kimi !== undefined && kimi.verdict !== 'error' && kimi.text.length > 20,
        kimi?.error ?? '(无)');
    check('Kimi 的结论能被解析成 approve/revise',
        ['approve', 'revise'].includes(kimi?.verdict), `verdict=${kimi?.verdict}`);

    console.log(`\n${BOLD}--- Kimi 的评审（原文） ---${RESET}`);
    console.log(kimi?.text ?? '(空)');
    console.log(`${BOLD}--- 评审结束 ---${RESET}\n`);

    check('converged 与 blocking 和实际结论一致',
        result.converged === (result.blocking.length === 0),
        `converged=${result.converged} blocking=${JSON.stringify(result.blocking)}`);

    if (interrupt) {
        check('真实评审之后的人工打断被正确识别',
            result.human.status === 'suggested',
            `human.status=${result.human.status}`);
        check('人类建议原文透传给了 DeepSeek',
            (result.human.suggestion ?? '').includes('MessageView.post'),
            result.human.suggestion ?? '(空)');
    } else {
        check('没人打断时窗口正常超时',
            result.human.status === 'timeout', `human.status=${result.human.status}`);
    }

    const status = await tools.council_status.execute({ session_id: started.session_id }, {});
    check('会议室里留下了完整记录（任务/计划/评审/窗口）',
        status.message_count >= 5, `message_count=${status.message_count}`);

    await tools.council_finish.execute({
        session_id: started.session_id,
        conclusion: `演示结束。Kimi 结论：${kimi?.verdict}`,
    });
    return started.session_id;
}

// ------------------------------------------------------------ main

async function main() {
    const { values } = parseArgs({
        options: {
            'bus-url': { type: 'string', default: 'http://127.0.0.1:7420' },
            'kimi-home': { type: 'string', default: '' },
            'skip-ai': { type: 'boolean', default: false },
            interrupt: { type: 'boolean', default: false },
        },
    });

    const bus = new CouncilBus({ busUrl: values['bus-url'] });
    console.log(`${BOLD}AI Council 端到端演示${RESET}`);
    console.log(`${DIM}   会议室服务：${bus.apiRoot}${RESET}`);

    // 先确认服务活着，否则报错信息会更难懂
    try {
        await bus.createSession({ task: '连通性自检', participants: [] });
    } catch (error) {
        console.log(`\n${RED}连不上会议室服务：${error.message}${RESET}`);
        process.exit(1);
    }

    await demoWindowSemantics(bus);
    if (values['skip-ai']) {
        console.log(`\n${DIM}   （--skip-ai：跳过真实模型评审）${RESET}`);
    } else {
        await demoRealReview(bus, {
            kimiHome: values['kimi-home'] !== '' ? values['kimi-home'] : undefined,
            interrupt: values.interrupt,
        });
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`通过 ${report.passed.length} 项，失败 ${report.failed.length} 项`);
    if (report.failed.length > 0) {
        console.log(`${RED}失败项：${RESET}`);
        for (const item of report.failed) {
            console.log(`  - ${item.label}: ${item.detail}`);
        }
        process.exit(1);
    }
    console.log(`${GREEN}全部通过 ✅${RESET}`);
}

main().catch(error => {
    console.error(`\n${RED}演示崩了：${error.stack ?? error}${RESET}`);
    process.exit(1);
});

export { main, pluginRoot };
