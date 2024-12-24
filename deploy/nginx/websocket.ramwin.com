server {
    listen 57419;
    server_name websocket.ramwin.com;
    location ~ "^/ws/generic/send\-message/room_[a-z]+" {
        proxy_pass http://localhost:57420;
    }
    location ~ "^/ws/generic/room_[a-z]+" {
        proxy_pass http://localhost:57420;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
    location ~ "^/ws/generic/send\-message/room_[0-9]+" {
        proxy_pass http://localhost:57421;
    }
    location ~ "^/ws/generic/room_[0-9]+" {
        proxy_pass http://localhost:57421;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
    location ~ "^/ws/generic/send\-message/room_[A-Z]+" {
        proxy_pass http://localhost:57422;
    }
    location ~ "^/ws/generic/room_[A-Z]+" {
        proxy_pass http://localhost:57422;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
}
