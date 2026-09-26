#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>

# pylint: disable=missing-function-docstring

"""AI 会议室（council）的端到端冒烟测试。

它**不依赖 DSH**，只依赖这个 Django 服务本身，用来证明：

1. 会议室 HTTP 接口（建会话 / 发言 / 长轮询 / 人类动作 / 结束）可用；
2. 会议室页面能打开；
3. 会议室消息真的通过项目原有的 WebSocket 广播机制推给了订阅者；
4. 项目原有的 HTTP 推送与房间页**没有被我改坏**。

用法（先在一个终端起服务）::

    ALLOWED_HOSTS='localhost;127.0.0.1' python manage.py runserver 7420

再在另一个终端::

    python tests/council_smoke.py --base-url http://127.0.0.1:7420

退出码 0 表示全部通过，1 表示有失败项。
"""

import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import click
import requests
import websocket


class Report:
    """极简的结果收集器。"""

    def __init__(self):
        self.passed = []
        self.failed = []

    def check(self, name, condition, detail=""):
        if condition:
            self.passed.append(name)
            click.echo(click.style("  PASS  ", fg="green") + name)
        else:
            self.failed.append((name, detail))
            click.echo(click.style("  FAIL  ", fg="red") + name
                       + (f"\n         {detail}" if detail else ""))
        return bool(condition)


def ws_url_of(base_url, session_id):
    if base_url.startswith("https://"):
        scheme = "wss://"
    else:
        scheme = "ws://"
    host = base_url.split("://", 1)[1].rstrip("/")
    return f"{scheme}{host}/ws/generic/{session_id}/"


def drain(ws, timeout=3.0, expected=None):
    """把 WebSocket 上收到的消息收干净，返回事件列表。

    ``expected`` 给定时，收满这么多条就提前返回。
    """
    events = []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if expected is not None and len(events) >= expected:
            break
        try:
            ws.settimeout(max(0.1, deadline - time.monotonic()))
            raw = ws.recv()
        except Exception:  # 超时 / 连接关闭
            break
        if not raw:
            break
        try:
            events.append(json.loads(raw))
        except ValueError:
            events.append({"raw": raw})
    return events


@click.command()
@click.option("--base-url", default="http://127.0.0.1:7420",
              help="Django 服务地址，默认 http://127.0.0.1:7420")
@click.option("--origin", default="http://localhost",
              help="WebSocket 握手用的 Origin，必须在 ALLOWED_HOSTS 里")
@click.option("--keep", is_flag=True, default=False,
              help="跑完后不结束会话，方便用浏览器打开会议室页面看")
def main(base_url, origin, keep):
    report = Report()
    base_url = base_url.rstrip("/")
    api = f"{base_url}/ws/generic/council"

    click.echo(f"\n=== 1. 建会话 ({api}/sessions/) ===")
    response = requests.post(f"{api}/sessions/", json={
        "task": "冒烟测试：验证会议室总线",
        "participants": ["kimi", "claude"],
    }, timeout=10)
    report.check("创建会话返回 201", response.status_code == 201,
                 f"HTTP {response.status_code}: {response.text[:200]}")
    if response.status_code != 201:
        return _finish(report)
    session = response.json()
    session_id = session["session_id"]
    click.echo(f"        session_id = {session_id}")

    report.check("session_id 能直接当 WebSocket 房间名",
                 session_id.replace("_", "").isalnum(),
                 f"session_id={session_id}")
    report.check("ws_path 指向 ws/generic/<session_id>/",
                 session["ws_path"] == f"/ws/generic/{session_id}/",
                 session["ws_path"])

    click.echo(f"\n=== 2. 打开会议室页面 {session['page_url']} ===")
    page = requests.get(session["page_url"], timeout=10)
    report.check("会议室页面返回 200", page.status_code == 200,
                 f"HTTP {page.status_code}")
    report.check("页面里带上了 session_id", session_id in page.text)
    report.check("页面里有 3 秒打断入口", "打断" in page.text)

    click.echo("\n=== 3. 订阅 WebSocket 并推消息 ===")
    url = ws_url_of(base_url, session_id)
    click.echo(f"        {url}")
    try:
        ws = websocket.create_connection(
                url, timeout=5, origin=origin, suppress_origin=False)
    except Exception as error:  # pylint: disable=broad-except
        report.check("WebSocket 能连上", False, repr(error))
        return _finish(report, session_id)
    report.check("WebSocket 能连上", True)

    messages_url = f"{api}/sessions/{session_id}/messages/"
    human_url = f"{api}/sessions/{session_id}/human/"

    requests.post(messages_url, json={
        "sender": "deepseek", "role": "plan", "step": "plan",
        "content": "计划：先加模型，再加接口，最后加页面",
    }, timeout=10)
    requests.post(messages_url, json={
        "sender": "kimi", "role": "review", "step": "plan",
        "content": "评审：建议先补测试",
    }, timeout=10)
    # 3 秒人工窗口：先广播「窗口已开」，再广播「窗口关闭」
    requests.post(messages_url, json={
        "sender": "deepseek", "role": "human_window_open",
        "step": "plan", "content": "等你 3 秒",
        "payload": {"deadline_ms": 3000},
    }, timeout=10)
    requests.post(human_url, json={"kind": "interrupt"}, timeout=10)
    requests.post(human_url, json={"kind": "suggest",
                                   "content": "记得把 Redis 多实例也测一下"},
                  timeout=10)
    requests.post(messages_url, json={
        "sender": "system", "role": "human_window_close",
        "payload": {"outcome": "interrupted"},
    }, timeout=10)

    events = drain(ws, timeout=5.0, expected=6)
    senders = [item.get("sender") for item in events]
    report.check("WebSocket 收到全部 6 条广播", len(events) == 6,
                 f"收到 {len(events)} 条：{senders}")
    report.check("DeepSeek 的计划被广播", "deepseek" in senders, str(senders))
    report.check("Kimi 的评审被广播", "kimi" in senders, str(senders))
    report.check("人类的打断被广播",
                 any(item.get("role") == "interrupt" for item in events),
                 str([item.get("role") for item in events]))
    report.check("人类的建议被广播",
                 any(item.get("role") == "suggest" for item in events),
                 str([item.get("role") for item in events]))
    report.check("每条广播都带 session_id 与 seq",
                 all(item.get("session_id") == session_id
                     and isinstance(item.get("seq"), int) for item in events),
                 str(events[:1]))

    click.echo("\n=== 4. 长轮询（没有 WebSocket 的客户端走这条路）===")
    polled = requests.get(messages_url, params={"after": 0}, timeout=10).json()
    report.check("长轮询能拉全历史", len(polled["messages"]) == 6,
                 f"拉到 {len(polled['messages'])} 条")
    report.check("latest_seq 正确", polled["latest_seq"] == 6,
                 str(polled["latest_seq"]))
    filtered = requests.get(messages_url, params={
        "after": 0, "wait": 0.3, "roles": "interrupt,resume,suggest",
    }, timeout=10).json()
    report.check("可以只等人类动作（roles 过滤）",
                 filtered["timed_out"] is False
                 and any(item["role"] == "interrupt"
                         for item in filtered["messages"]),
                 json.dumps(filtered)[:200])

    click.echo("\n=== 5. 并发发言时 seq 不重号、不漏号 ===")
    # 这条针对的是一个具体的设计决定：council.post_message() **不能**用
    # select_for_update()（项目默认的 sqlite 后端不支持，会抛 NotSupportedError），
    # 所以 seq 改用「UPDATE ... SET next_seq = next_seq + 1」原子自增。
    # 这个性质只有在真并发下才看得出来，所以必须打真请求。
    parallel = 24
    conc = requests.post(f"{api}/sessions/",
                         json={"task": "并发测试", "participants": []},
                         timeout=10).json()
    conc_id = conc["session_id"]
    conc_url = f"{api}/sessions/{conc_id}/messages/"

    def _post(index):
        return requests.post(conc_url, json={
            "sender": f"w{index}", "role": "note", "content": f"m{index}",
        }, timeout=20)

    with ThreadPoolExecutor(max_workers=parallel) as pool:
        list(pool.map(_post, range(parallel)))
    collected = requests.get(conc_url, params={"after": 0},
                             timeout=20).json()["messages"]
    seqs = [item["seq"] for item in collected]
    report.check(f"{parallel} 条并发发言一条不少",
                 len(collected) == parallel, f"实际 {len(collected)} 条")
    report.check("seq 唯一（没有重号）",
                 len(set(seqs)) == len(seqs), f"重复：{len(seqs) - len(set(seqs))}")
    report.check("seq 连续（没有空洞）",
                 sorted(seqs) == list(range(1, len(seqs) + 1)),
                 f"{sorted(seqs)[:8]}...")
    report.check("并发下内容也没丢",
                 len({item["content"] for item in collected}) == parallel)

    click.echo("\n=== 6. 原有能力没被改坏 ===")
    legacy = requests.post(
            f"{base_url}/ws/generic/send-message/legacy_room/",
            json={"message": "hello"}, timeout=10)
    report.check("原有 HTTP 推送接口仍然可用", legacy.status_code == 200,
                 f"HTTP {legacy.status_code}")
    legacy_page = requests.get(
            f"{base_url}/ws/generic/room/legacy_room/", timeout=10)
    report.check("原有房间页仍然可用", legacy_page.status_code == 200,
                 f"HTTP {legacy_page.status_code}")

    try:
        ws.close()
    except Exception:  # pylint: disable=broad-except
        pass

    if not keep:
        click.echo("\n=== 7. 结束会话 ===")
        done = requests.post(f"{api}/sessions/{session_id}/finish/",
                             json={"conclusion": "冒烟测试通过"}, timeout=10)
        report.check("结束会话返回 200", done.status_code == 200,
                     f"HTTP {done.status_code}")

    return _finish(report, session_id, page_url=session["page_url"])


def _finish(report, session_id=None, page_url=None):
    click.echo("\n" + "=" * 60)
    click.echo(f"通过 {len(report.passed)} 项，失败 {len(report.failed)} 项")
    if page_url:
        click.echo(f"会议室页面：{page_url}")
    if report.failed:
        click.echo(click.style("失败项：", fg="red"))
        for name, detail in report.failed:
            click.echo(f"  - {name}: {detail}")
        sys.exit(1)
    click.echo(click.style("全部通过 ✅", fg="green"))
    return 0


if __name__ == "__main__":
    main()  # pylint: disable=no-value-for-parameter
