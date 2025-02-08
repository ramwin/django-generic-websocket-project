FROM python
MAINTAINER Xiang Wang "ramwin@qq.com"
RUN ADD requirements.txt
RUN pip install -r requirements.txt
COPY ./ /home/websocket/django-generic-websocket-project
CMD daphne -b 0.0.0.0 -p 7419 project.asgi:application
EXPOSE 7419
