"""
URL configuration for project project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/4.2/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.urls import path, include
from health_check.views import HealthCheckView

from generic.backends import MyHealthCheck


class CustomHealthCheckView(HealthCheckView):
    """扩展默认健康检查视图，加入自定义 Redis 内存检查。"""

    checks = (
        "health_check.checks.Cache",
        "health_check.checks.Database",
        "health_check.checks.DNS",
        "health_check.checks.Mail",
        "health_check.checks.Storage",
        MyHealthCheck,
    )


urlpatterns = [
    path('admin/', admin.site.urls),
    path('ht/', CustomHealthCheckView.as_view(), name='health_check_home'),
    path('ht/<str:subset>/', CustomHealthCheckView.as_view(), name='health_check_subset'),
    path('ws/generic/', include("generic.urls")),
    path('ws/pair/', include("generic.urls")),
]
