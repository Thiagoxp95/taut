# Runtime compatibility checks

Verified September 10, 2026 against Codex CLI 0.154.0 and Cursor Agent
2026.09.02-c22c1a3. Recheck these details when upgrading either CLI; remove this
note when its checks are superseded by a newer compatibility investigation.

- Codex ChatGPT accounts can discover models with
  `GET https://chatgpt.com/backend-api/codex/models?client_version=0.154.0`,
  using the access token and optional `ChatGPT-Account-Id` from the seat's login.
  A live request returned HTTP 200 and a `models` array with `slug`,
  `display_name`, `visibility`, and `priority`. The visible list included
  `gpt-6-astra`. Internal models had `visibility: "hide"`.
- The production `ModelCatalogs.get` service returned `source: "live"` and
  `gpt-6-astra` using a real ChatGPT login. API-key accounts keep their separate
  `/v1/models` endpoint; a ChatGPT token must not be sent there.
- `codex exec --json -m gpt-6-astra -c 'service_tier="fast"'
-c 'features.fast_mode=true'` completed a read-only, no-tools `OK` prompt with
  exit 0 and a `turn.completed` event. Standard speed uses
  `service_tier="default"`; an absent override inherits CLI configuration.
- Cursor rejects a project `.cursor/cli.json` that has `permissions.allow` but
  omits `permissions.deny`. The real failing task exited 1 with a schema error
  at `permissions.deny` before starting a model session. Both arrays are
  required, including an empty deny list.
- Cursor's `sonnet-4.5` alias still completed a standalone read-only `OK` prompt;
  the model alias was not the cause of the startup schema error.
- The same Cursor seat completed a no-MCP prompt with Taut's isolated home, but
  its default macOS credential store displayed Keychain dialogs during refresh.
  The installed CLI explicitly supports `AGENT_CLI_CREDENTIAL_STORE=memory`.
  API-key runs now use that store because Taut supplies their credential on every
  invocation. Host-login runs retain normal credential discovery. The memory
  store change is covered by command tests; no further live Cursor probes were
  launched after the user reported the dialogs. The full MCP smoke run was
  stopped and is not a verified success.

Sources: [Codex model discovery implementation](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/models.rs),
[Codex speed configuration](https://learn.chatgpt.com/docs/agent-configuration/speed),
and the installed CLIs' actual responses. No credentials or private prompt
contents are retained here.
