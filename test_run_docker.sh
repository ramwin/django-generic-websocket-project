#!/bin/bash
# Xiang Wang(ramwin@qq.com)

set -ex

./docker_build.sh

docker run --rm \
    -e WEBSOCKET_REDIS_PORT=6380 \
    -d \
    -p 7420:7419 \
    --network host \
    django-generic-websocket-project
