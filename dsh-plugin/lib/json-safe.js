/**
 * 把工具返回值变成「无损 JSON」。
 *
 * 为什么需要这一层：DSH 的工具执行管道会
 *
 *   1. 先给工具返回值做一次无损 JSON 快照；
 *   2. 再用工具自己声明的 ``output.schema`` 校验它。
 *
 * 也就是说，**声明了 output.schema 的工具，返回值必须严格符合这份 schema，
 * 否则会在运行时抛 `ToolOutputError`（INVALID_TOOL_OUTPUT）**。
 *
 * JS 里很自然的写法却会踩这个坑：对象里带 `undefined` 的可选字段。例如
 * 「超时」这条路径下 `human.suggestion` 是 `undefined`，如果它被当成
 * 「存在但类型不对」而不是「不存在」，校验就会失败。
 *
 * 这类问题只在 DSH 管道里才会暴露，本地直接调 `execute` 是看不出来的
 * （见 test/output-contract.test.mjs）。
 *
 * @module dsh-plugin-ai-council/json-safe
 */

/** 判断是不是可以用 `{}` 重建的普通对象。 */
function isPlainObject(value) {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * 深度去掉 `undefined`（对象属性与数组元素都处理）。
 *
 * 不做 JSON 往返，是为了保住 `Date` 之外的原始类型不被意外字符串化；
 * 这里只需要保证结果是无损 JSON。
 *
 * @param {*} value 任意值。
 * @returns {*} 去掉 undefined 之后的值。
 */
export function compact(value) {
    if (value === undefined) {
        return undefined;
    }
    if (Array.isArray(value)) {
        return value
            .filter(item => item !== undefined)
            .map(item => compact(item));
    }
    if (isPlainObject(value)) {
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            if (item === undefined) {
                continue;
            }
            result[key] = compact(item);
        }
        return result;
    }
    return value;
}

/**
 * 检查一个值是不是无损 JSON（与 DSH 快照的语义一致）。
 *
 * @param {*} value 任意值。
 * @returns {string[]} 违规说明，空数组表示通过。
 */
export function losslessJsonProblems(value, path = 'value') {
    const problems = [];
    const walk = (item, where) => {
        if (item === undefined) {
            problems.push(`${where} 是 undefined`);
            return;
        }
        if (item === null) {
            return;
        }
        const type = typeof item;
        if (type === 'string' || type === 'boolean') {
            return;
        }
        if (type === 'number') {
            if (!Number.isFinite(item)) {
                problems.push(`${where} 是 ${item}，不是 JSON 数字`);
            }
            return;
        }
        if (type === 'bigint' || type === 'function' || type === 'symbol') {
            problems.push(`${where} 是 ${type}，不是 JSON`);
            return;
        }
        if (Array.isArray(item)) {
            item.forEach((child, index) => walk(child, `${where}[${index}]`));
            return;
        }
        if (item instanceof Date) {
            return;
        }
        if (isPlainObject(item)) {
            for (const [key, child] of Object.entries(item)) {
                walk(child, `${where}.${key}`);
            }
            return;
        }
        problems.push(
            `${where} 的类型是 ${item?.constructor?.name ?? type}，不是普通 JSON 值`);
    };
    walk(value, path);
    return problems;
}
