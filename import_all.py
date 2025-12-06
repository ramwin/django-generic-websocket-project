#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>


from pathlib import Path


file_directory = Path(__name__).parent.absolute()
pwd = Path().absolute()
if file_directory == pwd:
    from django.conf import settings
else:
    raise ValueError(pwd, file_directory)
