FROM python

MAINTAINER Xiang Wang "ramwin@qq.com"

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		postgresql-client \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /home/websocket/django-generic-websocket-project

COPY requirements.txt ./
RUN pip install -r ./requirements.txt

COPY ./ ./

CMD python -m daphne -b 0.0.0.0 -p 7419 project.asgi:application

EXPOSE 7419
