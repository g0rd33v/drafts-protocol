# Installation

Run a conformant drafts/0.1 server.

## Requirements

- Node.js 18+
- nginx 1.24+
- Redis 6+ (rate-limit state; optional for small deployments with in-memory fallback)
- SQLite 3+ or a JSON file for project state
- Let's Encrypt / certbot for TLS
- 1 GB RAM minimum, 2 GB recommended
- Linux recommended (tested on Ubuntu 24.04)

## Clone and install

```bash
git clone https://github.com/g0rd33v/drafts-protocol.git /opt/drafts-receiver
cd /opt/drafts-receiver
npm install --production
cp .env.example .env
```

## Configure

Edit `.env`:

```env
BEARER_TOKEN=<generate with: openssl rand -hex 8>
STATE_FILE=/var/www/beta.labs.vc/drafts/.state.json
PUBLIC_BASE=https://your.domain
PORT=3100
REDIS_URL=redis://127.0.0.1:6379
```

Generate your server pass:

```bash
openssl rand -hex 8   # 16-hex characters = 64-bit entropy
```

Store it in `BEARER_TOKEN` and keep it secret. You will use it to create your first project.

## nginx

Example config at `deploy/nginx.conf`. Key blocks:

```nginx
location /drafts/ {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
}

location /live/ {
    alias /var/www/html/live/;
    try_files \$uri \$uri/ =404;
}
```

## systemd

```ini
# /etc/systemd/system/drafts-receiver.service
[Unit]
Description=drafts receiver (reference implementation)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/drafts-receiver
EnvironmentFile=/opt/drafts-receiver/.env
ExecStart=/usr/bin/node /opt/drafts-receiver/app.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now drafts-receiver
systemctl status drafts-receiver
```

## Verify

```bash
curl -o /dev/null -w '%{http_code}\n' "https://your.domain/drafts/pass/drafts_server_0_<your_token>"
# Expect: 200
```

## Create your first project

```bash
curl -X POST https://your.domain/drafts/projects \
  -H "Authorization: Bearer <SERVER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"hello","description":"My first drafts project"}'
```

Response contains the Project Pass. Share that URL with the project owner.

## Register with the federation

See [REGISTRY.md](REGISTRY.md).

## Operational scripts

`deploy/bin/` contains cron and ops scripts:

- `labs-sync` — deploy drafts → live for one project
- `labs-github-sync` — pull changes from GitHub for projects with mirror enabled
- `labs-drafts-refresh` — regenerate directory metadata
- `labs-status-collect` — emit health metrics

Install to `/usr/local/bin/`, wire up with cron (see [REFERENCE_IMPLEMENTATION.md](../REFERENCE_IMPLEMENTATION.md)).

## Troubleshooting

- **401 on welcome page** — check secret length matches tier (16/12/10 hex)
- **502 from nginx** — receiver not running, check `systemctl status drafts-receiver`
- **403 on `/live/`** — check nginx `alias` path and directory permissions (www-data:www-data)
