#!/usr/bin/env bash
# Ships the working tree to the VM, installs, builds the dashboard and restarts
# both services. Run it again after every change you want live.
#
#   ./deploy/azure/sync.sh <ip-or-host>
#   ./deploy/azure/sync.sh              # resolves the IP from Azure
#
# LOCAL_BUILD=1 builds web/.next here and ships it, for when the VM is too small
# to build comfortably. node_modules is always installed on the VM and never
# copied: the VM is arm64 Linux and this workstation is arm64 darwin, so the
# lockfile resolves different platform binaries on each side.
set -euo pipefail

RG=${RG:-jev-trade-rg}
VM=${VM:-jev-trade-vm}
ADMIN=${ADMIN:-azureuser}
APP=${APP:-/opt/jev-trade}
# The dashboard talks to the bot through Caddy on the same origin.
API_URL=${API_URL:-/api}

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
HOST=${1:-}
if [ -z "$HOST" ]; then
  HOST=$(az vm show -d -g "$RG" -n "$VM" --query publicIps -o tsv)
  [ -n "$HOST" ] || { echo "could not resolve the VM address" >&2; exit 1; }
fi
TARGET="$ADMIN@$HOST"

say() { printf '\n==> %s\n' "$*"; }

say "Target $TARGET"
ssh -o StrictHostKeyChecking=accept-new "$TARGET" 'cloud-init status --wait' || true

if [ "${LOCAL_BUILD:-0}" = "1" ]; then
  say "Building the dashboard here (LOCAL_BUILD=1)"
  ( cd "$ROOT/web" && NEXT_PUBLIC_API_URL="$API_URL" bun run build )
fi

say "Shipping the tree"
# Excluded paths are never deleted on the far side, so node_modules and .next
# survive --delete.
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '/assets/' \
  --exclude '/data/' \
  --exclude '/docs/' \
  --exclude '/.idea/' \
  --exclude '/.claude/' \
  --exclude '/deploy/' \
  --exclude 'tsconfig.tsbuildinfo' \
  --exclude '*.log' \
  --exclude '/web/.env.local' \
  $( [ "${LOCAL_BUILD:-0}" = "1" ] || printf '%s' "--exclude /web/.next/" ) \
  "$ROOT/" "$TARGET:$APP/"

say "Remote install, build and restart"
ssh "$TARGET" API_URL="$API_URL" APP="$APP" LOCAL_BUILD="${LOCAL_BUILD:-0}" 'bash -seu' <<'REMOTE'
export PATH="$HOME/.bun/bin:$PATH"

# .env carries a signing key. Nobody else on the box needs to read it.
chmod 600 "$APP/.env" 2>/dev/null || true
chmod 600 "$APP/.wallets.json" 2>/dev/null || true

# Next inlines NEXT_PUBLIC_* at build time, so this has to be right before the
# build, not at boot.
printf 'NEXT_PUBLIC_API_URL=%s\n' "$API_URL" > "$APP/web/.env.local"

echo "-- bun install (bot)"
cd "$APP" && bun install

echo "-- bun install (dashboard)"
cd "$APP/web" && bun install

if [ "$LOCAL_BUILD" != "1" ]; then
  echo "-- next build"
  cd "$APP/web" && NODE_ENV=production bun run build
else
  echo "-- using the .next shipped from the workstation"
fi

echo "-- services"
sudo systemctl daemon-reload
sudo systemctl enable jev-bot jev-web >/dev/null
sudo systemctl restart jev-bot jev-web

# The bot rebuilds each sleeve's position from the venue and replays its fills
# before it listens, which takes well over a couple of seconds. Wait for the
# port rather than guess at a sleep, or the health check below reports a 502 on
# a desk that is merely still booting.
for _ in $(seq 1 45); do
  curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:3000/ && break
  sleep 2
done
for _ in $(seq 1 30); do
  curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:3001/ && break
  sleep 2
done
systemctl is-active jev-bot jev-web || true
REMOTE

say "Health"
curl -fsS --max-time 10 "http://$HOST/api/" | head -c 400 || echo "bot did not answer on /api/"
echo
curl -fsS --max-time 20 -o /dev/null -w 'dashboard http %{http_code}\n' "http://$HOST/" || echo "dashboard did not answer"

say "Live at http://$HOST"
echo "Logs:  ssh $TARGET 'journalctl -u jev-bot -u jev-web -f'"
