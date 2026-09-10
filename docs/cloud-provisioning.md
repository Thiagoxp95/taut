# Provision Taut for one company or many

The [Hetzner Terraform configuration](../deploy/terraform/hetzner) provisions a separate Ubuntu 24.04 host for each customer. First boot installs Docker, Node.js 22, and Caddy; checks out an explicitly selected Taut commit; builds the app and agent images; creates an installation with its own encryption key and data directory; and starts the app behind HTTPS. Optional calling adds LiveKit, Redis, and eturnal on the same host.

This is a repeatable infrastructure setup, not a hosted signup or billing service. You operate the cloud account, DNS, backups, and updates. The macOS app connects to the resulting HTTPS address; see [macOS releases](macos-release.md). Running a Linux server does not add a Linux desktop release target.

## Before provisioning

- A Hetzner Cloud account/project with billing and a read/write API token. Applying the plan creates paid resources, including a public IPv4 and server backups by default. Check the provider's current price and capacity for your selected region and server type.
- Terraform 1.7 or newer, below 2.0, and a public SSH key with its private counterpart on your computer.
- One public DNS name per installation; a second name when enabling calls. DNS records must point directly at the server. TURN/media traffic cannot pass through an ordinary HTTP CDN proxy.
- A **published, reachable Git commit containing these deployment files**. The default repository URL does not make unpublished local changes available. Push/release through your normal review workflow before using its SHA, or supply your own public fork. The bootstrap deliberately rejects mutable branch/tag names. Private repository authentication is not automated; do not put access tokens in Terraform or the repository URL.

The example uses `cx33` in `hel1`. Confirm availability and choose capacity for your concurrent agents and calls; this is not a verified load limit. Agent browsers and image builds consume additional memory and disk.

## Create your installation

From the repository root:

```sh
cd deploy/terraform/hetzner
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` with your public key, operator/VPN CIDR, domains, and published full commit SHA. The example addresses and SHA placeholder intentionally cannot be used as a real deployment. Each map key is a stable customer ID:

```hcl
customers = {
  acme = {
    domain       = "taut.acme.example"
    calls_domain = "calls.acme.example"
    revision     = "0123456789abcdef0123456789abcdef01234567"
  }
}
```

Replace that illustrative SHA with the actual release commit. Omit `calls_domain` to leave calling disabled. Retrieve your API token from your secret manager into `HCLOUD_TOKEN`, then run:

```sh
terraform init
terraform validate
terraform plan -out=provision.tfplan
terraform apply provision.tfplan
terraform output installations
```

The reviewed plan is the point where you choose to create paid resources. Terraform does not wait for application bootstrap to finish. Outputs contain the IP addresses and SSH command, never application encryption keys.

Create an **A record** for the app domain pointing to its output IPv4. Optionally add an AAAA record using the output IPv6 for the app. For calls, create an **A record only** for `calls_domain` on the same IPv4: media/relay firewall rules are IPv4 and this setup does not configure IPv6 TURN relay. Remove stale AAAA records for that name. Caddy obtains and renews certificates after DNS resolves correctly; early certificate failures before DNS propagation are retried.

SSH to the output address and verify first boot:

```sh
cloud-init status --wait
tail -n 100 /var/log/taut-bootstrap.log
node /opt/taut-source/scripts/self-host.mjs status /opt/taut-instance
curl --fail http://127.0.0.1:3080/api/health
journalctl -u caddy -n 50 --no-pager
```

Then, from your computer:

```sh
curl --fail https://YOUR_APP_DOMAIN/api/health
```

Open the app URL, create your account, then create your company. Enter the same URL in the macOS client. Connect the model provider credentials needed by your agents in the application. Verify an actual agent task and, with calling enabled, a two-person huddle across separate networks. Health checks alone do not prove agent execution, media relay, or customer onboarding.

If first boot fails, inspect the log, fix the actual cause, and run `/usr/local/sbin/taut-bootstrap` over SSH. It serializes execution and reuses the existing installation and secrets. It checks out the original configured revision again, so use this only for initial bootstrap recovery, not as an upgrade command.

## What is isolated and persisted

| Resource | Per customer |
| --- | --- |
| VM and cloud firewall | Dedicated host and rules |
| Application | Own process, SQLite database, accounts, companies, and agent containers |
| Files and encryption key | `/opt/taut-instance`, generated on the host; never copied into Terraform state |
| Source | `/opt/taut-source`, pinned initial checkout |
| TLS certificates | Caddy's persistent `/var/lib/caddy` directory |
| Calling | Optional LiveKit/Redis/eturnal services and generated credentials |

The app listens on loopback port 3080 and calling signaling on loopback port 7880. Public TCP 80/443 reaches Caddy. SSH is limited to the supplied CIDRs. Calling additionally opens TCP 7881, UDP 7882, TCP/UDP 3478, and UDP 49160–49200. Redis has no public port. WebSocket signaling is proxied by Caddy. This TURN configuration provides UDP/TCP relay on 3478; it does not provide TURN-over-TLS on 443, so restrictive corporate networks that allow only TLS 443 can still block media.

The app needs control of the host Docker daemon to manage agents; that access is equivalent to host administrator access. The separate customer VM is the isolation boundary. Do not place unrelated or mutually untrusted customer installations on this host.

## Add another customer

Add another entry with a distinct ID and domains to `customers`, then review and apply a new Terraform plan. The existing map entries retain their hosts and data. This map is the interface a future provisioning service can generate; a hosted control plane still needs authenticated orders, billing, DNS automation, secret custody, lifecycle jobs, and status reporting.

For a managed service, use a separate state/backend or workspace per customer to scope access and failures, and secure the state with encryption and locking. The multi-customer map is useful for an operator managing a small fleet. Application secrets are absent from state, but cloud IDs, public keys, addresses, and cloud-init remain there. Keep `.terraform.lock.hcl` in version control; keep state, private inputs, tokens, and saved plans out.

## Back up and update

Run the installer backup on the host before an update:

```sh
node /opt/taut-source/scripts/self-host.mjs backup /opt/taut-instance
```

Copy the resulting archive to protected storage outside the VM. It includes the encryption key; losing the key prevents recovery of encrypted credentials. The backup command briefly stops the app and agents for a consistent filesystem snapshot. Check the [self-host guide](self-hosting.md) for restore instructions. Provider server backups are enabled by default as an additional disk-recovery mechanism; they are not a substitute for verified application backups.

The cloud-init `user_data` is deliberately ignored after host creation. Changing `revision`, `domain`, or `calls_domain` in Terraform does **not** upgrade or reconfigure an existing installation. This prevents an application release from replacing a customer's data disk. On an existing host, deploy a reviewed published commit explicitly:

```sh
cd /opt/taut-source
git fetch origin YOUR_FULL_COMMIT_SHA
git checkout --detach YOUR_FULL_COMMIT_SHA
node scripts/self-host.mjs up /opt/taut-instance
curl --fail http://127.0.0.1:3080/api/health
git rev-parse HEAD > /opt/taut-instance/deployed-revision
```

Check the public URL and an agent task afterward. Keep the matching revision in your customer inventory for future rebuilds. Do not assume checking out an older app reverses database migrations: rollback may require restoring the pre-update backup and compatible source revision. Domain or calling changes also require updating the installation configuration, DNS, and Caddy; those migrations are not automated here.

Terraform `prevent_destroy` and provider deletion/rebuild protection guard against accidental removal. Renaming a customer map key, replacing a host, or deleting a customer requires an explicit decommission/migration plan and backup, not simply deleting its map entry. Removing the whole resource block also removes Terraform's lifecycle guard; provider protection remains the last guard.

## Why this uses a VM

This installer uses Taut's Docker provider, which starts sibling containers and uses matching host/container bind paths. A VM supplies that Docker daemon and separate agent containers. For one trusted company, [Railway deployment](railway.md) uses the local provider to run Taut and its agents together in one service; it needs no external execution service. Its agents share the server's user and filesystem, so it is a different trust model from this customer VM configuration.

## Validation and external references

The configuration pins `hetznercloud/hcloud` **1.60.0**. Locally, `terraform init -backend=false`, `terraform validate`, and `terraform test` exercise provider configuration, separate customer resources, calling port gating, immutable revisions, and domain validation without creating resources. The three Terraform tests pass. Both bootstrap variants were rendered through Terraform, parsed as YAML, checked against Canonical's cloud-init 26.2 JSON schema, and passed `bash -n`. The tests use a mocked provider; they do not establish real Hetzner capacity or bootstrap success. No paid VM or public DNS/TLS deployment was performed while implementing this configuration.

Primary references checked on 2026-09-10: [Hetzner server resource v1.60.0](https://github.com/hetznercloud/terraform-provider-hcloud/blob/v1.60.0/docs/resources/server.md), [firewall resource v1.60.0](https://github.com/hetznercloud/terraform-provider-hcloud/blob/v1.60.0/docs/resources/firewall.md), [Hetzner metadata API](https://docs.hetzner.cloud/reference/cloud#server-metadata), [Docker's Ubuntu installation](https://docs.docker.com/engine/install/ubuntu/), [NodeSource distributions](https://github.com/nodesource/distributions/blob/master/DEV_README.md), [Caddy packages](https://caddyserver.com/docs/install), and [Caddy automatic HTTPS prerequisites](https://caddyserver.com/docs/automatic-https).

Recheck these vendor instructions before changing the bootstrap. OS packages follow their stable repositories (Node.js remains on major 22); package patch versions and upstream image tags are not frozen by the Terraform provider lock. Reproducible fleet rollout beyond the pinned application commit needs tested image digests or a baked machine image.
