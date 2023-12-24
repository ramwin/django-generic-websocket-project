#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>


from django.urls import re_path

from . import consumers

websocket_urlpatterns = [
    re_path(r"ws/generic/(?P<room_name>\w+)/$", consumers.ChatConsumer.as_asgi()),
]
