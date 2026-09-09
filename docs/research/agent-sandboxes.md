# Agent sandboxes: how OSS agent platforms give each coding agent "its own Linux box"

Research date: 2026-09-08. Question: what should Taut's MVP do to give each agent
(Claude Code / Codex / Cursor CLI / OpenCode) an isolated machine, given the
constraint in `docs/agent-model.md`: `docker compose up` on a €4 VPS, no managed services.

Every claim links to its owning source. Costs assume one agent ≈ 2 vCPU / 2 GB,
active ~60 h/month, idle the rest.

---

## 1. Sandcastle (Matt Pocock) — deep-dive

Repo: https://github.com/mattpocock/sandcastle · npm: `@ai-hero/sandcastle` 0.12.0 · MIT.
Read from a clone at v0.12.0 (`src/`, `docs/adr/`, `research/`, README).

**What it is.** A TypeScript library + CLI that runs a coding agent _for one task_ inside a
sandbox around a **host git repo**, then merges the commits back. Core call:
`run({ agent: claudeCode("claude-opus-4-8"), sandbox: docker(), prompt })`
([README](https://github.com/mattpocock/sandcastle#what-is-sandcastle)). Its own glossary
defines the host as "the developer's machine where Sandcastle runs and the real git repo
lives" ([CONTEXT.md](https://github.com/mattpocock/sandcastle/blob/main/CONTEXT.md)).

**Isolation tech.** Plain containers, not VMs. `docker()`/`podman()` shell out to the
`docker`/`podman` CLI: `docker run -d --name sandcastle-<uuid> -e K=V -v host:sandbox:z
-w <worktree> --user <uid>:<gid> [--network|--group-add|--device|--cpus] <image>` with
`ENTRYPOINT ["sleep","infinity"]`, then `docker exec ... sh -c <cmd>` per command
([src/DockerLifecycle.ts](https://github.com/mattpocock/sandcastle/blob/main/src/DockerLifecycle.ts),
[src/sandboxes/docker.ts](https://github.com/mattpocock/sandcastle/blob/main/src/sandboxes/docker.ts)).
No seccomp/cap-drop/pids/memory hardening flags are set. Remote "isolated" providers exist
for Vercel Sandbox (Firecracker microVMs via `@vercel/sandbox`) and Daytona
([README prerequisites](https://github.com/mattpocock/sandcastle#prerequisites),
[src/sandboxes/vercel.ts](https://github.com/mattpocock/sandcastle/blob/main/src/sandboxes/vercel.ts)).

**Two provider families** ([src/SandboxProvider.ts](https://github.com/mattpocock/sandcastle/blob/main/src/SandboxProvider.ts)):

- _Bind-mount_ (Docker, Podman): host creates a git worktree under `.sandcastle/worktrees/`
  and mounts it in; "the agent writes directly to the host filesystem through the mount, so
  no sync is needed" ([README: How it works](https://github.com/mattpocock/sandcastle#how-it-works)).
- _Isolated_ (Vercel, Daytona, custom): sync-in via `git bundle` + `copyIn`, sync-out via
  `git format-patch` + `git am --3way`, plus `git diff` for uncommitted and `copyFileOut`
  for untracked files ([src/syncIn.ts](https://github.com/mattpocock/sandcastle/blob/main/src/syncIn.ts),
  [src/syncOut.ts](https://github.com/mattpocock/sandcastle/blob/main/src/syncOut.ts)).
  The handle contract is tiny: `exec(cmd, {onLine, cwd, sudo, stdin})`, optional
  `interactiveExec`, `copyFileIn/Out`, `close()`. The doc comment insists providers "MUST
  support line-by-line streaming via `onLine`" because idle timeouts depend on it.

**Persistence.** None by design. `close()` runs `docker stop && docker rm`; the container's
`HOME=/home/agent` is discarded. The only state that survives is (a) the bind-mounted
worktree and (b) the agent's _session file_, which Sandcastle copies out of the sandbox into
the host's `~/.claude/projects/<encoded-cwd>/<id>.jsonl` (or `~/.codex/sessions/...`),
rewriting `cwd` fields so `claude --resume` works on the host
([README: Session capture](https://github.com/mattpocock/sandcastle#session-capture),
[ADR 0012](https://github.com/mattpocock/sandcastle/blob/main/docs/adr/0012-agent-provider-owned-session-storage.md)).
OpenCode is non-resumable because its state lives in SQLite
([ADR 0016](https://github.com/mattpocock/sandcastle/blob/main/docs/adr/0016-resume-requires-filesystem-backed-sessions.md)).
`createSandbox()` keeps one container warm across several `run()` calls, which is the
closest it gets to a long-lived machine ([README](https://github.com/mattpocock/sandcastle#createsandbox--reusable-sandbox)).

**Secrets.** Only keys declared in `.sandcastle/.env` are read (value from the file, else
`process.env`) and passed as `docker run -e` flags; agent/sandbox providers can add `env`
but must not overlap ([src/EnvResolver.ts](https://github.com/mattpocock/sandcastle/blob/main/src/EnvResolver.ts),
[README: Provider env](https://github.com/mattpocock/sandcastle#provider-env)). Quick start tells
users to put `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY` there
([README: Quick start](https://github.com/mattpocock/sandcastle#quick-start)). No proxy, no
credential isolation: secrets are plain container env.

**Output streaming.** `docker exec` stdout → `readline` → `onLine`; each agent provider parses
its NDJSON. The exact Claude command is
`claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model <m> -p -`
with the prompt piped on stdin to dodge the 128 KB argv limit
([src/AgentProvider.ts, `claudeCode`](https://github.com/mattpocock/sandcastle/blob/main/src/AgentProvider.ts)).
Parsed events: `assistant` text, allow-listed `tool_use`, `result`, `system/init` session_id,
usage. The scaffolded image is `node:22-bookworm` + git/curl/jq/gh + the Claude installer,
running as a non-root `agent` user whose UID/GID are build-args matched to the host user
([src/InitService.ts](https://github.com/mattpocock/sandcastle/blob/main/src/InitService.ts),
[ADR 0005](https://github.com/mattpocock/sandcastle/blob/main/docs/adr/0005-remove-chown-uid-alignment.md)).

**Cost.** Zero beyond the host running Docker; Vercel/Daytona providers cost whatever those
services bill (see §3).

**Stated rationale.** Issue #250 (2026-04-10): "Sandcastle is hardcoded to Docker...
Introduce a sandbox provider abstraction... Bind-mount providers... Isolated providers"
([#250](https://github.com/mattpocock/sandcastle/issues/250)); announced as "moving Sandcastle
off Docker and making the sandbox totally pluggable... an orchestrator that works with any
coding agent in any sandbox - local or remote" ([tweet](https://x.com/mattpocockuk/status/2042548410264264973)).
His 37 KB survey concludes the fundamental divide is "Bind-mounting local directories is only
possible with local tools. Every cloud service requires file syncing," rates Firecracker as
isolated-only because it has "no filesystem sharing — only block devices," and lists Fly
Sprites as "Firecracker + persistent NVMe + checkpoint/restore. $0.07/CPU-hr"
([research/sandbox-provider-research.md](https://github.com/mattpocock/sandcastle/blob/main/research/sandbox-provider-research.md)).

## 2. Should Taut take Sandcastle as a dependency?

| Fact                    | Evidence                                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License                 | MIT ([LICENSE](https://github.com/mattpocock/sandcastle/blob/main/LICENSE))                                                                                                                                                                                                                       |
| Distribution            | npm `@ai-hero/sandcastle` 0.12.0, published 2026-06-29, 44 versions since 2026-03-26, one runtime dep (`@clack/prompts`) ([registry](https://registry.npmjs.org/@ai-hero/sandcastle)); ~88k downloads/week ([api.npmjs.org](https://api.npmjs.org/downloads/point/last-week/@ai-hero/sandcastle)) |
| Activity                | 1,193 commits: Mar 372, Apr 520, May 240, Jun 61, **nothing after 2026-06-29** (10 weeks); GitHub `pushed_at` 2026-06-29; 160 open issues; 7.9k stars, 838 forks (`gh api repos/mattpocock/sandcastle`)                                                                                           |
| Bus factor              | 721 human commits by Matt Pocock + 95 by his own `sandcastle-agent[bot]` + 51 release bot; next human contributor has 3 (`git shortlog`) — effectively one maintainer, pre-1.0                                                                                                                    |
| API shape               | Node library (`run`, `interactive`, `createSandbox`, `createWorktree`, provider factories) + `sandcastle` CLI for `init`/`build-image`; internals are Effect-based, public provider interface is plain Promises ([README: API](https://github.com/mattpocock/sandcastle#api))                     |
| Persistent per-agent FS | **No.** Containers are torn down per `close()`; persistence is host worktree + copied session JSONL (§1)                                                                                                                                                                                          |
| Agents inside           | Claude Code, Codex, Cursor, OpenCode, Copilot, Pi — `claudeCode()`, `codex()`, `cursor()`, `opencode()`, `copilot()`, `pi()` factories; resume only for Claude/Codex/Pi ([README: RunOptions](https://github.com/mattpocock/sandcastle#runoptions))                                               |
| Host tie                | Needs Docker/Podman CLI on the _same host as the git repo_, or Vercel/Daytona accounts; Daytona's OSS repo is now unmaintained (§4)                                                                                                                                                               |

**Coverage of Taut's "machine provider" layer:** it gives streaming `exec` over `docker exec`,
UID-aligned Dockerfiles, and well-tested NDJSON parsers for six agent CLIs. It gives nothing
for: one long-lived box per agent, a persistent `$HOME` (Taut's `agents/<handle>/` folder),
idle stop/wake, resource limits, network policy, secrets at exec-time rather than run-time,
remote VMs (Fly/Hetzner), or driving Docker via the socket from inside Taut's own container
(it spawns the `docker` binary). Its git-worktree/branch-strategy core is orthogonal to a chat
product whose agents may not even have a repo.

**Verdict: No — do not depend on it; port the useful parts.** Copy (MIT, with attribution)
`AgentProvider.ts`'s command builders + stream parsers and the Dockerfile templates into
Taut's runtime layer, and keep Sandcastle's `exec(cmd, {onLine, stdin})` contract as the
minimum for any provider. Wrapping it behind Taut's interface would still inherit its
ephemeral-container lifecycle and a single-maintainer project that has been silent since June.

## 3. Comparison table

| Approach                                         | Isolation                                                                                      | $/agent/mo idle                                                          | $/agent/mo active (60 h)                         | Cold start                                     | Home persistence                                               | Secrets                                            | OSS self-host fit                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| Docker container per agent (same host)           | Kernel-shared namespaces; + user-ns/syscall trap with sysbox, or user-space kernel with gVisor | ~0 (host cost shared)                                                    | ~0                                               | ms (exec into running) / <1 s (`docker start`) | Bind mount or named volume — free                              | `docker exec -e` per task                          | **Best**: just the Docker socket                                                |
| Firecracker / Kata microVM per agent (self-host) | Own kernel; ≤125 ms boot, ≤5 MiB overhead                                                      | ~0                                                                       | ~0                                               | ~125 ms + guest init                           | Block device per VM (no fs sharing)                            | Kernel cmdline/vsock/agent — DIY                   | Needs `/dev/kvm` (bare metal or nested virt); heavy plumbing                    |
| Docker Sandboxes (`sbx`)                         | microVM + own dockerd + credential proxy                                                       | ~0                                                                       | ~0                                               | seconds (unstated)                             | Per-workspace sandbox reused                                   | Host proxy injects auth headers; creds never in VM | Free; Linux needs Ubuntu 24.04 + KVM; no headless `-p` documented               |
| Fly Machines                                     | Fly VM ("fast-launching VMs")                                                                  | ~$1.50 (10 GB vol) + $0.15/GB rootfs                                     | +$0.49 (shared-1x 1 GB @ $0.00000228/s) ≈ **$2** | "well under a second" (existing machine)       | Fly Volume mounted at path                                     | `env` + `files` w/ `secret_name` in machine config | Proprietary but plain REST; good 2nd provider                                   |
| Fly Sprites                                      | Linux VM, root, 100 GB durable FS                                                              | ≈$0.10 (5 GB cold) + plan from $20/mo                                    | +~$2.50 ($0.07/CPU-h, $0.04375/GB-h)             | 100–500 ms warm, 1–2 s cold, 1–2 s create      | Whole disk persists across sleep                               | Connectors (policy-controlled)                     | Proprietary; cheapest hosted idle                                               |
| Hetzner / DO VM per agent                        | Full VM                                                                                        | **$4/mo even when off** (DO 1 vCPU/512 MB)                               | $4                                               | tens of seconds + cloud-init (unmeasured)      | VM disk                                                        | `user_data` (32 KiB Hetzner) / SSH                 | Vendor API only; poor idle economics                                            |
| E2B                                              | Firecracker                                                                                    | paused: retained indefinitely, storage cost undisclosed (10–20 GiB free) | ~$7 (2 vCPU $0.1008/h + $0.0162/GiB-h)           | resume ~1 s                                    | Pause = FS+RAM snapshot                                        | `envs` at create                                   | Apache-2.0 infra but needs GCP/AWS + Nomad/Consul/Terraform + nested virt       |
| Daytona                                          | "dedicated kernel" per sandbox                                                                 | stopped/archived: rates not published                                    | ~$8 ($0.0504/vCPU-h, $0.0162/GiB-h)              | "sub 90 ms" (claim)                            | Snapshots, volumes                                             | Secrets page                                       | **OSS repo unmaintained since June 2026**; BYOC still needs their control plane |
| Modal Sandboxes                                  | gVisor (VM opt-in)                                                                             | snapshots: image storage                                                 | ~$11 ($0.142/core-h, $0.024/GiB-h)               | fast (unquantified)                            | FS snapshots (30 d default), Volumes                           | `Secret` objects                                   | Proprietary                                                                     |
| Cloudflare Sandbox SDK                           | Container (runtime undisclosed), max 4 vCPU/12 GiB                                             | $0 while asleep + $5 Workers Paid                                        | ~$4.30 (standard-1)                              | 1–3 s                                          | **Disk is ephemeral after sleep**; R2 via FUSE, backup/restore | Worker injects headers                             | Proprietary; poor fit for persistent home                                       |
| Vercel Sandbox                                   | Firecracker microVM                                                                            | snapshots $0.08/GB-mo                                                    | ~$10 ($0.128/vCPU-h active + $0.0212/GB-h)       | seconds                                        | Persistent sandboxes / snapshots                               | env at create                                      | Proprietary; Hobby free tier 45-min sessions                                    |
| Coder workspaces                                 | Whatever Terraform provisions (Docker/K8s/VM)                                                  | host-dependent                                                           | host-dependent                                   | container start                                | `/home/coder` volume                                           | Coder Agents: LLM keys never enter workspace       | AGPL-3.0 + Premium; needs Postgres; a whole platform                            |
| OpenClaw sandboxing                              | Docker/Podman/SSH per agent or session                                                         | ~0                                                                       | ~0                                               | container start                                | `workspaceAccess` mount                                        | container env (visible in metadata)                | MIT; design reference, not a lib                                                |

## 4. Per-approach notes (sources)

**Docker + sysbox + gVisor.** Sysbox (Apache-2.0, v0.7.1 on 2026-07-31) puts "Linux
user-namespace on all containers (i.e., root user in the container has zero privileges on the
host)", virtualises procfs/sysfs, traps selected syscalls, and lets Docker/systemd run inside
without `--privileged`; used via `docker run --runtime=sysbox-runc`; community support only
since Docker acquired Nestybox ([nestybox/sysbox](https://github.com/nestybox/sysbox)). gVisor's
`runsc` is an OCI runtime with a user-space kernel (Sentry + Gofer); default platform
`systrap` "works in nested VMs without requiring KVM"; trade-offs are "higher per-system call
overhead" and incomplete syscall/`/proc` coverage ([gvisor.dev/docs](https://gvisor.dev/docs/),
[platforms](https://gvisor.dev/docs/architecture_guide/platforms/)). Anthropic's own guidance:
run Claude Code "in any Docker or OCI container image with your own network policies, mounted
volumes, and seccomp profiles" and "Always run `--dangerously-skip-permissions` sessions inside
a container, a VM, or the sandbox runtime" ([sandbox-environments](https://code.claude.com/docs/en/sandbox-environments)).

**Firecracker / firecracker-containerd / Kata.** Spec: "<= 125 ms" from InstanceStart to
`/sbin/init`, VMM overhead "<= 5 MiB" ([SPECIFICATION.md](https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md));
needs read/write `/dev/kvm`, tested on `.metal` ([getting-started](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md)).
No image management, networking or orchestration are included. firecracker-containerd
(Apache-2.0) has no GitHub releases ([repo](https://github.com/firecracker-microvm/firecracker-containerd)).
Kata (Apache-2.0) is an OCI runtime over QEMU/Cloud Hypervisor/Firecracker/Dragonball and
requires KVM or nested virt ([kata-containers](https://github.com/kata-containers/kata-containers)).
E2B's own self-host guide states "Firecracker requires bare metal or nested virtualization
support" ([e2b-dev/infra self-host.md](https://github.com/e2b-dev/infra/blob/main/self-host.md)).
Whether a €4 VPS exposes `/dev/kvm` is provider-specific: **check `ls /dev/kvm` before
planning on it.**

**Docker Sandboxes (`sbx`).** "Hypervisor isolation with separate kernel per sandbox", each
with its own Docker Engine; "the host-side proxy injects authentication headers into outbound
HTTP requests. The raw credential values never enter the VM"; deny-by-default egress
([security](https://docs.docker.com/ai/sandboxes/security/)). Supports Claude Code, Codex,
Copilot, Cursor, Devin, Droid, Gemini, Kiro, OpenCode ([agents](https://docs.docker.com/ai/sandboxes/agents/)).
Linux: Ubuntu 24.04+, KVM enabled, user in `kvm` group; "You don't need Docker Desktop or
Docker Engine" ([install](https://docs.docker.com/ai/sandboxes/install/)). Claude page: auth
via `sbx secret set anthropic` or `/login`; "Sandboxes don't pick up user-level configuration
from your host, such as `~/.claude`"; no headless mode documented
([claude-code](https://docs.docker.com/ai/sandboxes/agents/claude-code/)).

**Fly Machines / Sprites.** Machines: shared-cpu-1x 256 MB $2.02/mo ($0.00000078/s), 1 GB
$5.92/mo; stopped machine pays only rootfs "$0.15 per GB for 30 days"; volumes $0.15/GB-mo
([pricing](https://fly.io/docs/about/pricing/)). Create config has `env`, `files`
(`raw_value` base64 or `secret_name`), `mounts` (volume + path), `auto_destroy`; `suspend`
snapshots memory and "the next start operation will attempt (but is not guaranteed) to
resume" ([machines API](https://fly.io/docs/machines/api/machines-resource/)); "started and
stopped at subsecond speeds" ([machines docs](https://fly.io/docs/machines/)). Sprites: "Linux
virtual machines. You get root", "100GB durable root filesystem" built on object storage
chunks cached on sparse local NVMe, create "in just a second or two", auto-sleep
([Fly blog](https://fly.io/blog/design-and-implementation/)); pricing $0.07/CPU-hour,
$0.04375/GB-hour memory, storage HOT $0.000683/GB-h, COLD $0.000027/GB-h, example "Claude
Code Session ... 4-hour ... Total $0.44" ([sprites.dev](https://sprites.dev/)); wake "~100–500ms",
cold "1–2s", disk persists, processes don't ([docs](https://docs.sprites.dev/working-with-sprites/));
exec over WebSocket, checkpoints, network policy, connectors ([API](https://sprites.dev/api));
plans Adventurer $20/20 concurrent up to Mythic $2,000/2,000 ([community post](https://community.fly.io/t/more-sprites-plans/26857)).

**Hetzner / DigitalOcean.** Hetzner `POST /servers` takes `user_data` ("Cloud-Init user data
... limited to 32KiB"), `ssh_keys`, `volumes`, `firewalls` ([OpenAPI spec](https://docs.hetzner.cloud/cloud.spec.json));
"you pay for a server ... regardless of whether it is turned on or not"
([billing FAQ](https://docs.hetzner.com/cloud/billing/faq/)). DO: $4/mo Basic Droplet, snapshots
$0.06/GB-mo ([pricing](https://www.digitalocean.com/pricing/droplets)); "You are still billed
for ... Droplets that are powered off" ([details](https://docs.digitalocean.com/products/droplets/details/pricing/));
API 5,000 req/h, `user_data` on create ([OpenAPI](https://api-engineering.nyc3.digitaloceanspaces.com/spec-ci/DigitalOcean-public.v2.yaml)).
Only sensible for few, always-on agents.

**Hosted sandbox APIs** (rates in §3). E2B: [pricing](https://e2b.dev/pricing),
[billing](https://docs.e2b.dev/billing); pause keeps FS + memory, resume "approximately 1
second", paused sandboxes kept indefinitely ([persistence](https://docs.e2b.dev/sandbox/persistence));
self-host is Apache-2.0 Firecracker on GCP/AWS via Terraform/Packer/Nomad/Consul/Postgres
([e2b-dev/infra](https://github.com/e2b-dev/infra)). Daytona: [pricing](https://www.daytona.io/pricing);
"complete isolation, a dedicated kernel" ([docs](https://www.daytona.io/docs/en/)); BYOC = runner
nodes on your K8s, control plane stays Daytona's ([BYOC](https://www.daytona.io/docs/en/bring-your-own-compute));
README: "This repository is no longer maintained. As of June 2026, Daytona's core development
has moved to a private codebase" ([README](https://raw.githubusercontent.com/daytonaio/daytona/main/README.md)).
Modal: sandbox rates ≈3× normal compute ([pricing](https://modal.com/pricing)); default gVisor,
`vm_runtime` opt-in ([VM sandboxes](https://modal.com/docs/guide/vm-sandboxes)); 5 min default /
24 h max, `Secret` objects, `sandbox.exec()` ([sandboxes](https://modal.com/docs/guide/sandboxes));
FS snapshots 30 d, memory snapshots 7 d ([snapshots](https://modal.com/docs/guide/sandbox-snapshots)).
Cloudflare: [containers pricing](https://developers.cloudflare.com/containers/pricing/),
[limits](https://developers.cloudflare.com/containers/platform/limits/); "When a Container
instance goes to sleep, the next time it is started, it will have a fresh disk", cold starts
"1-3 second range" ([FAQ](https://developers.cloudflare.com/containers/faq/)); GA 2026-04-13
([changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/)).
Vercel: Active-CPU billing (I/O wait unbilled), 64 GB NVMe, persistent sandboxes reset the
session limit ([pricing](https://vercel.com/docs/sandbox/pricing)).

**Coder / OpenClaw.** Coder: AGPL-3.0 + `LICENSE.enterprise`, Terraform templates for
"EC2 VMs, Kubernetes Pods, Docker Containers", Postgres required ([coder/coder](https://github.com/coder/coder));
Docker template keeps a "Docker volume (persistent on `/home/coder`)", the rest is lost on
restart ([template README](https://raw.githubusercontent.com/coder/coder/main/examples/templates/docker/README.md));
Coder Agents run "the agent loop ... in the Coder control plane" and "LLM provider credentials
never enter the workspace" ([agents](https://coder.com/docs/ai-coder/agents)); AI Governance is
Premium ([ai-coder](https://coder.com/docs/ai-coder)); AgentAPI (MIT) wraps Claude Code/Codex/
Cursor/OpenCode behind HTTP+SSE via a terminal emulator ([coder/agentapi](https://github.com/coder/agentapi)).
OpenClaw (MIT): backends Docker/Podman, SSH, OpenShell, host; scope `agent` | `session` |
`shared`; `workspaceAccess` none/ro/rw; env "remain[s] visible through container metadata
commands"; Gateway stays on host, only tools move into the sandbox
([sandboxing](https://docs.openclaw.ai/gateway/sandboxing), [LICENSE](https://raw.githubusercontent.com/openclaw/openclaw/main/LICENSE)).

## 5. Running the agents headless inside — gotchas

- **Claude Code.** `claude -p ... --output-format stream-json` **requires `--verbose`**; add
  `--include-partial-messages` for token deltas; the last line is a `result` event
  ([headless](https://code.claude.com/docs/en/headless)). Sandcastle's exact invocation (§1) is
  a working template. Auth precedence: `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` >
  `apiKeyHelper` > `CLAUDE_CODE_OAUTH_TOKEN` > `/login` creds; `claude setup-token` mints a
  **one-year** subscription token; **`--bare` does not read `CLAUDE_CODE_OAUTH_TOKEN`**; Linux
  creds live in `~/.claude/.credentials.json`, relocatable with `CLAUDE_CONFIG_DIR`
  ([authentication](https://code.claude.com/docs/en/authentication)). "Claude Code refuses to
  start with [`--dangerously-skip-permissions`] when running as root" → the sandbox user must
  be non-root ([sandbox-environments](https://code.claude.com/docs/en/sandbox-environments)).
  Persist `~/.claude` **and** set `CLAUDE_CONFIG_DIR` to it or `.claude.json` (OAuth account,
  trust) is lost ([devcontainer](https://code.claude.com/docs/en/devcontainer)). `/login`-style
  tokens have failed to refresh headless (~6 h expiry) ([#50743](https://github.com/anthropics/claude-code/issues/50743)).
  Sessions are `~/.claude/projects/<encoded-cwd>/<id>.jsonl` + `--resume <id>`; with a
  persistent home there is nothing to transfer.
- **Licensing (read before designing the vault).** Hosting Claude Code "in hosted sandboxes or
  other agent infrastructure" requires the Commercial ToS; "Customers may not pay for, resell,
  or intermediate Claude usage on their end users' behalf"; developers "may not collect, store,
  or intermediate Claude.ai credentials or session tokens"; but provisioning "an API key in a
  ... secrets manager ... for use by the customer's own authorized users" is explicitly fine,
  as is an end user signing in to the unmodified binary with their own subscription
  ([legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)). `sk-ant-oat01`
  tokens are rejected by the API outside Claude Code since ~2026-02-20 ([#28091](https://github.com/anthropics/claude-code/issues/28091)).
  Implication: Taut's `claude.oauth` vault kind (company-stored, shared by agents) is the
  risky path; `anthropic.api_key` in the vault is the clean one.
- **Codex.** `codex exec "…" --json`, `--sandbox`, `--ephemeral`, `codex exec resume --last`;
  auth via `CODEX_API_KEY` or `~/.codex/auth.json`; needs a git repo unless
  `--skip-git-repo-check` ([non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)).
  Sandcastle uses `--dangerously-bypass-approvals-and-sandbox` and session JSONL under
  `~/.codex/sessions/` ([adding-an-agent-provider](https://github.com/mattpocock/sandcastle/blob/main/docs/agents/adding-an-agent-provider.md)).
- **OpenCode.** `opencode run --format json`, `--session/--continue`, `--auto`; creds in
  `~/.local/share/opencode/auth.json`; `opencode serve` HTTP ([cli](https://opencode.ai/docs/cli/));
  session state is SQLite (no file-level resume transfer) ([ADR 0016](https://github.com/mattpocock/sandcastle/blob/main/docs/adr/0016-resume-requires-filesystem-backed-sessions.md)).
- **Cursor.** `agent -p --output-format stream-json`, `CURSOR_API_KEY`, `--force` to apply
  edits ([headless](https://cursor.com/docs/cli/headless)); prompt must fit argv (~120 KB) per
  Sandcastle's guard.

## 6. Recommendation for Taut MVP

**Ship a Docker provider first, one long-lived container per agent, driven over the Docker
socket from the Taut container.** It is the only option that satisfies "docker compose up on a
€4 VPS", costs nothing per agent, gives millisecond task start, and makes the agent home
folder persistent by construction — bind-mount `/data/companies/<slug>/agents/<handle>/home`
to `/home/agent`, so `~/.claude`, `~/.codex`, repos and skills all survive. That is exactly the
gap Sandcastle papers over with session capture, and Coder/OpenClaw solve the same way
(`/home/coder` volume; `workspaceAccess: rw`).

Concrete shape:

- Image: `taut-agent` built from Sandcastle's template lineage (node:22-bookworm, git, gh,
  `claude`, `codex`, `cursor-agent`, `opencode`, non-root `agent` UID 1000). Container runs
  `sleep infinity`; tasks are `docker exec -i -u agent -e ...` with stdout NDJSON streamed
  into the WebSocket layer.
- Secrets: never at `docker run`. `vault.resolveForSpawn()` output goes on `docker exec -e`
  per task, so revocation is immediate and `docker inspect` shows nothing. (Still visible in
  `/proc/<pid>/environ` to host root — acceptable for MVP; Docker Sandboxes' header-injecting
  proxy is the later upgrade.)
- Hardening flags from day one: `--cap-drop ALL --security-opt no-new-privileges
--pids-limit 512 --memory 2g --cpus 2 --read-only --tmpfs /tmp`, a per-company bridge
  network. Config knob `runtime: "runc" | "runsc" | "sysbox-runc"` so operators with gVisor or
  Sysbox installed get stronger isolation without code changes.
- Idle policy: `docker stop` after N minutes idle, `docker start` (<1 s) on next @mention.

Second provider (post-MVP, for companies that outgrow one host): **Fly Machines** — one
machine + one volume per agent, `stop` when idle, ≈$2/agent/month, same `exec` semantics via
`fly machine exec`/SSH; Sprites are the cheaper-idle alternative if their API stabilises.
Skip Hetzner/DO-per-agent (billed while off), Cloudflare (ephemeral disk), Daytona (OSS dead),
E2B self-host (needs a cloud + Nomad + nested virt).

```ts
// packages/machines/src/provider.ts — the seam every backend implements
export interface MachineSpec {
  agentId: string
  companyId: string
  image: string // "taut-agent:<version>"
  homeDir: string // host path or volume id; mounted at /home/agent
  limits: { cpus: number; memoryMb: number; pidsLimit?: number }
  network: { egress: 'allow-all' | { allowDomains: string[] } }
  runtime?: 'runc' | 'runsc' | 'sysbox-runc'
}

export interface ExecOptions {
  cmd: string[] // ["claude", "--print", "--verbose", ...]
  cwd?: string
  env?: Record<string, string> // vault.resolveForSpawn() output, per task
  stdin?: string | AsyncIterable<Uint8Array>
  signal?: AbortSignal
  onStdoutLine: (line: string) => void // NDJSON from the agent CLI
  onStderr?: (chunk: string) => void
  idleTimeoutMs?: number // no output for N ms → kill (Sandcastle's rule)
}

export interface Machine {
  id: string
  status(): Promise<'running' | 'stopped' | 'missing'>
  start(): Promise<void> // must be idempotent and < ~1 s on the docker provider
  exec(opts: ExecOptions): Promise<{ exitCode: number; killedBy?: 'idle' | 'abort' }>
  putFile(path: string, content: Uint8Array): Promise<void>
  getFile(path: string): Promise<Uint8Array>
  stop(): Promise<void> // keep the home dir
  destroy(): Promise<void> // remove everything but the home dir
}

export interface MachineProvider {
  readonly name: 'docker' | 'fly' | 'sprites'
  ensure(spec: MachineSpec): Promise<Machine> // create-or-reuse for this agent
  get(agentId: string): Promise<Machine | null>
  list(companyId: string): Promise<Machine[]>
}
```

Agent runtimes (Claude/Codex/Cursor/OpenCode) sit above this as `RuntimeAdapter`s that only
produce `cmd`/`env` and parse NDJSON — the layer worth lifting from Sandcastle.
