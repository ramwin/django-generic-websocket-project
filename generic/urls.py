#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>


from django.urls import path

from . import views


urlpatterns = [
        path("send-message/<slug:room_name>/",
             views.MessageView.as_view()),
]
