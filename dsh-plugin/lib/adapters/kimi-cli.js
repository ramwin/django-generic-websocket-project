/**
 * Kimi 适配器（走本机已登录的 kimi CLI）。
 *
 * 为什么用 CLI 而不是 API：用户的 Kimi For Coding 是 OAuth 订阅，没有
 * API key，但 CLI 已经登录好了。`kimi -p "<提示>"` 就是一次非交互调用。
 *
 * 实测输出格式（kimi 2.1.1）：
 *   stdout -> "• 答案正文\n"        （干净，只有答案，前面带一个 UI 圆点）
 *   stderr -> banner + 思考过程 + "To resume this session: ..."
 * 所以只取 stdout，并去掉开头的圆点。
 *
 * @module dsh-plugin-ai-council/adapters/kimi-cli
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 去掉 CLI 的 "• " 前缀。 */
export function stripBullet(text) {
    return String(text ?? '').replace(/^\s*[•·]\s?/u, '').trim();
}

/**
 * 调用 kimi CLI 做一次评审。
 *
 * @param {object} options 调用参数。
 * @param {string} options.prompt 提示词。
 * @param {object} options.participant 参与者配置。
 * @param {number} [options.timeoutMs] 超时毫秒。
 * @param {Function} [options.spawnImpl] 便于测试注入。
 * @returns {Promise<{text: string, stderr: string, code: number}>} 结果。
 */
export async function callKimiCli({ prompt, participant, timeoutMs = 180_000, spawnImpl }) {
    const spawn = spawnImpl ?? nodeSpawn;
    const command = participant.command || 'kimi';
    const args = [
        ...(participant.args ?? []),
        '-p', prompt,
        '--output-format', participant.outputFormat ?? 'text',
    ];

    // 评审模型不需要一个能改代码的工作区：默认给它一个空临时目录。
    let scratch = null;
    let cwd = participant.cwd;
    if (!cwd) {
        scratch = await mkdtemp(join(tmpdir(), 'ai-council-review-'));
        cwd = scratch;
    }

    const env = { ...process.env, ...(participant.env ?? {}) };
    if (typeof participant.homeDir === 'string' && participant.homeDir !== '') {
        // 沙箱里跑时（例如 ~/.kimi-code 只读），把它指到一个可写目录。
        env.KIMI_CODE_HOME = participant.homeDir;
    }

    try {
        return await new Promise((resolve, reject) => {
            let child;
            try {
                child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (error) {
                reject(new Error(`启动 ${command} 失败：${error.message}`));
                return;
            }
            let stdout = '';
            let stderr = '';
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                child.kill('SIGKILL');
                reject(new Error(`${command} 超过 ${timeoutMs}ms 没有返回，已终止`));
            }, timeoutMs);

            child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
            child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
            child.on('error', error => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                reject(new Error(`无法执行 ${command}：${error.message}`));
            });
            child.on('close', code => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                if (code !== 0) {
                    reject(new Error(
                        `${command} 退出码 ${code}：${stderr.trim().slice(-500) || '(无 stderr)'}`));
                    return;
                }
                resolve({ text: stripBullet(stdout), stderr, code });
            });
        });
    } finally {
        if (scratch !== null) {
            await rm(scratch, { recursive: true, force: true }).catch(() => {});
        }
    }
}
