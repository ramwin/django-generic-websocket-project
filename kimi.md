# django-generic-websocket-project — AI 阅读理解指南

> 一句话：这是一个基于 Django + Channels 的**通用 WebSocket 实时消息推送服务模板**，支持 HTTP 触发向 WebSocket 房间广播消息，并自带生产级多实例部署方案。

---

## 技术栈

- **Django 4.2.7** + **Django REST Framework**
- **Django Channels** + **Daphne**（ASGI 服务器）
- **channels_redis**（Redis Channel Layer，支撑多实例广播）
- **django-health-check**（`/ht/` 健康检查端点）
- **django-split-settings**（配置拆分）
- **python-dotenv**（环境变量管理）
- **Docker / Supervisor / Nginx**（生产部署）

---

## 目录结构

```
project/
  settings.py          # 主配置：Redis、CHANNEL_LAYERS、DEBUG、ALLOWED_HOSTS
  asgi.py              # ASGI 入口，含自定义 WebSocket 认证中间件
  urls.py              # 总路由：admin / ht / ws/generic/ / ws/pair/
  logging_settings.py  # 日志配置（由 split_settings 引入）
  wsgi.py              # WSGI 入口（备用）

generic/               # 核心应用（唯一业务应用）
  consumers.py         # WebSocket 消费者 ChatConsumer
  routing.py           # WebSocket 路由规则
  views.py             # HTTP API：MessageView（向房间发消息）
  urls.py              # HTTP 子路由：send-message/<room_name>/
  backends.py          # 自定义健康检查后端
  models.py            # 空（本项目无持久化模型）
  admin.py             # 空

tests/
  test_send_message.py      # CLI 工具：HTTP POST 发消息到房间
  test_receive_message.py   # CLI 工具：WebSocket 客户端订阅房间

deploy/
  supervisor.conf           # 3 个 Daphne 实例配置
  nginx/websocket.ramwin.com  # Nginx 负载均衡 + WebSocket 代理

docker/
  docker_build.sh / docker_run.sh / test_run_docker.sh

.env.shared            # 共享环境变量（非敏感）
.env                   # 本地环境变量（gitignored，可能含敏感信息）
requirements.txt
Dockerfile
runserver.sh
```

---

## 核心逻辑与数据流

### 1. WebSocket 连接流程

```
Client  ──ws──►  Nginx  ──ws──►  Daphne  ──►  project.asgi.application
                                                    │
                                                    ▼
                                          AllowedHostsOriginValidator
                                                    │
                                                    ▼
                                            MyAuthMiddleware
                                                    │
                                                    ▼
                                              URLRouter
                                                    │
                                                    ▼
                                        ChatConsumer.connect(room_name)
                                                    │
                              ┌─────────────────────┴─────────────────────┐
                              ▼                                           ▼
                    channel_layer.group_add("all_user")     channel_layer.group_add(room_name)
```

- 连接建立后，客户端自动进入两个组：
  - `"all_user"`：全员广播组（可用于系统通知）
  - `"<room_name>"`：业务房间组

### 2. 消息下行（HTTP → WebSocket 广播）

```
Client  ──POST──►  /ws/generic/send-message/<room_name>/
                              │
                              ▼
                    MessageView.post(request, room_name)
                              │
                              ▼
                    async_to_sync(channel_layer.group_send)(
                        room_name,
                        {"type": "message", "data": request.data}
                    )
                              │
                              ▼
                    Redis Channel Layer 广播到该 room 的所有 consumer
                              │
                              ▼
                    ChatConsumer.message(event) ──► send(text_data=json.dumps(data))
```

这是本项目的**核心模式**：外部系统通过 HTTP API 向指定房间推送消息，所有订阅该房间的 WebSocket 客户端实时收到。

### 3. 消息上行（WebSocket → 同房间广播）

客户端发送 JSON → `ChatConsumer.receive(text_data)` → `channel_layer.group_send(room_group_name, ...)` → 同房间所有客户端收到。

---

## 关键文件详解

### `project/asgi.py`

- **自定义 `MyAuthMiddleware`**：Django Channels 未内置便捷的 WebSocket 认证，这里手写了一个 ASGI 中间件。
  - 从 `Authorization` Header 或 Query String `?token=xxx` 提取 token。
  - 目前硬编码了示例 token：`tokenabc` → `User(id=1, username="abc")`，`token123` → `User(id=1, username="123")`。
  - 鉴权失败时返回 `AnonymousUser()`，不会强制断开；是否拒绝由 Consumer 控制。
- **路由组合**：`ProtocolTypeRouter` 区分 HTTP 和 WebSocket。

### `generic/consumers.py`

- **`ChatConsumer(AsyncWebsocketConsumer)`**
  - `need_auth = False`：当前不强制认证，可改为 `True` 使未登录用户断开（close code 3000）。
  - `connect`：加入 `all_user` 组和 `<room_name>` 组，然后 `accept()`。
  - `disconnect`：从两组中移除。
  - `receive`：收到客户端 JSON，向 `<room_name>` 组广播。
  - `message`：处理来自 Channel Layer 的组消息，回写给客户端。

### `generic/views.py`

- **`MessageView(APIView)`**
  - `POST`：核心推送接口，接收任意 JSON body，通过 Channel Layer 广播到指定房间。
  - `GET`：调试接口，返回进程启动命令、请求头、进程 PID。

### `project/settings.py`

- 配置加载顺序：`.env.shared` → `.env`（后者覆盖前者）。
- `REDIS_HOST` / `REDIS_PORT`：从环境变量或 `.env` 读取，默认 `localhost:6379`。
- 启动时会尝试 `REDIS.get('foo')`，Redis 连不上直接抛异常终止启动。
- `CHANNEL_LAYERS` 使用 `channels_redis.core.RedisChannelLayer`。
- `INSTALLED_APPS` 包含 `daphne`（必须放第一）、`generic`、`health_check`。

---

## 环境变量

| 变量 | 来源 | 说明 |
|------|------|------|
| `DEBUG` | `.env.shared` / `.env` | `True` 开启调试模式 |
| `ALLOWED_HOSTS` | `.env.shared` / `.env` | 分号 `;` 分隔多个 host |
| `WEBSOCKET_REDIS_HOST` | `.env.shared` / `.env` / 环境变量 | Redis 地址，默认 `localhost` |
| `WEBSOCKET_REDIS_PORT` | `.env.shared` / `.env` / 环境变量 | Redis 端口，默认 `6379` |
| `BASE_URL` | `.env.shared` / `.env` | HTTP 测试脚本使用的 base URL |
| `BASE_WSS_URL` | `.env.shared` / `.env` | WebSocket 测试脚本使用的 base URL |

---

## 运行与测试

```bash
# 安装依赖
pip install -r requirements.txt

# 启动（开发）
python manage.py runserver 0.0.0.0:57419

# 测试发消息
python tests/test_send_message.py --room room_123

# 测试收消息
python tests/test_receive_message.py --room room_123 --auth token123
```

> **注意**：`test_send_message.py` 里请求的 URL 是 `/ws/generic/send-message/{room}/`，但 `generic/urls.py` 里注册的 room 参数是 `slug` 类型。如果 room 名包含连字符或下划线以外的特殊字符，可能需要调整路由正则。

---

## 生产部署架构

```
                    ┌──────────────────┐
                    │      Nginx       │
                    │  (负载均衡+代理)  │
                    └────────┬─────────┘
                             │
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
    ┌────────────┐   ┌────────────┐   ┌────────────┐
    │  Daphne    │   │  Daphne    │   │  Daphne    │
    │  :57420    │   │  :57421    │   │  :57422    │
    └────────────┘   └────────────┘   └────────────┘
           │                 │                 │
           └─────────────────┼─────────────────┘
                             ▼
                    ┌──────────────────┐
                    │      Redis       │
                    │  (Channel Layer) │
                    └──────────────────┘
```

- **多实例通过 Redis Channel Layer 共享连接状态**，任何 Daphne 实例都能向任意 room 广播。
- **Supervisor** 管理多个 Daphne 进程（见 `deploy/supervisor.conf`）。
- **Nginx** 配置示例中展示了按 URL 前缀/后缀分发到不同后端的策略（如 `room_a-z` → 57420，`room_A-Z` → 57421），可用于特定业务场景的水平扩展。
- **Docker**：`Dockerfile` 基于官方 Python 镜像，最终启动命令为 `daphne -b 0.0.0.0 -p 7419 project.asgi:application`。

---

## 常见修改点（扩展指南）

如果你要基于此项目做二次开发，优先改这几个地方：

| 需求 | 修改文件 | 说明 |
|------|---------|------|
| 接入真实用户认证 | `project/asgi.py` | 替换 `MyAuthMiddleware.get_user()` 里的硬编码 token 逻辑 |
| 强制 WebSocket 认证 | `generic/consumers.py` | `need_auth = True` |
| 修改消息格式/业务逻辑 | `generic/consumers.py` | `receive()` / `message()` |
| 扩展 HTTP 推送接口 | `generic/views.py` | `MessageView.post()` |
| 增加持久化（消息记录） | `generic/models.py` + `consumers.py` | 在 `receive()` 或 `message()` 中存库 |
| 增加新的 WebSocket 路由 | `generic/routing.py` + 新 Consumer | 仿照 `ChatConsumer` |
| 调整日志 | `project/logging_settings.py` | split_settings 已引入 |
| 调整健康检查逻辑 | `generic/backends.py` | 继承 `HealthCheck` dataclass，实现 `run()` 方法 |

---

## 编码约定

- 使用 **4 空格缩进**。
- 字符串引号：配置和路由多用单引号，业务代码多用双引号，未强制统一。
- 注释以中文为主（原项目作者习惯）。
- pylint 配置较宽松，部分文件顶部有 `pylint: disable=...`。
- 模型/Admin 当前为空，项目不依赖数据库业务表，但 Django 的 auth/session 迁移仍需正常执行。

---

## 注意事项

1. **当前没有模型迁移的压力**，但 `db.sqlite3` 已存在，说明至少跑过 `migrate`。
2. **Redis 是启动强依赖**：`settings.py` 在导入期就会连接 Redis，若 Redis 未启动，Django 会直接抛异常退出。
3. **WSGI 配置存在但基本不用**：本项目以 ASGI 为主，Daphne 为生产服务器。
4. **测试脚本依赖 `click` 和 `websocket-client`**，但 `click` 未在 `requirements.txt` 中列出，运行测试前若报错需手动安装。
