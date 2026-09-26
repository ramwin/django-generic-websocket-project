/**
 * 插件的配置解析。
 *
 * 这里刻意不 import 任何 `@deepseek-ai/*`：配置、总线客户端、适配器、
 * 人工窗口这几块都要能脱离 DSH 用 `node --test` 直接测。
 *
 * @module dsh-plugin-ai-council/config
 */

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
        model: 'claude-sonnet-4-5',
        maxTokens: 4096,
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
    reviewTimeoutMs: 180_000,
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
 * 解析 API key：显式写的优先，否则读环境变量。
 *
 * @param {object} participant 参与者配置。
 * @param {Record<string, string|undefined>} [env] 环境变量表。
 * @returns {string} API key，取不到时为空串。
 */
export function resolveApiKey(participant, env = process.env) {
    if (typeof participant.apiKey === 'string' && participant.apiKey.trim() !== '') {
        return participant.apiKey.trim();
    }
    const envName = participant.apiKeyEnv;
    if (typeof envName === 'string' && envName !== '' && typeof env[envName] === 'string') {
        return env[envName];
    }
    return '';
}
