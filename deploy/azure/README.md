# Azure deploy

One Ubuntu 24.04 VM runs the whole desk. Caddy on 80/443 is the only public
listener; the Bun bot and the Next dashboard both stay on loopback.

```
        :80 / :443                 Caddy
          |                          |
          |  /            --------->  127.0.0.1:3001   Next dashboard
          |  /api/*       --------->  127.0.0.1:3000   Bun bot  (prefix stripped)
```

Both are served from one origin, so the dashboard reads `/api/events` as a
relative URL. That is why `NEXT_PUBLIC_API_URL=/api` and not a hostname.

The split the repo cares about still holds: keys, evaluate and orders live on the
Bun process, and the dashboard is a Next app that only reads the feed.

## Shape

| | |
| --- | --- |
| Resource group | `jev-trade-rg` |
| Region | `southeastasia` (Singapore) |
| VM | `jev-trade-vm`, `Standard_B2pts_v2`, 2 vCPU / 1 GiB, arm64 |
| Disk | 30 GB StandardSSD |
| Public IP | Standard SKU, static, so it survives a deallocate |
| Open ports | 22, 80, 443 |
| Image | Ubuntu 24.04 LTS arm64, Gen2 |
| Runtime | Bun native under systemd, `jev-bot` and `jev-web` |

### Why arm64

Every x64 B-series SKU is `NotAvailableForSubscription` in `southeastasia` on
this subscription, so `Standard_B1s` cannot be deployed there at all. The arm64
`Bpsv2` family is available, and it is what the existing `vm-proxy` in this
subscription already runs on. `Standard_B2pts_v2` costs about the same as a
`B1s`, gives two vCPUs instead of one, and keeps the desk in Singapore rather
than trading latency to the exchanges for an architecture nobody here needs. Bun,
Caddy and Next all ship arm64 Linux builds.

Moving region does not recover a `B1s` either: it is unavailable in `eastasia`,
`japaneast` and `koreacentral` too, which offer only `B2ls_v2` (4 GiB) and
`B2s_v2` (8 GiB), both dearer than this. Confirm the picture yourself before
changing region or size:

```sh
az vm list-skus -l southeastasia --resource-type virtualMachines \
  --query "[?starts_with(name,'Standard_B2')].{sku:name,restricted:restrictions[0].reasonCode}" -o table
```

### The 1 GiB build

1 GiB is comfortable at runtime (the bot sits near 100 MB, `next start` near
250 MB) but not enough to build Next 16. cloud-init adds a 2 GiB swapfile with
`vm.swappiness=10` so the build has headroom without the bot paging during
normal operation. If a build still drags, build on your workstation instead:

```sh
LOCAL_BUILD=1 ./deploy/azure/sync.sh
```

`node_modules` is always installed on the VM and never copied. Both sides are
arm64, but the lockfile still resolves different platform binaries for linux and
darwin.

## First run

```sh
az login --tenant 5e2a3cbd-1a52-45ad-b514-ab42956b372c --scope "https://management.core.windows.net//.default"
./deploy/azure/provision.sh
./deploy/azure/sync.sh
```

`provision.sh` is idempotent. `sync.sh` is the deploy: run it again after every
change you want live.

Override anything from the environment:

```sh
RG=jev-staging LOCATION=eastasia SIZE=Standard_B2s ./deploy/azure/provision.sh
```

## Secrets

`.env` and `.wallets.json` travel with `sync.sh` over ssh and land at mode 600.
They are deliberately **not** in `cloud-init.yaml`: cloud-init user data is
readable from the instance metadata service, so a signing key put there is
readable by anything that can reach 169.254.169.254 on the box.

Check what the VM is actually running before you let it trade for real:

```sh
ssh azureuser@<ip> 'grep -E "^(VENUE|HL_TESTNET|OKX_DEMO|DRY_RUN|MODEL)=" /opt/jev-trade/.env'
```

`HL_TESTNET=false` or `OKX_DEMO=false` is real money.

## Day to day

```sh
ssh azureuser@<ip> 'journalctl -u jev-bot -u jev-web -f'   # logs
ssh azureuser@<ip> 'sudo systemctl restart jev-bot'        # restart the bot only
ssh azureuser@<ip> 'systemctl is-active jev-bot jev-web'   # status
curl http://<ip>/api/                                      # snapshot
```

The bot holds its tape in memory and nothing on disk, so a restart starts the
tape over. Position and balance are rebuilt from the venue, not from local state.

## A hostname and HTTPS

Point an A record at the VM's IP, then swap the first line of
`/etc/caddy/Caddyfile` from `:80` to the hostname and reload. Caddy takes out
the certificate itself.

```sh
ssh azureuser@<ip>
sudo sed -i 's/^:80 {/desk.example.com {/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## Cost

`Standard_B2pts_v2` plus a 30 GB StandardSSD and a static IP is roughly 15 USD a
month in Southeast Asia. Stop paying for compute without losing the disk or the
address:

```sh
az vm deallocate -g jev-trade-rg -n jev-trade-vm
az vm start      -g jev-trade-rg -n jev-trade-vm
```

Tear it all down:

```sh
az group delete -n jev-trade-rg --yes
```

## Locking down ssh

Port 22 is open to the internet with key only auth. To pin it to your address:

```sh
az network nsg rule update -g jev-trade-rg --nsg-name jev-trade-vmNSG \
  -n default-allow-ssh --source-address-prefixes "$(curl -s ifconfig.me)/32"
```
