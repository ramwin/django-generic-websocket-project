#!/bin/bash
# Xiang Wang(ramwin@qq.com)


docker run \
    --name ws \
    -d \
    -p 7420:7419 \
    --log-driver json-file \
    --log-opt max-size=10m \
    --log-opt max-file=3 \
    ws
