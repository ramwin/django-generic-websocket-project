server {
    listen 57419;
    server_name websocket.ramwin.com;
    location /ws/generic/room_1 {
        proxy_pass http://websocket.ramwin.com:57420/ws/generic/room_1;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
    location /ws/generic/send-message/room_1 {
        proxy_pass http://websocket.ramwin.com:57420/ws/generic/send-message/room_1;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
    location /ws/generic/room_a {
        proxy_pass http://websocket.ramwin.com:57421/ws/generic/room_a;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
    location /ws/generic/send-message/room_a {
        proxy_pass http://websocket.ramwin.com:57421/ws/generic/send-message/room_a;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
}
