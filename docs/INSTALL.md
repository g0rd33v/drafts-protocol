# Installing drafts

## Recommended: one-command installer

On a fresh Ubuntu 22.04 or 24.04 VPS, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/g0rd33v/drafts-protocol/main/install.sh \
  | bash -s drafts.example.com admin@example.com
```

Two arguments:

1. **Domain** — public hostname pointing at this VPS. Add the A record and wait for it to propagate before running.
2. **Email** — used by Let's Encrypt for cert registration and renewal warnings.

What the installer does, in order:

1. Detects Ubuntu version. Continues with a warning on other distros.
2. Verifies the domain resolves to this VPS's public IP. Aborts if it doesn't.
3. `apt install` nginx, certbot, python3-certbot-nginx, git, curl.
4. Installs Node.js 20 from NodeSource (skipped if Node 18+ already present).
5. Installs `pm2` globally (skipped if already present).
6. Clones `g0rd33v/drafts-protocol` to `/opt/drafts`.
7. Runs `npm install`.
8. Writes `/etc/labs/drafts.env` with `PUBLIC_BASE_URL` set to your domain.
9. Configures nginx as reverse proxy (port 80, with `/live/*` and `/drafts-view/*` served as static).
10. Issues HTTPS cert via certbot. Falls back to HTTP-only if Let's Encrypt fails (you can re-run certbot later).
11. Starts `drafts.js` under pm2 with `--name drafts`. Saves the pm2 process list and registers the systemd boot hook.
12. Hits `/drafts/health` to verify.
13. Reads the freshly minted SAP token from `/etc/labs/drafts.sap` and prints it once with example commands.

Total time on a $4/mo VPS: 2–3 minutes.

## Prerequisites

- Fresh Ubuntu 22.04 or 24.04 VPS (other distros may work; tested only on Ubuntu)
- Public IPv4 with port 80 + 443 open to the internet
- A domain with A record pointing at the VPS IP, propagated (verify with `dig <domain>`)
- Root SSH access
- ~512 MB RAM, ~5 GB disk minimum (drafts itself uses very little; budget for project file storage)

## Manual install

If you want to do it yourself instead of running the installer:

```bash
# As root on Ubuntu 22.04+
apt update && apt install -y curl git nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pm2

git clone https://github.com/g0rd33v/drafts-protocol.git /opt/drafts
cd /opt/drafts
npm install

mkdir -p /etc/labs /var/lib/drafts
cat > /etc/labs/drafts.env <<EOF
PUBLIC_BASE_URL=https://drafts.example.com
SERVER_NUMBER=0
PORT=3100
DRAFTS_DIR=/var/lib/drafts
EOF
chmod 600 /etc/labs/drafts.env

# nginx config — see install.sh for the full template
# certbot --nginx -d drafts.example.com -m admin@example.com --agree-tos --non-interactive

pm2 start /opt/drafts/drafts.js --name drafts
pm2 save
pm2 startup
# Save the SAP printed at startup, or read from /etc/labs/drafts.sap
```

## After install

The installer prints your SAP token once. Save it. To create a project:

```bash
SAP=$(cat /etc/labs/drafts.sap)
curl -X POST https://drafts.example.com/drafts/projects \
  -H "Authorization: Bearer $SAP" \
  -H "Content-Type: application/json" \
  -d '{"name":"hello","description":"first project"}'
```

The response contains a `pap_activation_url`. Hand that link to anyone — they paste it into Claude for Chrome and start building.

To enable GitHub mirroring of projects, configure once via the API:

```bash
# Server-default GitHub credentials (used by all projects unless overridden)
curl -X PUT https://drafts.example.com/drafts/config/github \
  -H "Authorization: Bearer $SAP" \
  -H "Content-Type: application/json" \
  -d '{"user":"yourname","token":"ghp_xxxxxxxxxxxx"}'

# Per-project override (use a different account for one project)
curl -X PUT https://drafts.example.com/drafts/projects/hello/config/github \
  -H "Authorization: Bearer $SAP" \
  -H "Content-Type: application/json" \
  -d '{"user":"otherusername","token":"ghp_yyyyyyyyyyyy"}'
```

## Troubleshooting

**`certbot` fails:** DNS isn't propagated, or ports 80/443 are blocked. Re-run `certbot --nginx -d drafts.example.com -m admin@example.com` after fixing.

**`/drafts/health` returns 502:** The Node process didn't start. Check `pm2 logs drafts`.

**SAP token not printed:** Look at `/etc/labs/drafts.sap` — the file is created on first run with mode 0600.

**Re-run installer:** Safe. The script is idempotent — it won't overwrite an existing `/etc/labs/drafts.env` or replace your data, only update code and config templates.

## Registering a public server number

Local installs use `SERVER_NUMBER=0` by default. Number 0 is the universal "unregistered" slot. To claim a public number, open a pull request adding your server entry to [`drafts-registry.json`](../drafts-registry.json) in this repo. After merge, edit `/etc/labs/drafts.env`, set `SERVER_NUMBER=<your_number>`, restart with `pm2 restart drafts`. Existing tokens stay valid; new tokens use the new number.
