# Live browser in conversations

When an agent first calls a browser tool in a conversation, the right pane opens
with a live view of its browser. The pane shows open tab titles, highlights the
page being streamed, and displays its URL. It follows new pages, navigation,
selection of an existing tab, and closure of the selected tab without activating
a tab on the viewer's behalf. It follows the tab selected by Playwright MCP,
including background tabs and tabs sharing the same URL.

The viewer shares the document pane's width, resize handle, 240 ms slide, narrow
window layout, and reduced-motion behavior. It leaves the reply composer mounted.
Close or Escape dismisses the browser for the current tasks; the Browser button in
the conversation and thread headers reopens it. A new browsing task can reveal it
again. Opening a document takes precedence until the document is closed. The
browser stays open between replies and reuses its connection across follow-up tasks
from the same agent. It disconnects when hidden or when leaving the conversation.
Transient connection failures retry automatically with a short backoff while the
pane is open. Reconnect remains available for an immediate retry. Closing the pane
cancels pending retries.

Take control in the pane header enables mouse, scrolling, and keyboard input using
the same input surface as Settings. A running agent requires the existing pause
confirmation; Release control resumes following. Closing the pane also releases
control and resumes a paused agent. Tab leaves the input surface; Escape inside
it goes to the remote browser. Ownership belongs to a connection, so another view
opened by the same user cannot accidentally claim to be driving.

## Data flow

- `runTask` identifies browser tool calls and adds a sticky `browser` flag to
  ephemeral `agent.activity`, scoped by channel, thread, task, and reply.
- The first browser activity bypasses the status throttle. Later public progress
  keeps the flag, without exposing model reasoning or parsing display text.
- The client's browser run store scopes the view to the current conversation,
  clears ended tasks, and reconciles missed completion events on task refetch.
- The conversation hook remembers the most recent browser per agent until leaving
  the conversation, independently of the active-task store.
- The pane opens the existing authenticated `/ws/terminal` endpoint with `pty=0`.
  It opens no shell and sends input only while holding control. Browser views have
  a separate per-agent connection cap and do not claim the viewer's terminal slot.
  Existing Workspace permissions still apply: viewers must be allowed to manage
  the agent. Control claims are serialized and the server reports socket ownership.
- The managed MCP launcher records its selected page's CDP target ID in
  `.taut/browser/active-target`, using the same BrowserContext as the tool server.
  `BrowserSession` reads this signal on connection and while streaming. Headless
  Chromium reports multiple pages as visible, so visibility alone cannot follow
  the agent. Visibility remains a fallback for browser sessions without this signal.
- `BrowserSession.tabs` carries title/URL/selection snapshots alongside JPEG frames.
  The viewer never activates a page to follow it.

Activity is ephemeral. Reloading during a task reveals its browser when the next
browser-marked activity arrives; it does not replay browsing from finished tasks.
This views Taut's managed browser; external browser processes and tools that do
not report browser activity are not discovered by inspecting shell commands.

## Validation

`pnpm --filter @taut/server test test/browserLive.test.ts test/activity.test.ts test/activityLive.test.ts test/browser-activity-state.test.ts test/thread-activity.test.ts test/browser-target.test.ts test/browser-preview-connection.test.ts`

`pnpm --filter @taut/server test test/browserFollow.test.ts`

The browser stream tests cover tab metadata, selection without navigation,
new/closed tabs, and absence of focus activation commands. Activity tests cover
scope, immediate browser notification, sticky progress, and task cleanup. The
production pane was checked in a temporary UI fixture at wide and narrow sizes,
including dismissal, reopening, reduced motion, and socket cleanup. Regression
tests cover automatic reconnect and cancellation when the pane closes. The stream
was also checked against isolated real headless Chromium.

UI regression: start Vite on port 5174, then run
`node apps/web/test/browser-pane.mjs` (or pass the Vite base URL as an argument). It covers
persistence between replies, follow-up connection reuse, drafts, take/release,
pause confirmation, keyboard escape, scrolling, ownership, reconnect, dismissal,
and conversation changes using the production components with a simulated socket.

The conversation browser fills the space below its tab and address bars without
outer padding. A debounced ResizeObserver sends its CSS viewport size through the
browser socket, replayed when the stream reconnects. Chromium reflows to those
dimensions and retains them when following another tab; images keep their aspect
ratio. Dimensions are bounded to 4096 pixels per side. The settings browser keeps
its existing layout.
