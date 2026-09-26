#!/usr/bin/env bash
# AI 会议室服务的常驻启动脚本。
#
# 它把 django-generic-websocket-project 拉起来当**常驻服务**用：进程用 setsid
# 脱离当前会话，所以关掉终端、重启 dsh 都不会把它带走。
#
# 设计要点是**幂等**：`start` 会先看服务是不是已经在跑
# （先看 PID 文件，再看端口健不健康），已经在跑就什么都不做、直接告诉你
# 当前活跃的会议室是哪一个 —— 于是「启动 → 进入某个房间继续交互」是一条命令。
#
# 用法：
#   deploy/council_service.sh start           # 幂等启动；已在跑就直接复用
#   deploy/council_service.sh start --open    # 顺手用浏览器打开活跃会议室
#   deploy/council_service.sh status          # 进程 + 健康 + 活跃会议室
#   deploy/council_service.sh enter [会话ID]  # 打印（并可选打开）某个会议室地址
#   deploy/council_service.sh logs            # tail 日志
#   deploy/council_service.sh stop
#   deploy/council_service.sh restart
#
# 环境变量：
#   COUNCIL_HOST  默认 127.0.0.1
#   COUNCIL_PORT  默认 7420
#   PYTHON        默认 python3

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${COUNCIL_HOST:-127.0.0.1}"
PORT="${COUNCIL_PORT:-7420}"
PYTHON="${PYTHON:-python3}"
BASE="http://${HOST}:${PORT}"
LOG_DIR="$ROOT/log"
PID_FILE="$LOG_DIR/council_service.pid"
LOG_FILE="$LOG_DIR/council_service.log"
READY_TIMEOUT_S=30

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'

info()  { echo "  $*"; }
ok()    { echo "  ${GREEN}$*${RESET}"; }
warn()  { echo "  ${YELLOW}$*${RESET}"; }
fail()  { echo "  ${RED}$*${RESET}"; }

# ---------------------------------------------------------------- 探测

#: 服务是否真的能应答（比「端口开着」更可靠：端口可能被别的东西占了）
service_healthy() {
    curl -s -o /dev/null -m 3 "$BASE/ws/generic/council/sessions/?limit=1" 2>/dev/null
}

#: 返回占用端口的进程 PID（没占用则空）
port_pid() {
    ss -ltnp 2>/dev/null | grep -F ":$PORT " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
}

pid_file_pid() {
    [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null | tr -d '[:space:]'
}

process_alive() {
    [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

#: 当前活跃（status=active）的会议室，最近创建的那个
active_session() {
    "$PYTHON" - "$BASE" <<'PY' 2>/dev/null
import json, sys, urllib.request
base = sys.argv[1]
try:
    with urllib.request.urlopen(f"{base}/ws/generic/council/sessions/?limit=50", timeout=5) as r:
        data = json.loads(r.read())
except Exception:
    sys.exit(0)
for item in data.get("sessions", []):
    if item.get("status") == "active" and item.get("latest_seq", 0) > 0:
        print(f"{item['session_id']}\t{item.get('round_index', 0)}\t"
              f"{(item.get('task') or '').replace(chr(10), ' ')[:40]}")
        break
PY
}

session_page_url() {
    echo "$BASE/ws/generic/council/room/$1/"
}

show_active() {
    local found sid
    found="$(active_session)"
    if [ -z "$found" ]; then
        warn "当前没有进行中的会议室（全都是空的或已结束）"
        return 1
    fi
    sid="$(echo "$found" | cut -f1)"
    ok "进行中的会议室：$sid（第 $(echo "$found" | cut -f2) 轮）"
    info "任务：$(echo "$found" | cut -f3)"
    info "地址：$(session_page_url "$sid")"
    return 0
}

# ---------------------------------------------------------------- 动作

do_start() {
    local open_browser="${1:-}"
    echo "${BOLD}AI 会议室服务${RESET}"

    if service_healthy; then
        ok "服务已经在运行（${BASE}），不重复启动"
        local owner; owner="$(pid_file_pid)"
        [ -n "$owner" ] && info "PID：$owner（来自 $PID_FILE）" \
                        || info "PID：$(( $(port_pid) ))（不是本脚本启动的）"
        echo
        show_active || true
        if [ "$open_browser" = "--open" ]; then
            local sid; sid="$(active_session | cut -f1)"
            if [ -n "$sid" ]; then
                info "打开浏览器：$(session_page_url "$sid")"
                (xdg-open "$(session_page_url "$sid")" >/dev/null 2>&1 &) || true
            fi
        fi
        return 0
    fi

    # 端口被别的进程占了，但不是我们的服务 —— 别去抢
    local squatter; squatter="$(port_pid)"
    if [ -n "$squatter" ] && ! service_healthy; then
        fail "端口 $PORT 被 PID $squatter 占着，但它不是健康的本服务。请先处理它。"
        return 1
    fi

    mkdir -p "$LOG_DIR"
    cd "$ROOT" || return 1
    info "启动：$PYTHON -m daphne -b $HOST -p $PORT project.asgi:application"

    # setsid：脱离当前会话，终端关掉/父进程退出都不会带走它。
    # 注意：setsid 有时会先 fork 再 exec，所以 `$!` 未必是 daphne 的 PID ——
    # 因此**不拿它当权威身份**，等就绪之后从端口反查真实 PID 再写进文件。
    setsid "$PYTHON" -m daphne -b "$HOST" -p "$PORT" project.asgi:application \
        >>"$LOG_FILE" 2>&1 &
    local spawned=$!

    local waited=0
    while [ "$waited" -lt "$READY_TIMEOUT_S" ]; do
        if service_healthy; then
            local real_pid; real_pid="$(port_pid)"
            [ -n "$real_pid" ] && echo "$real_pid" > "$PID_FILE" \
                               || echo "$spawned" > "$PID_FILE"
            ok "已启动（PID ${real_pid:-$spawned}，日志 $LOG_FILE）"
            echo
            show_active || true
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done
    fail "等了 ${READY_TIMEOUT_S}s 还没就绪，日志末尾："
    tail -n 12 "$LOG_FILE" | sed 's/^/    /'
    rm -f "$PID_FILE"
    return 1
}

do_stop() {
    # 安全第一：**只杀真正占着这个端口的进程**，而且要先确认它就是 daphne。
    #
    # 为什么不直接用 PID 文件里的号：这个脚本可能在不同的 PID namespace 里被
    # 调用（比如包在 bwrap 沙箱里跑），同一个进程在不同 namespace 里号不一样。
    # 拿着沙箱里的号去宿主机 kill，杀掉的会是完全不相干、甚至很关键的进程。
    # 所以 PID 文件只当参考，权威来源是 `ss` —— 它在**当前 namespace 里**给出的
    # 号一定是对的。
    local pid; pid="$(port_pid)"
    local recorded; recorded="$(pid_file_pid)"

    if [ -z "$pid" ]; then
        if service_healthy; then
            fail "服务能应答，但找不到监听 $PORT 的进程（权限不足？）"
            return 1
        fi
        warn "服务没在跑"
        rm -f "$PID_FILE"
        return 0
    fi

    if ! tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q daphne; then
        fail "PID $pid 占着 $PORT 但不是 daphne，拒绝杀它。请自行确认。"
        return 1
    fi

    info "停止 PID $pid（PID 文件里记的是 ${recorded:-无}，以实际占端口者为准）"
    kill "$pid" 2>/dev/null

    local waited=0
    while [ -n "$(port_pid)" ] && [ "$waited" -lt 10 ]; do
        sleep 1
        waited=$((waited + 1))
    done
    if [ -n "$(port_pid)" ]; then
        warn "优雅退出超时，发 SIGKILL"
        kill -9 "$pid" 2>/dev/null
        sleep 1
    fi
    rm -f "$PID_FILE"
    ok "已停止"
}

do_status() {
    echo "${BOLD}AI 会议室服务状态${RESET}"
    info "地址：$BASE"
    local pid; pid="$(port_pid)"
    local recorded; recorded="$(pid_file_pid)"
    if service_healthy; then
        ok "健康：能应答"
        info "PID：${pid:-未知}"
        [ -n "$recorded" ] && info "（PID 文件记录：$recorded；跨 namespace 时以实际为准）"
        echo
        show_active || true
    elif [ -n "$pid" ]; then
        warn "进程 $pid 占着端口，但接口不应答（可能还在启动，或已经卡住）"
        tail -n 5 "$LOG_FILE" 2>/dev/null | sed 's/^/    /'
        return 1
    else
        fail "未运行"
        return 1
    fi
}

do_enter() {
    local sid="${1:-}"
    if ! service_healthy; then
        fail "服务没在跑。先执行：$0 start"
        return 1
    fi
    if [ -z "$sid" ]; then
        local found; found="$(active_session)"
        if [ -z "$found" ]; then
            warn "没有进行中的会议室。可以用 council_start 新建一个。"
            return 1
        fi
        sid="$(echo "$found" | cut -f1)"
        info "最近进行中的会议室：$sid（第 $(echo "$found" | cut -f2) 轮）"
    fi
    echo "$(session_page_url "$sid")"
    (xdg-open "$(session_page_url "$sid")" >/dev/null 2>&1 &) || true
}

case "${1:-status}" in
    start)   shift; do_start "${1:-}" ;;
    stop)    do_stop ;;
    restart) do_stop; echo; do_start ;;
    status)  do_status ;;
    enter)   shift; do_enter "${1:-}" ;;
    logs)    tail -n 30 -f "$LOG_FILE" ;;
    *)
        echo "用法：$0 {start [--open]|stop|restart|status|enter [会话ID]|logs}"
        exit 2
        ;;
esac
