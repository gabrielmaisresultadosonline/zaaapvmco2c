#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/SEU_USUARIO/SEU_REPO.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/kindred-connect}"
APP_USER="${APP_USER:-zapmro}"
APP_PORT="${APP_PORT:-3000}"
DOMAIN="${DOMAIN:-zapmro.com.br}"

NODE_MAJOR="${NODE_MAJOR:-20}"

JWT_SECRET="${JWT_SECRET:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@zapmro.cloud}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
TEST_PROMO_CODE="${TEST_PROMO_CODE:-ZAPMRO2026}"

GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-}"
GOOGLE_REDIRECT_URI="${GOOGLE_REDIRECT_URI:-https://zapmro.com.br/auth/google/callback}"

OPENAI_API_KEY="${OPENAI_API_KEY:-}"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "Precisa rodar como root ou ter sudo instalado."
    exit 1
  fi
fi

$SUDO apt-get update -y
$SUDO apt-get install -y git curl ca-certificates gnupg lsb-release nginx

curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
$SUDO apt-get install -y nodejs

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  $SUDO useradd -m -s /bin/bash "$APP_USER"
fi

if ! command -v google-chrome >/dev/null 2>&1; then
  $SUDO install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | $SUDO gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | $SUDO tee /etc/apt/sources.list.d/google-chrome.list >/dev/null
  $SUDO apt-get update -y
  $SUDO apt-get install -y google-chrome-stable
fi

$SUDO mkdir -p "$APP_DIR"
$SUDO chown -R "$APP_USER:$APP_USER" "$APP_DIR"

if [ ! -d "$APP_DIR/.git" ]; then
  $SUDO -u "$APP_USER" git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"
else
  $SUDO -u "$APP_USER" bash -lc "cd '$APP_DIR' && git fetch --all --prune && git checkout '$BRANCH' && git pull --ff-only"
fi

if [ ! -f "$APP_DIR/.env" ]; then
  if [ -z "$JWT_SECRET" ] || [ -z "$ADMIN_PASSWORD" ]; then
    echo "Defina JWT_SECRET e ADMIN_PASSWORD antes de rodar."
    echo "Exemplo:"
    echo "  JWT_SECRET='...forte...' ADMIN_PASSWORD='...forte...' bash install_ubuntu_24.sh"
    exit 1
  fi

  $SUDO -u "$APP_USER" bash -lc "cat > '$APP_DIR/.env' <<EOF
PORT=$APP_PORT
JWT_SECRET=$JWT_SECRET
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
TEST_PROMO_CODE=$TEST_PROMO_CODE

GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI=$GOOGLE_REDIRECT_URI

OPENAI_API_KEY=$OPENAI_API_KEY

WA_HEADLESS=true
WA_CHROME_PATH=/usr/bin/google-chrome
EOF"
  $SUDO chmod 600 "$APP_DIR/.env"
  $SUDO chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
fi

$SUDO -u "$APP_USER" bash -lc "cd '$APP_DIR' && export PUPPETEER_SKIP_DOWNLOAD=1 && npm install --omit=dev"

$SUDO tee /etc/systemd/system/kindred-connect.service >/dev/null <<EOF
[Unit]
Description=ZAPMRO Kindred Connect
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=/usr/bin/node $APP_DIR/Server/index.js
Restart=always
RestartSec=2
User=$APP_USER

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now kindred-connect

$SUDO tee /etc/nginx/sites-available/kindred-connect >/dev/null <<EOF
server {
  listen 80;
  server_name $DOMAIN;

  client_max_body_size 50m;

  location /socket.io/ {
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_pass http://127.0.0.1:$APP_PORT;
  }

  location / {
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_pass http://127.0.0.1:$APP_PORT;
  }
}
EOF

if [ -e /etc/nginx/sites-enabled/default ]; then
  $SUDO rm -f /etc/nginx/sites-enabled/default
fi
$SUDO ln -sf /etc/nginx/sites-available/kindred-connect /etc/nginx/sites-enabled/kindred-connect
$SUDO nginx -t
$SUDO systemctl reload nginx

echo "OK."
echo "App: systemctl status kindred-connect --no-pager"
echo "Logs: journalctl -u kindred-connect -f"
echo "Abra: http://$DOMAIN"
