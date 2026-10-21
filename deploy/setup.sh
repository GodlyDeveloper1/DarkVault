#!/usr/bin/env bash
# Puts Dark Vault on a fresh Ubuntu 24.04 server, with HTTPS. TESTNET ONLY.
#
#   curl -fsSL https://raw.githubusercontent.com/GodlyDeveloper1/DarkVault/main/deploy/setup.sh -o setup.sh
#   sudo bash setup.sh zecdarkvault.xyz
#
# Run it as root (or with sudo). Before running it, point the domain's A record
# (and www, if you want it) at this server's IP: Caddy can only get an HTTPS
# certificate once the name leads here.
#
# What it does:
#   1. Installs Docker and turns on the firewall: only SSH (22), HTTP (80) and HTTPS (443).
#   2. Gets the code into /opt/darkvault (or updates it).
#   3. Makes /opt/darkvault/.env with a fresh operator key, made here and never
#      printed in full. Read it on the server: sudo grep OPERATOR /opt/darkvault/.env
#   4. Builds and starts the signer, the house signer, the web app and Caddy.
#      The first build takes 20-45 minutes.
#
# Run it again at any time to update to the latest code: the wallets, records
# and keys stay in their Docker volumes, and .env is kept.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
REPO="https://github.com/GodlyDeveloper1/DarkVault.git"
DIR="/opt/darkvault"

if [ "$(id -u)" -ne 0 ]; then echo "Run it with sudo: sudo bash setup.sh yourdomain"; exit 1; fi
if [ -z "$DOMAIN" ]; then echo "Say which domain: sudo bash setup.sh zecdarkvault.xyz [email-for-certificate-notices]"; exit 1; fi

echo "== 1/4 Docker and the firewall"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl git ufw openssl
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
# Docker publishes ports past ufw. Only Caddy publishes to the world (80, 443);
# the web app is published on 127.0.0.1 only and the signers not at all.

echo "== 2/4 The code"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi
cd "$DIR"

echo "== 3/4 Settings"
if [ ! -f .env ]; then
  KEY="$(openssl rand -hex 24)"
  cat > .env <<ENV
# Made by deploy/setup.sh. Never commit or share this file.
DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
VAULT_OPERATOR_KEY=$KEY
VAULT_MIN_CONFIRMATIONS=3
WEB_PORT=3100
ENV
  chmod 600 .env
  echo "   Made .env with a new operator key (starts ${KEY:0:4}…). Read it with: sudo grep OPERATOR $DIR/.env"
else
  sed -i "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" .env
  grep -q '^DOMAIN=' .env || echo "DOMAIN=$DOMAIN" >> .env
  echo "   Kept the existing .env (and its operator key)."
fi

echo "== 4/4 Build and start (the first build takes 20-45 minutes)"
docker compose -f docker-compose.yml -f deploy/caddy.yml up -d --build

echo
echo "Done. Dark Vault is starting at https://$DOMAIN"
echo "  Watch the signers sync:   docker compose logs -f signer house-signer"
echo "  Everything running:       docker compose -f docker-compose.yml -f deploy/caddy.yml ps"
echo "  Operator key:             sudo grep OPERATOR $DIR/.env"
