# macOS desktop builds and releases

Taut's Mac app connects to your self-hosted or managed Taut URL. The same binary works for every company; customer URLs, server secrets and company data are not compiled into the app. Hosting the server remains a separate step described in [self-hosting](self-hosting.md). This release setup targets Apple Silicon (`arm64`) and Intel (`x64`) Macs.

## Build a local DMG

On a Mac with Node 22+, pnpm 10.18.3, Xcode command line tools and enough free disk space (allow several GB):

```sh
pnpm install --frozen-lockfile
pnpm --filter @taut/desktop package:mac --arch=arm64
# Intel build, including cross-building on Apple Silicon:
pnpm --filter @taut/desktop package:mac --arch=x64
```

Artifacts appear under `apps/desktop/dist/unsigned/`, named `Taut-1.0.0-mac-arm64-unsigned.dmg` (or `x64`) plus a ZIP. Mount the DMG, drag Taut into Applications and open it. Enter your deployed instance URL on the Connect screen; register there to create your company. The app contains the connection screen and loads the web client from your instance.

These are explicitly unsigned testing builds and macOS may block downloaded copies. Prefer building locally for development. Public downloads should use the signed release process below. Do not instruct users to disable Gatekeeper globally.

## Signed public release

Prepare a **Developer ID Application** certificate and its private key, exported as a password-protected `.p12`, from the Apple Developer team that owns the application. Apple Development and Apple Distribution certificates do not replace Developer ID Application for this distribution method.

Set these GitHub repository Actions secrets:

| Secret                        | Value                                          |
| ----------------------------- | ---------------------------------------------- |
| `MAC_CSC_LINK`                | Base64-encoded Developer ID Application `.p12` |
| `MAC_CSC_KEY_PASSWORD`        | Password protecting that `.p12`                |
| `APPLE_ID`                    | Apple account email with access to the team    |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization         |
| `APPLE_TEAM_ID`               | Apple Developer team ID                        |

Alternatively, keep the two `MAC_CSC_*` signing secrets and replace the three Apple account secrets with `MAC_APPLE_API_KEY` (base64-encoded team `.p8`), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. The workflow writes the API key to a private temporary file and removes it after packaging. Use only one notarization method.

For a local release, export the same values, using `CSC_LINK` and `CSC_KEY_PASSWORD` for the first two; `CSC_LINK` can instead be the local `.p12` path. Keep credentials in your secret manager or shell environment, never in the repository or chat. Use an app-specific password generated for notarization, not the Apple account login password. Apple documents this requirement in [its notarization workflow guide](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

Local builds also accept either of these notarization methods alongside `CSC_LINK` and `CSC_KEY_PASSWORD`:

- A team API key: `APPLE_API_KEY` is the local `.p8` path, with `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
- A previously stored `notarytool` Keychain profile: `APPLE_KEYCHAIN_PROFILE`, plus optional `APPLE_KEYCHAIN` for a specific keychain path.

Configure one notarization method at a time. The release preflight rejects incomplete or competing methods. The supplied GitHub workflow accepts either the app-specific-password or team API key secrets shown above.

```sh
pnpm --filter @taut/desktop test:release
pnpm --filter @taut/desktop release:mac --check
pnpm --filter @taut/desktop release:mac --arch=arm64
```

Release packaging requires all credentials before starting the build, enforces code signing, enables hardened runtime, and submits the signed app to Apple's notarization service. Missing credentials or signing/notarization failures stop the build. The command always uses `--publish never`; a local build never uploads to a GitHub release. Apple notarization necessarily submits the app to Apple.

Signed DMGs and ZIPs are written separately under `apps/desktop/dist/release/`. The notarization ticket is stapled to the app inside the DMG. Validate the mounted app with:

```sh
codesign --verify --deep --strict --verbose=2 /Volumes/Taut/Taut.app
xcrun stapler validate /Volumes/Taut/Taut.app
spctl --assess --type execute --verbose=2 /Volumes/Taut/Taut.app
```

Use the actual volume path shown by Finder if its name differs.

## GitHub workflow

The `macOS desktop` workflow builds both architectures on native Mac runners. Run it manually with `signed: false` for unsigned testing artifacts, or `signed: true` to test the signed pipeline. Downloads are workflow artifacts; a manual run does not create a release.

For a versioned release:

1. Update `apps/desktop/package.json` version and commit the reviewed changes.
2. Push a matching tag, for example `v1.0.0`. Only stable `vMAJOR.MINOR.PATCH` tags are supported; malformed, prerelease, or mismatched tags fail before either Mac build starts.
3. Wait for both architecture builds, DMG mount and integrity checks, bundle/version/architecture checks, signature verification, stapled-ticket validation and Gatekeeper assessment.
4. Review the generated **draft** GitHub release, including both versioned DMGs, ZIPs, their blockmaps, stable DMG aliases, architecture-specific updater feeds and per-architecture SHA-256 checksum files. Publish the draft when ready. The updater and public download links see it only after publication.

Unsigned artifacts cannot flow into the tag release job. A failed architecture or signing verification prevents the draft release job. Release upload uses the repository-scoped GitHub token; it does not need a personal access token. Both architecture feeds are validated again after downloading the workflow artifacts and before creating the draft. Metadata must match the desktop version, architecture, file sizes and SHA-512 archive hashes; aliases must match their versioned DMGs, and SHA-256 manifests cover all published architecture assets.

## Implementation verification and references

Researched against installed electron-builder **26.15.3** and Electron **44.2.0** on 2026-09-10. The locked dependency version, rather than the broad package range, defines the build. Revalidate these details when upgrading the release toolchain.

The release guard and artifact preparation are exercised by `pnpm --filter @taut/desktop test:release`, including missing credentials, notarization-method selection, architecture and stable-tag validation, fork repository validation, real archive hashes, missing blockmaps, mismatched metadata and tampered aliases/checksums. `--check` only validates configuration inputs; it does not prove that a certificate or Apple account is valid. Only a real signed build and Gatekeeper check prove that.

Local verification on 2026-09-10 produced signed and notarized arm64 and x64 DMGs and ZIPs for version 0.1.0 under `apps/desktop/dist/release/`. Both DMGs passed `hdiutil verify`, mounting, bundle ID/version/architecture checks, strict recursive signature verification, stapled-ticket validation and Gatekeeper assessment (`accepted`, `source=Notarized Developer ID`). The certificate is a valid Developer ID Application identity and hardened runtime is enabled. Per-architecture SHA-256 checksum files are beside the artifacts.

The signed Apple Silicon app was launched directly from its DMG and successfully opened the main self-host installation's signup page at http://localhost:3080. Intel metadata and Gatekeeper verification ran on the Apple Silicon host; native Intel execution is left to the Intel CI runner or a physical Intel Mac. The earlier explicitly unsigned testing artifacts remain in `dist/unsigned/`.

The preceding verification records the original 0.1.0 packaging baseline, before the updater pipeline. It does not establish a successful 1.0.0 → 1.0.1 update. See the [verification log](self-host-verification.md) for baseline notarization submission IDs and deployment evidence.

## Update feed and public downloads

Signed builds embed a generic `electron-updater` feed at `https://github.com/Thiagoxp95/taut/releases/latest/download`. Each native client selects channel `latest-${process.arch}`, which resolves to `latest-arm64-mac.yml` or `latest-x64-mac.yml`. The feeds keep the versioned ZIP/DMG names and SHA-512 digests produced by electron-builder. ZIPs are required for macOS updates; publish their `.blockmap` files as well. The two matrix jobs never upload the colliding builder filename `latest-mac.yml`.

`release:mac` validates builder metadata and creates the architecture feed, `Taut-mac-arm64.dmg` or `Taut-mac-x64.dmg` alias, and `SHA256SUMS-<arch>.txt`. All six per-architecture assets are covered by the checksum manifest. The [repository download page](downloads/index.html) links to the stable aliases, so its buttons continue to work after each release:

- [Download for Apple Silicon](https://github.com/Thiagoxp95/taut/releases/latest/download/Taut-mac-arm64.dmg)
- [Download for Intel](https://github.com/Thiagoxp95/taut/releases/latest/download/Taut-mac-x64.dmg)

Unsigned builds have no embedded update provider. Updating replaces the desktop client only; each user continues connecting to their separately hosted Taut instance. The download does not install or upgrade a server.

For forks, Actions automatically derives the feed from `GITHUB_REPOSITORY`. For local signed fork builds, set `GITHUB_REPOSITORY=your-owner/your-repository` before running `release:mac`; update the public download page links for the fork too. A repository must be public for unauthenticated client updates and download links to work. Keep the bundle ID and signing identity consistent between versions installed by the same users.

## Back-to-back updater smoke test

1. Set desktop version `1.0.0`, commit, push tag `v1.0.0`, and wait for both Mac jobs and the draft-release job to pass. Publish that draft.
2. Install the signed 1.0.0 DMG from the public download page into `/Applications`. Run the installed copy, connect to a server, and confirm its displayed version. Do not test from the mounted DMG or a development process.
3. Make a small visible change, set desktop version `1.0.1`, commit and push tag `v1.0.1`. Wait for the same validation and publish the new draft as the latest stable release.
4. In the still-running 1.0.0 client, check for updates. Confirm the update offer and download progress, then use **Restart to update** once the download is ready.
5. Confirm the restarted app reports 1.0.1, retains the connection settings, reconnects to the same server, and no longer offers that update. Repeat on Intel hardware for native x64 execution.

Record the two CI run URLs, release URLs, installed architectures, version before/after and restart result. Passing unit tests and valid feeds alone do not prove the native Squirrel replacement and relaunch worked. Keep the 1.0.0 release assets available: differential updates may request the previous version's blockmap.

Official references: [electron-builder signing](https://www.electron.build/docs/features/code-signing/), [notarization](https://www.electron.build/v26/docs/notarization/), [Mac configuration](https://www.electron.build/v26/docs/mac/), [auto-update configuration](https://www.electron.build/auto-update/), [publishing](https://www.electron.build/publish/), [GitHub Mac runner architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
