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
python3 test_send_message.py

# in terminal 3
python3 test_receive_message.py
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

# load balance
1. use `deploy/supervisor.conf` to run multi instance
2. use `deploy/nginx/websocket.ramwin.com` to loadbalance
