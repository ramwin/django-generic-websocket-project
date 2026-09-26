#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>


from django.urls import path, re_path

from . import views


urlpatterns = [
        path("send-message/<slug:room_name>/",
             views.MessageView.as_view(), name="send_message"),
        # 浏览器端的会话查看页面，房间名限制为 \w+ ，
        # 与 generic/routing.py 里 WebSocket 路由的 (?P<room_name>\w+) 保持一致，
        # 避免页面能打开但 WebSocket 连不上的情况。
        re_path(r"^room/(?P<room_name>\w+)/$",
                views.RoomView.as_view(), name="room"),
]
