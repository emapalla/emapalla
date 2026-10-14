#!/usr/bin/env bash
# Trae la última versión del conector desde GitHub y lo reinicia solo si cambió algo.
set -euo pipefail
DIR=/opt/bitacora
RAMA="${RAMA:-claude/bitacora-perforacion}"
cd "$DIR"
ANTES="$(git rev-parse HEAD)"
git fetch --depth 1 origin "$RAMA"
git reset --hard FETCH_HEAD
if [ "$(git rev-parse HEAD)" != "$ANTES" ]; then
  cd conector-whatsapp && npm ci --omit=dev --no-audit --no-fund
  systemctl restart bitacora-conector
  echo "Conector actualizado a $(git rev-parse --short HEAD)"
else
  echo "Sin cambios"
fi
