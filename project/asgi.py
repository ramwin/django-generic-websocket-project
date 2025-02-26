"""
ASGI config for project project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/4.2/howto/deployment/asgi/
"""

import logging
import os
from typing import Union
from urllib.parse import parse_qs

from redis import Redis

from django.core.asgi import get_asgi_application
from django.contrib.auth.models import User, AnonymousUser
from channels.auth import AuthMiddlewareStack
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.security.websocket import AllowedHostsOriginValidator

from generic.routing import websocket_urlpatterns

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "project.settings")
django_asgi_app = get_asgi_application()
REDIS = Redis(decode_responses=True)
LOGGER = logging.getLogger("generic")


class MyAuthMiddleware:

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        LOGGER.info("prepare to auth user: %s %s %s %s", self, scope, receive, send)
        LOGGER.info("headers: %s %s", scope["headers"], type(scope["headers"]))
        scope["user"] = AnonymousUser()
        for key, value in scope["headers"]:
            if key == b"authorization":
                scope["user"] = self.get_user(value)
        LOGGER.info("登录的query: %s", scope['query_string'])
        for query_string, query_values in parse_qs(scope['query_string']).items():
            if query_string == b"token":
                scope["user"] = self.get_user(query_values[0])
        await self.app(scope, receive, send)

    def get_user(self, token: bytes) -> Union[User, AnonymousUser]:
        # TODO here you need to generate user from token
        # e.g store the token in redis and get user info from redis
        if token == b"tokenabc":
            return User(id=1, username="abc")
        if token == b"token123":
            return User(id=1, username="123")
        return AnonymousUser()


application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        "websocket": AllowedHostsOriginValidator(
            MyAuthMiddleware(URLRouter(websocket_urlpatterns))
        ),
    }
)
