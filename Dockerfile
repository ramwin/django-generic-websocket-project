FROM python
MAINTAINER Xiang Wang "ramwin@qq.com"
RUN pip install -r ./requirements.txt
CMD daphne -b 0.0.0.0 -p 7419 project.asgi:application
EXPOSE 7419
