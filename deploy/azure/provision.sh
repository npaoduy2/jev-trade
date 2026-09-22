#!/usr/bin/env bash
# Creates the Azure resource group, VM and firewall rules for the Jev Trade desk.
# Idempotent: re-running skips whatever already exists.
#
#   ./deploy/azure/provision.sh
#
# Override any of these from the environment:
set -euo pipefail

RG=${RG:-jev-trade-rg}
LOCATION=${LOCATION:-southeastasia}
VM=${VM:-jev-trade-vm}
SIZE=${SIZE:-Standard_B2pts_v2}
ADMIN=${ADMIN:-azureuser}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519.pub}
IMAGE=${IMAGE:-Canonical:ubuntu-24_04-lts:server-arm64:latest}
DISK_SKU=${DISK_SKU:-StandardSSD_LRS}

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

say() { printf '\n==> %s\n' "$*"; }

[ -f "$SSH_KEY" ] || { echo "no ssh public key at $SSH_KEY (set SSH_KEY=)" >&2; exit 1; }

say "Subscription"
az account show --query '{name:name, id:id, user:user.name}' -o tsv

if az group show -n "$RG" >/dev/null 2>&1; then
  say "Resource group $RG exists"
else
  say "Creating resource group $RG in $LOCATION"
  az group create -n "$RG" -l "$LOCATION" -o none
fi

if az vm show -g "$RG" -n "$VM" >/dev/null 2>&1; then
  say "VM $VM exists, leaving it alone"
else
  say "Creating $VM ($SIZE, $IMAGE) in $LOCATION"
  az vm create \
    --resource-group "$RG" \
    --name "$VM" \
    --image "$IMAGE" \
    --size "$SIZE" \
    --admin-username "$ADMIN" \
    --ssh-key-values "$SSH_KEY" \
    --public-ip-sku Standard \
    --public-ip-address-allocation static \
    --storage-sku "$DISK_SKU" \
    --os-disk-size-gb 30 \
    --nsg-rule SSH \
    --custom-data "$HERE/cloud-init.yaml" \
    -o none

  say "Opening 80 and 443 (Caddy is the only public listener)"
  az vm open-port -g "$RG" -n "$VM" --port 80  --priority 1010 -o none
  az vm open-port -g "$RG" -n "$VM" --port 443 --priority 1020 -o none
fi

IP=$(az vm show -d -g "$RG" -n "$VM" --query publicIps -o tsv)
say "Public IP: $IP"

cat <<TXT

Next:
  1. Wait for cloud-init to finish (bun + caddy + swap, a couple of minutes):
       ssh $ADMIN@$IP 'cloud-init status --wait'
  2. Ship the code and your .env, then start the services:
       ./deploy/azure/sync.sh $IP
  3. Open http://$IP

Notes:
  * Port 22 is open to the internet with key only auth. To pin it to your
    address instead:
       az network nsg rule update -g $RG --nsg-name ${VM}NSG -n default-allow-ssh \\
         --source-address-prefixes "\$(curl -s ifconfig.me)/32"
  * Stop billing for compute without losing the disk or the IP:
       az vm deallocate -g $RG -n $VM
  * Tear the whole thing down:
       az group delete -n $RG --yes
TXT
