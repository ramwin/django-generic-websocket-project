#!/bin/bash
# Xiang Wang(ramwin@qq.com)

set -ex


./docker/docker_build.sh

docker network create websocket-network

echo "start redis server"
docker run \
    --network websocket-network \
    --rm --name redis \
    -d -p 6380:6379 \
    --log-driver json-file \
    --log-opt max-size=10m \
    --log-opt max-file=3 \
    redis --save ""

echo "start websocket service"
# use docker network, so use 6379 directly
docker run --rm \
    -e WEBSOCKET_REDIS_HOST=redis \
    -e WEBSOCKET_REDIS_PORT=6379 \
    -d \
    -p 7420:7419 \
    --name websocket \
    --network websocket-network \
    --log-driver json-file \
    --log-opt max-size=10m \
    --log-opt max-file=3 \
    django-generic-websocket-project
    # --network host \
