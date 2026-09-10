# Provider connections

The `/subscriptions` route is labelled **Providers** in navigation. It lists every supported provider from the first visit, with compact account rows and a provider-neutral connection picker.

The reference is [Orca's account settings](https://github.com/stablyai/orca/tree/main/src/renderer/src/components/settings), specifically `accounts-pane-claude-section.tsx` and `accounts-pane-codex-section.tsx`: provider identity, small account rows, clear account actions, and minimal technical detail on the overview. The implementation uses Taut's existing components and credential contracts.

## Structure

- `provider-connect-dialog.tsx` owns provider selection, two connection methods (Subscription or API key where supported), plaintext form state, saving credentials, and adding accounts. Claude subscriptions open browser sign-in and capture a fresh CLI login automatically. Account names are assigned automatically. Failed account creation can retry with the previously saved credential. Closing the dialog unmounts plaintext state.
- `provider-accounts.tsx` owns account status and expandable routing controls. Usage is shown only for accounts with a compatible credential already attached; connecting an account never prompts for a separate usage login.
- `secret-fields.tsx` retains the full vault editor and adds a compact presentation for connections. Both use the same credential validation and normalization, including removal of unrelated Claude MCP credentials before upload.

Subscription and API-key methods are offered only where Taut's runtime contract supports them. The connection dialog has no saved-credential picker, account-name field, model selector, or advanced login types. Account creation, checking, removal, weights, and cooldowns continue to use existing APIs. Existing full-login credentials remain supported by the vault and runtime.

## Browser sign-in

Claude has two connection methods: **Subscription** and **API key**. Subscription has one **Connect** button, no command or pasted-token field. The button opens Claude sign-in; after authorization, Taut saves the returned credential and creates the account. Account creation can retry without repeating successful authorization or creating another vault item.

- Desktop invokes `claude auth login --claudeai` through a narrow preload bridge. Only the main window at the configured instance origin can invoke it.
- Web opens `taut://connect/claude` and uses Taut desktop as its local sign-in helper. **Taut desktop and Claude Code must be installed on the same computer as the browser, and desktop must be connected to the same workspace URL.** A browser may ask for permission to access the local network. A standalone browser without the desktop helper cannot complete this flow.
- The CLI owns its OAuth callback and opens the system browser. A fresh temporary configuration and scoped Keychain service keep this separate from the computer's default Claude login. Only `claudeAiOauth` is transferred; unrelated MCP credentials are excluded.
- The web handoff listens only on `127.0.0.1:45173`. Each request must match the configured origin, loopback Host header, and a cryptographically random, one-use nonce. Responses are not cached. The listener closes after delivery, cancellation, or five minutes.
- Closing/cancelling sign-in terminates the CLI. The temporary directory and scoped Keychain item are cleaned up. App shutdown waits for that cleanup.
- Credentials are validated and stored through the existing encrypted vault API. No OAuth secrets are put in the deep link. Usage tracking is not a connection requirement; compatible existing credentials can still report usage.

An expired connection currently needs a fresh account connection followed by removal of the old account. Codex retains its existing subscription import flow.

## Verification

Electron development launches open `http://localhost:5173` (or `TAUT_DEV_INSTANCE_URL` when set), overriding an instance saved by a previous session. Port 5273 serves only the desktop setup screen. A Docker instance such as `localhost:3080` serves its own built client and will not reflect local web source edits.

- `node --experimental-strip-types --test apps/desktop/scripts/claude-login.test.mjs apps/desktop/scripts/claude-browser-login.test.mjs`: isolated CLI capture, cancellation, empty credentials, failure redaction, origin/nonce checks, one-use delivery, listener cleanup.
- `node --experimental-strip-types apps/web/test/provider-connect.mjs`: real dialog with intercepted vault/account APIs, desktop bridge sign-in, API key, cancellation, and the real loopback web handoff. Also checks a 390px layout.
- Desktop and web typechecks, targeted ESLint, and desktop production build. The desktop scripts explicitly select the TypeScript configuration and entry so old adjacent JavaScript files cannot hide the new IPC handlers.
- Claude Code 2.1.267 was observed generating a localhost callback in its automatic browser URL. No real provider authorization or live token exchange was performed during QA; tests use fake credentials.
