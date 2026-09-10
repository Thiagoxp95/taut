# Agent canvases

Agents can show self-contained HTML previews in the conversation's **Canvases** dialog. The browser and Electron use the same UI. Channel and DM headers show the button after the first canvas exists; issue conversations show only canvases for that issue thread.

The tools are available through the existing Taut MCP server for every agent runtime:

| Tool            | Input                       | Behavior                                                                               |
| --------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| `canvas_create` | `{title, html, open?}`      | Stores a new document and opens it by default. Use `open:false` to prepare it quietly. |
| `canvas_update` | `{canvasId, title?, html?}` | Replaces supplied fields; preserves open/closed state.                                 |
| `canvas_open`   | `{canvasId}`                | Presents an existing canvas again.                                                     |
| `canvas_close`  | `{canvasId}`                | Closes that canvas for viewers; retains its document.                                  |
| `canvas_list`   | `{}`                        | Lists the calling agent's canvases in the current task conversation/thread.            |

Create separate IDs for alternatives. The dialog shows one selected preview at a time, with a selector for comparing documents. Closing a dialog manually affects only that viewer. Updates do not undo that dismissal; an explicit agent open can present it again. Closed documents remain available through the Canvases button and survive page reloads and server restarts.

The server derives ownership, company, channel, and thread from the task token. Another agent or thread cannot modify a canvas. HTML reads and live/replayed metadata events follow channel read access, including private DMs.

Use complete HTML with inline CSS and JavaScript, embedding images and fonts as data URLs. Documents are limited to 1 MB in UTF-8, and titles to 200 characters. Preview frames have opaque origins, cannot access Taut's document/session or Electron bridge, and block network resources and external navigation. Escape closes the popup even while the preview has keyboard focus. The frame message bridge accepts only dismissal from the currently displayed frame.

Migration `0035_canvases` runs on server startup. The MCP bundle must be rebuilt alongside the server/client for existing development checkouts: `pnpm --filter @taut/taut-mcp build`. Start a fresh agent turn to pick up updated tool discovery and prompt guidance.

Validation: server lifecycle and HTTP/WebSocket privacy tests, client state/race/bridge tests, MCP protocol tests, migration/contract tests, and desktop/web/server/MCP typechecks. Browser QA covered a rendered yellow-sidebar mockup, inline interaction, dismiss/update/reopen, mobile layout, blocked parent/storage/network/navigation access, and Escape preserving the underlying thread. Native Electron was typechecked; the shared preview UI was exercised in Chrome.
