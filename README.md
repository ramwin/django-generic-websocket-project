# django-generic-websocket-project
a generic websocket  
一个非常通用的websocket项目  

# Install
```bash
# install redis server
git clone git@github.com:ramwin/django-generic-websocket-project.git
cd django-generic-websocket-project
pip3 install -r ./requirements.txt
```

# Usage
```
# in terminal 1
python3 manage.py runserver 7420

# in terminal 2
python3 test_send_message.py

# in terminal 3
python3 test_receive_message.py
```

# 浏览器里查看会话
```bash
# 终端 1：启动服务
python3 manage.py runserver 7420

# 浏览器打开（房间名跟推送时用的房间名保持一致）
# http://localhost:7420/ws/generic/room/room_123/

# 终端 2：用 HTTP 接口往这个房间推消息，页面上会立刻出现
curl -X POST http://localhost:7420/ws/generic/send-message/room_123/ \
     -H 'Content-Type: application/json' \
     -d '{"message": "hello"}'
```
- 页面里的输入框也可以发消息，会通过 WebSocket 广播给房间内的所有客户端
- 消息格式不限：有 `message` 字段就显示这个文本，其余字段以 JSON 附在下面；没有 `message` 字段就整体格式化输出
- 需要鉴权时把 token 放在页面地址上，会透传给 WebSocket：`http://localhost:7420/ws/generic/room/room_123/?token=token123`
- 房间名只能包含字母/数字/下划线（和 WebSocket 路由 `(?P<room_name>\w+)` 一致）
- 连接断开（比如服务重启）后页面会指数退避自动重连
- 页面模板：`generic/templates/generic/room.html`，HTML 和 JS 全部内联，不依赖静态文件服务

# Deploy
1. change `project/settings.py`
```
DEBUG = False
ALLOWED_HOSTS = [<your hostname>]
```

2. run command
```
replace example.com with your hostname
daphne -b <example.com> -p <port> wsbackend.asgi:application
```

# load balance
1. use `deploy/supervisor.conf` to run multi instance
2. use `deploy/nginx/websocket.ramwin.com` to loadbalance
