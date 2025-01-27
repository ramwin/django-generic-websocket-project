import os
import sys

from django.shortcuts import render

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


class InfoView(APIView):

    def get(self, request, *args, **kwargs) -> Response:
        return Response({
            "start server commands": sys.argv,
            "headers": request._request.headers,
            "processid": os.getpid(),
        })
