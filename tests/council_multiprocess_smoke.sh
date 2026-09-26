#!/usr/bin/env bash
# 多实例部署冒烟：验证 AI 会议室在 `CHANNEL_LAYER_BACKEND=redis` +
# 多个 Daphne 进程下仍然正确。
#
# 为什么需要它：本项目默认的 memory channel layer **只在单进程内广播**，
# 而 `deploy/supervisor.conf` 起的是 3 个 Daphne 实例 —— 那套部署必须切到
# redis。AI 会议室是在这个既有部署形态上新增的能力，所以必须证明：
#
#   1. **跨实例广播**：WebSocket 连在实例 A，HTTP 投递打到实例 B，
#      A 上的订阅者要能收到（这靠 redis channel layer，不是靠会话保持）；
#   2. **跨进程写 sqlite 不会锁死**：会议室每说一句话都要写库，而
#      supervisor 那套部署共享同一个 sqlite 文件。改动之前这个项目运行期
#      几乎不写库，所以这是个**新引入**的并发面，必须实测；
#   3. **seq 在多进程并发下仍然唯一且连续**（它对长轮询游标至关重要）。
#
# 需要本机有 redis；没有就跳过（不算失败）。
#
# 用法：bash tests/council_multiprocess_smoke.sh
#
# 不会改动仓库里的任何文件：settings 覆盖与探针都写在临时目录里。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/council-mp-XXXXXX")"
PORT_A=17431
PORT_B=17432
PY="${PYTHON:-python3}"

RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
PASS=0; FAIL=0
PID_A=""; PID_B=""

ok()  { PASS=$((PASS + 1)); echo "  ${GREEN}PASS${RESET}  $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  ${RED}FAIL${RESET}  $1"; [ -n "${2:-}" ] && echo "         $2"; return 0; }

cleanup() {
    [ -n "$PID_A" ] && kill "$PID_A" 2>/dev/null
    [ -n "$PID_B" ] && kill "$PID_B" 2>/dev/null
    wait 2>/dev/null
    rm -rf "$WORK"
}
trap cleanup EXIT

cd "$ROOT"

echo "${BOLD}多实例（redis channel layer）会议室冒烟${RESET}"

# ---------------------------------------------------------------- 前置检查

if ! command -v redis-cli >/dev/null 2>&1 || [ "$(redis-cli ping 2>/dev/null)" != "PONG" ]; then
    echo "${DIM}   本机没有可用的 redis（redis-cli ping 不通），跳过这项检查。${RESET}"
    echo "${DIM}   想跑的话：redis-server --daemonize yes${RESET}"
    exit 0
fi
ok "本机 redis 可用"

"$PY" -c "import channels_redis" 2>/dev/null \
    && ok "channels_redis 已安装" \
    || { bad "缺少 channels_redis（pip install channels_redis）"; exit 1; }

# ---------------------------------------------------------------- 起两个实例

cat > "$WORK/settings_redis.py" <<'PY'
"""一次性设置：把 channel layer 换成 redis（不改仓库里的任何文件）。"""
from project.settings import *  # noqa: F401,F403

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [("127.0.0.1", 6379)]},
    },
}
PY

export PYTHONPATH="$WORK:$ROOT"
export DJANGO_SETTINGS_MODULE=settings_redis

echo "${DIM}   启动两个 Daphne 实例：$PORT_A / $PORT_B（共享同一个 sqlite）${RESET}"
"$PY" manage.py runserver "$PORT_A" --noreload >"$WORK/a.log" 2>&1 &
PID_A=$!
"$PY" manage.py runserver "$PORT_B" --noreload >"$WORK/b.log" 2>&1 &
PID_B=$!

wait_ready() {
    local port=$1
    for _ in $(seq 1 40); do
        if curl -s -o /dev/null -m 2 "http://localhost:$port/ws/generic/council/sessions/"; then
            return 0
        fi
        sleep 0.5
    done
    return 1
}

if wait_ready "$PORT_A" && wait_ready "$PORT_B"; then
    ok "两个实例都起来了"
else
    bad "实例没能在 20 秒内起来"
    echo "${DIM}$(tail -5 "$WORK/a.log")${RESET}"
    echo "${DIM}$(tail -5 "$WORK/b.log")${RESET}"
    exit 1
fi

# ---------------------------------------------------------------- 探针

cat > "$WORK/probe.py" <<PY
import json, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
import websocket

A, B = "http://localhost:$PORT_A", "http://localhost:$PORT_B"
N = 20


def post(base, path, payload):
    req = urllib.request.Request(
        base + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read())


def get(base, path):
    with urllib.request.urlopen(base + path, timeout=30) as response:
        return json.loads(response.read())


results = []


def check(label, condition, detail=""):
    results.append((label, bool(condition), detail))


sid = post(A, "/ws/generic/council/sessions/",
           {"task": "多实例验证", "participants": []})["session_id"]

# 1. 跨实例广播
ws = websocket.create_connection(
    f"ws://localhost:$PORT_A/ws/generic/{sid}/", timeout=10,
    origin="http://localhost")
post(B, f"/ws/generic/council/sessions/{sid}/messages/",
     {"sender": "deepseek", "role": "plan", "content": "经 B 端口投递"})
try:
    ws.settimeout(10)
    got = json.loads(ws.recv())
    check("WebSocket 在 A、HTTP 投递到 B，A 能收到（redis 扇出）",
          got.get("content") == "经 B 端口投递", json.dumps(got)[:120])
except Exception as error:
    check("WebSocket 在 A、HTTP 投递到 B，A 能收到（redis 扇出）", False, repr(error))

# 2. 两进程并发写同一个 sqlite
errors = []


def one(index):
    try:
        base = A if index % 2 == 0 else B
        post(base, f"/ws/generic/council/sessions/{sid}/messages/",
             {"sender": f"w{index}", "role": "note", "content": f"m{index}"})
    except Exception as error:
        errors.append(f"{type(error).__name__}: {error}")


with ThreadPoolExecutor(max_workers=N * 2) as pool:
    list(pool.map(one, range(N * 2)))

messages = get(A, f"/ws/generic/council/sessions/{sid}/messages/?after=0")["messages"]
seqs = [item["seq"] for item in messages]
expected = N * 2 + 1  # 40 条并发 + 前面那条跨实例广播

check(f"跨进程并发写 {N * 2} 条，一条不少",
      len(messages) == expected, f"实际 {len(messages)} 条，期望 {expected}")
check("跨进程写 sqlite 零报错（没有 database is locked）",
      not errors, errors[0][:160] if errors else "")
check("多进程下 seq 唯一", len(set(seqs)) == len(seqs),
      f"重复 {len(seqs) - len(set(seqs))} 个")
check("多进程下 seq 连续无洞",
      sorted(seqs) == list(range(1, len(seqs) + 1)), f"{sorted(seqs)[:8]}...")

# 3. 另一个实例也能读回同样的数据（共享 DB，不是各自内存）
other = get(B, f"/ws/generic/council/sessions/{sid}/messages/?after=0")["messages"]
check("B 实例读回与 A 完全一致",
      [item["seq"] for item in other] == seqs,
      f"A={len(seqs)} B={len(other)}")

json.dump(results, open("$WORK/results.json", "w"))
PY

"$PY" "$WORK/probe.py" || true

# ---------------------------------------------------------------- 汇报

"$PY" - "$WORK/results.json" <<'PY' || true
import json, sys
try:
    results = json.load(open(sys.argv[1]))
except Exception:
    results = []
GREEN = '\033[32m'; RED = '\033[31m'; RESET = '\033[0m'
for label, passed, detail in results:
    if passed:
        print(f"  {GREEN}PASS{RESET}  {label}")
    else:
        print(f"  {RED}FAIL{RESET}  {label}")
        if detail:
            print(f"         {detail}")
PY

COUNT=$("$PY" -c "
import json
try:
    r = json.load(open('$WORK/results.json'))
except Exception:
    r = []
print(sum(1 for _, p, _ in r if p), sum(1 for _, p, _ in r if not p))
")
set -- $COUNT
PASS=$((PASS + ${1:-0}))
FAIL=$((FAIL + ${2:-0}))

echo
if grep -qiE "database is locked|OperationalError" "$WORK/a.log" "$WORK/b.log" 2>/dev/null; then
    echo "${BOLD}实例日志里出现了数据库锁相关错误：${RESET}"
    grep -iE "database is locked|OperationalError" "$WORK/a.log" "$WORK/b.log" | head -3
fi

echo "============================================================"
echo "通过 $PASS 项，失败 $FAIL 项"
if [ "$FAIL" -gt 0 ]; then
    echo "${RED}多实例路径有问题 —— 这套部署（deploy/supervisor.conf）先别上线${RESET}"
    exit 1
fi
echo "${GREEN}多实例 + redis 路径通过 ✅${RESET}"
