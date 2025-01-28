server {
    listen 80;
    server_name websocket.ramwin.com;
    # use suffix as router
    location ~ "^/ws/generic/send-message/user_[0-9]*[0-4]+/$" {
        proxy_pass http://localhost:7430;
        proxy_set_header through "suffix0-4";
    }
    location ~ "^/ws/generic/user_[0-9]*[0-4]+/$" {
        proxy_pass http://localhost:7430;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header through "suffix0-4";
    }
    location ~ "^/ws/generic/send-message/user_[0-9]*[5-9]+/$" {
        proxy_pass http://localhost:7431;
        proxy_set_header through "suffix5-9";
    }
    location ~ "^/ws/generic/user_[0-9]*[5-9]+/$" {
        proxy_pass http://localhost:7431;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header through "suffix5-9";
    }
    location ~ "^/ws/generic/send-message/user_[0-5]+" {
        proxy_pass http://localhost:7430;
    }
    # use prefix as router
    location ~ "^/ws/generic/send-message/room_[a-z]+" {
        proxy_pass http://localhost:57420;
    }
    location ~ "^/ws/generic/room_[a-z]+" {
        proxy_pass http://localhost:57420;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
    location ~ "^/ws/generic/send-message/room_[A-Z]+" {
        proxy_pass http://localhost:57421;
    }
    location ~ "^/ws/generic/room_[A-Z]+" {
        proxy_pass http://localhost:57421;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
    location ~ "^/ws/generic/send-message/room_[0-9]+" {
        proxy_pass http://localhost:57422;
    }
    location ~ "^/ws/generic/room_[0-9]+" {
        proxy_pass http://localhost:57422;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
    location / {
        proxy_pass http://localhost:7430;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header through "default";
    }
}
