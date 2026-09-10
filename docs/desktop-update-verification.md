# Desktop update verification

Date: 2026-09-10. The signed 1.0.0 → 1.0.1 installed-app upgrade completed successfully on an Apple Silicon Mac.

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
- The public download page and its release-status script both returned HTTP 200 anonymously. A real browser now reports `v1.0.0 · Available for Apple Silicon and Intel`, with both stable download links enabled.

## Signed 1.0.0 baseline

- All five signing/notarization secrets are configured in GitHub Actions. Apple API authentication succeeded. No private key, signing password, or token was committed or shipped.
- [Signed 1.0.0 CI](https://github.com/Thiagoxp95/taut/actions/runs/34514827879) passed both native architecture jobs and draft creation. Both builds were notarized and passed signature, Gatekeeper, metadata, and checksum validation.
- [1.0.0](https://github.com/Thiagoxp95/taut/releases/tag/v1.0.0) was published with all 14 assets. The Apple Silicon DMG was downloaded anonymously through the same stable URL used by the website. SHA-256: `be5c30f189453c697f0f824cd05a115e8e8ecd14b0a6961df1a19e5369981115`.
- The DMG passed its image checksum. Its installed `/Applications/Taut.app` passed `codesign --verify --deep --strict`, `stapler validate`, and Gatekeeper (`accepted`, `Notarized Developer ID`). Its baseline installed version was `1.0.0`.
- The real app connected to an isolated production server at `http://127.0.0.1:50642`. UI signup and company creation completed: user “Desktop Update Test”, company “Release Upgrade Test”. The workspace shows Connected. The original user profile was safely backed up before testing.
- Baseline server PID: `64806`; `/api/health` reports `{"ok":true,"version":"0.0.0"}`. Server and web artifacts remain fixed throughout the desktop upgrade.

## Completed back-to-back upgrade

- Commit `93deac8` bumps only the desktop version to `1.0.1` and changes the connection heading to “Connect to your workspace”. Local release/updater tests, desktop typechecks, and production build pass.
- [Signed 1.0.1 CI](https://github.com/Thiagoxp95/taut/actions/runs/34516071642) passed every job. Both native architecture builds were signed, notarized, and validated. Self-host and Railway CI passed for the same commit.
- [1.0.1](https://github.com/Thiagoxp95/taut/releases/tag/v1.0.1) was published with all 14 assets while the installed 1.0.0 client stayed open. Before publication, its native check correctly reported 1.0.0 as current.
- After publication, **Taut → Check for Updates…** found 1.0.1. The actual workspace card displayed live download progress, then **Taut 1.0.1 is ready**. The native ready dialog was dismissed with Later so the actual workspace card's **Restart to update** button could drive installation. No fixture events, feed overrides, replacement app copies, or manual relaunch were used.
- Clicking that card exited the app. Squirrel installed the downloaded update and relaunched Taut automatically. The installed bundle and the live native About panel both reported **1.0.1**. Client PID changed from `12877` to `69908`.
- The relaunched app returned directly to the same “Release Upgrade Test” company as “Desktop Update Test” (Owner), showing Connected, without login or onboarding. The saved instance file's SHA-256 fingerprint was unchanged. The connection screen retained `http://127.0.0.1:50642` and showed the new **Connect to your workspace** heading.
- Server PID `64806` remained alive throughout. `/api/health` still reported `{"ok":true,"version":"0.0.0"}`. No server rebuild/restart occurred during the upgrade. This fixture had no running agents or calls, so this test does not independently prove preservation of an active agent run or call cleanup.
- The updated installed app again passed strict deep code-signature verification, stapler validation, and Gatekeeper (`accepted`, `Notarized Developer ID`).
- A real anonymous browser reported **v1.0.1 · Available for Apple Silicon and Intel** on the public download page. Both download URLs returned HTTP 200 with nonempty DMGs; both anonymous update feeds returned version 1.0.1. Intel execution and signing checks ran on native Intel CI; the interactive upgrade was tested on Apple Silicon.
- The test app was quit and the original user's desktop profile restored. The signed 1.0.1 app remains installed in `/Applications/Taut.app`. The isolated server was stopped after completing the checks.

See [the release guide](macos-release.md) for repeating the release and installed-app verification procedure.
