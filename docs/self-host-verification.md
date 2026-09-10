# Self-host and release verification log

Date: 2026-09-10. This records the current goal's evidence, not a declaration of release readiness.

## Verified

- Installer CLI generates private `secrets.env`, stable installation metadata and Compose definitions. Reinitialization preserves secrets; separate installations have separate keys, data, namespaces and image tags. Local and HTTPS public URLs stay separate from the internal agent API URL. Invalid arguments and remote Docker hosts are rejected.
- Generated base and calls Compose definitions pass `docker compose config --quiet`.
- `node --test scripts/test/self-host.test.mjs`: installer and backup failure tests pass. Partial secret archives are removed; stopped agents are restarted on failure.
- `pnpm exec turbo build --filter=@taut/server --filter=@taut/web`: all three build tasks pass.
- `node --test scripts/test/production-onboarding.test.mjs`: real built production server serves the SPA, creates account/company, preserves session/company through restart, and recovers them after installer archive restoration at the same path. Docker discovery is stubbed only for this host-process backup test, so it does not prove container lifecycle.
- Packaged Apple Silicon app connected to a fresh production server on localhost:3081; signup → company creation → optional GitHub skip → company workspace succeeded, with `Connected seq 1`. Disposable account `desktop-qa@local.test`, company `desktop-release-qa`; no external provider connected. Screenshot visible in the thread.
- Both `apps/desktop/dist/unsigned/Taut-0.1.0-mac-{arm64,x64}-unsigned.dmg` files pass hdiutil integrity verification and mounting. Bundle ID `dev.taut.desktop`, version `0.1.0`, respective `arm64` and `x86_64` executables verified. ZIPs and SHA256SUMS files accompany them.
- `pnpm --filter @taut/desktop test:release`: eight subprocess tests pass. Missing/incomplete or competing signing/notarization variables fail preflight; Apple ID, API key and Keychain notarization inputs are supported. No Developer ID Application identity was initially present in the local keychain, but a valid exported certificate was subsequently found.
- Docker namespace implementation: runtime/server typechecks and scoped lint pass; 101 runtime tests passed (19 optional tests skipped), configuration tests passed. Namespace ownership and default discovery regression tests ran.
- `deploy/terraform/hetzner`: terraform init/validate, three mocked tests, both rendered cloud-init schemas and Bash syntax validation passed. No real cloud resources created.

- Full production server and agent images built successfully with the installer. The main installation at `self-hosted/my-company` is healthy on http://localhost:3080, with zero users and companies, ready for the owner's signup.
- `TAUT_SELF_HOST_TEST_DIR=<disposable-installation> node --test scripts/test/container-onboarding.test.mjs` passed against the installed production image: signup, company, department, agent sandbox startup, shared home files, internal API connectivity and session/company/file persistence through API restart. The test uses fresh HTTP connections across intentional server restarts.
- Real Docker namespace integration passed all seven checks, including the four daemon-backed cases, using the built agent image. Two installations can reuse company/agent names without discovering or reusing each other's resources.
- Container-backed backup/restore passed with two disposable companies and agent homes. The exact encryption key was preserved. Replaced marker files in the old directory differed from restored files seen through both server and agent mounts, proving the restored archive supplied the data.
- Optional LiveKit, Redis and eturnal services started healthy; authenticated LiveKit room creation/deletion succeeded from the API container. Published media ports were omitted for this local startup test to avoid the existing development calls service. This does not verify public media routing or TURN relay.
- Built agent image smoke checks passed: Claude Code 2.1.266, Codex CLI 0.154.0, OpenCode 1.18.30, and syntax checks for the bundled MCP server and CLI. These version checks do not prove paid provider execution.
- Focused server regression checks passed: 35 tests passed and one existing skip across configuration, phase4 and repositories. Server typecheck and scoped lint passed.

- Signed/notarized version 0.1.0 DMGs and ZIPs exist for arm64 and x64 under `apps/desktop/dist/release/`. Both mounted DMGs pass integrity, bundle ID/version/architecture checks, `codesign --verify --deep --strict`, `xcrun stapler validate` and Gatekeeper assessment (`accepted`, `source=Notarized Developer ID`). Hardened runtime and the Developer ID certificate chain were inspected. SHA-256 manifests cover both DMGs and ZIPs.
- Apple notarization accepted arm64 submission `40612d67-2a21-47fd-a64a-288a330024cc` and x64 submission `d7f44cab-7402-4a04-9249-861ecb3d0a8c` on 2026-09-10. The signed arm64 app launched from its DMG and reached the main installation's signup screen.
- CI API-key preparation was exercised using a fixture: correct decoding, mode-0600 permissions, no base64 key in the packaging child's environment, and temporary-key removal after both successful and failed builds. Workflow YAML and shell syntax checks pass.

## Remaining external validation

- Public-network calls (two participants/NAT), actual cloud apply and HTTPS endpoints require an operator's cloud account, domains and public network environment.
- Native Intel app execution and execution of both remote CI workflows. Intel signature, architecture and Gatekeeper checks passed locally on Apple Silicon.
- Publishing a reachable commit containing this work is required before cloud-init can fetch it. No push or release publication occurred. Open-source license choice remains with the owner.

## Environment and continuation

The first Docker image build encountered EIO/ENOSPC while downloading packages. Docker API requests subsequently hung. After the owner approved a restart, graceful restart timed out; a forced Docker Desktop stop followed by start recovered the daemon. All 57 previously running Supabase/development containers were restored, including the development LiveKit service. The main Taut server adds one healthy container.

Only disposable caches were removed: obsolete Electron downloads, npm/pnpm caches and unused Docker build cache. Existing user volumes, databases and app artifacts were preserved. After image verification and cache cleanup, approximately 11 GiB remained free. The earlier failed builds and namespace timeouts were superseded by the successful checks above.

The disposable desktop QA server on port 3081 was stopped. The old unsigned DMG was unmounted; the signed arm64 DMG is mounted at `/tmp/taut-signed-arm64-4g7q7_fz`. The notarized packaged app was launched from that DMG and now points to the durable main installation at http://localhost:3080 and is left at the empty signup screen. Its pre-task URL was http://localhost:5173. Revalidate live processes before further testing.

Disposable container validation and calls stacks, agent containers and instance networks were removed after verification. Their ignored installation directories and backup evidence remain under `self-hosted/`; the main `my-company` installation remains running. The early `self-hosted/preview` fixture predates the final generated configuration and should not be used for deployment.

At the owner's request, a local credential search found a valid Developer ID Application `.p12` and its matching password file. Its certificate is valid through August 2031, and its private key matches. After the owner signed in to App Store Connect, the existing API key authenticated successfully with the issuer ID shown in the account. No new key was created. Credential values were not added to source files. The release script and CI workflow now support team API key notarization; the CI key is decoded into a mode-0600 temporary file and removed after either successful or failed packaging. This preparation was exercised with a fixture key.

The local deliverables are verified: easy self-hosting with company creation, signed macOS installers, and tested infrastructure for future per-customer provisioning. Public cloud rollout still requires the operator steps and external validation above; no hosted service, paid cloud deployment or published GitHub release is claimed.
