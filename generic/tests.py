#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>

"""generic 应用的测试。

分三块：

1. :class:`LegacyServiceRegressionTests`
   锁死本项目**原本就对外承诺的能力**：HTTP 推送接口、浏览器房间页、
   WebSocket consumer、WS 路由。改 AI 会议室不能把这些弄坏，也不能
   把项目绑死在 DSH 上。

2. :class:`CouncilApiTests`
   AI 会议室的 HTTP 接口：建会话、发言、长轮询、人类动作、结束会话。

3. :class:`CouncilBroadcastTests`
   会议室消息必须真的走 ``channel_layer.group_send`` 广播到房间组里——
   这是浏览器页面和 AI 插件共用的通道，也是多实例 Redis 部署的基础。

说明：这里刻意不依赖 Redis、不依赖 DSH，``python manage.py test`` 即可。
"""

import asyncio
import json
import re
from unittest import mock

from django.test import TestCase
from django.urls import reverse

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator

from project.asgi import application

from . import council, routing
from .models import CouncilMessage, CouncilSession


async def _receive_or_none_async(channel_name, timeout):
    """在 ``timeout`` 秒内收一条消息，收不到返回 None。

    channel layer 的 ``receive()`` 是阻塞的（内部是 ``asyncio.Queue.get()``），
    所以「确认收不到东西」必须靠超时，不能直接调用。
    """
    try:
        return await asyncio.wait_for(
                get_channel_layer().receive(channel_name), timeout)
    except Exception:  # asyncio.TimeoutError / QueueEmpty / ChannelFull ...
        return None


def _receive_or_none(channel_name, timeout=0.5):
    return async_to_sync(_receive_or_none_async)(channel_name, timeout)


class LegacyServiceRegressionTests(TestCase):
    """原有能力回归：这些测试挂了说明我改坏了项目本来的东西。"""

    def test_send_message_endpoint_still_accepts_post(self):
        """原本的 HTTP 推送接口必须照旧可用。"""
        url = reverse("send_message", kwargs={"room_name": "room_123"})
        response = self.client.post(
                url,
                data=json.dumps({"message": "hello"}),
                content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)

    def test_send_message_debug_get_still_works(self):
        url = reverse("send_message", kwargs={"room_name": "room_123"})
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertIn("processid", response.json())

    def test_room_page_still_renders(self):
        url = reverse("room", kwargs={"room_name": "room_123"})
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "room_123")

    def test_websocket_routing_unchanged(self):
        """WS 路由必须仍然是 ws/generic/<\\w+>/ 。"""
        patterns = [str(item.pattern) for item in routing.websocket_urlpatterns]
        self.assertIn(r"ws/generic/(?P<room_name>\w+)/$", patterns)

    def test_websocket_consumer_still_echoes_to_room(self):
        """WebSocket 服务本身必须照旧能连、能收发。"""
        async def scenario():
            communicator = WebsocketCommunicator(
                    application, "/ws/generic/room_ws_check/",
                    headers=[(b"origin", b"http://localhost")])
            connected, _ = await communicator.connect()
            self.assertTrue(connected)
            await communicator.send_json_to({"message": "ping"})
            received = await communicator.receive_json_from(timeout=5)
            self.assertEqual(received, {"message": "ping"})
            await communicator.disconnect()

        async_to_sync(scenario)()


class CouncilApiTests(TestCase):
    """AI 会议室的 HTTP 接口。"""

    def _create(self, **extra):
        payload = {"task": "把 health check 加上超时", "participants": ["kimi"]}
        payload.update(extra)
        response = self.client.post(
                reverse("council_sessions"),
                data=json.dumps(payload),
                content_type="application/json",
        )
        return response

    def test_create_session_returns_room_and_page(self):
        response = self._create()
        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertTrue(body["session_id"].startswith("council_"))
        self.assertEqual(body["room"], body["session_id"])
        # session_id 必须能直接当 WebSocket 房间名用
        self.assertRegex(body["session_id"], r"^\w+$")
        self.assertEqual(body["ws_path"], f"/ws/generic/{body['session_id']}/")
        self.assertIn(f"/ws/generic/council/room/{body['session_id']}/",
                      body["page_url"])
        self.assertEqual(body["status"], "active")

    def test_duplicate_session_id_is_rejected(self):
        first = self._create().json()
        response = self._create(session_id=first["session_id"])
        self.assertEqual(response.status_code, 409)

    def test_illegal_session_id_is_rejected(self):
        response = self._create(session_id="bad-name")
        self.assertEqual(response.status_code, 400)

    def test_post_message_assigns_increasing_seq(self):
        session_id = self._create().json()["session_id"]
        url = reverse("council_messages", kwargs={"session_id": session_id})
        first = self.client.post(
                url, data=json.dumps({
                    "sender": "deepseek", "role": "plan", "step": "plan",
                    "content": "第一步先加迁移"}),
                content_type="application/json").json()
        second = self.client.post(
                url, data=json.dumps({
                    "sender": "kimi", "role": "review", "step": "plan",
                    "content": "建议先补测试"}),
                content_type="application/json").json()
        self.assertEqual(first["seq"], 1)
        self.assertEqual(second["seq"], 2)
        self.assertEqual(second["council"], True)
        self.assertEqual(second["session_id"], session_id)

    def test_post_message_requires_sender(self):
        session_id = self._create().json()["session_id"]
        url = reverse("council_messages", kwargs={"session_id": session_id})
        response = self.client.post(
                url, data=json.dumps({"role": "plan", "content": "x"}),
                content_type="application/json")
        self.assertEqual(response.status_code, 400)

    def test_list_messages_after_seq(self):
        session_id = self._create().json()["session_id"]
        session = CouncilSession.objects.get(session_id=session_id)
        for index in range(3):
            council.post_message(session, sender="deepseek", role="plan",
                                 content=f"第{index}条")
        url = reverse("council_messages", kwargs={"session_id": session_id})
        body = self.client.get(url, {"after": 1}).json()
        self.assertEqual([item["seq"] for item in body["messages"]], [2, 3])
        self.assertEqual(body["latest_seq"], 3)

    def test_long_poll_returns_immediately_when_messages_exist(self):
        session_id = self._create().json()["session_id"]
        session = CouncilSession.objects.get(session_id=session_id)
        council.post_message(session, sender="kimi", role="review",
                             content="我有意见")
        url = reverse("council_messages", kwargs={"session_id": session_id})
        body = self.client.get(url, {"after": 0, "wait": 2}).json()
        self.assertFalse(body["timed_out"])
        self.assertEqual(len(body["messages"]), 1)

    def test_long_poll_times_out_when_nothing_new(self):
        session_id = self._create().json()["session_id"]
        url = reverse("council_messages", kwargs={"session_id": session_id})
        body = self.client.get(url, {"after": 0, "wait": 0.3}).json()
        self.assertTrue(body["timed_out"])
        self.assertEqual(body["messages"], [])

    def test_long_poll_can_filter_by_role(self):
        """等人类打断时要能忽略模型自己刷屏的评审输出。"""
        session_id = self._create().json()["session_id"]
        session = CouncilSession.objects.get(session_id=session_id)
        for index in range(5):
            council.post_message(session, sender="kimi", role="review",
                                 content=f"评审{index}")
        url = reverse("council_messages", kwargs={"session_id": session_id})
        body = self.client.get(url, {
            "after": 0, "wait": 0.3, "roles": "interrupt,resume,suggest",
        }).json()
        self.assertTrue(body["timed_out"])
        # 但不带过滤时这 5 条评审意见必须能拿到
        all_messages = self.client.get(url, {"after": 0}).json()["messages"]
        self.assertEqual(len(all_messages), 5)

    def test_wait_for_messages_returns_role_matched_batch(self):
        """roles 过滤命中时返回完整批次，而不是只返回命中的那几条。

        插件需要按 ``after=seq`` 顺序推进游标，少收消息会漏内容。
        """
        session = council.create_session(task="t")
        council.post_message(session, sender="kimi", role="review", content="评审")
        interrupt = council.post_message(
                session, sender="human", role="interrupt", content="")
        found, timed_out = council.wait_for_messages(
                session, after_seq=0, wait_seconds=1.0, roles=["interrupt"])
        self.assertFalse(timed_out)
        self.assertEqual([item.seq for item in found],
                         [1, 2])
        self.assertEqual(found[-1].pk, interrupt.pk)

    def test_human_actions_map_to_roles(self):
        session_id = self._create().json()["session_id"]
        url = reverse("council_human", kwargs={"session_id": session_id})
        cases = [
            ({"kind": "interrupt"}, CouncilMessage.ROLE_INTERRUPT),
            ({"kind": "resume"}, CouncilMessage.ROLE_RESUME),
            ({"kind": "suggest", "content": "先写文档"}, CouncilMessage.ROLE_SUGGEST),
            ({"kind": "note", "content": "记一下"}, CouncilMessage.ROLE_NOTE),
        ]
        for payload, expected_role in cases:
            response = self.client.post(
                    url, data=json.dumps(payload),
                    content_type="application/json")
            self.assertEqual(response.status_code, 201)
            self.assertEqual(response.json()["role"], expected_role)
            self.assertEqual(response.json()["sender"], "human")

    def test_human_action_rejects_unknown_kind(self):
        session_id = self._create().json()["session_id"]
        url = reverse("council_human", kwargs={"session_id": session_id})
        response = self.client.post(
                url, data=json.dumps({"kind": "nonsense"}),
                content_type="application/json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("allowed", response.json())

    def test_suggest_requires_content(self):
        session_id = self._create().json()["session_id"]
        url = reverse("council_human", kwargs={"session_id": session_id})
        response = self.client.post(
                url, data=json.dumps({"kind": "suggest", "content": "  "}),
                content_type="application/json")
        self.assertEqual(response.status_code, 400)

    def test_finish_session(self):
        session_id = self._create().json()["session_id"]
        url = reverse("council_finish", kwargs={"session_id": session_id})
        body = self.client.post(
                url, data=json.dumps({"conclusion": "都满意了"}),
                content_type="application/json").json()
        self.assertEqual(body["session"]["status"], "finished")
        self.assertEqual(body["session"]["conclusion"], "都满意了")

    def test_unknown_session_returns_404(self):
        url = reverse("council_messages", kwargs={"session_id": "council_nope"})
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_round_index_counts_closed_human_windows(self):
        session = council.create_session(task="t")
        for _ in range(2):
            council.post_message(session, sender="deepseek",
                                 role=CouncilMessage.ROLE_HUMAN_WINDOW_OPEN,
                                 payload={"deadline_ms": 3000})
            council.post_message(session, sender="system",
                                 role=CouncilMessage.ROLE_HUMAN_WINDOW_CLOSE,
                                 payload={"outcome": "timeout"})
        session.refresh_from_db()
        self.assertEqual(session.round_index, 2)

    def test_council_room_page_renders(self):
        session_id = self._create().json()["session_id"]
        url = reverse("council_room", kwargs={"session_id": session_id})
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, session_id)
        self.assertContains(response, "打断")

    def test_council_room_rejects_non_word_session_id(self):
        """页面和 WebSocket 房间名约束必须一致，避免页面能开、WS 连不上。"""
        self.assertEqual(
                self.client.get("/ws/generic/council/room/bad-name/").status_code,
                404)


class CouncilBroadcastTests(TestCase):
    """会议室消息必须真的广播进房间组。"""

    def test_posted_message_reaches_room_group(self):
        session = council.create_session(task="广播测试")
        channel_layer = get_channel_layer()
        channel_name = async_to_sync(channel_layer.new_channel)()
        async_to_sync(channel_layer.group_add)(
                session.session_id, channel_name)

        url = reverse("council_messages",
                      kwargs={"session_id": session.session_id})
        self.client.post(
                url, data=json.dumps({
                    "sender": "claude", "role": "review", "step": "plan",
                    "content": "这段我看不懂"}),
                content_type="application/json")

        event = async_to_sync(channel_layer.receive)(channel_name)
        self.assertEqual(event["type"], "message")
        self.assertEqual(event["data"]["sender"], "claude")
        self.assertEqual(event["data"]["role"], "review")
        self.assertEqual(event["data"]["content"], "这段我看不懂")
        self.assertEqual(event["data"]["session_id"], session.session_id)
        async_to_sync(channel_layer.group_discard)(
                session.session_id, channel_name)

    def test_human_action_is_broadcast_too(self):
        """人类打断必须也能被房间里的插件实时收到。"""
        session = council.create_session(task="广播测试")
        channel_layer = get_channel_layer()
        channel_name = async_to_sync(channel_layer.new_channel)()
        async_to_sync(channel_layer.group_add)(
                session.session_id, channel_name)

        url = reverse("council_human", kwargs={"session_id": session.session_id})
        self.client.post(
                url, data=json.dumps({"kind": "interrupt"}),
                content_type="application/json")

        event = async_to_sync(channel_layer.receive)(channel_name)
        self.assertEqual(event["data"]["role"], CouncilMessage.ROLE_INTERRUPT)
        async_to_sync(channel_layer.group_discard)(
                session.session_id, channel_name)

    def test_legacy_room_and_council_room_are_isolated(self):
        """往老房间推消息不能漏进会议室房间。"""
        session = council.create_session(task="隔离测试")
        channel_layer = get_channel_layer()
        channel_name = async_to_sync(channel_layer.new_channel)()
        async_to_sync(channel_layer.group_add)(
                session.session_id, channel_name)

        self.client.post(
                reverse("send_message", kwargs={"room_name": "other_room"}),
                data=json.dumps({"message": "老房间的消息"}),
                content_type="application/json")

        self.assertIsNone(_receive_or_none(channel_name, timeout=0.5))
        async_to_sync(channel_layer.group_discard)(
                session.session_id, channel_name)


class CouncilRoutingTests(TestCase):
    """会议室路由必须挂在 /ws/generic/council/ 下，且不能吃掉原有路由。"""

    def test_council_paths_resolve(self):
        self.assertEqual(
                reverse("council_sessions"), "/ws/generic/council/sessions/")
        self.assertEqual(
                reverse("council_room", kwargs={"session_id": "council_x"}),
                "/ws/generic/council/room/council_x/")

    def test_legacy_paths_unchanged(self):
        self.assertEqual(
                reverse("send_message", kwargs={"room_name": "room_123"}),
                "/ws/generic/send-message/room_123/")
        self.assertEqual(
                reverse("room", kwargs={"room_name": "room_123"}),
                "/ws/generic/room/room_123/")

    def test_session_id_regex_matches_websocket_room_regex(self):
        """两边的房间名约束必须是同一套 \\w+ 。"""
        ws_pattern = str(routing.websocket_urlpatterns[0].pattern)
        self.assertRegex("council_abc123", r"^\w+$")
        self.assertTrue(re.search(r"\\w\+", ws_pattern) is not None)


class BroadcastHelperTests(TestCase):
    """broadcast() 在 channel layer 缺失时不能炸。"""

    def test_missing_channel_layer_is_tolerated(self):
        with mock.patch.object(council, "get_channel_layer", return_value=None):
            council.broadcast("room_x", {"message": "hi"})


class CouncilAdminTests(TestCase):
    """AI 会议室的 admin 注册。

    admin 是给人看会议记录的地方，所以这里钉两件事：**能看**（两个 changelist
    和会话详情页都要 200）和**只能看**（增/改/删三个入口全关）。

    刻意不写 ``has_view_permission``：它查的是模型层权限，与
    ``ReadOnlyAdmin.has_change_permission`` 无关，显式返回 True 会把会议记录
    放开给所有 staff 用户。下面的权限断言就是在钉这一点。
    """

    def setUp(self):
        from django.contrib.auth import get_user_model

        user_model = get_user_model()
        self.superuser = user_model.objects.create_superuser(
            username="council_root", email="root@example.com", password="pw-root")
        #: 已登录但**不是** staff：admin 应该把它挡在登录页
        self.plain_user = user_model.objects.create_user(
            username="council_plain", password="pw-plain")

        self.session = council.create_session(
            task="把 health check 加上超时", participants=["kimi", "claude"])
        # post_message 收的是**模型实例**（见 council.post_message 的签名），
        # 不是 session_id —— 这里传错过一次，记一笔。
        self.message = council.post_message(
            self.session, sender="kimi", role="review",
            step="plan", content="第一条评审意见")

    # ------------------------------------------------------------ 注册

    def test_两个模型都注册进了_admin(self):
        from django.contrib import admin as django_admin
        self.assertIn(CouncilSession, django_admin.site._registry)
        self.assertIn(CouncilMessage, django_admin.site._registry)

    def test_只读是用权限方法关的_不是靠_readonly_fields(self):
        # readonly_fields 只影响表单渲染，管不到增删入口。
        # 「只追加」这个契约必须在权限方法上直接编码。
        from django.contrib import admin as django_admin
        for model in (CouncilSession, CouncilMessage):
            model_admin = django_admin.site._registry[model]
            for name in ("has_add_permission", "has_change_permission",
                         "has_delete_permission"):
                self.assertFalse(
                    getattr(model_admin, name)(self._request()),
                    f"{model.__name__}.{name} 应该返回 False")

    def test_没有_has_view_permission_的显式放宽(self):
        # 一旦有人加上 `def has_view_permission: return True`，
        # 任何 staff 用户都能看全部会议记录。这条测试专门防这个改动。
        #
        # 基类和**每个子类**都要查：只盯基类的话，把方法写在
        # CouncilSessionAdmin 上就漏过去了（评审指出的盲区）。
        from django.contrib import admin as django_admin
        from generic.admin import ReadOnlyAdmin
        self.assertNotIn("has_view_permission", ReadOnlyAdmin.__dict__)
        for model in (CouncilSession, CouncilMessage):
            model_admin = django_admin.site._registry[model]
            self.assertNotIn("has_view_permission", type(model_admin).__dict__)
            # 顺着 MRO 找到第一个定义了它的类，必须只有 django 自己的默认实现
            owner = next(
                (klass for klass in type(model_admin).__mro__
                 if "has_view_permission" in klass.__dict__), None)
            self.assertIsNotNone(owner)
            self.assertNotIn(owner.__name__, ("CouncilSessionAdmin", "CouncilMessageAdmin",
                                             "ReadOnlyAdmin"))

    def _request(self):
        request = mock.Mock()
        request.user = self.superuser
        return request

    # ------------------------------------------------------------ 能看

    def test_会话列表页_200_并且渲染出了消息数与参与模型(self):
        self.client.force_login(self.superuser)
        response = self.client.get(
            reverse("admin:generic_councilsession_changelist"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, self.session.session_id)
        # annotate 出来的消息数
        self.assertContains(response, ">1<")
        # participants 是 JSONField，必须经方法渲染成文本
        self.assertContains(response, "kimi")
        self.assertContains(response, "claude")

    def test_消息列表页_200(self):
        self.client.force_login(self.superuser)
        response = self.client.get(
            reverse("admin:generic_councilmessage_changelist"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "第一条评审意见")

    def test_会话详情页_200_并且给出跳转到消息列表的链接(self):
        # 详情页是「放弃 inline」之后真正的落地点，必须真的有这个链接
        self.client.force_login(self.superuser)
        response = self.client.get(reverse(
            "admin:generic_councilsession_change", args=[self.session.pk]))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "查看该会话的消息")
        self.assertContains(
            response, f"session__id__exact={self.session.pk}")

    def test_带会话过滤的消息列表能打开(self):
        # 就是上面那个链接指向的地址
        self.client.force_login(self.superuser)
        response = self.client.get(
            reverse("admin:generic_councilmessage_changelist"),
            {"session__id__exact": self.session.pk})
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "第一条评审意见")

    def test_消息详情页_200(self):
        self.client.force_login(self.superuser)
        response = self.client.get(reverse(
            "admin:generic_councilmessage_change", args=[self.message.pk]))
        self.assertEqual(response.status_code, 200)

    def test_add_入口被挡住(self):
        # 只读不能只靠隐藏按钮：直接访问 /add/ 也必须被拒
        self.client.force_login(self.superuser)
        for name in ("admin:generic_councilsession_add",
                     "admin:generic_councilmessage_add"):
            response = self.client.get(reverse(name))
            self.assertIn(response.status_code, (302, 403),
                          f"{name} 应该被拒，实际 {response.status_code}")

    # ------------------------------------------------------------ 挡住

    def test_匿名用户被重定向到登录页(self):
        for name in ("admin:generic_councilsession_changelist",
                     "admin:generic_councilmessage_changelist"):
            response = self.client.get(reverse(name))
            self.assertEqual(response.status_code, 302)
            self.assertIn("/admin/login/", response["Location"])

    def test_已登录但非_staff_也被重定向(self):
        # 这条和上一条是两种身份：匿名 vs 已登录无权限。
        # 用 is_staff=False 的号，走的是 302；若用 is_staff=True 但无模型权限
        # 的号，会变成 403 PermissionDenied，断言目标不同。
        self.client.force_login(self.plain_user)
        response = self.client.get(
            reverse("admin:generic_councilsession_changelist"))
        self.assertEqual(response.status_code, 302)
        self.assertIn("/admin/login/", response["Location"])


    def test_消息列表不会按行数增加查询(self):
        """session_link 每行都要读 obj.session，必须 select_related。

        评审指出的 N+1：没有 select_related 时，每多一条消息就多一条查会话的
        SQL（list_per_page=50 时每页 51 条）。这里用「同一页里 1 条 vs 6 条
        消息的查询数必须相同」来钉住它 —— 比写死一个魔法数字稳。
        """
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        self.client.force_login(self.superuser)
        url = reverse("admin:generic_councilmessage_changelist")

        def queries_for(extra):
            CouncilMessage.objects.filter(pk=self.message.pk).delete()
            council.post_message(self.session, sender="kimi", role="review",
                                 content="第一条评审意见")
            for index in range(extra):
                council.post_message(self.session, sender="kimi", role="review",
                                     content=f"第 {index} 条")
            with CaptureQueriesContext(connection) as captured:
                response = self.client.get(url)
            self.assertEqual(response.status_code, 200)
            return len(captured)

        one = queries_for(0)
        six = queries_for(5)
        self.assertEqual(
            one, six,
            f"消息从 1 条变成 6 条时查询数从 {one} 变到 {six} —— 说明每行都在查会话（N+1）")


class CouncilAdminRenderingTests(TestCase):
    """展示方法的纯函数测试：JSONField 里什么脏数据都不能让页面 500。"""

    def test_render_participants_处理字符串列表(self):
        from generic.admin import render_participants
        self.assertEqual(render_participants(["kimi", "claude"]), "kimi、claude")

    def test_render_participants_处理字典列表(self):
        # HTTP 接口收任意 JSON，外部客户端可能塞 list[dict]。
        # 直接 join 会 TypeError —— 而 changelist 渲染期抛异常就是 500。
        from generic.admin import render_participants
        self.assertEqual(
            render_participants([{"name": "kimi"}, {"label": "Claude"}]),
            "kimi、Claude")

    def test_render_participants_兜住各种奇怪输入(self):
        from generic.admin import render_participants
        self.assertEqual(render_participants([]), "—")
        self.assertEqual(render_participants(None), "—")
        self.assertEqual(render_participants({}), "—")
        # dict 而不是 list：取 key，不能崩
        self.assertEqual(render_participants({"kimi": 1}), "kimi")
        # 不是列表也不是字典
        self.assertEqual(render_participants("kimi"), "kimi")
        # 未知形状的 dict 也要能渲染
        self.assertEqual(render_participants([{"weird": 1}]), "{'weird': 1}")

    def test_content_preview_截断长正文并处理空正文(self):
        from generic.admin import CouncilMessageAdmin
        model_admin = CouncilMessageAdmin(CouncilMessage, None)
        short = CouncilMessage(content="短")
        self.assertEqual(model_admin.content_preview(short), "短")
        long = CouncilMessage(content="字" * 200)
        preview = model_admin.content_preview(long)
        self.assertEqual(len(preview), 81)          # 80 个字 + 省略号
        self.assertTrue(preview.endswith("…"))
        self.assertEqual(model_admin.content_preview(CouncilMessage(content="  ")), "—")
