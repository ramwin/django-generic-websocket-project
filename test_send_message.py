#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>


"""
test if the webserver is working
"""


import logging
import time

import requests
from dotenv import dotenv_values


logging.basicConfig(level=logging.INFO)
CONFIG = {
        **dotenv_values(".env.shared"),
        **dotenv_values(".env"),
}
BASE_URL = CONFIG["BASE_URL"]
LOGGER = logging.getLogger(__name__)


def main():
    """send a message"""
    websocket_url = f"{BASE_URL}/ws/generic/send-message/room123/"
    LOGGER.info("websocket_url: %s", websocket_url)
    res = requests.post(
            websocket_url, {123: 456}
    )
    if res.status_code != 200:
        print(res.text)
        raise Exception("webserver not working")
    time.sleep(1)
    res = requests.post(
            f"{BASE_URL}/ws/generic/send-message/room123/", {"action": "raise"}
    )


if __name__ == "__main__":
    main()
