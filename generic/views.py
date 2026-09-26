import os
import sys

from django.shortcuts import render
from django.urls import reverse
from django.views.generic import TemplateView

from channels.layers import get_channel_layer
from rest_framework.views import APIView
from rest_framework.response import Response

from asgiref.sync import async_to_sync


class MessageView(APIView):

    def post(self, request, room_name, *args, **kwargs):
        channel_layer = get_channel_layer()
        print("发送消息给", room_name)
        async_to_sync(channel_layer.group_send)(
                room_name,
                {
                    "type": "message",
                    "data": request.data,
                },
        )
        return Response({})

    def get(self, request, *args, **kwargs) -> Response:
        return Response({
            "start server commands": sys.argv,
            "headers": request._request.headers,
            "processid": os.getpid(),
        })


class RoomView(TemplateView):
    """浏览器端的会话查看页面，渲染 generic/templates/generic/room.html 。

    对应 django channels 官方教程里的 chat/room.html ：
    页面用 WebSocket 订阅房间，把收到的消息展示出来，也可以在页面里发消息。
    """

    template_name = "generic/room.html"

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        room_name = self.kwargs["room_name"]
        context["room_name"] = room_name
        context["send_message_url"] = reverse(
                "send_message", kwargs={"room_name": room_name})
        return context
