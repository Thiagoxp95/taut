# Desktop update verification

Date: 2026-09-10. This file separates implemented behavior from a completed installed-app upgrade.

## Source and publication

- All pre-existing workspace changes were committed in `d634faf`, merged with remote main in `55016df`, and pushed. The merge's only conflict was a comment; runtime typecheck and nine browser tests passed.
- The repository is public under the MIT license. Gitleaks scanned the source history; its five findings were reviewed test fixtures (notarization placeholders, a test-only VAPID key pair, and a deliberately invalid API key). No production credential was identified.
- Updater and release changes landed in `c56a655`; `6270b97` keeps the update card clear of connection controls and makes the download page wait for published artifacts.
- The public download page is https://taut-downloads.manga4671.chatgpt.site (Sites deployment succeeded; anonymous HTTP verified). Its source is `docs/downloads`. Its links enable themselves only after GitHub reports the signed release aliases. The client contains no server credentials or GitHub token.

## Local validation

- `pnpm --filter @taut/desktop test:release`: 15 tests pass. Real fixture files exercise metadata hashes, versions, architectures, aliases, blockmaps, and checksum tampering; subprocesses exercise release credential and tag validation.
- `pnpm --filter @taut/desktop test:updater`: seven tests pass. Covers explicit restart, disabled builds, retry after check/download failures, concurrent checks, preserving a ready update, and waiting for local cleanup before restart.
- Desktop, web, and shared UI typechecks pass. Desktop/web production builds pass. Scoped ESLint and diff whitespace checks pass.
- An isolated Electron process using a temporary `--user-data-dir` opened the real bundled connection screen. Its real preload reported updates disabled in development. Main-process fixture events reached the React update card; ready, dismiss, and retry UI passed. The process and temporary profile were removed afterward. This is a UI/IPC smoke test, **not** evidence that an actual signed update was downloaded or installed.
- Source resolution explicitly prefers TypeScript over legacy generated JavaScript siblings, so packaging includes the current implementation.

## CI and packaged runtime

- [macOS CI run 34513452519](https://github.com/Thiagoxp95/taut/actions/runs/34513452519) passed version validation and both native architecture jobs with unsigned test builds. Its draft-release job was correctly skipped for a manual unsigned run.
- The arm64 CI artifact was downloaded. Its DMG and ZIP both passed the published SHA-256 checks. The ZIP's actual packaged Taut executable launched in an isolated profile, reported version `1.0.0` and `app.isPackaged === true`, exposed the setup/update preload, and kept updates disabled for the unsigned build. Ready/dismiss/retry UI passed using explicit fixture events. This also verifies that the packaged runtime includes its dependencies.
- Self-host and Railway CI passed for the implementation commits, including `6270b97`.
- The public download page and its release-status script both returned HTTP 200 anonymously. It currently reports that the first release is being prepared, matching GitHub's empty release list.

## Remaining release proof

The owner requested a signed `1.0.0` followed by `1.0.1` and a real installed-app upgrade. Neither version has been published yet. All five signing/notarization secrets are now configured. The matching issuer ID was read from App Store Connect beside key 69434JWN58, and Apple notarization authentication succeeded. Signed release execution and the real upgrade test follow below.

After configuring that ID: tag the final reviewed 1.0.0 commit, wait for both signed CI builds and artifact verification, publish the draft, install the arm64 DMG in Applications, and connect an isolated profile to a Taut server. Record the version, instance URL and session before publishing 1.0.1. Confirm the card downloads the new release, click Restart to update, and verify version 1.0.1 plus the same URL/session afterward. Verify both feeds and website downloads anonymously. Desktop updates must leave server version and agent processes unchanged.

Use [the release guide](macos-release.md) for commands and required signature checks. Never substitute a fixture card or an unsigned build for the signed upgrade proof.
