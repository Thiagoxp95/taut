# Department specialist discovery

An agent that lacks a capability can find a teammate with `taut_agent_search` and delegate through the existing `taut_handoff`, `taut_ask`, `taut_send` and `taut_inbox` tools.

```text
taut_agent_search({ query: "production database" })
taut_handoff({
  to: "@database",
  text: "Review this proposed SQL against your mandate, ask me for missing details, perform it if authorized, and report the outcome: …"
})
```

The specialist may ask for the SQL or other inputs with `taut_ask`. The requester answers in that conversation. The specialist runs with its own machine, skills, connectors and credentials, then replies with results. The requester receives replies through the existing messaging flow and reports back to the original person. Delegated requests remain subject to the specialist's mandate and authorization requirements.

The CLI equivalent is `taut agents production database --limit 20`; `taut agents` lists teammates. The authenticated runtime endpoint is `POST /api/agent-runtime/agents/search`.

Search matches all whitespace-separated words, case-insensitively, across handles, names, roles and active skill names/descriptions. Results contain `id`, `handle`, `name`, `role`, `status` and `skills`. The default limit is 20, the maximum is 50, and `hasMore` indicates that the query should be refined or the limit raised. An empty query lists teammates in handle order. Paused agents remain visible with their status; choose an active specialist for work.

Only other, unarchived agents sharing at least one current department in the caller's company are discoverable. Multiple shared departments do not duplicate a result. No department means no results. Request fields cannot override the authenticated agent or department scope. Discovery grants no new permissions and exposes no mandates, skill bodies, pending skills, vault metadata or connector configuration.

For the production database example, keep the credential in the specialist's **agent-scoped vault** or its own connector. Company-scoped vault entries are deliberately shared with all company agents. Discovery and delegation do not copy credentials; agents are instructed to exchange requests and results, never secrets. Existing handoff depth and conversation turn limits still apply.

Validation: `pnpm --filter @taut/server test test/agent-discovery.test.ts` exercises discovery and private-vault isolation through the real HTTP API. `pnpm --filter @taut/taut-mcp test` covers the MCP and CLI tool entry points.
