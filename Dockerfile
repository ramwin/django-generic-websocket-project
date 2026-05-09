FROM python

MAINTAINER Xiang Wang "ramwin@qq.com"

WORKDIR /home/websocket/django-generic-websocket-project

COPY requirements.txt ./
RUN curl https://ramwin.com/
RUN pip install -r ./requirements.txt --extra-index-url https://pypi.tuna.tsinghua.edu.cn/simple

COPY ./ ./

CMD python -m daphne -b 0.0.0.0 -p 7419 project.asgi:application

EXPOSE 7419
