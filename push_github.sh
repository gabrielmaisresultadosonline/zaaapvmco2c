#!/bin/bash
# ═══════════════════════════════════════════════════════
#  Script para sincronizar código com o GitHub
#  e fazer deploy automático no VPS
# ═══════════════════════════════════════════════════════

REPO="https://github.com/gabrielmaisresultadosonline/kindred-connect.git"
BRANCH="main"

echo "📤 Sincronizando com GitHub..."

cd "$(dirname "$0")"

# Inicializar git se necessário
if [ ! -d ".git" ]; then
  git init
  git remote add origin "$REPO"
fi

# Garantir remote correto
git remote set-url origin "$REPO" 2>/dev/null || git remote add origin "$REPO"

# Stage e commit
git add -A
git commit -m "feat: deploy ZAPMRO v2.0 - $(date '+%Y-%m-%d %H:%M')" 2>/dev/null || echo "Nada para commitar"

# Push
echo "📤 Enviando para GitHub..."
git push -u origin "$BRANCH" --force 2>/dev/null || {
  echo "⚠️  Push falhou. Configure git credentials:"
  echo "  git config user.email 'seu@email.com'"
  echo "  git config user.name 'Seu Nome'"
  echo "  git push -u origin main"
}

echo "✅ Pronto! Para deploy no VPS execute:"
echo "  ssh user@SEU_VPS_IP 'cd ~/kindred-connect && git pull && pm2 restart zapmro'"
