#!/bin/bash
# Xiang Wang(ramwin@qq.com)

set -ex

docker build . -t django-generic-websocket-project --network host
