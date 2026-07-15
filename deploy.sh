#!/bin/bash
# Despliega una version a produccion. Uso: ./deploy.sh [rama|tag]   (por defecto: main)
# Respalda la base, verifica la sintaxis, reinicia y comprueba que responda.
# Si algo falla, avisa para ejecutar ./rollback.sh
set -euo pipefail

APP_DIR=/root/bunnyrabbit-whatsapp
BACKUP_DIR=/root/backups-bunnyrabbit
PM2_NAME=bunnyrabbit
PUERTO=3000
REF="${1:-main}"

cd "$APP_DIR"
mkdir -p "$BACKUP_DIR"

echo "==> Respaldando base de datos"
cp whatsapp.db "$BACKUP_DIR/whatsapp.db.$(date +%Y%m%d_%H%M%S)"

echo "==> Guardando version actual (para rollback)"
git rev-parse HEAD > "$BACKUP_DIR/.version-anterior"
echo "    anterior: $(git log -1 --format='%h %s')"

echo "==> Trayendo '$REF' desde GitHub"
git fetch --tags --prune origin
git checkout -q "$REF"
# Si es una rama, avanzar al ultimo commit remoto
if git show-ref -q --verify "refs/heads/$REF" 2>/dev/null; then
  git merge -q --ff-only "origin/$REF" || echo "    (sin cambios nuevos)"
fi
echo "    nueva:    $(git log -1 --format='%h %s')"

echo "==> Verificando sintaxis"
node --check index.js

echo "==> Reiniciando PM2"
pm2 restart "$PM2_NAME" --update-env >/dev/null
sleep 3

CODE=$(curl -s -o /dev/null -m 10 -w "%{http_code}" "http://localhost:$PUERTO/" || echo "000")
if [ "$CODE" != "200" ]; then
  echo ""
  echo "!! FALLO: la app responde HTTP $CODE"
  echo "!! Ejecuta:  ./rollback.sh"
  exit 1
fi

echo ""
echo "==> OK. Produccion en $(git log -1 --format='%h %s')"
echo "    version: $(node -p "require('./package.json').version")"
