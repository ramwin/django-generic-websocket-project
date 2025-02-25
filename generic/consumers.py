#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>

# pylint: disable=unused-argument,attribute-defined-outside-init
# pylint: disable=arguments-renamed,missing-function-docstring,missing-class-docstring,arguments-differ

"""
基础功能，什么消息都直接发送
"""

import json
import logging

from channels.generic.websocket import AsyncWebsocketConsumer

LOGGER = logging.getLogger(__name__)


class ChatConsumer(AsyncWebsocketConsumer):
    need_auth = False

    async def connect(self):
        self.room_name = self.scope["url_route"]["kwargs"]["room_name"]
        self.room_group_name = f"{self.room_name}"

        LOGGER.info("current connect user: %s", self.scope["user"])

        if self.need_auth and not self.scope['user'].is_authenticated:
            self.close(3000)
            return
        await self.channel_layer.group_add(self.room_group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        # Leave room group
        await self.channel_layer.group_discard(self.room_group_name, self.channel_name)

    # Receive message from WebSocket
    async def receive(self, text_data):
        data = json.loads(text_data)
        LOGGER.info("receive message: %s in %s", data, self.channel_layer.group_send)
        await self.channel_layer.group_send(
            self.room_group_name,
            {"type": "message", "data": data}
        )

    # Receive message from room group
    async def message(self, event):
        data = event["data"]
        LOGGER.info("收到消息: %s", data)
        await self.send(text_data=json.dumps(data))
