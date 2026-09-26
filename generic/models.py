#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Xiang Wang <ramwin@qq.com>

"""AI 会议室（council）的持久化模型。

设计原则：**会议室里的一切都是消息**。

一次 council 会话就是一个房间（room），房间名等于 ``session_id``。
DeepSeek、Kimi、Claude、人类都是这个房间里的「参与者」，他们说的话
统一落成 :class:`CouncilMessage`，并被 ``channel_layer.group_send``
广播给房间内所有订阅者。

因此「人工打断」不需要单独的状态机：它是人类发出的一条
``role="interrupt"`` 消息；「恢复循环」「加入建议」同理。这样既能
被 WebSocket 实时推送，也能被 HTTP 长轮询可靠地取回，还能完整回放。
"""

from django.db import models


class CouncilSession(models.Model):
    """一次 AI 会议室会话。

    ``session_id`` 同时也是 WebSocket 的房间名，必须满足
    ``generic/routing.py`` 里 ``(?P<room_name>\\w+)`` 的约束
    （只允许字母、数字、下划线）。
    """

    STATUS_ACTIVE = "active"
    STATUS_FINISHED = "finished"
    STATUS_CHOICES = [
        (STATUS_ACTIVE, "进行中"),
        (STATUS_FINISHED, "已结束"),
    ]

    session_id = models.CharField(
            "会话 ID（同时是房间名）", max_length=64, unique=True)
    task = models.TextField("任务描述", blank=True, default="")
    participants = models.JSONField("参与模型", default=list, blank=True)
    status = models.CharField(
            "状态", max_length=16, default=STATUS_ACTIVE, choices=STATUS_CHOICES)
    conclusion = models.TextField("最终结论", blank=True, default="")
    round_index = models.PositiveIntegerField("当前轮次", default=0)
    #: 下一个待分配的 seq。用「UPDATE ... SET next_seq = next_seq + 1」这种
    #: 单条原子语句分配序号，而不是 select_for_update()——因为项目默认用
    #: sqlite，而 sqlite 后端不支持 SELECT ... FOR UPDATE。
    next_seq = models.PositiveIntegerField("下一个消息序号", default=0)

    created_at = models.DateTimeField("创建时间", auto_now_add=True)
    updated_at = models.DateTimeField("更新时间", auto_now=True)

    class Meta:
        verbose_name = "AI 会议室会话"
        verbose_name_plural = verbose_name
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.session_id}({self.status})"


class CouncilMessage(models.Model):
    """会议室里的一条消息。

    ``seq`` 在同一个会话内从 1 开始单调递增，是客户端拉取增量、
    以及「这条人类打断针对哪一轮」的锚点。
    """

    # 常用角色，用常量而不是 choices，方便后续扩展新角色时不改迁移。
    ROLE_TASK = "task"                    # 任务下发
    ROLE_PLAN = "plan"                    # 计划
    ROLE_CODING = "coding"                # 编码
    ROLE_EXECUTE = "execute"              # 执行
    ROLE_EVALUATE = "evaluate"            # 评价
    ROLE_REVIEW = "review"                # 异模型评审意见
    ROLE_NOTE = "note"                    # 人类的普通备注
    ROLE_INTERRUPT = "interrupt"          # 人类按下打断/暂停
    ROLE_RESUME = "resume"                # 人类选择恢复循环
    ROLE_SUGGEST = "suggest"              # 人类加入自己的建议
    ROLE_HUMAN_WINDOW_OPEN = "human_window_open"      # 3 秒人工窗口开启
    ROLE_HUMAN_WINDOW_CLOSE = "human_window_close"    # 3 秒人工窗口关闭
    ROLE_SYSTEM = "system"                # 系统事件（开始/结束等）

    session = models.ForeignKey(
            CouncilSession, verbose_name="会话", related_name="messages",
            on_delete=models.CASCADE)
    seq = models.PositiveIntegerField("会话内序号")
    sender = models.CharField("发送者", max_length=64)
    role = models.CharField("角色", max_length=32, blank=True, default="")
    step = models.CharField("所属步骤", max_length=32, blank=True, default="")
    content = models.TextField("正文", blank=True, default="")
    payload = models.JSONField("结构化附加数据", default=dict, blank=True)

    created_at = models.DateTimeField("创建时间", auto_now_add=True)

    class Meta:
        verbose_name = "AI 会议室消息"
        verbose_name_plural = verbose_name
        ordering = ["seq"]
        constraints = [
            models.UniqueConstraint(
                    fields=["session", "seq"], name="unique_session_seq"),
        ]
        indexes = [
            models.Index(fields=["session", "seq"], name="council_msg_seq_idx"),
        ]

    def __str__(self):
        return f"#{self.seq} {self.sender}/{self.role}"

    def as_event(self):
        """转成广播给房间内所有订阅者的事件体。

        字段刻意与项目原有的 ``{"message": "..."}`` 推送格式保持兼容：
        ``generic/templates/generic/room.html`` 遇到不认识的 JSON 会整体
        格式化输出，所以老页面收到这些事件也不会崩。
        """
        return {
            "council": True,
            "event": "message",
            "session_id": self.session.session_id,
            "seq": self.seq,
            "sender": self.sender,
            "role": self.role,
            "step": self.step,
            "content": self.content,
            "payload": self.payload,
            "at": self.created_at.isoformat() if self.created_at else None,
        }
