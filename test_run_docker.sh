#!/bin/bash
# Xiang Wang(ramwin@qq.com)

set -ex

docker build . -t django-generic-websocket-project

docker run --rm -e WEBSOCKET_REDIS_PORT=6380 -d -p 7420:7419 django-generic-websocket-project
