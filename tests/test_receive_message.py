#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>

# pylint: disable=unused-argument, missing-function-docstring


"""
test if websocket server is working
"""


import time
import logging
import json
import rel

import click
import websocket
from dotenv import dotenv_values


logging.basicConfig(level=logging.INFO)
CONFIG = {
        **dotenv_values(".env.shared"),
        **dotenv_values(".env"),
}
BASE_WSS_URL = CONFIG["BASE_WSS_URL"]
LOGGER = logging.getLogger(__name__)


def on_message(ws, message):
    data = json.loads(message)
    LOGGER.info("here comes message: %s", data)
    time.sleep(0.03)
    if data.get("action") == "raise":
        LOGGER.info("get raise action")
        raise ValueError

def on_error(ws, error, **kwargs):
    LOGGER.info("here comes error: %s, %s, %s",
                ws, error, kwargs)
    ws.close()

def on_close(ws, close_status_code, close_msg):
    print("### closed ###")

def on_open(ws):
    print("Opened connection")

@click.command()
@click.option("--room", default="room_123") 
def main(room):
    websocket.enableTrace(True)
    ws_app = websocket.WebSocketApp(
            f"{BASE_WSS_URL}/ws/generic/{room}/",
            on_open=on_open,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
    )
    ws_app.run_forever()

if __name__ == "__main__":
    main()
