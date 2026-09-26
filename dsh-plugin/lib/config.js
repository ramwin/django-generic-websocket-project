/**
 * 插件的配置解析。
 *
 * 这里刻意不 import 任何 `@deepseek-ai/*`：配置、总线客户端、适配器、
 * 人工窗口这几块都要能脱离 DSH 用 `node --test` 直接测。
 *
 * @module dsh-plugin-ai-council/config
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 支持的适配器类型。 */
export const ADAPTER_KINDS = ['kimi-cli', 'claude-api', 'openai-api'];

/** 默认参与者。 */
export const DEFAULT_PARTICIPANTS = {
    kimi: {
        enabled: true,
        adapter: 'kimi-cli',
        label: 'Kimi',
        command: 'kimi',
        args: [],
        // 留空 = 沿用用户自己的 ~/.kimi-code（CLI 已登录的订阅）。
        // 在沙箱里跑时把它指到一个可写目录即可。
        homeDir: '',
        // 留空 = 每次评审都用一个临时目录当工作区，让评审模型
        // 手边没有可改的东西 —— 写代码这件事只由 DeepSeek 做。
        cwd: '',
        env: {},
    },
    claude: {
        enabled: true,
        adapter: 'claude-api',
        label: 'Claude',
        // baseUrl / apiKeyEnv / model 都可替换：换成别人的中转或别的模型即可。
        baseUrl: 'https://api.anthropic.com',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        apiKey: '',
        // 进程环境里没有这个变量时，去这个文件里按 apiKeyEnv 找
        // （支持 `export NAME=value` 这种 shell 片段）
        apiKeyFile: '',
        // 'api-key' → x-api-key（Anthropic 官方）；'bearer' → Authorization: Bearer
        // （Claude Code 的 ANTHROPIC_AUTH_TOKEN、以及多数中转都用这种）
        authStyle: 'api-key',
        // 思考模式：auto（不传，由端点决定）/ disabled（关掉）/ budget（设上限）
        // 有些端点默认开思考，且会把 max_tokens 全花在思考上导致没有正文，
        // 那种情况用 disabled 最可靠。
        thinking: 'auto',
        thinkingBudgetTokens: 2048,
        model: 'claude-sonnet-4-5',
        // 别设太小：开了思考模式的模型会把预算花在 thinking 上，
        // 正文就没有位置了（实测 4096 不够，整个评审会被判成「空内容」）。
        maxTokens: 8192,
        anthropicVersion: '2023-06-01',
        headers: {},
    },
};

/** 解析后的默认值。 */
export const DEFAULTS = {
    busUrl: 'http://127.0.0.1:7420',
    humanWindowMs: 3000,
    // 人类按下「打断」之后，最多等他这么久来选「恢复循环」还是「加入建议」。
    // 10 分钟的依据：超过这个量级，把控制权交回对话比让一个工具调用一直挂着
    // 更合适（`paused` 就是这条退路）。
    //
    // 注意一个部署相关的边界：`council_review` **刻意不声明** `timeoutMs`，
    // 而 DSH 只在工具作者显式声明时才套用执行期限，所以默认的 native 模式下
    // 等 10 分钟是安全的。如果某个部署把 dsh-tools 配成 `ptc` 或 `both`，
    // 工具会经由 `run_code` 调用，那里有 `runtime.timeout` 的程序级预算，
    // 长等待可能被截断 —— 被截断时窗口会走 `aborted` 分支如实关窗，不会
    // 让会议室停在「等人工确认」。
    humanWaitMs: 600_000,
    // 单次长轮询请求的上限。**必须小于服务端 generic/council.py 的
    // MAX_WAIT_SECONDS（60 秒）**，否则会被服务端静默截断，实际等待时长就
    // 会缩水（真实踩过：配了 10 分钟，实际只等 60 秒，用户 60 秒后写的
    // 建议没人接）。放在配置里是因为它取决于中间层：nginx 的
    // proxy_read_timeout 默认也是 60 秒，走 nginx 时应该调得更小。
    pollWindowMs: 55_000,
    // 单个模型评审的超时。Kimi 开着思考模式、又要把长计划读完，
    // 实测 130 秒能回来、180 秒也会超时，所以默认给足 8 分钟。
    reviewTimeoutMs: 480_000,
    requestTimeoutMs: 30_000,
    promptSectionOrder: 118,
    transcriptLimit: 40,
    systemPrompt: '你是一名严格的技术评审。你的输出会被另一个编码代理直接采用，'
        + '所以请只讲可执行、可验证的意见。',
};

function positiveInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.floor(parsed);
}

/**
 * 把插件配置（可能来自 cordis.patch.yml，也可能来自单元测试）解析成运行时配置。
 *
 * @param {object} raw 原始配置。
 * @returns {object} 运行时配置。
 */
export function resolveConfig(raw = {}) {
    const participants = {};
    const configured = raw.participants ?? {};
    const names = new Set([
        ...Object.keys(DEFAULT_PARTICIPANTS),
        ...Object.keys(configured),
    ]);
    for (const name of names) {
        const base = DEFAULT_PARTICIPANTS[name] ?? {
            enabled: true,
            adapter: 'openai-api',
            label: name,
        };
        participants[name] = { name, ...base, ...(configured[name] ?? {}) };
    }
    return {
        busUrl: String(raw.busUrl ?? DEFAULTS.busUrl).replace(/\/+$/, ''),
        humanWindowMs: positiveInt(raw.humanWindowMs, DEFAULTS.humanWindowMs),
        humanWaitMs: positiveInt(raw.humanWaitMs, DEFAULTS.humanWaitMs),
        pollWindowMs: positiveInt(raw.pollWindowMs, DEFAULTS.pollWindowMs),
        reviewTimeoutMs: positiveInt(raw.reviewTimeoutMs, DEFAULTS.reviewTimeoutMs),
        requestTimeoutMs: positiveInt(raw.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
        promptSectionOrder: positiveInt(raw.promptSectionOrder, DEFAULTS.promptSectionOrder),
        transcriptLimit: positiveInt(raw.transcriptLimit, DEFAULTS.transcriptLimit),
        systemPrompt: String(raw.systemPrompt ?? DEFAULTS.systemPrompt),
        participants,
    };
}

/**
 * 取某个参与者的启用列表。
 *
 * @param {object} config 运行时配置。
 * @param {string[]|undefined} names 显式指定的参与者；省略则取所有 enabled 的。
 * @returns {object[]} 参与者配置数组。
 */
export function selectParticipants(config, names) {
    const wanted = names && names.length > 0
        ? names
        : Object.values(config.participants)
            .filter(item => item.enabled !== false)
            .map(item => item.name);
    const selected = [];
    for (const name of wanted) {
        const participant = config.participants[name];
        if (participant === undefined) {
            throw new Error(`未配置的参与者：${name}（已配置：`
                + `${Object.keys(config.participants).join(', ')}）`);
        }
        selected.push(participant);
    }
    return selected;
}

/**
 * 从一个文件里取出 API key。
 *
 * 支持两种格式：
 * 1. **shell 环境文件**（推荐）：按 ``apiKeyEnv`` 给的名字找
 *    ``NAME=value`` / ``export NAME=value`` / ``NAME="value"`` 那一行。
 *    这样可以直接指向 ``~/.bashrc`` 片段或 ``secret/bashrc`` 这类文件，
 *    不必为了插件去改系统的环境变量。
 * 2. **纯 key 文件**：整份内容就是一个 key（Docker secret 那种）。
 *
 * 为什么需要它：DSH 进程未必继承到你 shell 里的那些 export（例如
 * ``ANTHROPIC_AUTH_TOKEN``），而插件也没法替你 source 一个 rc 文件。
 *
 * @param {string} path 文件路径。
 * @param {string} [name] 变量名；给了就按名字找，找不到再退化成整份内容。
 * @param {Function} [readFile] 便于测试注入。
 * @returns {string} key，取不到时为空串。
 */
export function readApiKeyFile(path, name, readFile = readFileSync) {
    if (typeof path !== 'string' || path.trim() === '') {
        return '';
    }
    let content;
    try {
        content = String(readFile(expandHome(path), 'utf8'));
    } catch {
        return '';
    }
    if (typeof name === 'string' && name !== '') {
        const pattern = new RegExp(
            `^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`, 'm');
        const matched = content.match(pattern);
        if (matched !== null) {
            return stripQuotes(matched[1]);
        }
        return '';
    }
    const trimmed = content.trim();
    if (trimmed === '' || trimmed.includes('\n') || trimmed.includes('=')) {
        return '';
    }
    return stripQuotes(trimmed);
}

/** 展开开头的 `~`，这样配置里不用硬编码用户名。 */
export function expandHome(path) {
    const value = String(path ?? '');
    if (value === '~') {
        return homedir();
    }
    if (value.startsWith('~/')) {
        return join(homedir(), value.slice(2));
    }
    return value;
}

/** 去掉 shell 里常见的包裹引号。 */
function stripQuotes(value) {
    const trimmed = String(value ?? '').trim();
    if (trimmed.length >= 2
        && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
            || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

/**
 * 解析 API key。
 *
 * 顺序：显式写的 ``apiKey`` → ``apiKeyFile`` 里按 ``apiKeyEnv`` 找 →
 * 环境变量 ``apiKeyEnv``。
 *
 * @param {object} participant 参与者配置。
 * @param {Record<string, string|undefined>} [env] 环境变量表。
 * @param {Function} [readFile] 便于测试注入。
 * @returns {string} API key，取不到时为空串。
 */
export function resolveApiKey(participant, env = process.env, readFile = readFileSync) {
    if (typeof participant.apiKey === 'string' && participant.apiKey.trim() !== '') {
        return participant.apiKey.trim();
    }
    if (typeof participant.apiKeyFile === 'string' && participant.apiKeyFile.trim() !== '') {
        const fromFile = readApiKeyFile(
            participant.apiKeyFile, participant.apiKeyEnv, readFile);
        if (fromFile !== '') {
            return fromFile;
        }
    }
    const envName = participant.apiKeyEnv;
    if (typeof envName === 'string' && envName !== '' && typeof env[envName] === 'string') {
        return env[envName];
    }
    return '';
}
