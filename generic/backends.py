#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>

import dataclasses

from humanfriendly import parse_size

from django.conf import settings

from health_check.base import HealthCheck
from health_check.exceptions import ServiceUnavailable


@dataclasses.dataclass
class MyHealthCheck(HealthCheck):
    """自定义健康检查：监控 Redis 内存使用。"""

    async def run(self) -> None:
        for key in ["used_memory_rss", "used_memory"]:
            if settings.REDIS.info("memory")[key] > parse_size("1GiB"):
                raise ServiceUnavailable(f"{settings.REDIS} 内存过大")
