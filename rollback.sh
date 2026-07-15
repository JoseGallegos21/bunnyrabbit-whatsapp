#!/bin/bash
# Vuelve produccion a una version anterior. Uso: ./rollback.sh [tag|commit]
# Sin argumento vuelve a la version que habia antes del ultimo ./deploy.sh
set -euo pipefail

APP_DIR=/root/bunnyrabbit-whatsapp
BACKUP_DIR=/root/backups-bunnyrabbit
PM2_NAME=bunnyrabbit
PUERTO=3000

cd "$APP_DIR"

DEST="${1:-}"
if [ -z "$DEST" ]; then
  if [ ! -f "$BACKUP_DIR/.version-anterior" ]; then
    echo "!! No hay version anterior registrada. Indica una:  ./rollback.sh v1.0.0"
    echo "   Versiones disponibles:"; git tag -l | tail -5
    exit 1
  fi
  DEST=$(cat "$BACKUP_DIR/.version-anterior")
fi

echo "==> Volviendo a: $DEST"
git checkout -q "$DEST"
echo "    $(git log -1 --format='%h %s')"

echo "==> Verificando sintaxis"
node --check index.js

echo "==> Reiniciando PM2"
pm2 restart "$PM2_NAME" --update-env >/dev/null
sleep 3

CODE=$(curl -s -o /dev/null -m 10 -w "%{http_code}" "http://localhost:$PUERTO/" || echo "000")
if [ "$CODE" != "200" ]; then
  echo "!! CUIDADO: sigue sin responder (HTTP $CODE). Revisa:  pm2 logs $PM2_NAME"
  exit 1
fi

echo ""
echo "==> OK. Rollback completado."
echo "    NOTA: la base de datos NO se revierte. Respaldos en $BACKUP_DIR"
