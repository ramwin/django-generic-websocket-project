# dsh-plugin-ai-council

把 **DeepSeek Harness** 和 **Kimi / Claude** 以及 **你自己** 放进同一个房间，
让每一个关键步骤都经过异模型迭代评审，并且**每次都给你留 3 秒打断的机会**。

它建立在 [django-generic-websocket-project](../) 之上 —— 那个项目提供
HTTP + WebSocket 的房间广播，本插件只是它的一个客户端。

```
你 ──对话──► DeepSeek(DSH) ──council_review──┐
                                             │  本插件（host plane）
                                             ├─ HTTP POST ──► 会议室房间（广播）
                                             ├─ kimi -p   ┐ 并行评审
                                             ├─ claude API┘
                                             └─ 等 3 秒看你要不要打断
                                                       ↓
                        django-generic-websocket-project ──► 会议室页面（你）
```

## 它解决什么

- **同一个模型审不出自己的错**：DeepSeek 写的计划由 Kimi / Claude 挑毛病，
  它们看到的是同一个房间里的完整上下文，包括前几轮别人说过什么。
- **人在回路里，但不挡路**：模型意见一出来就弹 3 秒倒计时；
  你没空就自动往下走，你想插手就按「打断」慢慢看。
- **写文件的只有 DeepSeek**：外部模型跑在空临时目录里，只产出文字意见，
  所有落盘都留在 DSH 的沙箱与审批之内。

## 固定工作流

`计划 → 编码 → 执行 → 评价`，**每一步**都是同一个循环：

1. DeepSeek 做出这一步的产物；
2. `council_review` 把产物发进房间，外部模型**并行**评审；
3. 自动打开 3 秒人工窗口；
4. 有 `revise` 就改，再调一次 `council_review`（下一轮）；
5. 所有模型 `approve` 且你没有异议，这一步才算过。

## 3 秒人工窗口的四种结果

| `human.status` | 发生了什么 | DeepSeek 该怎么做 |
|---|---|---|
| `timeout` | 3 秒内没人打断 | 正常继续 |
| `resumed` | 你看了，选择继续 | 正常继续 |
| `suggested` | 你注入了建议（`human.suggestion`） | **建议优先级高于所有模型意见**，先按它改 |
| `paused` | 你按了打断但还没决定 | **停下来**，在对话里说清局面并问你 |

阶段时长都可以配：`humanWindowMs`（默认 3000）、`humanWaitMs`（默认 600000，
即打断之后愿意等你多久）。

## 工具

| 工具 | 干什么 |
|---|---|
| `council_start` | 建会议室，返回围观页面地址 |
| `council_review` | 送审一步产物 + 自动开 3 秒人工窗口（核心） |
| `council_status` | 读回任务、轮次、最近结论和完整记录 |
| `council_note` | 往房间广播一条自己的消息 |
| `council_finish` | 写下结论、结束会话 |

## 安装

### 1. 起会议室服务

它**不需要** DSH 也能单独跑：

```bash
cd ..                       # django-generic-websocket-project
pip install -r requirements.txt
python manage.py migrate
ALLOWED_HOSTS='localhost;127.0.0.1' python manage.py runserver 7420
```

多实例 / 生产部署照旧走仓库里的 `Dockerfile`、`deploy/supervisor.conf`，
需要跨进程广播时把 `CHANNEL_LAYER_BACKEND` 设成 `redis` 即可。

### 2. 装插件

别人（或你自己换台机器）直接从 GitHub 装 —— 本插件在仓库的 `dsh-plugin/`
子目录里，所以路径要写成 `#path:` 的形式：

```bash
dsh plugin --profile web add "github:ramwin/django-generic-websocket-project#path:/dsh-plugin"
# 然后重启 dsh
```

在本机开发时，用本地路径装更顺手，改完代码 `dsh plugin` 重装即可：

```bash
dsh plugin --profile web add "$PWD/dsh-plugin"
```

> **装之前建议先跑一下装载验证**，它会用一次性 DSH home 检查
> "组合器认不认、模块能不能导入、profile 能不能启动"，不碰你现有的 profile：
>
> ```bash
> bash dsh-plugin/scripts/verify-dsh-mount.sh
> ```

安装形式的选择：`github:owner/repo#path:/sub` 会跟着仓库分支走，
适合还在迭代的阶段；等这个插件发到 npm 之后，`dsh plugin --profile web add dsh-plugin-ai-council`
会更省事（前提是先把 `dsh-plugin` topic 与 npm 包名对上）。

### 3. 配置

插件配置写在 profile 的 `cordis.patch.yml` 里（`ai-council` 那一行的 `config`），
也可以在 DSH 的插件设置页改。随包的默认配置见 [cordis.patch.yml](cordis.patch.yml)：

```yaml
participants:
  kimi:
    adapter: kimi-cli            # 走本机已登录的 kimi CLI，不需要 API key
  claude:
    adapter: claude-api          # baseUrl / apiKeyEnv / model 都可换
    baseUrl: https://api.anthropic.com
    apiKeyEnv: ANTHROPIC_API_KEY
    model: claude-sonnet-4-5
```

**这是一个对外暴露的接口**：别人要接自己的中转或别的模型，只改这三行就行。

想再加一个异模型（GLM / Qwen / Moonshot…），只需要加一段配置，不用改代码：

```yaml
participants:
  glm:
    adapter: openai-api
    label: GLM
    baseUrl: https://open.bigmodel.cn/api/paas/v4
    apiKeyEnv: ZHIPU_API_KEY
    model: glm-4.6
```

## 适配器

| 适配器 | 协议 | 需要的凭据 |
|---|---|---|
| `kimi-cli` | 本机 `kimi -p` 非交互调用 | 用 CLI 已登录的 Kimi For Coding 订阅 |
| `claude-api` | Anthropic Messages API | `apiKey` 或 `apiKeyEnv` |
| `openai-api` | OpenAI 兼容 `/chat/completions` | `apiKey` 或 `apiKeyEnv` |

`kimi-cli` 复用 CLI 的登录态，因此**不需要 API key**；在沙箱里跑时把
`homeDir` 指到一个可写目录（CLI 默认要写 `~/.kimi-code`）。

单个模型失败（没配 key、超时、CLI 挂了）会被收敛成一条
`verdict: "error"` 的评审结果回帖到房间，**不会**拖垮整轮 —— 但也不会
被悄悄吞掉，DeepSeek 会如实向你汇报。

## 自己验一遍

不需要 DSH：

```bash
# 单元测试（假会议室 + 假模型，88 项，含用 DSH 自己的校验器做的输出契约测试）
cd dsh-plugin && node --test test/

# 链路自检：插件 ↔ 真实会议室服务（模型换成桩，不消耗任何额度，17 项）
node dsh-plugin/scripts/live-check.mjs --bus-url http://127.0.0.1:7420

# 端到端演示（真服务 + 真 3 秒 + 真 Kimi）
node dsh-plugin/scripts/e2e-demo.mjs --bus-url http://127.0.0.1:7420 \
     --kimi-home "$PWD/.kimi-home" --interrupt

# 只验窗口语义，不调模型
node dsh-plugin/scripts/e2e-demo.mjs --skip-ai
```

**装之前先验"DSH 能不能装载它"** —— 这条不需要动你自己的 `~/.dsh`：
脚本会建一个一次性的 DSH home（`DSH_HOME` 覆盖到临时目录），把本插件挂成
bundle，然后检查组合器认不认、能不能导入模块读 schema、profile 能不能启动。

```bash
bash dsh-plugin/scripts/verify-dsh-mount.sh
```

> `live-check` / `verify-dsh-mount` / `e2e-demo` 的分工：
> `verify-dsh-mount` 验**装载**（DSH 组合器 + 模块导入 + 启动）；
> `live-check` 验**插件 ↔ Django 服务的 HTTP 链路**（含"工具输出是否符合
> 它自己声明的 schema"这种只在 DSH 管道里才会暴露的问题）；
> `e2e-demo` 才真的叫 Kimi 来评审。

Django 侧：

```bash
python manage.py test generic                          # 30 项，含原有能力回归
node --test tests/council_page.test.mjs                # 13 项，会议室页面内联 JS
python tests/council_smoke.py --base-url http://localhost:7420   # 23 项，活服务
bash tests/council_multiprocess_smoke.sh               # 9 项，多实例 + redis（需要 redis）
```

多实例那条验的是你的生产部署形态（`deploy/supervisor.conf` 起 3 个 Daphne
实例 + `CHANNEL_LAYER_BACKEND=redis`）：跨实例广播能不能到、多个进程同时写
同一个 sqlite 会不会 `database is locked`、多进程下 `seq` 还唯不唯一。

## 和 AgentTeams 的关系

DSH 自带的 AgentTeams 解决「多个 agent 分工干活」；本插件解决
「同一个 agent 的每一步都被异模型和人检查」。两者可以一起用，
也可以只用一个。

## 已知边界

- 会议室服务不在 DSH 进程里，需要单独起（这正是它能让别人
  脱离 DSH 复用的原因）。
- 外部模型只能产出文字意见，不能直接改文件 —— 这是刻意设计的边界。
- 打断后最多等你 `humanWaitMs`（默认 10 分钟）；超时会返回 `paused`
  把控制权交回 DeepSeek，由它在对话里继续问你。
- 本插件注册工具/提示词，改完需要**重启 dsh** 才生效。
