#!/usr/bin/env bash
# 验证「这个插件真的能被 DSH 装载」——不需要动用户自己的 ~/.dsh。
#
# 做法：在工作区外的临时目录里造一个**一次性 DSH home**（靠 DSH_HOME 覆盖），
# 从 shipped 模板初始化一个 headless profile，把本插件挂成 bundle，然后：
#
#   1. --dump-config        DSH 的组合器是否读到了我们的 dsh.bundle.patch，
#                           并把 ai-council 这一行挂进配置树；
#   2. --dump-config-schema DSH 是否真的**导入**了 lib/index.js，并认出了
#                           Config 里的每一个字段；
#   3. --help               整个 profile 能不能**启动**（也就是 apply() 能不能跑通）。
#
# 这三步正是 `dsh plugin add` 之后、真正开始用之前会走的路径，所以它能把
# 「本地单测全绿、装进 DSH 才炸」这类问题提前暴露出来。
#
# 用法：bash dsh-plugin/scripts/verify-dsh-mount.sh
#
# 退出码 0 表示三步都过。

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_NAME="council-mount-check"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dsh-mount-check-XXXXXX")"

RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
PASS=0
FAIL=0

cleanup() {
    rm -rf "$WORK"
}
trap cleanup EXIT

ok()   { PASS=$((PASS + 1)); echo "  ${GREEN}PASS${RESET}  $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  ${RED}FAIL${RESET}  $1"; [ -n "${2:-}" ] && echo "         $2"; return 0; }

command -v dsh >/dev/null 2>&1 || {
    echo "${RED}找不到 dsh 命令${RESET}；这个脚本需要在装了 DeepSeek Harness 的机器上跑。"
    exit 1
}

echo "${BOLD}插件能否被 DSH 装载${RESET}"
echo "${DIM}   插件目录：$PLUGIN_DIR${RESET}"
echo "${DIM}   一次性 DSH home：$WORK（结束即删）${RESET}"
echo "${DIM}   dsh 版本：$(dsh --version 2>/dev/null || echo '?')${RESET}"
echo

export DSH_HOME="$WORK"

echo "${BOLD}1. 用 shipped 模板建一个一次性 profile${RESET}"
if dsh --profile "$PROFILE_NAME" --from-default-profile headless --dump-config \
        >"$WORK/base-dump.yml" 2>"$WORK/base.err"; then
    ok "一次性 profile 创建成功（$DSH_HOME/profiles/$PROFILE_NAME）"
else
    bad "一次性 profile 创建失败" "$(head -3 "$WORK/base.err")"
    exit 1
fi

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"

echo
echo "${BOLD}2. 把本插件挂成 bundle（等价于 dsh plugin add 做的事）${RESET}"
mkdir -p "$PROFILE_DIR/node_modules"
ln -sfn "$PLUGIN_DIR" "$PROFILE_DIR/node_modules/dsh-plugin-ai-council"
if node -e "
const { createRequire } = require('module');
const require_ = createRequire('$PROFILE_DIR/');
process.exit(require_.resolve('dsh-plugin-ai-council/package.json') ? 0 : 1);
" 2>/dev/null; then
    ok "profile 能解析到 dsh-plugin-ai-council"
else
    bad "profile 解析不到 dsh-plugin-ai-council"
fi

node -e "
const fs = require('fs');
const path = '$PROFILE_DIR/package.json';
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
pkg.dependencies ??= {};
pkg.dependencies['dsh-plugin-ai-council'] = 'link:$PLUGIN_DIR';
pkg.dsh.profile.bundles ??= [];
if (!pkg.dsh.profile.bundles.includes('dsh-plugin-ai-council')) {
  pkg.dsh.profile.bundles.push('dsh-plugin-ai-council');
}
fs.writeFileSync(path, JSON.stringify(pkg, null, 2));
"

echo
echo "${BOLD}3. --dump-config：DSH 的组合器认不认这个 bundle${RESET}"
if dsh --profile "$PROFILE_NAME" --dump-config >"$WORK/dump.yml" 2>"$WORK/dump.err"; then
    if grep -qE '^- id: ai-council$' "$WORK/dump.yml"; then
        ok "配置树里出现了 ai-council 这一行"
    else
        bad "配置树里没有 ai-council" "$(grep -c . "$WORK/dump.yml") 行输出里没找到"
    fi
    if grep -q "name: dsh-plugin-ai-council" "$WORK/dump.yml"; then
        ok "挂载的包名正确"
    else
        bad "挂载的包名不对"
    fi
    if grep -q "busUrl: http://127.0.0.1:7420" "$WORK/dump.yml"; then
        ok "我们 cordis.patch.yml 里的默认配置被带进去了"
    else
        bad "默认配置没进配置树"
    fi
else
    bad "--dump-config 失败" "$(head -3 "$WORK/dump.err")"
fi

echo
echo "${BOLD}4. --dump-config-schema：DSH 能不能真的导入 lib/index.js${RESET}"
if dsh --profile "$PROFILE_NAME" --dump-config-schema >"$WORK/schema.json" 2>"$WORK/schema.err"; then
    ok "DSH 导入本插件模块并读出 Config schema 成功"
    missing=""
    for field in busUrl humanWindowMs humanWaitMs reviewTimeoutMs participants promptSectionOrder; do
        grep -q "\"$field\"" "$WORK/schema.json" || missing="$missing $field"
    done
    if [ -z "$missing" ]; then
        ok "Config 的每个字段都被 schema 收录"
    else
        bad "这些字段没被识别：$missing"
    fi
else
    bad "--dump-config-schema 失败（模块导入或 Config schema 有问题）" "$(head -3 "$WORK/schema.err")"
fi

echo
echo "${BOLD}5. 启动整个 profile（apply() 会不会抛）${RESET}"
set +e
timeout 60 dsh --profile "$PROFILE_NAME" --help >"$WORK/boot.out" 2>"$WORK/boot.err"
boot_rc=$?
set -e
if [ "$boot_rc" -eq 0 ]; then
    ok "profile 启动成功（apply() 没抛异常）"
else
    bad "profile 启动失败（rc=$boot_rc）" "$(head -5 "$WORK/boot.err")"
fi
if [ -s "$WORK/boot.err" ]; then
    # 启动期的加载失败不一定是致命的，所以这里单独看一眼
    if grep -qiE "cannot find|is not a function|SyntaxError|failed to (load|import)" "$WORK/boot.err"; then
        bad "启动期 stderr 里有加载错误" "$(head -5 "$WORK/boot.err")"
    else
        ok "启动期 stderr 没有加载错误"
    fi
else
    ok "启动期 stderr 干净"
fi

echo
echo "============================================================"
echo "通过 $PASS 项，失败 $FAIL 项"
if [ "$FAIL" -gt 0 ]; then
    echo "${RED}有失败项 —— 这个状态直接 dsh plugin add 大概率也会出问题${RESET}"
    exit 1
fi
echo "${GREEN}插件能被 DSH 装载 ✅${RESET}"
echo "${DIM}注意：这只证明「装载」这一段。真正让模型调用 council_* 还需要"
echo "      dsh plugin add 到你的 profile 并重启 dsh。${RESET}"
