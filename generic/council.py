#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>

"""AI 会议室（council）的服务层。

这一层只做三件事，且都不依赖 DSH：

1. **分配序号**：``post_message`` 在事务里给消息分配会话内自增的 ``seq``；
2. **落库**：消息写进 :class:`generic.models.CouncilMessage`；
3. **广播**：复用项目原有的 ``channel_layer.group_send(room, {"type":
   "message", "data": ...})`` 原语，把消息推给房间内所有 WebSocket 订阅者。

因此会议室天然支持 ``CHANNEL_LAYER_BACKEND=redis`` 的多实例部署，
也天然兼容原有的 ``ChatConsumer`` 与 ``room.html``。
"""

import logging
import secrets
import string
import time

from django.db import models, transaction
from django.utils import timezone

from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

from .models import CouncilMessage, CouncilSession

LOGGER = logging.getLogger(__name__)

#: 长轮询的最长等待时间，避免占用 Django 的工作线程过久。
MAX_WAIT_SECONDS = 60.0
#: 长轮询的轮询间隔。
POLL_INTERVAL_SECONDS = 0.2
#: 会话 ID 允许的字符集：必须落在 WebSocket 路由的 ``\w+`` 里。
_SESSION_ID_ALPHABET = string.ascii_lowercase + string.digits


def generate_session_id(prefix="council"):
    """生成一个满足 ``\\w+`` 约束的房间名。"""
    suffix = "".join(secrets.choice(_SESSION_ID_ALPHABET) for _ in range(10))
    return f"{prefix}_{suffix}"


def broadcast(room_name, data):
    """把一份 JSON 数据广播给房间内的所有 WebSocket 订阅者。

    走的是项目原有的 channel layer 原语，所以单进程 memory 后端和
    多实例 redis 后端都能用。
    """
    channel_layer = get_channel_layer()
    if channel_layer is None:  # pragma: no cover - 仅在未配置 channel layer 时发生
        LOGGER.warning("没有配置 channel layer，消息不会广播：%s", room_name)
        return
    async_to_sync(channel_layer.group_send)(
            room_name,
            {"type": "message", "data": data},
    )


def create_session(task="", participants=None, session_id=None):
    """创建一次会议室会话。"""
    if not session_id:
        session_id = generate_session_id()
    session = CouncilSession.objects.create(
            session_id=session_id,
            task=task or "",
            participants=list(participants or []),
    )
    LOGGER.info("创建会议室会话 %s，任务：%s", session_id, (task or "")[:80])
    return session


def post_message(session, sender, role="", content="", step="", payload=None,
                 broadcast_it=True):
    """追加一条消息并（默认）广播。

    ``seq`` 的分配不用 ``select_for_update()``——项目默认的 sqlite 后端不支持
    ``SELECT ... FOR UPDATE``，会直接抛 ``NotSupportedError``。改成对会话行做
    一条 ``UPDATE ... SET next_seq = next_seq + 1`` 原子自增，再读回自己刚写的
    值：sqlite 的写锁和 Postgres 的行锁都会让并发的第二条 UPDATE 阻塞到第一条
    提交之后，因此两边读到的都是自己的号，不会重号。
    """
    with transaction.atomic():
        CouncilSession.objects.filter(pk=session.pk).update(
                next_seq=models.F("next_seq") + 1,
                updated_at=timezone.now(),
        )
        seq = CouncilSession.objects.values_list(
                "next_seq", flat=True).get(pk=session.pk)
        message = CouncilMessage.objects.create(
                session_id=session.pk,
                seq=seq,
                sender=sender,
                role=role or "",
                step=step or "",
                content=content or "",
                payload=dict(payload or {}),
        )
        if role == CouncilMessage.ROLE_HUMAN_WINDOW_CLOSE:
            CouncilSession.objects.filter(pk=session.pk).update(
                    round_index=models.F("round_index") + 1,
                    updated_at=timezone.now(),
            )

    session.refresh_from_db(fields=["next_seq", "round_index", "status",
                                    "updated_at"])
    if broadcast_it:
        broadcast(session.session_id, message.as_event())
    return message


def finish_session(session, conclusion=""):
    """结束会话，并广播一条系统消息。"""
    session.status = CouncilSession.STATUS_FINISHED
    session.conclusion = conclusion or ""
    session.save(update_fields=["status", "conclusion", "updated_at"])
    return post_message(
            session,
            sender="system",
            role=CouncilMessage.ROLE_SYSTEM,
            content=conclusion or "会话结束",
            payload={"status": session.status},
    )


def messages_after(session, after_seq=0, limit=500):
    """取出 ``seq > after_seq`` 的消息，按序号升序。"""
    queryset = session.messages.filter(seq__gt=max(0, int(after_seq)))
    return list(queryset.order_by("seq")[:limit])


def wait_for_messages(session, after_seq=0, wait_seconds=0.0, roles=None,
                      limit=500):
    """长轮询：等新消息出现，最多等 ``wait_seconds`` 秒。

    返回 ``(messages, timed_out)``。``wait_seconds<=0`` 时只做一次查询。

    ``roles`` 非空时只认这些角色的新消息，用于「等人类的打断 / 恢复 /
    建议」而忽略模型自己刷屏的评审输出。
    """
    deadline = time.monotonic() + min(max(0.0, float(wait_seconds)),
                                      MAX_WAIT_SECONDS)
    role_filter = set(roles) if roles else None
    while True:
        found = messages_after(session, after_seq=after_seq, limit=limit)
        if role_filter is not None:
            matched = [item for item in found if item.role in role_filter]
        else:
            matched = found
        if matched:
            return found, False
        if time.monotonic() >= deadline:
            return [], True
        time.sleep(POLL_INTERVAL_SECONDS)


def latest_seq(session):
    """会话当前的最新序号。"""
    latest = session.messages.order_by("-seq").first()
    return latest.seq if latest else 0


def session_snapshot(session):
    """给 HTTP 接口用的会话快照。"""
    return {
        "session_id": session.session_id,
        "task": session.task,
        "participants": session.participants,
        "status": session.status,
        "conclusion": session.conclusion,
        "round_index": session.round_index,
        "latest_seq": latest_seq(session),
        "created_at": session.created_at.isoformat() if session.created_at else None,
        "updated_at": session.updated_at.isoformat() if session.updated_at else None,
        "server_time": timezone.now().isoformat(),
    }
