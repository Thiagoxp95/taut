# Agent connectors

Every agent has a **Connectors** settings section. A connector can also be added to the new-agent form; its configuration is saved in the same transaction as the agent.

The picker offers provider presets, regional choices, and **Custom URL…**. A connector consists of a name, an HTTP(S) MCP endpoint, and optional authentication headers. Saving configures the next task; it does not probe the provider or confirm its credentials. Providers requiring browser OAuth sign-in are labeled as unavailable until an OAuth authorization flow is implemented.

Company admins and the heads of an agent's departments can add, edit, or remove its connectors. Other company members can see names and URLs. Authentication values are encrypted with the existing vault key, bound to the company and connector ID, and never returned in API responses or events. Editing a name or URL preserves saved headers; **Replace headers** explicitly replaces the full set. URLs cannot contain embedded credentials, query parameters, or fragments; put authentication in headers.

The runner loads only that agent's connectors and generates the native configuration for Claude Code, Codex, Cursor, or OpenCode. Header values are registered with the task redactor before configuration is written. Failed configuration writes fail the task instead of launching with stale settings. Changes invalidate saved sessions and take effect on the next task; an already-running task keeps its configuration. The bundled Taut MCP server must be available for connector wiring.

SQLite migration `0037_agent_connectors.ts` adds the encrypted connector store. Existing agents start with no connectors. Migration discovery is automatic at server startup.

## Verification

- `pnpm --filter @taut/server exec vitest run test/agent-connectors.test.ts test/connectorRuntime.test.ts`
- `pnpm --filter @taut/taut-mcp test`
- `pnpm --filter @taut/contract test`
- `pnpm --filter @taut/web typecheck`
- `pnpm --filter @taut/web build`

Runtime tests exercise the real scheduler, API, configuration builders, and event redaction with a fake machine/model process for each runtime. They do not authenticate against live third-party providers. Manual UI checks cover the existing-agent section, search, regional choices, the custom dialog, header validation, draft editing, and adding a draft without submitting the parent agent form.
