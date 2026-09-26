#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>

"""AI 会议室（council）的路由。

由 ``project/urls.py`` 挂在 ``/ws/generic/council/`` 下，
所以完整路径形如 ``/ws/generic/council/sessions/``。

会话 ID 用 ``(?P<session_id>\\w+)`` 匹配，与 ``generic/routing.py`` 里
WebSocket 房间名的约束保持一致——因为 session_id 同时就是房间名。
"""

from django.urls import path, re_path

from . import council_views

SESSION_ID = r"(?P<session_id>\w+)"

urlpatterns = [
    path("sessions/",
         council_views.CouncilSessionListView.as_view(),
         name="council_sessions"),
    re_path(rf"^sessions/{SESSION_ID}/$",
            council_views.CouncilSessionDetailView.as_view(),
            name="council_session_detail"),
    re_path(rf"^sessions/{SESSION_ID}/messages/$",
            council_views.CouncilMessageView.as_view(),
            name="council_messages"),
    re_path(rf"^sessions/{SESSION_ID}/human/$",
            council_views.CouncilHumanActionView.as_view(),
            name="council_human"),
    re_path(rf"^sessions/{SESSION_ID}/finish/$",
            council_views.CouncilFinishView.as_view(),
            name="council_finish"),
    re_path(rf"^room/{SESSION_ID}/$",
            council_views.CouncilRoomView.as_view(),
            name="council_room"),
]
