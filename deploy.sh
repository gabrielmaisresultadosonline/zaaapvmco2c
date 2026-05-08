#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
#  ZAPMRO CLOUD v2.0 - Script de Instalação/Deploy Completo
#  Ubuntu 24 LTS | Hostinger VPS
#  Uso: bash deploy.sh
# ═══════════════════════════════════════════════════════════════════════

set -e
echo "🚀 ZAPMRO CLOUD v2.0 - Deploy Profissional"
echo "============================================"

# ── Configurações ──────────────────────────────────────────────────────
PROJECT_DIR="$HOME/kindred-connect"
GITHUB_REPO="https://github.com/gabrielmaisresultadosonline/kindred-connect.git"
NODE_VERSION="20"

# ── 1. Atualizar sistema ───────────────────────────────────────────────
echo "📦 Atualizando sistema..."
sudo apt-get update -qq
sudo apt-get upgrade -y -qq

# ── 2. Instalar Node.js 20 ─────────────────────────────────────────────
echo "⚙️ Instalando Node.js ${NODE_VERSION}..."
if ! node -v 2>/dev/null | grep -q "v${NODE_VERSION}"; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v && npm -v

# ── 3. Dependências sistema para Puppeteer/Chrome ──────────────────────
echo "🌐 Instalando dependências do Chrome/Puppeteer..."
sudo apt-get install -y \
  ffmpeg git curl wget unzip \
  libnss3 libatk-bridge2.0-0t64 libatk1.0-0t64 \
  libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxrandr2 libgbm1 libasound2t64 \
  libpango-1.0-0 libcairo2 libxshmfence1 \
  libgtk-3-0t64 libgdk-pixbuf2.0-0 libx11-xcb1 \
  xvfb 2>/dev/null || true

# ── 4. Instalar PM2 globalmente ────────────────────────────────────────
echo "🔧 Instalando PM2..."
sudo npm install -g pm2 2>/dev/null || npm install -g pm2

# ── 5. Clone ou atualizar repositório ─────────────────────────────────
echo "📂 Preparando projeto..."
if [ -d "$PROJECT_DIR/.git" ]; then
  echo "Atualizando repositório existente..."
  cd "$PROJECT_DIR"
  git pull origin main 2>/dev/null || git pull origin master 2>/dev/null || true
else
  echo "Clonando repositório..."
  git clone "$GITHUB_REPO" "$PROJECT_DIR" 2>/dev/null || {
    echo "⚠️ Clone falhou. Criando estrutura manualmente..."
    mkdir -p "$PROJECT_DIR"
  }
  cd "$PROJECT_DIR"
fi

# ── 6. Criar estrutura de pastas ──────────────────────────────────────
mkdir -p "$PROJECT_DIR"/{Server,Public,data/{history,archives},Public/uploads,.wwebjs_auth}

# ── 7. Instalar dependências Node ─────────────────────────────────────
echo "📦 Instalando dependências npm..."
cd "$PROJECT_DIR"
npm install --prefer-offline 2>/dev/null || npm install

# ── 8. Configurar .env se não existir ─────────────────────────────────
if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "⚙️ Criando .env padrão..."
  cat > "$PROJECT_DIR/.env" << 'ENV_EOF'
ADMIN_EMAIL="admin@zapmro.cloud"
ADMIN_PASSWORD="admin123"
NODE_ENV="production"
PORT="3000"
JWT_SECRET="zapmro-jwt-secret-change-this-in-production"
OPENAI_API_KEY=""
DEEPSEEK_API_KEY=""
SUPABASE_URL="https://tuwokddiyltxsmcmzbaz.supabase.co"
SUPABASE_PUBLISHABLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1d29rZGRpeWx0eHNtY216YmF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxOTc5MjQsImV4cCI6MjA5Mzc3MzkyNH0.m-b9PvlWfMYewSLHD2L9VjJuDXBJq60DDqJme6UNdrI"
TEST_PROMO_CODE="ZAPMRO2026"
ENV_EOF
fi

# ── 9. Configurar Firewall ─────────────────────────────────────────────
echo "🔒 Configurando firewall..."
sudo ufw allow 3000/tcp 2>/dev/null || true
sudo ufw allow 80/tcp 2>/dev/null || true
sudo ufw allow 443/tcp 2>/dev/null || true
sudo ufw allow 22/tcp 2>/dev/null || true

# ── 10. Parar instâncias antigas do PM2 ───────────────────────────────
echo "🔄 Reiniciando serviço..."
pm2 delete zapmro 2>/dev/null || true

# ── 11. Iniciar com PM2 ───────────────────────────────────────────────
pm2 start "$PROJECT_DIR/Server/index.js" \
  --name "zapmro" \
  --max-memory-restart 800M \
  --restart-delay 3000 \
  --log "$HOME/.pm2/logs/zapmro.log" \
  --error "$HOME/.pm2/logs/zapmro-error.log" \
  -- 2>/dev/null

pm2 save
pm2 startup 2>/dev/null | tail -1 | bash 2>/dev/null || true

# ── 12. Status final ──────────────────────────────────────────────────
sleep 3
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo ""
echo "═══════════════════════════════════════════════════"
echo "✅  ZAPMRO CLOUD v2.0 ONLINE!"
echo "═══════════════════════════════════════════════════"
echo "🌐  URL: http://${SERVER_IP}:3000"
echo "📊  PM2: pm2 status"
echo "📋  Logs: pm2 logs zapmro"
echo "🔄  Restart: pm2 restart zapmro"
echo "═══════════════════════════════════════════════════"
pm2 status
