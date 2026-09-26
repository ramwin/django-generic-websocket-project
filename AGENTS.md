# AGENTS.md — django-generic-websocket-project

> 本文件面向 AI 编码代理，假设读者对本项目零了解。所有内容均基于对仓库实际代码的核对（2026-09 时点）。

## 一、项目概述

一个基于 **Django + Django Channels** 的通用 WebSocket 实时消息推送服务模板。核心模式：**外部系统通过 HTTP API 向指定"房间"广播消息，所有订阅该房间的 WebSocket 客户端实时收到**。默认用内存 channel layer，单进程即可跑、不需要 Redis；多实例（`CHANNEL_LAYER_BACKEND=redis`）通过 Redis Channel Layer 共享状态，可水平扩展。

- 作者：Xiang Wang <ramwin@qq.com>，MIT License
- 业务持久化模型只有 **AI 会议室**两张表（`generic/models.py` 的 `CouncilSession` / `CouncilMessage`）；`admin.py` 仍是空占位，`tests.py` 已改成真正的单元测试
- 数据库默认 sqlite3（`db.sqlite3`）：除 Django 自带的 auth/session/admin 外，还存会议室会话与消息
- 仓库里还带了一个可选组件 **`dsh-plugin/`（AI Council）**：把本项目当成多方（DeepSeek / Kimi / Claude / 人类）共享的评审通道，供 DeepSeek Harness 调用。**它不影响项目本身的独立部署**——插件只是本项目 HTTP 接口的一个客户端

## 二、技术栈与关键依赖

依赖清单只有 `requirements.txt`（**无版本锁定**），无 pyproject.toml / setup.py / pytest.ini 等：

| 依赖 | 用途 |
|------|------|
| `django`（settings 头部注明基于 4.2.7 生成） | Web 框架 |
| `channels[daphne]` | ASGI 服务与 WebSocket consumer，生产服务器为 Daphne |
| `channels_redis` | 可选依赖，仅 `CHANNEL_LAYER_BACKEND=redis` 时需要（**未列入** requirements.txt，需手动 `pip install channels_redis`） |
| `djangorestframework` | `MessageView` 继承 `APIView` |
| `django-health-check` | `/ht/` 健康检查端点 |
| `django-split-settings` | `settings.py` 末尾 `include("logging_settings.py")` 拆分日志配置 |
| `python-dotenv` | 读取 `.env.shared` / `.env` |
| `colorlog` | 控制台彩色日志 handler |
| `humanfriendly` | 健康检查中 `parse_size("1GiB")` |
| `websocket-client`、`rel` | 测试脚本里的 WebSocket 客户端 |

**注意**：`tests/` 下的脚本还依赖 `click` 和 `requests`，但二者**未列入** `requirements.txt`，运行测试前可能需要手动安装；`settings.py` 里 `from redis import Redis` 只在 `CHANNEL_LAYER_BACKEND=redis` 分支执行，默认的 memory 后端既不装也不需要 `redis` / `channels_redis` 包（`django-health-check` 对缺失的 `redis` 包会自行降级）。

## 三、目录结构

```
project/                  # Django 项目包（配置层）
  settings.py             # 主配置：CONFIG 加载、CHANNEL_LAYER_BACKEND 分支（memory/redis）、CHANNEL_LAYERS
  asgi.py                 # ASGI 入口 + 自定义 MyAuthMiddleware + 路由组合
  urls.py                 # 总路由：admin/、ht/、ws/generic/
  logging_settings.py     # 日志配置（被 split_settings 引入，运行时写 log/ 目录）
  wsgi.py                 # WSGI 入口（备用，生产走 ASGI/Daphne）

generic/                  # 唯一业务应用
  consumers.py            # ChatConsumer（AsyncWebsocketConsumer）
  routing.py              # WebSocket 路由：ws/generic/<room_name>/
  views.py                # MessageView：HTTP 推送接口 + 调试 GET；RoomView：浏览器会话查看页面
  urls.py                 # HTTP 子路由：send-message/<slug:room_name>/、room/<room_name>/
  templates/generic/room.html  # 浏览器端会话查看页面（HTML + 内联 JS，参考 channels 官方教程 chat/room.html）
  backends.py             # MyHealthCheck：自定义 Redis 内存健康检查（memory 后端下自动跳过）
  models.py               # CouncilSession / CouncilMessage：AI 会议室（唯一有业务模型的模块）
  council.py              # AI 会议室服务层：分配 seq、落库、复用 channel layer 广播、长轮询
  council_views.py        # AI 会议室 HTTP 接口 + 人类动作接口 + 会议室页面视图
  council_urls.py         # AI 会议室路由，挂在 /ws/generic/council/ 下
  templates/generic/council.html  # AI 会议室页面：消息流 + 3 秒人工打断条
  tests.py                # 30 项单元测试：会议室接口 + 原有 HTTP/WS 能力回归
  admin.py                # 空占位
  migrations/             # 0001_initial.py：会议室两张表

tests/                    # 端到端冒烟测试脚本（CLI 工具，非单元测试）
  test_send_message.py    # click CLI：HTTP POST 发消息到房间
  test_receive_message.py # click CLI：WebSocket 客户端订阅房间
  council_smoke.py        # click CLI：AI 会议室全链路冒烟（含并发 seq 校验）
  council_multiprocess_smoke.sh  # 多实例 + redis channel layer 冒烟（生产部署形态）
  council_page.test.mjs   # 会议室页面内联 JS 的测试（最小 DOM 桩，13 项）

dsh-plugin/               # DeepSeek Harness 插件：AI Council（见 dsh-plugin/README.md）
  package.json            # 插件包声明，dsh.bundle.patch 指向 cordis.patch.yml
  cordis.patch.yml        # 把插件挂进 profile 的 host 组合（含默认配置）
  lib/                    # 纯 ESM，无构建步骤；只有 index.js/tools.js 依赖 DSH
  test/                   # 88 项单元测试，node --test，不需要 DSH
  scripts/verify-dsh-mount.sh  # 验证 DSH 能否装载本插件（一次性 DSH home，可重复跑）
  scripts/e2e-demo.mjs    # 端到端演示：真服务 + 真 3 秒 + 真 Kimi
  scripts/live-check.mjs  # 链路自检：插件 ↔ 真实服务（模型换成桩，不耗额度）

deploy/
  supervisor.conf         # 3 个 Daphne 实例（端口 57420/57421/57422）
  nginx/websocket.ramwin.com  # Nginx 按房间名前缀/后缀分流 + WebSocket 代理示例

docker/                   # docker_build.sh / docker_run.sh / test_run_docker.sh
Dockerfile / docker-compose.yml
.env.shared               # 共享环境变量（已入库）
.env                      # 本地环境变量（gitignored，可能含敏感信息）
runserver.sh              # 开发启动脚本（daphne）
import_all.py             # 小工具：校验必须在项目根目录下运行
log/                      # 运行期日志输出目录（由 logging_settings.py 自动创建）
```

## 四、运行架构与核心数据流

### WebSocket 连接链路

```
Client ──ws──► AllowedHostsOriginValidator ──► MyAuthMiddleware ──► URLRouter
      ──► ChatConsumer.connect(room_name)
            ├─ group_add("all_user", ...)      # 全员广播组
            ├─ group_add(<room_name>, ...)     # 业务房间组
            └─ accept()
```

- `project/asgi.py` 的 `MyAuthMiddleware`：从 `Authorization` Header 或 query string `?token=xxx` 提取 token，**硬编码示例逻辑**——`tokenabc` → `User(username="abc")`、`token123` → `User(username="123")`，否则 `AnonymousUser()`。鉴权失败不强制断开。
- `generic/consumers.py` 的 `ChatConsumer`：`need_auth = False`（置 `True` 时未认证用户被 close code 3000 拒绝）；`receive()` 把客户端 JSON 广播给同房间；`message()` 把 Channel Layer 事件回写给客户端。

### 消息下行（本项目核心模式）

```
HTTP POST /ws/generic/send-message/<room_name>/
  ──► generic/views.py MessageView.post
  ──► async_to_sync(channel_layer.group_send)(room_name, {"type": "message", "data": request.data})
  ──► CHANNEL_LAYERS 广播（默认 InMemoryChannelLayer；配置成 redis 则走 RedisChannelLayer）──► ChatConsumer.message() ──► send(text_data=...)
```

- `MessageView.get` 是调试接口，返回启动命令、请求头、进程 PID。
- 注意 URL 参数类型不一致：HTTP 路由用 `<slug:room_name>`（`generic/urls.py`），WS 路由用 `(?P<room_name>\w+)`（`generic/routing.py`）。房间名含连字符/点号等特殊字符时，两边匹配行为不同，修改路由时需同步考虑。
- `project/urls.py` 只把 `generic.urls` 挂在 `/ws/generic/` 下，HTTP 推送和 WS 连接共用这一个前缀（历史上还有一个 `/ws/pair/` 前缀，已移除）。
- 广播实际走 `CHANNEL_LAYERS`：默认 `channels.layers.InMemoryChannelLayer`（只在单进程内广播，不需要 redis），`CHANNEL_LAYER_BACKEND=redis` 时用 `channels_redis.core.RedisChannelLayer`，多实例才能共享广播。

### 浏览器端会话查看页面

```
浏览器 GET /ws/generic/room/<room_name>/
  ──► generic/views.py RoomView（TemplateView）
  ──► generic/templates/generic/room.html
  ──► 页面内联 JS 连接 ws://<host>/ws/generic/<room_name>/?token=<token>
  ──► 展示房间内所有消息（HTTP 推送 + 其他客户端发送），也可在页面内发消息
```

- 页面地址上的 `?token=xxx` 会由 JS 透传给 WebSocket，交给 `MyAuthMiddleware` 处理；`ChatConsumer.need_auth` 未开启时 token 可选。
- 房间名用 `\w+` 匹配（与 `generic/routing.py` 的 WS 路由一致），含连字符的房间名页面直接 404，避免「页面能打开但 WebSocket 连不上」。
- HTML/CSS/JS 全部内联在模板里，不经过 `{% static %}`，所以 daphne 直连或 nginx 都不需要额外的静态文件配置；JS 渲染消息时兼容两种格式：`{"message": "..."}` 显示文本，其余 JSON 整体格式化输出。
- JS 在连接断开后按指数退避自动重连（最长 30 秒），close code 3000（鉴权拒绝）不重连。

### 健康检查

- `GET /ht/`（及 `/ht/<subset>/`）走 `CustomHealthCheckView`，含 Cache/Database/DNS/Mail/Storage + 自定义 `MyHealthCheck`。
- `generic/backends.py` 的 `MyHealthCheck`：Redis `used_memory_rss` 或 `used_memory` 超过 1GiB 时抛 `ServiceUnavailable`。

### AI 会议室（council，本仓库新增的第二个能力）

在原有「广播」能力之上加了一层**持久化的多方评审通道**：DeepSeek（编码代理）、
Kimi / Claude（异模型）、人类三方把发言都投进同一个房间。

**一句话设计**：会议室里的一切都是消息。没有额外的状态机——「人类打断」
就是一条 `role="interrupt"` 的消息，「3 秒窗口关闭」就是一条
`role="human_window_close"` 的消息。这样它既能被 WebSocket 实时推送，
也能被 HTTP 长轮询可靠取回，还能完整回放。

```
POST /ws/generic/council/sessions/<sid>/messages/   ← 发言（模型/系统）
POST /ws/generic/council/sessions/<sid>/human/      ← 人类动作：interrupt/resume/suggest/note
GET  /ws/generic/council/sessions/<sid>/messages/   ← 拉增量，支持 ?after=&wait=&roles= 长轮询
GET  /ws/generic/council/room/<sid>/                ← 会议室页面（含 3 秒打断条）
        │
        └─► council.broadcast() ──► channel_layer.group_send(sid, ...) ──► ChatConsumer ──► 页面 / 插件
```

- `sid`（session_id）**同时就是房间名**，必须匹配 `\w+`——`council_urls.py` 和 `routing.py`
  用的是同一套正则，就是为了避免「页面能打开但 WebSocket 连不上」。
- `seq` 的分配**不能**用 `select_for_update()`：项目默认 sqlite 不支持 `SELECT ... FOR UPDATE`，
  会直接抛 `NotSupportedError`。改用 `UPDATE ... SET next_seq = next_seq + 1` 的原子自增
  （见 `council.post_message`）。
- 会议室消息复用**原有**的 `channel_layer.group_send` 原语，所以 `CHANNEL_LAYER_BACKEND=redis`
  的多实例部署、原有 `room.html`、原有 `ChatConsumer` 全都不受影响。
- 「3 秒人工打断窗口」的实现只有一个技巧：插件侧用一次
  `GET ...?after=N&wait=3&roles=interrupt,resume,suggest` 的长轮询等这 3 秒。
  有人打断就立刻返回，没人打断就超时返回。**不需要定时器，也不需要外部调度器。**
- 房间名约束在 `council_views.SESSION_ID_PATTERN` 与会话创建校验里都做了，
  自定义 `session_id` 必须满足 `\w+`。

`dsh-plugin/` 是本仓库里的可选组件，通过上面这些**公开 HTTP 接口**与本服务交互，
因此**本服务可以完全脱离 DSH 单独部署**（docker / supervisor / runserver 三种方式都不变）。

## 五、配置与环境变量

`project/settings.py` 的加载顺序：`.env.shared` → `.env`（后者覆盖前者），均为 `dotenv_values` 读取的**文件**，然后 `CONFIG.get(...) or os.environ.get(...)`——**即 .env 文件优先级高于进程环境变量**。Docker 部署时若构建上下文里存在 `.env`，会被 `COPY ./ ./` 打入镜像并使 compose 注入的环境变量失效，需注意。

| 变量 | 读取处 | 说明 |
|------|--------|------|
| `DEBUG` | settings.py | 值为字符串 `"True"` 才开启 |
| `ALLOWED_HOSTS` | settings.py | 分号 `;` 分隔多个 host |
| `CHANNEL_LAYER_BACKEND` | settings.py | channel layer 后端：`memory`（默认，单进程内广播，不需要 redis）或 `redis`（多实例共享广播，需要 redis 服务和 `channels_redis`）；其他值启动即报 `ImproperlyConfigured` |
| `WEBSOCKET_REDIS_HOST` / `WEBSOCKET_REDIS_PORT` | settings.py | 默认 `localhost:6379`；compose 中指向 `redis` 服务 |
| `BASE_URL` / `BASE_WSS_URL` | tests/ 脚本 | HTTP / WS 测试目标地址（见 `.env.shared`） |
| compose 专用 | docker-compose.yml | `WEBSOCKET_PORT`（默认 7420）、`WEBSOCKET_INTERNAL_PORT`（默认 7419）、`DOCKER_NETWORK_NAME`、`*_CONTAINER_NAME`，示例见 `.env.compose.example` |

**Redis 默认不再是启动依赖**：只有 `CHANNEL_LAYER_BACKEND=redis` 时，`settings.py` 才在**导入期**创建 Redis 连接并执行 `REDIS.get('foo')`，连不上直接抛异常终止启动；此时才会有 `settings.REDIS`（`generic/backends.py` 的 Redis 内存健康检查据此判断是否跳过）。默认的 memory 后端全程不碰 redis。

其他配置要点：

- `INSTALLED_APPS` 中 `daphne` 必须排第一（Channels 要求，保证开发 runserver 也走 ASGI）。
- `CHANNEL_LAYERS` 由 `CHANNEL_LAYER_BACKEND` 决定：`memory` → `channels.layers.InMemoryChannelLayer`，`redis` → `channels_redis.core.RedisChannelLayer`。用 memory 时启动日志会打一条 WARNING 提醒只支持单进程。
- 日志由 `logging_settings.py` 配置：按级别轮转写 `log/debug.log`、`info.log`、`warning.log`、`error.log`，控制台用 colorlog；通过 `manage.py <命令>` 运行时额外写 `log/<命令>/info.log`。**`log/` 目录必须可写**（缺失时自动创建）。

## 六、构建、运行与测试命令

```bash
# 安装依赖（建议虚拟环境）
pip install -r requirements.txt

# 前置：默认不需要 redis；只有 CHANNEL_LAYER_BACKEND=redis 时才要求 Redis 已启动且可连通（settings 导入即检查）

# 初始化数据库（auth/session/admin 迁移需要）
python manage.py migrate

# 开发运行（README 用法，HTTP+WS 都由它服务）
python manage.py runserver 7420
# 或等价 Daphne 方式（runserver.sh 内容，注意绑定的 host/port 随脚本不同）：
daphne -b 0.0.0.0 -p 7419 project.asgi:application

# 端到端冒烟测试（三个终端）：
# 终端1：runserver；终端2：
python tests/test_send_message.py --room room_123        # HTTP POST 发消息
# 终端3：
python tests/test_receive_message.py --room room_123 --auth token123   # WS 订阅收消息
```

**测试策略说明**：本项目**没有 CI**，但现在有真正的单元测试。

- `generic/tests.py` 是 Django 单元测试（30 项）：覆盖 AI 会议室接口、广播落组、路由，以及**原有 HTTP/WS 能力的回归**（原来的推送接口、房间页、`ChatConsumer` 收发、WS 路由正则）。跑法：`python manage.py test generic`。
- `tests/` 目录是人工跑的端到端 CLI 脚本（依赖 click/requests/websocket-client），其中 receive 脚本支持 `data.action == "raise"` 时主动抛错以模拟客户端异常。`council_smoke.py` 是 AI 会议室的全链路冒烟（23 项，含**并发发言下 seq 不重号不漏号**），需要先起服务：`python tests/council_smoke.py --base-url http://localhost:7420`。
- `tests/council_page.test.mjs` 是**会议室页面里那段内联 JS** 的测试（13 项）：用一个手写的最小 DOM 桩加载模板里真实的脚本，由测试驱动时间，覆盖 3 秒打断条的状态机（倒计时、窗口过期不误弹、打断来晚了不能假装循环停了、服务端关窗后暂停面板的去留）。**不引入 jsdom**，跑法：`node --test tests/council_page.test.mjs`。
- `tests/council_multiprocess_smoke.sh` 验**生产部署形态**（9 项）：切到 `CHANNEL_LAYER_BACKEND=redis`、同时起两个 Daphne 实例共享同一个 sqlite，然后检查跨实例广播（WS 连 A、HTTP 打到 B 要能收到）、跨进程并发写 sqlite 不报 `database is locked`、多进程下 seq 仍唯一连续。**这一点很重要**：改动之前这个项目运行期几乎不写库，而会议室每句话都要写，是**新引入**的并发面。需要本机有 redis，没有就跳过。脚本把 settings 覆盖写在临时目录里，**不动仓库文件**。
- `dsh-plugin/test/` 是插件的单元测试（88 项），用假会议室 + 假模型，**不需要 DSH 也不需要网络**，跑法：`cd dsh-plugin && node --test test/`。其中 `test/output-contract.test.mjs` 用 **DSH 自己的 `validateJsonSchemaValue`** 校验每个工具在每个分支上的真实返回值——因为 DSH 管道会按 `output.schema` 校验工具输出，而直接调 `execute` 是绕过校验的，「本地全绿、装进 DSH 就炸」就是这样来的。
- `dsh-plugin/scripts/live-check.mjs` 是**插件 ↔ 真实会议室服务**的链路自检（17 项，模型换成桩、不消耗任何额度），需要先起服务：`node dsh-plugin/scripts/live-check.mjs --bus-url http://localhost:7420`。
- `dsh-plugin/scripts/verify-dsh-mount.sh` 验证 **DSH 能不能装载这个插件**（9 项）：靠 `DSH_HOME` 指向临时目录造一个一次性 DSH home，从 shipped 模板建 profile、把插件挂成 bundle，再逐个检查 `--dump-config`（组合器认不认）、`--dump-config-schema`（能不能导入模块读 schema）、`--help`（profile 能不能启动，即 `apply()` 会不会抛）。**不会碰用户自己的 `~/.dsh`。**
- `dsh-plugin/scripts/e2e-demo.mjs` 是插件侧的端到端演示（真服务 + 真 3 秒 + 真 Kimi）。

仓库里存在 `.mypy_cache`，说明用 mypy 做过类型检查，但无配置文件、未纳入标准流程。改动后请至少跑通上述流程验证。

## 七、部署

- **Docker**：`Dockerfile` 基于官方 `python` 镜像，pip 走清华镜像源，最终 `CMD python -m daphne -b 0.0.0.0 -p 7419 project.asgi:application`（暴露 7419）。`docker-compose.yml` 起 `redis:7-alpine` + 应用两个服务，宿主机端口默认 `7420→7419`。`docker/test_run_docker.sh` 演示了纯 docker run 的手动编排（redis 容器 + 同网络应用容器，用 `-e WEBSOCKET_REDIS_HOST=redis` 注入）。
- **裸机多实例**：`deploy/supervisor.conf` 用 supervisor 管 3 个 Daphne 实例（57420-57422，user `websocket`）；`deploy/nginx/websocket.ramwin.com` 示例按房间名前缀/后缀（`room_[a-z]`→57420、`room_[A-Z]`→57421、`room_[0-9]`→57422、`user_...` 尾号→7430/7431）把连接和 HTTP 推送分流到不同后端，WebSocket location 带 `Upgrade` 头转发。多实例广播一致性依赖 Redis Channel Layer，而非 Nginx 的 ip_hash 之类的会话保持——所以这套部署必须设置 `CHANNEL_LAYER_BACKEND=redis` 并安装 `channels_redis`（默认的 memory 后端只在单进程内广播，实例之间收不到消息）。Docker 单容器用默认的 memory 即可，compose 里的 `redis` 服务只有在切到 redis 后端时才需要。

## 八、代码风格约定

- Python，**4 空格缩进**；多数手写文件头部带 `#!/usr/bin/env python3`、`# -*- coding: utf-8 -*-` 及作者注释。
- **注释/文档字符串以中文为主**（原项目作者习惯），README 中英混杂。
- 引号未强制统一：配置/路由偏单引号，业务代码偏双引号。
- 部分文件顶部有 `pylint: disable=...` 豁免注释；`settings.py` 中 `CONFIG` 字典使用了 8 空格续行缩进，属历史风格，不强求模仿也不强求统一。
- `requirements.txt` 不锁版本，新增依赖直接在末尾追加即可。

## 九、安全注意事项

- `settings.py` 里 `SECRET_KEY` **硬编码且已入库**，生产部署必须替换。
- `asgi.py` 的 `MyAuthMiddleware` 是**演示级**鉴权（硬编码 token），接入真实系统前必须重写 `get_user()`（代码内 TODO 也指出了这一点）。
- `MessageView.post` **无任何认证/权限校验**，任何能访问该 URL 的人都能向任意房间广播；暴露在公网前必须自行加鉴权或在网关层限制。
- `ChatConsumer.need_auth` 当前为 `False`，未认证连接不会被拒绝。
- 使用 redis channel layer（`CHANNEL_LAYER_BACKEND=redis`）时，Redis 无密码、无 TLS 配置，仅适合内网部署。
- `.env` 已被 `.gitignore` 忽略（勿提交真实环境变量）；`Dockerfile` 的 `COPY ./ ./` 会把本地 `.env` 打进镜像，构建生产镜像前注意清理。

## 十、二次开发常见修改点

| 需求 | 位置 |
|------|------|
| 接入真实用户认证 | `project/asgi.py` 的 `MyAuthMiddleware.get_user()` |
| 强制 WS 认证 | `generic/consumers.py` 的 `ChatConsumer.need_auth` |
| 修改消息格式/业务逻辑 | `ChatConsumer.receive()` / `message()` |
| 扩展 HTTP 推送接口 | `generic/views.py` 的 `MessageView.post()` |
| 调整浏览器会话查看页面 | `generic/templates/generic/room.html` + `generic/views.py` 的 `RoomView` |
| 增加消息持久化 | `generic/models.py` + 在 consumer 中落库 |
| 新增 WS 路由 | `generic/routing.py` + 新 consumer（仿照 `ChatConsumer`） |
| 调整健康检查 | `generic/backends.py`（继承 `HealthCheck` dataclass，实现 `run()`） |
| 调整日志 | `project/logging_settings.py` |
| 改会议室的消息/接口 | `generic/council.py`（服务层）+ `council_views.py`（HTTP）+ `council_urls.py`（路由） |
| 改会议室页面 / 打断条 | `generic/templates/generic/council.html` + `council_views.CouncilRoomView` |
| 给会议室加业务字段 | `generic/models.py` + `python manage.py makemigrations generic` |
| 加一个新的评审模型（GLM/Qwen/…） | 只改 `dsh-plugin/cordis.patch.yml` 的 `participants`，通常不用写代码 |
| 加一种新的模型接入协议 | `dsh-plugin/lib/adapters/` 新增一个文件 + 在 `adapters/index.js` 注册 |
| 改 3 秒窗口/等待时长 | `dsh-plugin/cordis.patch.yml` 的 `humanWindowMs` / `humanWaitMs` |
| 改「什么时候唤醒插件」 | `dsh-plugin/lib/usage.js`（注入 system prompt 的说明） |
