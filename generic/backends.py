#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>

from humanfriendly import parse_size

from django.conf import settings

from health_check.backends import BaseHealthCheckBackend


class MyHealthCheckBackend(BaseHealthCheckBackend):
    #: The status endpoints will respond with a 200 status code
    #: even if the check errors.
    critical_service = False

    def check_status(self) -> None:
        # The test code goes here.
        # You can use `self.add_error` or
        # raise a `HealthCheckException`,
        # similar to Django's form validation.
        for key in ["used_memory_rss", "used_memory"]:
            if settings.REDIS.info("memory")[key] > parse_size("1GiB"):
                self.add_error(f"{settings.REDIS}内存过大")

    def identifier(self):
        return self.__class__.__name__  # Display name on the endpoint.
