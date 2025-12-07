FROM python

MAINTAINER Xiang Wang "ramwin@qq.com"

WORKDIR /home/websocket/django-generic-websocket-project

# speedup docker build
RUN pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
RUN pip install --root-user-action django
RUN pip install --root-user-action channels[daphne]
RUN pip install --root-user-action channels_redis
RUN pip install --root-user-action websocket-client
RUN pip install --root-user-action rel
RUN pip install --root-user-action setuptools
RUN pip install --root-user-action djangorestframework
RUN pip install --root-user-action python-dotenv
RUN pip install --root-user-action colorlog
RUN pip install --root-user-action django-split-settings
RUN pip install --root-user-action humanfriendly

# finally install

COPY ./ /home/websocket/django-generic-websocket-project

RUN pip install --root-user-action -r requirements.txt

CMD python -m daphne -b 0.0.0.0 -p 7419 project.asgi:application

EXPOSE 7419
