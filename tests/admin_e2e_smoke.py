#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>

"""AI 会议室 admin 的端到端冒烟。

和 ``generic/tests.py`` 里的 admin 测试是**互补**关系，不是重复：

- 单元测试用 Django 的 test client，在测试数据库里跑，快、能进 CI；
- 这个脚本用**真实 HTTP**打一个**真的在跑的** daphne，验的是
  「模板能不能渲染、csrf/登录态、URL 反查、gzip/中间件」这些只有真服务
  才会暴露的东西。

它会临时建一个 superuser、跑完删掉（用的是服务连的那个库）。

用法::

    # 先确保服务在跑，且跑的是当前代码
    deploy/council_service.sh start
    python tests/admin_e2e_smoke.py --base-url http://127.0.0.1:7420
"""

import argparse
import os
import re
import sys
from pathlib import Path

import django


def main():
    parser = argparse.ArgumentParser(description="AI 会议室 admin 端到端冒烟")
    parser.add_argument("--base-url", default="http://127.0.0.1:7420",
                        help="已经在跑的会议室服务地址")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")

    # 直接 `python tests/xxx.py` 时 sys.path 里放的是 tests/ 而不是仓库根目录，
    # 因此 `import project.settings` 会失败 —— 这里显式补上根目录。
    # （tests/ 下别的脚本是纯 HTTP 客户端、不 import Django，所以没暴露这一点。）
    root = str(Path(__file__).resolve().parents[1])
    if root not in sys.path:
        sys.path.insert(0, root)

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "project.settings")
    django.setup()

    import requests
    from django.contrib.auth import get_user_model

    from generic import council
    from generic.models import CouncilSession

    user_model = get_user_model()
    username = "admin_e2e_probe"
    password = "probe-pw-9f3a"
    #: 两个标记用来证明「过滤真的生效」—— 只断言 200 是不够的：
    #: Django admin 对不认识的查询参数是**静默忽略**的，参数名写错也照样 200。
    probe_marker = "E2E_PROBE_TARGET_MARKER"
    other_marker = "E2E_PROBE_OTHER_MARKER"
    probe_sessions = []

    checks = []

    def check(name, ok, detail=""):
        checks.append((name, bool(ok), detail))
        mark = "PASS" if ok else "FAIL"
        print(f"  {mark}  {name}" + (f"  [{detail}]" if detail else ""))

    try:
        session = CouncilSession.objects.order_by("-created_at").first()
        if session is None:
            print("库里还没有会议室会话，先造一个再跑这个脚本")
            return 1

        # 造两个可识别的会话：一个当过滤目标，一个当对照组。
        target = council.create_session(task="admin e2e 过滤探针", participants=["probe"])
        probe_sessions.append(target)
        council.post_message(target, sender="probe", role="note", content=probe_marker)
        control = council.create_session(task="admin e2e 对照", participants=["other"])
        probe_sessions.append(control)
        council.post_message(control, sender="other", role="note", content=other_marker)

        user_model.objects.filter(username=username).delete()
        user_model.objects.create_superuser(
            username=username, email="probe@example.com", password=password)

        client = requests.Session()
        login_page = client.get(f"{base}/admin/login/", timeout=10)
        matched = re.search(
            r'name="csrfmiddlewaretoken" value="([^"]+)"', login_page.text)
        if matched is None:
            print("登录页里没找到 csrf token")
            return 1
        response = client.post(
            f"{base}/admin/login/",
            data={"username": username, "password": password,
                  "csrfmiddlewaretoken": matched.group(1), "next": "/admin/"},
            headers={"Referer": f"{base}/admin/login/"}, timeout=10)
        check("能登录 admin", response.status_code == 200
              and "Site administration" in response.text, f"HTTP {response.status_code}")

        # ---- 能看 ----
        list_session = client.get(f"{base}/admin/generic/councilsession/", timeout=10)
        check("会话列表页 200", list_session.status_code == 200,
              f"HTTP {list_session.status_code}")
        check("列表页出现消息数这一列", "消息数" in list_session.text)
        check("列表页把 JSONField 的 participants 渲染成了文本",
              "参与模型" in list_session.text)

        list_message = client.get(f"{base}/admin/generic/councilmessage/", timeout=10)
        check("消息列表页 200", list_message.status_code == 200,
              f"HTTP {list_message.status_code}")

        detail = client.get(
            f"{base}/admin/generic/councilsession/{session.pk}/change/", timeout=10)
        # 这条是本步最关键的一条：has_change_permission 为 False 时，
        # 详情页仍然应该以只读表单打开，而不是 403。
        check("会话详情页 200（change 权限为 False 也能看）",
              detail.status_code == 200, f"HTTP {detail.status_code}")
        check("详情页含跳转到消息列表的链接", "查看该会话的消息" in detail.text)
        check("跳转链接带上会话过滤参数",
              f"session__id__exact={session.pk}" in detail.text)

        # ---- 只能看 ----
        for label, path in (("会话", "councilsession"), ("消息", "councilmessage")):
            add = client.get(f"{base}/admin/generic/{path}/add/", timeout=10)
            check(f"{label} /add/ 被拒（不能新增）", add.status_code != 200,
                  f"HTTP {add.status_code}")

        # ---- 过滤与搜索 ----
        filtered = client.get(f"{base}/admin/generic/councilmessage/",
                              params={"session__id__exact": target.pk}, timeout=10)
        # 内容级断言：既要看到本会话的消息，又不能看到对照会话的。
        # 只断 200 的话，参数名写错（被静默忽略）也会绿。
        check("会话过滤真的生效（只出现本会话的消息）",
              filtered.status_code == 200
              and probe_marker in filtered.text
              and other_marker not in filtered.text,
              f"HTTP {filtered.status_code}")

        searched = client.get(f"{base}/admin/generic/councilmessage/",
                              params={"q": target.session_id}, timeout=10)
        check("搜索真的生效（按会话号只搜到本会话）",
              searched.status_code == 200
              and probe_marker in searched.text
              and other_marker not in searched.text,
              f"HTTP {searched.status_code}")

    finally:
        # 临时会话按主键删掉，级联带走消息 —— 不给真实库留垃圾
        for probe in probe_sessions:
            CouncilSession.objects.filter(pk=probe.pk).delete()
        user_model.objects.filter(username=username).delete()

    failed = [item for item in checks if not item[1]]
    print(f"\n通过 {len(checks) - len(failed)} 项，失败 {len(failed)} 项")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
