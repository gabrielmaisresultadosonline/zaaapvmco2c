#!/usr/bin/env bash
set -euo pipefail

ORIGIN_URL="${ORIGIN_URL:-https://github.com/gabrielmaisresultadosonline/zaaapvmco2c.git}"
BRANCH="${BRANCH:-main}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "Git não encontrado. Instale o Git for Windows."
  exit 1
fi

if [ ! -d .git ]; then
  git init
  git branch -M "$BRANCH"
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$ORIGIN_URL"
else
  git remote add origin "$ORIGIN_URL"
fi

if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  git rm --cached -f .env || true
fi

tracked_json="$(git ls-files 'data/*.json' 'data/**/*.json' 2>/dev/null || true)"
if [ -n "${tracked_json:-}" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    git rm --cached -f "$f" || true
  done <<< "$tracked_json"
fi

git add -A

if git diff --cached --quiet; then
  echo "Nada para enviar."
  exit 0
fi

MSG="${1:-}"
if [ -z "${MSG:-}" ]; then
  MSG="update $(date +%Y-%m-%d_%H-%M)"
fi

git commit -m "$MSG" || true

git fetch origin "$BRANCH" >/dev/null 2>&1 || true
git pull --rebase origin "$BRANCH" || true
git push -u origin "$BRANCH"

echo "OK: enviado para $ORIGIN_URL ($BRANCH)"
