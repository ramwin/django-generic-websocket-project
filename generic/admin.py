#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>

"""把 AI 会议室的两张表注册进 Django admin。

设计前提：**会议室数据只追加、不可改。**

- ``CouncilMessage.seq`` 是长轮询游标的锚点（客户端记着「我读到第几条」），
  改一条、删中间一条，都会让所有在等的客户端游标错乱。
- ``CouncilSession.next_seq`` 是并发分配 seq 的依据（见 ``council.post_message``
  的原子自增），在 admin 里改它等于破坏发号器。

所以这里一律只读，连 add/delete 的入口都不给 —— 注意**只设 readonly_fields
是不够的**，它只影响表单渲染，``/add/`` 和删除入口照旧存在。
"""

from django.contrib import admin
from django.db.models import Count
from django.urls import reverse
from django.utils.html import format_html

from generic.models import CouncilMessage, CouncilSession


def model_field_names(model):
    """模型自己的全部字段名。

    ``_meta.fields`` 只含具体字段，不含反向关系与多对多 —— 对本模型够用。
    """
    return [field.name for field in model._meta.fields]


def describe_participant(item):
    """把 participants 里的一个元素渲染成短文本。

    本项目自己写进去的是 ``list[str]``（见 ``council.create_session``），
    但这个字段是 JSONField、HTTP 接口收任意 JSON，外部客户端完全可能塞进
    ``list[dict]``。直接 ``"、".join(...)`` 遇到 dict 会抛 TypeError，
    而 changelist 渲染期抛异常整个页面就 500 了。
    """
    if isinstance(item, dict):
        for key in ("name", "label", "model", "id", "adapter"):
            # 不能用真值判断：id 完全可能是 0，那也是一个有效值，
            # 用 `if item.get(key)` 会把它跳过、退化成打印整个 dict。
            if key in item and item[key] is not None:
                return str(item[key])
        return str(item)
    return str(item)


def render_participants(participants):
    """把 JSONField 里的 participants 渲染成一行文本。"""
    if not participants:
        return "—"
    if isinstance(participants, dict):
        items = list(participants.keys())
    elif isinstance(participants, (list, tuple)):
        items = list(participants)
    else:
        return str(participants)
    return "、".join(describe_participant(item) for item in items)


class ReadOnlyAdmin(admin.ModelAdmin):
    """只给看，不给增删改。

    ``readonly_fields`` 管不到增删入口，所以三个权限方法必须显式关掉。
    刻意**不实现** ``has_view_permission``：它的默认实现查的是模型层权限，
    与这里的 ``has_change_permission`` 无关；显式返回 True 会把会议记录
    放开给所有 staff 用户，那是权限放宽，比默认行为更糟。
    """

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(CouncilSession)
class CouncilSessionAdmin(ReadOnlyAdmin):
    list_display = (
        "session_id", "status", "round_index",
        "participants_text", "message_count_display", "created_at",
    )
    list_filter = ("status", "created_at")
    search_fields = ("session_id", "task")
    ordering = ("-created_at",)
    # 生成式只会拿到真实字段，三个展示方法必须**显式相加**，否则它们
    # 不会出现在详情页上（latest_messages_link 就白做了）。
    readonly_fields = model_field_names(CouncilSession) + [
        "participants_text", "message_count_display", "latest_messages_link",
    ]

    def get_queryset(self, request):
        # 不覆盖 get_queryset 的话，list_display 里的 message_count 既不存在、
        # 也没法按它排序。
        return super().get_queryset(request).annotate(
            message_count=Count("messages"))

    @admin.display(description="参与模型")
    def participants_text(self, obj):
        return render_participants(obj.participants)

    @admin.display(description="消息数", ordering="message_count")
    def message_count_display(self, obj):
        return obj.message_count

    @admin.display(description="消息")
    def latest_messages_link(self, obj):
        # 刻意不用 inline：长会话会把详情页一次渲染上千条。这里只给一个
        # 过滤好的跳转链接，列表页自己有分页。
        url = reverse("admin:generic_councilmessage_changelist")
        return format_html(
            '<a href="{}?session__id__exact={}">查看该会话的消息</a>',
            url, obj.pk)


@admin.register(CouncilMessage)
class CouncilMessageAdmin(ReadOnlyAdmin):
    list_display = (
        "seq", "session_link", "sender", "role", "step",
        "content_preview", "created_at",
    )
    list_filter = ("role", "sender", "step", "session")
    # 加 session__session_id 之后，搜索框直接输会话号就能过滤；
    # 上量之后侧栏的 session 下拉可以拿掉（评审建议）。
    search_fields = ("content", "sender", "session__session_id")
    # CouncilMessage.Meta.ordering 是 ["seq"]，但跨会话按 seq 排序毫无意义，
    # 同一个 seq 在每个会话里都有一份。admin 里必须带上 session。
    ordering = ("session", "seq")
    list_per_page = 50
    readonly_fields = model_field_names(CouncilMessage) + [
        "session_link", "content_preview",
    ]

    def get_queryset(self, request):
        # session_link 每行都要读 obj.session.session_id，而 admin 不会为
        # list_display 里的方法自动 select_related —— 不补这一行就是
        # 每页 50 次额外查询（评审指出，实测确认）。
        return super().get_queryset(request).select_related("session")

    @admin.display(description="会话")
    def session_link(self, obj):
        url = reverse(
            "admin:generic_councilsession_change", args=[obj.session_id])
        return format_html('<a href="{}">{}</a>', url, obj.session.session_id)

    @admin.display(description="正文")
    def content_preview(self, obj):
        text = (obj.content or "").strip()
        if text == "":
            return "—"
        return text if len(text) <= 80 else f"{text[:80]}…"
