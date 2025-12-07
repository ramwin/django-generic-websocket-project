FROM python

MAINTAINER Xiang Wang "ramwin@qq.com"

WORKDIR /home/websocket/django-generic-websocket-project

# speedup docker build
RUN pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
RUN pip install django
RUN pip install channels[daphne]
RUN pip install channels_redis
RUN pip install websocket-client
RUN pip install rel
RUN pip install setuptools
RUN pip install djangorestframework
RUN pip install python-dotenv
RUN pip install colorlog
RUN pip install django-split-settings

# finally install

COPY ./ /home/websocket/django-generic-websocket-project

RUN pip install -r requirements.txt

CMD python -m daphne -b 0.0.0.0 -p 7419 project.asgi:application

EXPOSE 7419
