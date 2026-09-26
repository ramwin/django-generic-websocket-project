#!/usr/bin/env node
/**
 * 插件 ↔ 真实会议室服务的链路自检（**不调用任何真实模型**）。
 *
 * 和 e2e-demo.mjs 的分工：
 *   - e2e-demo 要跑真 Kimi，慢、且消耗订阅额度，验证的是「异模型评审」；
 *   - 本脚本把模型换成桩，只验证**插件与 django-generic-websocket-project
 *     之间的那条 HTTP 链路**，几秒就能跑完。
 *
 * 它覆盖三件容易在「本地单测全绿、连上真服务才炸」的事情：
 *   1. 工具返回值真的能通过 DSH 自己声明的 output.schema 校验
 *      （单测直接调 execute 是绕过管道校验的）；
 *   2. 工具在真实服务上跑出来的输出仍然满足该 schema；
 *   3. 人类的打断/建议走真实 HTTP 接口时能被正确识别。
 *
 * 用法（先起 Django 服务）：
 *   ALLOWED_HOSTS='localhost;127.0.0.1' python manage.py runserver 7420
 *   node dsh-plugin/scripts/live-check.mjs --bus-url http://127.0.0.1:7420
 */

import { parseArgs } from 'node:util';

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

import { CouncilBus } from '../lib/council-client.js';
import { resolveConfig } from '../lib/config.js';
import { losslessJsonProblems } from '../lib/json-safe.js';
import { registerCouncilTools } from '../lib/tools.js';

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

const report = { passed: [], failed: [] };

function check(label, ok, detail = '') {
    if (ok) {
        report.passed.push(label);
        console.log(`  ${GREEN}PASS${RESET}  ${label}`);
    } else {
        report.failed.push({ label, detail });
        console.log(`  ${RED}FAIL${RESET}  ${label}${detail ? `\n         ${detail}` : ''}`);
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 按 DSH 管道的做法校验一次工具返回值。 */
function contractProblems(tool, value) {
    const problems = losslessJsonProblems(value);
    const snapshot = JSON.parse(JSON.stringify(value));
    return [
        ...problems,
        ...validateJsonSchemaValue(tool.output.schema, snapshot, 'value'),
    ];
}

/** 桩模型：永远给 revise。 */
function stubFetch(verdict = 'revise', text = '这个计划漏了鉴权') {
    return async () => new Response(JSON.stringify({
        content: [{ type: 'text', text: `${text}\nVERDICT: ${verdict}` }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function main() {
    const { values } = parseArgs({
        options: {
            'bus-url': { type: 'string', default: 'http://127.0.0.1:7420' },
        },
    });

    const bus = new CouncilBus({ busUrl: values['bus-url'] });
    console.log(`${BOLD}插件 ↔ 会议室服务 链路自检${RESET}`);
    console.log(`${DIM}   ${bus.apiRoot}${RESET}\n`);

    const config = resolveConfig({
        busUrl: bus.baseUrl,
        humanWindowMs: 600,
        participants: {
            // 默认配置里 claude 也是开的；这里只留一个桩，断言才确定
            kimi: { enabled: false },
            claude: { enabled: false },
            reviewer: {
                adapter: 'claude-api', label: 'Reviewer（桩）',
                baseUrl: 'https://stub.example', model: 'm', apiKey: 'k',
            },
        },
    });
    const tools = {};
    const ctx = {
        tools: { register: tool => { tools[tool.name] = tool; } },
        systemPrompt: { section: () => {} },
    };
    registerCouncilTools(ctx, config, { bus, fetchImpl: stubFetch() });

    console.log(`${BOLD}1. 真服务上跑完整一轮${RESET}`);
    let started;
    try {
        started = await tools.council_start.execute({ task: '给 WS 加真实鉴权' }, {});
    } catch (error) {
        console.log(`${RED}连不上会议室服务：${error.message}${RESET}`);
        process.exit(1);
    }
    check('council_start 在真实服务上建会话成功',
        /^council_\w+$/.test(started.session_id), started.session_id);
    check('council_start 的输出符合它自己声明的 schema',
        contractProblems(tools.council_start, started).length === 0,
        contractProblems(tools.council_start, started).join('; '));

    const reviewed = await tools.council_review.execute({
        session_id: started.session_id,
        step: 'plan',
        artifact: '1. 改 get_user\n2. 加 AuthToken 模型和迁移',
    }, {});
    console.log(`${DIM}   converged=${reviewed.converged} blocking=`
        + `${JSON.stringify(reviewed.blocking)} human=${reviewed.human.status}${RESET}`);
    check('council_review 在真实服务上完成一轮并拿到 revise',
        reviewed.converged === false && reviewed.blocking.length === 1,
        JSON.stringify(reviewed.blocking));
    check('council_review 的输出符合它自己声明的 schema',
        contractProblems(tools.council_review, reviewed).length === 0,
        contractProblems(tools.council_review, reviewed).join('; '));
    check('可选字段是被省掉，而不是留一个 undefined',
        !('suggestion' in reviewed.human) && !('error' in reviewed.human),
        JSON.stringify(reviewed.human));
    check('窗口是正常超时（桩模型很快，没人打断）',
        reviewed.human.status === 'timeout', reviewed.human.status);

    console.log(`\n${BOLD}2. 人类打断走真实 HTTP 接口${RESET}`);
    // 和浏览器页面完全同一条路径：POST /sessions/<id>/human/
    const suggestTimer = (async () => {
        await sleep(200);
        await bus.humanAction(started.session_id, {
            kind: 'suggest', content: '别忘了 MessageView.post 也在裸奔',
        });
    })();
    const second = await tools.council_review.execute({
        session_id: started.session_id, step: 'coding', artifact: 'diff...',
    }, {});
    await suggestTimer;
    check('真实 HTTP 的人类建议被识别为 suggested',
        second.human.status === 'suggested', second.human.status);
    check('建议正文完整透传',
        (second.human.suggestion ?? '').includes('MessageView.post'),
        second.human.suggestion ?? '(空)');
    check('带 suggestion 的输出同样符合 schema',
        contractProblems(tools.council_review, second).length === 0,
        contractProblems(tools.council_review, second).join('; '));

    console.log(`\n${BOLD}3. 另外三个工具${RESET}`);
    const status = await tools.council_status.execute({
        session_id: started.session_id,
    }, {});
    check('council_status 读回完整记录',
        status.message_count >= 8 && status.round_index === 2,
        `message_count=${status.message_count} round_index=${status.round_index}`);
    check('council_status 的输出符合 schema',
        contractProblems(tools.council_status, status).length === 0,
        contractProblems(tools.council_status, status).join('; '));

    const note = await tools.council_note.execute({
        session_id: started.session_id, content: '我按意见改了', role: 'coding',
    }, {});
    check('council_note 的输出符合 schema',
        contractProblems(tools.council_note, note).length === 0);

    const finished = await tools.council_finish.execute({
        session_id: started.session_id, conclusion: '链路自检通过',
    }, {});
    check('council_finish 的输出符合 schema',
        contractProblems(tools.council_finish, finished).length === 0);

    console.log(`\n${BOLD}4. 原地重连一次（确认状态是持久的，不是内存里的）${RESET}`);
    // 注意：上面 council_note / council_finish 又追加了消息，所以基线要重新读一次，
    // 不能用更早那份 status.message_count 快照。
    const baseline = await bus.getMessages(started.session_id, { after: 0 });
    const freshBus = new CouncilBus({ busUrl: bus.baseUrl });
    const reread = await freshBus.getMessages(started.session_id, { after: 0 });
    check('换一个全新客户端能读回完全相同的消息',
        reread.messages.length === baseline.messages.length
        && reread.messages.length > 0,
        `新客户端 ${reread.messages.length} 条，原客户端 ${baseline.messages.length} 条`);
    check('最后一条消息也一致（说明不是只读了缓存片段）',
        reread.messages.at(-1)?.seq === baseline.messages.at(-1)?.seq,
        `${reread.messages.at(-1)?.seq} vs ${baseline.messages.at(-1)?.seq}`);
    check('会话状态已经落库（status=finished）',
        reread.session?.status === 'finished', reread.session?.status);
    check('结论也落库了',
        (reread.session?.conclusion ?? '').includes('链路自检通过'),
        reread.session?.conclusion ?? '(空)');

    console.log(`\n${'='.repeat(60)}`);
    console.log(`通过 ${report.passed.length} 项，失败 ${report.failed.length} 项`);
    console.log(`${DIM}会议室页面：${bus.pageUrl(started.session_id)}${RESET}`);
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
    console.error(`\n${RED}自检崩了：${error.stack ?? error}${RESET}`);
    process.exit(1);
});
