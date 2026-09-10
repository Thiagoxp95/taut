# Taut on Railway

Run Taut and its Claude Code, Codex, and OpenCode agents together in one Railway
service, with one persistent volume. This deployment is for **one trusted company**.
All members and agents must be trusted with the whole installation: local agent
processes share the server's user, filesystem, network, and credentials. Agent home
directories organize files; they do not isolate them. For separate agent containers
or independent customers, use the [Docker installer](self-hosting.md) or
[customer VM provisioning](cloud-provisioning.md).

The Railway image includes the web app, API, agent runtimes, Taut MCP/CLI, and
Playwright Chromium. Model subscriptions or API credentials are connected after
signup. They are not included in hosting.

## Deployment button status

The [Taut template draft](https://railway.com/workspace/templates/d3475e93-c6b5-4bb4-935b-c017212b9987)
exists in the Tedy workspace, with one service, `/data`, generated secrets and
HTTP port 3000. Its real deployment URL is
[railway.com/deploy/PyzQbM](https://railway.com/deploy/PyzQbM).
It is **not ready for public deployment**: `Thiagoxp95/taut` remains private,
and the local release files have not been pushed to its selected branch. A
fresh Railway deployment must pass before advertising the button publicly.

[template.json](../deploy/railway/template.json) records the intended serialized
configuration against Railway's
[template schema](https://backboard.railway.app/schema/template.schema.json).
Railway does not automatically import that file. The template sets
`RAILWAY_DOCKERFILE_PATH=deploy/railway/Dockerfile` to select the combined image.
This follows Railway's [custom Dockerfile path](https://docs.railway.com/builds/dockerfiles)
mechanism and does not depend on deprecated `railway.json` discovery.

The saved template was generated from the private, configuration-only
`Taut template preparation` project, then completed in the composer. The
preparation project was deleted after confirming it had zero deployments. Only
the reusable template remains.

## Create the template without an existing project

In Railway, open your workspace's **Templates** page and choose **New Template**.
Add one service from the Taut GitHub repository and configure it as follows:

| Setting               | Value                                         |
| --------------------- | --------------------------------------------- |
| Service name          | Taut                                          |
| Source branch         | The branch containing this Railway deployment |
| Root Directory        | `/` (the repository root)                     |
| Builder               | Dockerfile                                    |
| Dockerfile Path       | `deploy/railway/Dockerfile`                   |
| Start Command         | Leave empty; use the image entrypoint         |
| Healthcheck           | `/api/health`, timeout 300 seconds            |
| Public Networking     | HTTP domain, target port `3000`               |
| Volume                | Attach one volume at `/data`                  |
| Replicas              | One, in one region                            |
| Serverless / sleeping | Disabled                                      |

The build context must stay at the repository root because the image builds the
server, web app, and runtime packages together. The entrypoint prepares the mounted
data directory, then starts Taut as UID/GID 1000. Leave Railway's custom start command
empty so this initialization runs. Do not use a pre-deploy command for volume setup;
the volume is mounted when the service starts.

Copy the variables below into the template service's Variables tab. The master-key
expression belongs in the **template editor**: Railway evaluates it separately for
each new installation. Do not paste that expression as a literal variable into an
ordinary running service.

```dotenv
RAILWAY_DOCKERFILE_PATH=deploy/railway/Dockerfile
PORT=3000
NODE_ENV=production
TAUT_DATA_DIR=/data
TAUT_MACHINE_PROVIDER=local
TAUT_COOKIE_SECURE=true
TAUT_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
TAUT_MAX_CONCURRENT_TASKS=1
TAUT_MASTER_KEY=${{secret(43, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/")}}=
```

The generated master key decodes to the 32 bytes Taut requires. Preserve it on
updates; never replace it with a shared example key. The image sets the internal
agent API URL to loopback using `PORT`, so agent callbacks stay inside this service.
`TAUT_PUBLIC_URL` remains the HTTPS origin used by browsers and integration callbacks.

Choose **Create Template**, then copy the actual URL Railway returns. A template
can be shared before marketplace publication. Private GitHub sources require the
deployer's Railway GitHub integration to have access; a public button for everyone
needs publicly reachable source or an appropriately configured image source.
See Railway's [template creation guide](https://docs.railway.com/templates/create).

After a fresh deployment passes, the actual button markup is:

```markdown
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/PyzQbM)
```

The [sharing guide](https://docs.railway.com/templates/publish-and-share)
documents the button format and optional marketplace publication.

For an already configured project, Railway CLI 5.52 supports generating an
unpublished template instead:

```sh
npx --yes @railway/cli@5.52.0 templates create --project PROJECT_ID --environment production --json
```

That command requires a project. It does not import `template.json`; use the
dashboard composer to start without a project. Inspect the generated draft to
replace any copied master key with the per-installation expression before sharing.
See the [CLI reference](https://docs.railway.com/cli/templates).

## Deploy and onboard

Open the created template's link, choose your Railway workspace, review its
resources and variables, and deploy. Once the service is healthy, open its HTTPS
domain and create your account and company. Connect a model subscription or API
credential, create an agent, and send it a task. Set the macOS app's server address
to the same HTTPS origin if you prefer the desktop client.

Copy `TAUT_MASTER_KEY` from the service's Variables tab into a password manager or
another secure backup location. A volume backup without the original key cannot
restore vault access. The template leaves this variable viewable by workspace
administrators so the installation owner can back it up.

If you configure the service manually instead of deploying a template, generate
the key locally with `openssl rand -base64 32` and save that value in Railway. When
adding a custom domain, also change `TAUT_PUBLIC_URL` to its exact HTTPS origin and
redeploy. Keep secure cookies enabled.

## Persistence, backups, and upgrades

`/data` contains the SQLite database, company files, and agent homes. Keep the
volume attached across deployments. Changes outside `/data` are disposable.

Enable scheduled backups in the volume's **Backups** tab and take a manual backup
before upgrades. Allow agent tasks to finish and pause new work before a backup
when you need database state and agent files to represent the same point in time.
For restoration, select a backup, review Railway's staged volume replacement, and
deploy it with the matching original master key. Then verify login, company data,
vault access, and an agent's files. Railway backups restore within the same project
and environment; wiping the volume also deletes its backups. Keep an independent
export for recovery from account or project deletion. See
[Railway volume backups](https://docs.railway.com/volumes/backups).

Upgrade by selecting a tested source revision and redeploying after backup. Taut's
migrations run at boot; do not assume an older image can read a migrated database.
One volume-backed replica is intentional: redeployments briefly interrupt the API
and any running agents. Railway documents this volume behavior in its
[healthcheck guide](https://docs.railway.com/deployments/healthchecks).

## Scope and optional features

- Local agents have no separate sandbox boundary. Do not offer unrelated customers
  different companies within this service as an isolation mechanism.
- The embedded agent terminal requires the Docker provider and is unavailable in
  this mode. Agent tasks and their persisted files use the local provider.
- Browser automation runs Chromium without its own sandbox inside the shared
  service. Treat any agent or browser compromise as access to the installation.
- Huddles are off by default. Use an external LiveKit service and set
  `TAUT_LIVEKIT_URL`, `TAUT_LIVEKIT_API_KEY`, and `TAUT_LIVEKIT_API_SECRET` to enable
  them. Route the external LiveKit webhook to this service's
  `/api/hooks/livekit`. The self-hosted LiveKit/TURN Compose profile is not part of
  this Railway template.
- Web Push is optional; configure the VAPID variables described in
  [the deployment guide](deploy.md). Railway's HTTPS domain supports the required
  secure browser context.
- Hosting cost depends on agent activity, browser usage, storage, and Railway's
  plan. This template makes no fixed VPS-price or participant-capacity promise.
  Start with one concurrent agent task and increase only after observing resource
  use.

## Verification (2026-09-10)

The combined Linux ARM64 image built locally. The real image integration check
passes signup, company and agent creation, the local machine provider, UID 1000
execution of Claude Code/Codex/OpenCode, Taut MCP/CLI bundles, Chromium startup and
reuse, loopback API access, and account/session/file persistence after container
replacement. The saved Chromium profile also reopens after replacement. Startup
removes only Chromium's stale process-lock symlinks; browser profile data remains.

Two packaging defects were reproduced and fixed: the bundled server needs an
explicit link to the globally installed Playwright MCP package, and Chromium's
old-container locks must be removed before reopening its persistent profile.
The first source build completed; these two final packaging changes were tested
as incremental layers on that image to stay within local disk space. The Linux
AMD64 source build and integration check are configured in
[CI](../.github/workflows/self-host.yml), but remote CI and an actual Railway HTTPS
deployment have not yet run. No billable model task was invoked by the check.

Run the same integration test after building the image:

```sh
docker build -f deploy/railway/Dockerfile -t taut/railway:test .
TAUT_RAILWAY_TEST_IMAGE=taut/railway:test node --test scripts/test/railway-onboarding.test.mjs
```
