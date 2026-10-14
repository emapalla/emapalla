#!/usr/bin/env bash
# Instalador del Conector WhatsApp de la Bitácora de Perforación.
# Pensado para un servidor Ubuntu nuevo (Oracle Cloud Always Free u otro).
# Uso (como root):  CLAVE="tu-clave-secreta" bash instalar.sh
# Deja andando: el conector (servicio bitacora-conector), HTTPS automático con Caddy
# en https://<ip-con-guiones>.sslip.io y una actualización diaria desde GitHub.
set -euo pipefail

REPO="${REPO:-https://github.com/emapalla/emapalla.git}"
RAMA="${RAMA:-claude/bitacora-perforacion}"
DIR=/opt/bitacora
DATA=/var/lib/bitacora
ENVF=/etc/bitacora.env
log(){ echo "[bitacora] $*"; }

if [ "$(id -u)" != 0 ]; then echo "Ejecutalo como root (sudo)."; exit 1; fi
export DEBIAN_FRONTEND=noninteractive

log "Instalando paquetes base…"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg openssl debian-keyring debian-archive-keyring apt-transport-https

# Memoria de intercambio: los servidores gratis tienen 1 GB de RAM
if [ "$(free -m | awk '/Mem:/{print $2}')" -lt 1800 ] && [ -z "$(swapon --show --noheadings)" ]; then
  log "Creando 2 GB de memoria de intercambio…"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  log "Instalando Node.js 22…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  log "Instalando Caddy (HTTPS automático)…"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

id bitacora >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin bitacora
mkdir -p "$DATA" && chown -R bitacora:bitacora "$DATA"

log "Descargando el conector desde GitHub ($RAMA)…"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --depth 1 origin "$RAMA" && git -C "$DIR" reset --hard FETCH_HEAD
else
  git clone --depth 1 -b "$RAMA" "$REPO" "$DIR"
fi
cd "$DIR/conector-whatsapp" && npm ci --omit=dev --no-audit --no-fund

# Clave secreta: la que se pasó en CLAVE, o una nueva al azar
if [ ! -f "$ENVF" ]; then
  CLAVE="${CLAVE:-$(openssl rand -hex 16)}"
  if [ "${#CLAVE}" -lt 16 ] || ! [[ "$CLAVE" =~ ^[A-Za-z0-9_-]+$ ]]; then
    log "La CLAVE tiene que tener al menos 16 caracteres, solo letras, números, - o _. Uso una al azar."
    CLAVE="$(openssl rand -hex 16)"
  fi
  printf 'TOKEN=%s\n' "$CLAVE" > "$ENVF"
  chmod 600 "$ENVF"
fi

IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
DOM="${DOMINIO:-$(echo "$IP" | tr . -).sslip.io}"
echo "$DOM" > /etc/bitacora.dominio

log "Configurando el servicio…"
cat > /etc/systemd/system/bitacora-conector.service <<EOF
[Unit]
Description=Conector WhatsApp de la Bitacora de Perforacion
After=network-online.target
Wants=network-online.target

[Service]
User=bitacora
EnvironmentFile=$ENVF
Environment=DATA_DIR=$DATA PORT=3000 NODE_ENV=production
WorkingDirectory=$DIR/conector-whatsapp
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/bitacora-actualizar.service <<EOF
[Unit]
Description=Actualiza el Conector WhatsApp desde GitHub

[Service]
Type=oneshot
Environment=RAMA=$RAMA
ExecStart=/bin/bash $DIR/conector-whatsapp/actualizar.sh
EOF

cat > /etc/systemd/system/bitacora-actualizar.timer <<'EOF'
[Unit]
Description=Actualizacion diaria del Conector WhatsApp

[Timer]
OnCalendar=*-*-* 07:30:00 UTC
RandomizedDelaySec=900
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$DOM {
	reverse_proxy 127.0.0.1:3000
}
EOF

# Cortafuegos del sistema (las imágenes Ubuntu de Oracle bloquean todo salvo SSH)
for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save || true; fi
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp; ufw allow 443/tcp; fi

cat > /usr/local/bin/bitacora-info <<'EOF'
#!/bin/bash
T=$(sed -n 's/^TOKEN=//p' /etc/bitacora.env); D=$(cat /etc/bitacora.dominio)
echo
echo "  Página de administración (QR y grupos):"
echo "    https://$D/admin?token=$T"
echo
echo "  Dirección del conector para claude.ai (nombre: Bitacora WhatsApp):"
echo "    https://$D/mcp/$T"
echo
systemctl is-active --quiet bitacora-conector && echo "  Conector: funcionando" || echo "  Conector: DETENIDO (sudo systemctl restart bitacora-conector)"
EOF
chmod 755 /usr/local/bin/bitacora-info

systemctl daemon-reload
systemctl enable --now bitacora-conector.service bitacora-actualizar.timer
systemctl enable caddy && systemctl restart caddy

log "Listo."
/usr/local/bin/bitacora-info | tee "$DATA/DIRECCIONES.txt"
