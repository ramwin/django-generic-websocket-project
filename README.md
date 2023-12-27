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
python3 manage.py runserver

# in terminal 2
python3  测试链接websocket.py

# in terminal 3
python3 测试发送消息.py
```

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
