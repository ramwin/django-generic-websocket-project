server {
    listen 57419;
    server_name websocket.ramwin.com;
    location ~ "^/ws/generic/send\-message/room_[a-z]+" {
        proxy_pass http://lte-test.test.huawei.com:57420;
    }
    location ~ "^/ws/generic/send\-message/room_[0-9A-Z]+" {
        proxy_pass http://lte-test.test.huawei.com:57421;
    }
}
