#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>

"""AI 会议室（council）的 HTTP 接口。

全部挂在 ``/ws/generic/council/`` 前缀下，与项目原有的
``/ws/generic/send-message/<room>/``、``/ws/generic/room/<room>/``
互不影响。

接口一览（``<sid>`` 为 session_id，同时是房间名）::

    POST /ws/generic/council/sessions/                 创建会话
    GET  /ws/generic/council/sessions/<sid>/           会话快照
    GET  /ws/generic/council/sessions/<sid>/messages/  拉消息（支持长轮询）
    POST /ws/generic/council/sessions/<sid>/messages/  发言（并广播）
    POST /ws/generic/council/sessions/<sid>/human/     人类动作：打断/恢复/建议/备注
    POST /ws/generic/council/sessions/<sid>/finish/    结束会话
    GET  /ws/generic/council/room/<sid>/               会议室页面

长轮询参数：``?after=<seq>&wait=<seconds>``。``wait`` 上限由
``council.MAX_WAIT_SECONDS`` 控制。这是给「没有 WebSocket 的客户端」
（例如一次性 CLI 进程）准备的可靠回退通道。
"""

import json
import logging

from django.http import Http404, JsonResponse
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt
from django.views.generic import TemplateView
from rest_framework.views import APIView
from rest_framework.response import Response

from . import council
from .models import CouncilMessage, CouncilSession

LOGGER = logging.getLogger(__name__)

#: 人类动作到消息角色的映射。
HUMAN_ACTION_ROLES = {
    "interrupt": CouncilMessage.ROLE_INTERRUPT,
    "resume": CouncilMessage.ROLE_RESUME,
    "suggest": CouncilMessage.ROLE_SUGGEST,
    "note": CouncilMessage.ROLE_NOTE,
}

#: 会话 ID 必须能直接当 WebSocket 房间名用。
SESSION_ID_PATTERN = r"(?P<session_id>\w+)"


def _payload_of(request):
    """兼容 DRF 解析过的 data 和原始 JSON body。"""
    data = getattr(request, "data", None)
    if isinstance(data, dict):
        return data
    try:
        return json.loads(request.body.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        return {}


def _int_param(request, name, default=0):
    raw = request.query_params.get(name, None) if hasattr(
            request, "query_params") else request.GET.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def _float_param(request, name, default=0.0):
    raw = request.query_params.get(name, None) if hasattr(
            request, "query_params") else request.GET.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def _event(message):
    return message.as_event()


def _find_session(session_id):
    try:
        return CouncilSession.objects.get(session_id=session_id)
    except CouncilSession.DoesNotExist as error:
        raise Http404(f"会话 {session_id} 不存在") from error


@method_decorator(csrf_exempt, name="dispatch")
class CouncilSessionListView(APIView):
    """``/sessions/``：创建会话，或列出最近的会话。"""

    def get(self, request, *args, **kwargs):
        limit = max(1, min(200, _int_param(request, "limit", 20)))
        sessions = CouncilSession.objects.all()[:limit]
        return Response({
            "sessions": [council.session_snapshot(item) for item in sessions],
        })

    def post(self, request, *args, **kwargs):
        data = _payload_of(request)
        session_id = (data.get("session_id") or "").strip() or None
        if session_id and not session_id.replace("_", "").isalnum():
            return Response(
                    {"error": "session_id 只能包含字母、数字、下划线"},
                    status=400)
        if session_id and CouncilSession.objects.filter(
                session_id=session_id).exists():
            return Response({"error": f"会话 {session_id} 已存在"}, status=409)
        session = council.create_session(
                task=data.get("task", ""),
                participants=data.get("participants") or [],
                session_id=session_id,
        )
        return Response(self._describe(request, session), status=201)

    @staticmethod
    def _describe(request, session):
        page_path = reverse("council_room", kwargs={
            "session_id": session.session_id})
        return {
            **council.session_snapshot(session),
            "room": session.session_id,
            "ws_path": f"/ws/generic/{session.session_id}/",
            "page_path": page_path,
            "page_url": request.build_absolute_uri(page_path),
        }


@method_decorator(csrf_exempt, name="dispatch")
class CouncilSessionDetailView(APIView):
    """``/sessions/<sid>/``：会话快照。"""

    def get(self, request, session_id, *args, **kwargs):
        session = _find_session(session_id)
        return Response(council.session_snapshot(session))


@method_decorator(csrf_exempt, name="dispatch")
class CouncilMessageView(APIView):
    """``/sessions/<sid>/messages/``：拉消息（可长轮询）与发言。"""

    def get(self, request, session_id, *args, **kwargs):
        session = _find_session(session_id)
        after = _int_param(request, "after", 0)
        wait = _float_param(request, "wait", 0.0)
        roles = request.query_params.get("roles", "") if hasattr(
                request, "query_params") else request.GET.get("roles", "")
        role_filter = [item for item in roles.split(",") if item] or None
        messages, timed_out = council.wait_for_messages(
                session, after_seq=after, wait_seconds=wait, roles=role_filter)
        return Response({
            "messages": [_event(item) for item in messages],
            "latest_seq": council.latest_seq(session),
            "timed_out": timed_out,
            "session": council.session_snapshot(session),
        })

    def post(self, request, session_id, *args, **kwargs):
        session = _find_session(session_id)
        data = _payload_of(request)
        sender = (data.get("sender") or "").strip()
        if not sender:
            return Response({"error": "sender 必填"}, status=400)
        message = council.post_message(
                session,
                sender=sender,
                role=data.get("role", ""),
                step=data.get("step", ""),
                content=data.get("content", ""),
                payload=data.get("payload") or {},
                broadcast_it=bool(data.get("broadcast", True)),
        )
        return Response(_event(message), status=201)


@method_decorator(csrf_exempt, name="dispatch")
class CouncilHumanActionView(APIView):
    """``/sessions/<sid>/human/``：人类动作。

    给会议室页面用，人类不需要自己填 ``sender``/``role``::

        {"kind": "interrupt"}                 暂停，让循环停下来等我
        {"kind": "resume"}                    继续跑循环
        {"kind": "suggest", "content": "..."} 把我的建议注入循环
        {"kind": "note", "content": "..."}    只是留个言
    """

    def post(self, request, session_id, *args, **kwargs):
        session = _find_session(session_id)
        data = _payload_of(request)
        kind = (data.get("kind") or "note").strip()
        role = HUMAN_ACTION_ROLES.get(kind)
        if role is None:
            return Response({
                "error": f"未知的 kind：{kind}",
                "allowed": sorted(HUMAN_ACTION_ROLES),
            }, status=400)
        content = data.get("content", "")
        if kind in ("suggest", "note") and not str(content).strip():
            return Response({"error": f"{kind} 需要 content"}, status=400)
        message = council.post_message(
                session,
                sender=data.get("sender") or "human",
                role=role,
                step=data.get("step", ""),
                content=content,
                payload={
                    "kind": kind,
                    "target_seq": data.get("target_seq"),
                },
        )
        return Response(_event(message), status=201)


@method_decorator(csrf_exempt, name="dispatch")
class CouncilFinishView(APIView):
    """``/sessions/<sid>/finish/``：结束会话。"""

    def post(self, request, session_id, *args, **kwargs):
        session = _find_session(session_id)
        data = _payload_of(request)
        message = council.finish_session(
                session, conclusion=data.get("conclusion", ""))
        return Response({
            "session": council.session_snapshot(session),
            "message": _event(message),
        })


class CouncilRoomView(TemplateView):
    """``/room/<sid>/``：人类用的会议室页面。

    与 ``RoomView`` 一样，房间名限制为 ``\\w+``，和 WebSocket 路由一致，
    避免出现「页面打得开但 WebSocket 连不上」。
    """

    template_name = "generic/council.html"

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        session_id = self.kwargs["session_id"]
        context["session_id"] = session_id
        context["room_name"] = session_id
        context["session_url"] = reverse(
                "council_session_detail", kwargs={"session_id": session_id})
        context["messages_url"] = reverse(
                "council_messages", kwargs={"session_id": session_id})
        context["human_url"] = reverse(
                "council_human", kwargs={"session_id": session_id})
        return context
