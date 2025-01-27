#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>

daphne -b websocket.ramwin.com -p 7431 project.asgi:application
