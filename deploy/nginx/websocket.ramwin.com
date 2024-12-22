{
    listen 57419;
    server_name websocket.ramwin.com;
    location /ws/generic/send-message/[0-7] {
        proxy_pass http://websocket.ramwin.com:57420/ws;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
    location /ws/generic/send-message/[8-f] {
        proxy_pass http://websocket.ramwin.com:57421/ws;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
}
