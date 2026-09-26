/**
 * 提示词构造与结果解析。
 *
 * 这里定下一条重要边界：**评审模型只产出文字，不改文件**。
 * Kimi / Claude 的任何输出都会先回帖到会议室，再由 DeepSeek 决定要不要
 * 落到代码里。这样「AI 能修改迭代」是真的，但所有写操作仍然留在
 * DeepSeek 这一侧，享有 DSH 的沙箱与审批。
 *
 * @module dsh-plugin-ai-council/prompts
 */

const ROLE_LABELS = {
    task: '任务',
    plan: '计划',
    coding: '编码',
    execute: '执行',
    evaluate: '评价',
    review: '评审意见',
    note: '人类留言',
    interrupt: '人类打断',
    resume: '人类选择恢复循环',
    suggest: '人类建议',
    human_window_open: '等待人工确认（3 秒窗口开启）',
    human_window_close: '人工窗口关闭',
    system: '系统事件',
};

const SENDER_LABELS = {
    deepseek: 'DeepSeek',
    kimi: 'Kimi',
    claude: 'Claude',
    human: '人类（项目所有者）',
    system: '系统',
};

/** 渲染一条消息的标题行。 */
function headerOf(message) {
    const sender = SENDER_LABELS[message.sender] ?? message.sender;
    const role = ROLE_LABELS[message.role] ?? message.role ?? '';
    const step = message.step ? `｜步骤：${message.step}` : '';
    return `### #${message.seq} ${sender}｜${role}${step}`;
}

/**
 * 把会议室里已经发生的事渲染成文本，供评审模型参考。
 *
 * 这是「多个 AI 在同一个通道里相互沟通」的落点：每个评审模型看到的
 * 不只是本次产物，还有之前每一轮其他人说过什么。
 *
 * 注意总长度是有预算的：kimi CLI 的提示词是作为一个命令行参数传进去的，
 * 而 Linux 单个参数上限约 128KB。所以这里从**最新**的消息往回装，
 * 装不下就丢掉更早的。
 *
 * @param {object[]} messages 消息数组（按 seq 升序）。
 * @param {object} [options] 选项。
 * @param {number} [options.limit] 最多渲染多少条（取最近的）。
 * @param {number} [options.maxCharsPerMessage] 单条消息的截断长度。
 * @param {number} [options.maxTotalChars] 整段文本的字符预算。
 * @returns {string} 文本。
 */
export function formatTranscript(messages, {
    limit = 40,
    maxCharsPerMessage = 4000,
    maxTotalChars = 20_000,
} = {}) {
    const usable = (messages ?? []).filter(
        item => item !== null && item !== undefined
            && item.role !== 'human_window_open'
            && item.role !== 'human_window_close');
    const recent = usable.slice(-limit);
    if (recent.length === 0) {
        return '（会议室里还没有任何消息）';
    }
    const render = item => {
        const content = String(item.content ?? '');
        const clipped = content.length > maxCharsPerMessage
            ? `${content.slice(0, maxCharsPerMessage)}\n…（已截断，原文 ${content.length} 字）`
            : content;
        return `${headerOf(item)}\n${clipped || '（空）'}`;
    };
    // 从最新往回装，超预算就停，最后再正序拼回去。
    const kept = [];
    let used = 0;
    for (let index = recent.length - 1; index >= 0; index -= 1) {
        const block = render(recent[index]);
        if (used + block.length > maxTotalChars && kept.length > 0) {
            kept.push(`（更早的 ${index + 1} 条消息因篇幅省略）`);
            break;
        }
        kept.push(block);
        used += block.length;
    }
    return kept.reverse().join('\n\n');
}

/**
 * 构造一次评审请求的提示词。
 *
 * @param {object} options 选项。
 * @param {string} options.label 评审模型的名字。
 * @param {string} options.task 整体任务。
 * @param {string} options.step 当前步骤（plan/coding/execute/evaluate）。
 * @param {string} options.artifact DeepSeek 本步的产物。
 * @param {string} [options.transcript] 会议室历史。
 * @param {string} [options.focus] 本次特别希望对方看什么。
 * @param {number} [options.round] 已是第几轮。
 * @param {string} [options.humanSuggestion] 人类刚注入的建议。
 * @returns {string} 提示词。
 */
export function buildReviewPrompt({
    label,
    task,
    step,
    artifact,
    transcript = '',
    focus = '',
    round = 1,
    humanSuggestion = '',
}) {
    const lines = [
        `你是「${label}」，在这次任务里担任独立评审。DeepSeek 是执行者，`,
        '你是校验者。你们唯一的共同目标是让产物真的对，而不是互相客气。',
        '',
        '## 整体任务',
        task || '（未提供）',
        '',
        `## 当前步骤：${step}（第 ${round} 轮）`,
        'DeepSeek 本步的产物如下：',
        '```',
        artifact || '（空）',
        '```',
    ];
    if (humanSuggestion) {
        lines.push('', '## 人类刚刚注入的建议（优先级最高）', humanSuggestion);
    }
    if (focus) {
        lines.push('', '## 本次特别希望你看的地方', focus);
    }
    lines.push('', '## 会议室里已经发生过的事', transcript || '（无）');
    lines.push(
        '',
        '## 你的工作',
        '1. **不要修改任何文件，不要执行任何命令。** 只输出文字意见，'
        + '落地这件事由 DeepSeek 负责。',
        '2. 明确说出什么地方是错的、有风险的、会失败的，并给出你会怎么改。',
        '3. 如果这一轮没问题，也要说清楚你具体验证了哪几点，不要只写「同意」。',
        '4. 不要重复上一轮已经解决过的意见；如果上一条意见已被采纳，'
        + '直接确认即可。',
        '5. 不要为了显得严格而硬找问题；也不要因为对方是同行就放过明显缺陷。',
        '',
        '## 输出格式',
        '先给意见正文，最后**必须**用单独一行给出结论，二选一：',
        '',
        'VERDICT: approve',
        'VERDICT: revise',
        '',
        'approve = 你认为这一步现在可以往下走；revise = 还有必须改的地方。',
    );
    return lines.join('\n');
}

/**
 * 从模型输出里解析结论。
 *
 * @param {string} text 模型输出。
 * @returns {'approve'|'revise'|'unknown'} 结论。
 */
export function parseVerdict(text) {
    const matches = [...String(text ?? '').matchAll(
        /VERDICT\s*[:：]\s*(approve|revise)/gi)];
    if (matches.length === 0) {
        return 'unknown';
    }
    const last = matches[matches.length - 1][1].toLowerCase();
    return last === 'approve' ? 'approve' : 'revise';
}

/**
 * 把一份评审结果压成一句话，方便在工具返回值里扫一眼。
 *
 * @param {object} review 评审结果。
 * @returns {string} 摘要。
 */
export function summarizeReview(review) {
    if (review.error) {
        return `${review.label}：调用失败（${review.error}）`;
    }
    const verdict = { approve: '同意', revise: '要改', unknown: '没给结论' }[review.verdict];
    const head = String(review.text ?? '').trim().split('\n')
        .find(line => line.trim() !== '' && !/^VERDICT/i.test(line.trim())) ?? '';
    const clipped = head.length > 80 ? `${head.slice(0, 80)}…` : head;
    return `${review.label}：${verdict}｜${clipped}`;
}

export { ROLE_LABELS, SENDER_LABELS };
