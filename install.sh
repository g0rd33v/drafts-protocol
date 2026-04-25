#!/usr/bin/env bash
# drafts v0.2 — one-command installer
#
# Usage (on a fresh Ubuntu 22.04+ VPS, as root):
#   curl -fsSL https://raw.githubusercontent.com/g0rd33v/drafts-protocol/main/install.sh | bash -s drafts.example.com admin@example.com
#
# Args:
#   $1  — domain name pointing to this VPS (DNS A record must already resolve)
#   $2  — email for Let's Encrypt registration
#
# What this does:
#   - Installs nginx, certbot, Node.js 20, pm2, git
#   - Clones drafts-protocol into /opt/drafts
#   - Configures /etc/labs/drafts.env
#   - Sets up nginx reverse proxy
#   - Issues HTTPS cert via Let's Encrypt
#   - Starts the server under pm2
#   - Auto-mints a SAP token, saves to /etc/labs/drafts.sap, prints once

set -euo pipefail

# ─── Args ─────────────────────────────────────────────────────
DOMAIN="${1:-}"
EMAIL="${2:-}"

if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
  cat >&2 <<USAGE
Usage: bash install.sh <domain> <email>

  <domain>  Public hostname pointing at this VPS (e.g. drafts.example.com).
            Must already resolve via DNS A record before running.
  <email>   Email for Let's Encrypt registration.

Example:
  curl -fsSL https://raw.githubusercontent.com/g0rd33v/drafts-protocol/main/install.sh \\
    | bash -s drafts.example.com admin@example.com
USAGE
  exit 1
fi

# ─── Pre-flight ───────────────────────────────────────────────
log() { echo -e "\n\033[1;34m▶\033[0m $*"; }
ok()  { echo -e "  \033[1;32m✓\033[0m $*"; }
warn(){ echo -e "  \033[1;33m!\033[0m $*"; }
die() { echo -e "\n\033[1;31m✗ $*\033[0m" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "must run as root (try: sudo bash install.sh ...)"

# OS check
. /etc/os-release 2>/dev/null || die "cannot detect OS"
[[ "$ID" == "ubuntu" ]] || warn "tested on Ubuntu — your distro ($ID) may need adjustments"
case "${VERSION_ID%%.*}" in
  22|24) ok "Ubuntu $VERSION_ID detected" ;;
  *) warn "Ubuntu $VERSION_ID may not be supported (tested: 22.04, 24.04)" ;;
esac

# DNS check
log "Checking DNS for $DOMAIN ..."
RESOLVED_IP=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)
SERVER_IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
if [[ -z "$RESOLVED_IP" ]]; then
  die "$DOMAIN does not resolve. Add an A record pointing to this VPS, wait 2 min, rerun."
fi
if [[ -n "$SERVER_IP" && "$RESOLVED_IP" != "$SERVER_IP" ]]; then
  warn "$DOMAIN resolves to $RESOLVED_IP but this VPS appears to be $SERVER_IP. Continuing — Let's Encrypt may fail if mismatched."
else
  ok "DNS OK ($RESOLVED_IP)"
fi

# ─── Packages ─────────────────────────────────────────────────
log "Installing system packages ..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -yqq curl git nginx certbot python3-certbot-nginx ca-certificates >/dev/null
ok "base packages installed"

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//;s/\..*//')" -lt 18 ]]; then
  log "Installing Node.js 20 ..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -yqq nodejs >/dev/null
  ok "Node.js $(node -v) installed"
else
  ok "Node.js $(node -v) already present"
fi

if ! command -v pm2 >/dev/null 2>&1; then
  log "Installing pm2 ..."
  npm install -g pm2 >/dev/null 2>&1
  ok "pm2 installed"
else
  ok "pm2 already present"
fi

# ─── Clone repo ───────────────────────────────────────────────
log "Fetching drafts-protocol ..."
if [[ -d /opt/drafts/.git ]]; then
  cd /opt/drafts
  git fetch --quiet && git reset --hard origin/main --quiet
  ok "updated existing /opt/drafts"
else
  rm -rf /opt/drafts
  git clone --quiet https://github.com/g0rd33v/drafts-protocol.git /opt/drafts
  ok "cloned to /opt/drafts"
fi

cd /opt/drafts
log "Installing npm dependencies ..."
npm install --silent --no-audit --no-fund
ok "dependencies installed"

# ─── Config ───────────────────────────────────────────────────
log "Writing /etc/labs/drafts.env ..."
mkdir -p /etc/labs /var/lib/drafts /var/www/html/live /var/www/html/drafts-view
chmod 755 /etc/labs

if [[ ! -f /etc/labs/drafts.env ]]; then
  cat > /etc/labs/drafts.env <<EOF
PUBLIC_BASE_URL=https://$DOMAIN
SERVER_NUMBER=0
PORT=3100
DRAFTS_DIR=/var/lib/drafts
EOF
  chmod 600 /etc/labs/drafts.env
  ok "config written"
else
  warn "/etc/labs/drafts.env already exists — leaving unchanged"
fi

# ─── nginx ────────────────────────────────────────────────────
log "Configuring nginx ..."
cat > /etc/nginx/sites-available/drafts <<NGINX
server {
  listen 80;
  server_name $DOMAIN;
  client_max_body_size 50M;

  # Project live output
  location ~ ^/live/([a-z0-9_-]+)/ {
    alias /var/www/html/live/\$1/;
    try_files \$uri \$uri/ /index.html =404;
  }

  # Drafts preview
  location ~ ^/drafts-view/([a-z0-9_-]+)/ {
    alias /var/www/html/drafts-view/\$1/;
    try_files \$uri \$uri/ /index.html =404;
  }

  # Everything else → drafts.js
  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 60s;
  }
}
NGINX

ln -sfn /etc/nginx/sites-available/drafts /etc/nginx/sites-enabled/drafts
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null 2>&1 || die "nginx config test failed"
systemctl reload nginx
ok "nginx configured"

# ─── HTTPS ────────────────────────────────────────────────────
log "Issuing Let's Encrypt cert ..."
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect >/dev/null 2>&1; then
  ok "HTTPS active"
else
  warn "certbot failed. The service will still start on HTTP. Common causes: DNS not propagated, port 80 blocked. Re-run later: certbot --nginx -d $DOMAIN -m $EMAIL"
fi

# ─── pm2 ──────────────────────────────────────────────────────
log "Starting drafts under pm2 ..."
pm2 delete drafts >/dev/null 2>&1 || true
cd /opt/drafts
pm2 start drafts.js --name drafts --time
sleep 2

# Ensure pm2 starts on boot
PM2_STARTUP_CMD=$(pm2 startup systemd -u root --hp /root 2>&1 | grep "sudo env" | tail -1 || true)
if [[ -n "$PM2_STARTUP_CMD" ]]; then
  eval "$PM2_STARTUP_CMD" >/dev/null 2>&1 || true
fi
pm2 save >/dev/null 2>&1

ok "drafts is running"

# ─── Verify ───────────────────────────────────────────────────
log "Verifying ..."
sleep 2
HEALTH=$(curl -fsS "https://$DOMAIN/drafts/health" 2>/dev/null || curl -fsS "http://$DOMAIN/drafts/health" 2>/dev/null || echo '{}')
if echo "$HEALTH" | grep -q '"ok":true'; then
  ok "health check passed: $HEALTH"
else
  warn "health check did not return 200 — check 'pm2 logs drafts'"
fi

# ─── Print SAP ────────────────────────────────────────────────
SAP_FILE=/etc/labs/drafts.sap
if [[ -f $SAP_FILE ]]; then
  SAP=$(cat $SAP_FILE)
  echo
  echo "════════════════════════════════════════════════════════════════════"
  echo
  echo "  drafts v0.2 is running at https://$DOMAIN/drafts/"
  echo
  echo "  SAP token: $SAP"
  echo "  (saved to $SAP_FILE — back it up, it's never shown again)"
  echo
  echo "  Server welcome:  https://$DOMAIN/drafts/pass/drafts_server_0_$SAP"
  echo
  echo "  Create your first project:"
  echo "    curl -X POST https://$DOMAIN/drafts/projects \\"
  echo "      -H \"Authorization: Bearer $SAP\" \\"
  echo "      -H \"Content-Type: application/json\" \\"
  echo "      -d '{\"name\":\"hello\",\"description\":\"first project\"}'"
  echo
  echo "  Hand the returned pap_activation_url to anyone — they paste it"
  echo "  into Claude for Chrome and start building."
  echo
  echo "  To register a public server number, open a PR adding this server"
  echo "  to https://github.com/g0rd33v/drafts-protocol/blob/main/drafts-registry.json"
  echo
  echo "════════════════════════════════════════════════════════════════════"
else
  warn "SAP file not found at $SAP_FILE — check 'pm2 logs drafts' for the minted token"
fi
