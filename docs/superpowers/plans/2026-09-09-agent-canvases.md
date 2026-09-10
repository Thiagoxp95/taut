# Agent Canvases Implementation Plan

**Goal:** Agents create, update, open and close multiple persistent HTML previews in conversation dialogs on web and Electron.

**Architecture:** A Canvases service owns SQLite persistence and emits metadata-only events. Task-authenticated tools infer agent/company/channel/thread; authenticated client reads enforce channel access. The shared web UI loads documents into sandboxed frames and keeps local dismissal independent from agent lifecycle state. Electron already loads that UI.

**Constraints:** Preserve existing working changes. No new dependencies. Self-contained HTML with inline CSS/JS and embedded assets. Each agent controls its own canvases within the task conversation. Human dismissal stays local. No canvas count limit; individual documents have a size bound.

- [x] End-to-end tracer: raw agent HTTP create, channel list/document reads, persisted event, shared dialog. Red command: `pnpm --filter @taut/server exec vitest run test/canvases.test.ts`.
- [x] Lifecycle: update/open/close/list, independent IDs and revisions, authorization and invalid input tests.
- [x] MCP client/tool table with schema validation and transport tests (delegated).
- [x] Shared UI state with replay/race/dismissal tests and accessible dialog (delegated).
- [x] Prompt guidance; format, typecheck, focused regression tests; browser visual and sandbox verification.
