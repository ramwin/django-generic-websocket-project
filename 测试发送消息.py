#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>


import requests


requests.post("http://localhost:8000/generic/send-message/room123/", {123: 456})
