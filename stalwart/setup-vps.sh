#!/usr/bin/env bash
# Prepara un VPS Ubuntu 24.04 y levanta Stalwart (correo real multi-dominio).
#
# Uso (como root, desde la carpeta que contiene este script y docker-compose.yml):
#   bash setup-vps.sh mail.midominio.com
#
# Es idempotente: se puede volver a ejecutar sin romper nada.
set -euo pipefail

HOST="${1:?Uso: bash setup-vps.sh mail.midominio.com}"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/stalwart

[[ "$(id -u)" == "0" ]] || { echo "Ejecuta como root (sudo -i)." >&2; exit 1; }
[[ -f "$SRC/docker-compose.yml" ]] || { echo "No encuentro docker-compose.yml junto a este script." >&2; exit 1; }
grep -q 'VERSION_ID="24.04"' /etc/os-release || echo "Aviso: probado para Ubuntu 24.04; continúo igual."

echo "==> Nombre del servidor: $HOST"
hostnamectl set-hostname "$HOST"

echo "==> Actualizando el sistema e instalando Docker y firewall"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq docker.io docker-compose-v2 ufw unattended-upgrades curl netcat-openbsd
systemctl enable --now docker
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Firewall: SSH + puertos de correo"
ufw allow OpenSSH
for p in 25 465 993 995 4190 443; do ufw allow "$p/tcp"; done
ufw --force enable

echo "==> Instalando Stalwart en $DEST"
mkdir -p "$DEST"
cp "$SRC/docker-compose.yml" "$DEST/"
[[ -f "$SRC/admin.sh" ]] && install -m 755 "$SRC/admin.sh" "$DEST/admin.sh"
cd "$DEST"
docker compose pull
docker compose up -d

echo "==> Comprobando salida por el puerto 25 (envío a otros servidores)"
if nc -z -w 8 gmail-smtp-in.l.google.com 25; then
  echo "    OK: el puerto 25 de salida está abierto."
else
  echo "    BLOQUEADO: pide a tu proveedor que desbloquee el puerto 25 de salida (ver RUNBOOK.md)."
fi

echo "==> Esperando a Stalwart"
sleep 10
if docker logs stalwart 2>&1 | grep -q 'bootstrap mode'; then
  echo "Credenciales TEMPORALES del administrador (cambian en cada reinicio hasta terminar el asistente):"
  docker logs stalwart 2>&1 | grep -A8 'bootstrap mode' | head -9
else
  echo "Stalwart ya estaba configurado (no está en modo inicial)."
fi

cat <<EOF

Siguiente paso, desde TU computador (no en el VPS):
  ssh -L 8080:127.0.0.1:8080 root@<IP-del-VPS>
y abre http://127.0.0.1:8080/admin para completar el asistente (ver RUNBOOK.md, sección 2).
EOF
