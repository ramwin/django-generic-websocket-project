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
