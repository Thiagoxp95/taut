# Self-host Taut

Taut runs without a paid Taut subscription. You supply a Docker host and your own AI provider credentials. One installation owns a SQLite database, encrypted vault, agent homes, and a Docker resource namespace. There is no separate database to provision. macOS is the supported desktop platform; the server and agent containers run Linux on Docker Desktop or a Linux VPS.

## Install

Requirements: Node 22 or newer, Docker Engine/Desktop running, Compose v2, and several GB of free build space. Run these commands from this repository:

```sh
node scripts/self-host.mjs init ./self-hosted/my-company --port 3080
node scripts/self-host.mjs up ./self-hosted/my-company
```

The second command builds both images, prepares the installation's data directory, starts the server, and waits for its health check. Open **http://localhost:3080**, choose **Create one**, create your account, then create your company. Connecting GitHub is optional. In **Providers**, connect your own AI provider account before asking an agent to work.

The installer only binds the application port to localhost. For a remote host, use the HTTPS deployment below or an SSH tunnel (`ssh -L 3080:localhost:3080 user@host`). It requires a local Docker daemon, not a remote Docker context, because agent homes are bind-mounted from that host. On Linux, run the installation commands with sufficient permission to use Docker and back up the uid-1000-owned data (usually as root on the dedicated VPS).

Re-running `init` preserves the existing installation and key; it does not update its options. Use a different directory and port for a second installation. Each receives different keys, database files, and Docker namespaces. The generated `installation.json` and `compose.json` describe that instance. The server and its sibling agent containers see the same absolute data path. A private Docker network lets agents reach the API without exposing it publicly.

The server controls Docker through its socket. Treat the whole host as one trust boundary. Use a dedicated host per paying customer; Docker namespaces prevent accidental resource reuse but are not a security boundary against a compromised server with Docker access.

## macOS app

Build an installer with `pnpm --filter @taut/desktop package:mac --arch=arm64` (or `--arch=x64`) and install Taut from the DMG. Enter the same instance URL in its connection screen. See [macOS releases](macos-release.md) for commands, signed public builds, and the current verified artifacts.

## HTTPS and repeatable cloud provisioning

For automated hosts and certificates, use the [Terraform cloud provisioning guide](cloud-provisioning.md). It provisions one host per customer from the same customer-map interface and pins the application commit.

For an existing host, initialize with its public HTTPS origin:

```sh
node scripts/self-host.mjs init /opt/taut-instance --port 3080 --url https://taut.example.com
node scripts/self-host.mjs up /opt/taut-instance
```

Point the domain at the host and configure Caddy on that host:

```caddyfile
taut.example.com {
  reverse_proxy 127.0.0.1:3080
}
```

HTTPS initialization enables Secure cookies. Terminate HTTPS at Caddy before trying to sign in. Port 3080 stays private.

## Calls

Calls are optional. To provision LiveKit, Redis, and TURN on the same dedicated host, supply their public addresses at initialization:

```sh
node scripts/self-host.mjs init /opt/taut-instance --url https://taut.example.com \
  --calls --calls-url wss://calls.example.com \
  --turn-host calls.example.com --turn-ip 203.0.113.10
node scripts/self-host.mjs up /opt/taut-instance
```

Replace the example IP with the host's actual public IPv4. Add a second Caddy site, `calls.example.com`, proxying to `127.0.0.1:7880`. Open TCP 7881, UDP 7882, TCP/UDP 3478, and UDP 49160–49200. The installer generates all three call secrets and configures the webhook automatically. Only one calls installation can use those fixed media ports per host. TURN-over-TLS for networks that block these ports is an additional configuration; see [call deployment details](deploy.md).

## Operate and back up

```sh
node scripts/self-host.mjs status /opt/taut-instance
node scripts/self-host.mjs backup /opt/taut-instance
node scripts/self-host.mjs stop /opt/taut-instance
```

Backups stop the server and running agents, archive their data plus installation configuration and secrets, then restart what was running. The archive is private from creation; a failed archive is removed. Store the archive off the host in encrypted storage. It contains the master key and provider credentials encrypted with that key; anyone who can read the backup can recover them. Redis contains transient call state, not company data, and is not backed up.

Restore onto an idle host at the **same absolute installation path**:

```sh
# Ensure this instance's server and agents are stopped before restoring.
install -d -m 700 /opt/taut-instance
# Extract a trusted backup into the empty directory, preserving file permissions.
tar -xzf /secure-backups/taut-backup.tar.gz -C /opt/taut-instance
node scripts/self-host.mjs up /opt/taut-instance
```

Do not start the original and restored copy on the same Docker daemon: both have the same namespace. Do not regenerate or lose `secrets.env`; existing vault items require its exact key. Moving to a different absolute data path requires a deliberate migration of persisted agent paths and is not automated.

For an upgrade, back up, check out the desired release commit, then run `up` again to rebuild and recreate the server. Existing agents keep the image they were created with; recreate their machines through the app to adopt runtime image changes while keeping their home directories. Database migrations run at startup. Rollback requires restoring the matching pre-upgrade data backup, not just selecting an older image.

## Verification status (2026-09-10)

Verified locally: full server and agent image builds, installed-image signup/company creation, real agent namespace isolation, shared home files and API networking, restart persistence, and container-backed backup restoration. Installer isolation/key-preservation/input/backup-failure tests and Compose rendering pass. The packaged Apple Silicon app completed onboarding; both signed architecture DMGs passed integrity, mount, bundle metadata, architecture, signature, stapled-ticket and Gatekeeper checks. Optional calls services started healthy and passed authenticated room creation/deletion. Terraform validation, offline tests and rendered cloud-init checks pass.

Not yet verified: calls between participants on public networks, an actual cloud apply and HTTPS endpoints, native Intel app execution and remote CI. Docker recovered after the approved restart and existing development containers were restored. The local installation at http://localhost:3080 is healthy and ready for account/company creation. See the [verification log](self-host-verification.md) for evidence and remaining release requirements.

For one trusted company, the [Railway deployment](railway.md) bundles Taut and its agents in one service with a persistent volume, using the local machine provider. It does not require Docker-in-Docker. Agents share the server's filesystem and user; the embedded agent terminal requires the Docker provider. Use the Docker installer when separate agent containers are required. See the Railway guide for template publication and verification status.
