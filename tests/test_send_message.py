#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>


"""
test if the webserver is working
"""


import logging
import time

import click
import requests
from dotenv import dotenv_values


logging.basicConfig(level=logging.INFO)
CONFIG = {
        **dotenv_values(".env.shared"),
        **dotenv_values(".env"),
}
BASE_URL = CONFIG["BASE_URL"]
LOGGER = logging.getLogger(__name__)


@click.command()
@click.option("--room", default="room_123", help="发送消息到哪个房间")
def main(room: str):
    """send a message"""
    websocket_url = f"{BASE_URL}/ws/generic/send-message/{room}/"
    LOGGER.info("websocket_url: %s", websocket_url)
    res = requests.post(
            websocket_url, {"room": room}
    )
    res.raise_for_status()


def send_many_message():
    for i in range(1):
        room = "room_a"
        websocket_url = f"{BASE_URL}/ws/generic/send-message/{room}/"
        LOGGER.info("websocket_url: %s", websocket_url)
        res = requests.post(
            websocket_url, {"room": room, "i": i}
        )
        LOGGER.info(res.text)
        res.raise_for_status()


if __name__ == "__main__":
    main()
