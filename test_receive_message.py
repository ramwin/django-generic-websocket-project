#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>

# pylint: disable=unused-argument, missing-function-docstring


"""
test if websocket server is working
"""


import rel

from dotenv import dotenv_values
import websocket


CONFIG = {
        **dotenv_values(".env.shared"),
        **dotenv_values(".env"),
}
BASE_WSS_URL = CONFIG["BASE_WSS_URL"]


def on_message(ws, message):
    print(message)

def on_error(ws, error):
    print(error)

def on_close(ws, close_status_code, close_msg):
    print("### closed ###")

def on_open(ws):
    print("Opened connection")

if __name__ == "__main__":
    websocket.enableTrace(True)
    ws_app = websocket.WebSocketApp(
            f"{BASE_WSS_URL}/ws/generic/room123/",
            on_open=on_open,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close)

    ws_app.run_forever(dispatcher=rel, reconnect=5)
    rel.signal(2, rel.abort)  # Keyboard Interrupt
    rel.dispatch()
