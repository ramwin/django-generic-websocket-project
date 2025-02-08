FROM python
MAINTAINER Xiang Wang "ramwin@qq.com"
RUN mkdir -p /home/websocket/
COPY ./ /home/websocket/django-generic-websocket-project
RUN pip install -r /home/websocket/django-generic-websocket-project/requirements.txt
CMD daphne -b 0.0.0.0 -p 7419 project.asgi:application
EXPOSE 7419
