from django.apps import AppConfig
from health_check.plugins import plugin_dir


class GenericConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'generic'

    def ready(self):
        from .backends import MyHealthCheckBackend
        plugin_dir.register(MyHealthCheckBackend)
