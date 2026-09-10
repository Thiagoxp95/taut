# Desktop updates implementation plan

**Goal:** Publish MIT-licensed Taut 1.0.0, then verify an installed Mac upgrades to 1.0.1 through GitHub Releases.

**Architecture:** The signed Electron client owns the update feed and installation. The separately hosted server supplies the workspace; its URL and session survive a desktop update. The renderer receives only update status and explicit check/restart actions.

**Tech stack:** Electron 44.2.0, electron-builder 26.15.3, electron-updater 6.8.9, React 19, GitHub Actions.

- [x] Commit all existing work, integrate remote main, and push.
- [ ] Add a tested updater controller and trusted main-frame IPC. Check at launch and periodically, download in the background, install only on explicit restart, handle retry and development builds.
- [ ] Add accessible update cards on the connection screen and workspace, plus native menu fallback when the server is unavailable or older.
- [ ] Publish architecture-specific update metadata, signed ZIPs/DMGs, stable download aliases and checksums. Validate both architectures before creating a draft.
- [ ] Add MIT license and a repository-owned public download page explaining separate server hosting.
- [ ] Configure existing signing credentials as repository secrets without exposing them, build 1.0.0 in CI, publish and install it.
- [ ] Make a small visible 1.0.1 change, run CI, publish, and verify real update/download/restart/version/session persistence.

**Feedback loops:** `pnpm --filter @taut/desktop test:updater`, `test:release`, desktop and web typechecks/builds, GitHub Actions artifacts/signatures, and real installed-app update. Unit tests cover state transitions and failed downloads; signed CI and the installed-app test establish behavior mocks cannot prove.

**Release boundary:** Stable Mac arm64/x64 releases only. No server auto-upgrade or embedded server. Repository publicity and published releases are required for anonymous downloads; no GitHub token is shipped in the client.
