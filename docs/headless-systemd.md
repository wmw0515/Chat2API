# Headless Deployment with systemd (Linux)

This guide shows a minimal systemd deployment for running Chat2API headless on a Linux server.

## Scope

This document intentionally covers only a minimal local service setup:

- Install dependencies
- Build the project
- Run `npm run start:headless` under `systemd`

Out of scope for this document:

- Docker
- Nginx/reverse proxy config details
- HTTPS/TLS termination
- Cloud backup workflows
- Automatic deployment scripts

## Recommended defaults

- Bind to `127.0.0.1` by default.
- Use port `8081` for headless mode (recommended because `8080` may already be used by Open WebUI).
- Run as a non-root user (example: `chat2api`).
- Set `CHAT2API_DASHBOARD_TOKEN` for dashboard API protection.

## 1) Prepare application directory and build

Example target directory: `/opt/chat2api`

```bash
# as root (or with sudo) to create the service user once
sudo useradd --system --create-home --shell /usr/sbin/nologin chat2api

# place project source under /opt/chat2api, then:
cd /opt/chat2api
npm install
npm run build
```

## 2) Create systemd unit

Create `/etc/systemd/system/chat2api-headless.service`:

```ini
[Unit]
Description=Chat2API Headless Service
After=network.target

[Service]
Type=simple
User=chat2api
WorkingDirectory=/opt/chat2api
Environment=CHAT2API_HOST=127.0.0.1
Environment=CHAT2API_PORT=8081
Environment=CHAT2API_DASHBOARD_TOKEN=change-this-token
ExecStart=/usr/bin/env npm run start:headless
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## 3) Reload and start service

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now chat2api-headless
sudo systemctl status chat2api-headless
```

## 4) View logs

```bash
# follow live logs
sudo journalctl -u chat2api-headless -f

# recent logs from current boot
sudo journalctl -u chat2api-headless -b
```

## Safety notes

- Keep `CHAT2API_HOST=127.0.0.1` unless you have a deliberate and protected network design.
- Do **not** expose dashboard API endpoints publicly without additional reverse proxy/auth/network boundary controls.
- Always set `CHAT2API_DASHBOARD_TOKEN` for server/headless deployments.
- Treat exported backups that include credentials as secrets.
- Restrict permissions of the Chat2API data directory and backup files to the service user/admins only.

