# Deploying Taut

One container, one volume, one secret; a €4/mo VPS with Docker and Compose v2 is enough (agent-model §0).

## 1. Up

`TAUT_MASTER_KEY` encrypts every vault item. Keep it — **lose it, lose the vault.**

```sh
git clone https://github.com/<you>/taut.git && cd taut
echo "TAUT_MASTER_KEY=$(openssl rand -base64 32)" > .env
docker compose up -d
curl localhost:3000/api/health          # {"ok":true,"version":"…"}
```

Open `http://<host>:3000`; the first visit lands on `/signup` and that account
owns the first company. On plain HTTP add `TAUT_COOKIE_SECURE=false` to `.env`,
or login bounces you straight back.

## 2. TLS

Uncomment the `caddy` service in `docker-compose.yml`, drop `ports:` from `taut`,
and add a `Caddyfile` beside it: `taut.example.com` then `reverse_proxy taut:3000`.

## 2b. Notifications on phones (PWA)

Taut installs to a Home Screen and pushes notifications, but **only over HTTPS** —
finish §2 first. `http://` works on `localhost` alone.

Generate a VAPID keypair once and put it in `.env`:

```sh
pnpm --filter @taut/server exec node -e "console.log(require('web-push').generateVAPIDKeys())"
```

```
TAUT_VAPID_PUBLIC_KEY=B...
TAUT_VAPID_PRIVATE_KEY=...
TAUT_VAPID_SUBJECT=mailto:you@example.com
```

Without both keys push stays off and the app hides the toggle; the rest of Taut is
unaffected. Rotating the keys invalidates every registered device — each one
re-subscribes the next time its owner opens the app and toggles notifications.

On the phone: open the site, **Add to Home Screen**, open it from there, then
avatar menu → _Turn on notifications_. iOS refuses the permission prompt in a
plain Safari tab, so the Home Screen step is not optional there.

## 2c. Calls (huddles)

Self-hosted LiveKit + Redis + eturnal (TURN), behind a `calls` compose profile.
Off by default — plain `docker compose up -d` never starts them, and the UI
hides the huddle button until `TAUT_LIVEKIT_URL`/`_API_KEY`/`_API_SECRET` are
all set (docs/build-plan-calls.md D3).

Generate the secrets once and put them in `.env`:

```sh
echo "TAUT_LIVEKIT_API_KEY=$(openssl rand -hex 16)"   >> .env
echo "TAUT_LIVEKIT_API_SECRET=$(openssl rand -hex 32)" >> .env
echo "TAUT_TURN_SECRET=$(openssl rand -hex 32)"        >> .env
```

Also set `TAUT_LIVEKIT_URL` (the `wss://` address browsers will use — usually
a dedicated subdomain such as `wss://livekit.example.com` proxied to port
7880, or `ws://<host>:7880` direct for a LAN trial — LiveKit serves its own
paths at the root, so do not put it on a subpath), `TAUT_TURN_HOST` (the address
clients reach eturnal on) and `TAUT_TURN_PUBLIC_IP` (this host's public IPv4 —
eturnal advertises it in relay candidates, and a wrong value here is the
number one reason calls connect on localhost and fail from anywhere else).

Open on the firewall: `7880/tcp` (signal), `7881/tcp` (ICE over TCP),
`7882/udp` (media — single-port mux, D9), `3478/udp` and `3478/tcp` (TURN),
`49160-49200/udp` (TURN relay range).

```sh
docker compose --profile calls up -d
```

**Scale.** One LiveKit node on bridge networking is fine up to roughly 100
concurrent participants; past that, `rtc.udp_port` stops being viable because
every media stream shares one mapped port. Switch the `livekit` service to
`network_mode: host` and give `rtc` a real UDP port range, in the `livekit`
config at the bottom of `docker-compose.yml`, instead of the single port (D9).
That is a config change, not a rebuild.

**TURN over TLS.** The default profile listens for TURN on plain UDP/TCP 3478,
which is enough behind most NATs. Some corporate networks only let TLS out on
443; for those, eturnal needs `tls_crt_file`/`tls_key_file` and a `tls`
listener added to `deploy/eturnal.yml`, which means real certificates for the
TURN host. Treat it as a production hardening step, not part of first bring-up
(D11).

## 3. The agent image

Agent runtimes (claude, codex, opencode) live in a _second_ image, built on the host before your first agent:

```sh
docker build -f packages/runtime/docker/agent.Dockerfile -t taut/agent:latest packages/runtime/docker
```

The `docker` MachineProvider drives `/var/run/docker.sock` (already mounted) and needs the
host's docker gid — see `group_add` in the compose file. With the `local` provider, drop the mount.

## 4. Backups

Everything is in the `taut-data` volume (`/data`: `taut.db`, company folders, agent
homes). Back up `.env` separately; the archive is useless without the key.

```sh
docker compose stop taut
docker run --rm -v taut-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/taut-$(date +%F).tar.gz -C /data .
docker compose start taut
```

## 5. Upgrading

`git pull && docker compose up -d --build`. Migrations run at boot; back up first, there is no downgrade path.

## 6. Hetzner CX22, from zero

```sh
ssh root@<ip> 'curl -fsSL https://get.docker.com | sh && \
  git clone https://github.com/<you>/taut.git /opt/taut && cd /opt/taut && \
  { echo "TAUT_MASTER_KEY=$(openssl rand -base64 32)"; echo TAUT_COOKIE_SECURE=false; } > .env && \
  docker compose up -d --build && docker compose logs --tail=20 taut'
```
