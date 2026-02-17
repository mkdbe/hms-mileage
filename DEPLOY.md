# Deploy HMS Mileage Server

## 1. Create subdomain dir and copy files
```bash
sudo mkdir -p /var/www/html/mileage.highlandmediaservices.com
sudo chown mdbe:mdbe /var/www/html/mileage.highlandmediaservices.com
rsync -av --exclude=node_modules ./ mdbe@linode:/var/www/html/mileage.highlandmediaservices.com/
```

## 2. Install dependencies (on server)
```bash
cd /var/www/html/mileage.highlandmediaservices.com
npm install
```

## 3. Install and start systemd service (on server)
```bash
sudo cp hms-mileage.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable hms-mileage
sudo systemctl start hms-mileage
sudo systemctl status hms-mileage
```

## 4. Add Nginx server block
Add this to /etc/nginx/nginx.conf (same pattern as inventory):
```nginx
server {
    server_name mileage.highlandmediaservices.com;
    location / {
        proxy_pass http://127.0.0.1:3004;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
Then: sudo nginx -t && sudo systemctl reload nginx

## 5. Get SSL cert
```bash
sudo certbot --nginx -d mileage.highlandmediaservices.com
```
