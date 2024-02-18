#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>


"""
test if the webserver is working
"""


import requests
from dotenv import dotenv_values


CONFIG = {
        **dotenv_values(".env.shared"),
        **dotenv_values(".env"),
}
BASE_URL = CONFIG["BASE_URL"]


def main():
    """send a message"""
    res = requests.post(
            f"{BASE_URL}/generic/send-message/room123/", {123: 456}
    )
    if res.status_code != 200:
        raise Exception("webserver not working")


if __name__ == "__main__":
    main()
