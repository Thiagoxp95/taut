# Self-host and macOS release implementation plan

**Goal:** A user can provision Taut, create their company, and connect from a macOS DMG; the same installation interface supports future managed customer provisioning.

**Architecture:** One installation owns its SQLite database, encrypted vault key, data directory, and Docker agent namespace. Docker Compose is the portable full-featured deployment target. The existing company/signup UI stays the onboarding entry point. macOS development artifacts and signed public releases use separate commands.

**Constraints:** Preserve existing worktree changes. No Windows/Linux desktop work. Do not claim a public release or Railway template exists until verified. No license choice on the owner's behalf. Preserve existing Docker workloads; the owner authorized the recovery restart, and all previously running containers were restored.

- [x] Installer: `node scripts/self-host.mjs init <directory> --port 3080` generates private, durable configuration without overwriting an existing installation. `up`, `status`, `stop`, and `backup` operate on that installation. Test idempotency, separate secrets/names, invalid paths/ports, Compose rendering, and fresh production signup/company creation with restart persistence.
- [x] Production image: build server/web and bundled MCP CLI from the current source; compile native dependencies in the container; prove `/api/health`, SPA and onboarding against the built image.
- [x] Agent isolation: `TAUT_INSTANCE_ID` namespaces all Docker resources. Test two installations using the same company/agent names and run an actual sandbox with persistent files and API connectivity.
- [x] Desktop: build and inspect an arm64 DMG, configure Intel artifacts and signing/notarization CI, verify missing release credentials fail early.
- [x] Cloud: document verified hosting requirements and ship repeatable VPS infrastructure/bootstrap for the complete Docker deployment. Railway is only a supported full-product route if its runtime can run the existing Docker provider; do not market an incomplete chat-only template as the solution.
- [x] Operations/docs: describe installation, TLS, backups/restores, upgrades, release secrets, and future per-customer orchestration. Verify backup restoration rather than archive creation alone.

- [x] Public distribution artifacts: both architectures signed and accepted by Apple notarization; mounted DMG signatures, stapled tickets and Gatekeeper acceptance verified. The signed arm64 app launches successfully against the main installation.

## Operator follow-up before public cloud rollout

Run remote CI against a reviewed published commit, including native Intel execution. A real customer cloud apply and public-network calls test require an operator account and domains. Configure repository release secrets and review the draft release before publication.

The installer, real Docker sandboxes, production onboarding, container-backed backup/restore and both signed and notarized macOS DMGs are verified. The main installation is running at http://localhost:3080 and the packaged app is at signup. See [verification evidence](../../self-host-verification.md) for completed checks and remaining limits.
