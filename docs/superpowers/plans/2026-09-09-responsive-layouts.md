# Responsive layouts implementation plan

**Goal:** Make every web surface usable from 320px phones through small tablets to desktop.

**Architecture:** Retain the existing React and Radix components. Use container queries for settings and conversation layouts, responsive spacing for page content, and bounded scrolling for overlays and wide data.

**Tech stack:** React 19, Tailwind 4, Radix, Vite.

**Constraints:** Preserve existing workspace edits and app behavior. Keep every navigation item and action reachable. Use isolated demo data for browser validation.

- [x] Shared settings (`components/settings.tsx`): stack controls until their card has room, keep navigation start-aligned and scrollable, constrain minimum widths, reduce phone padding.
- [x] Shared shell (`components/page.tsx`, `routes/_app.tsx`, `components/app-sidebar.tsx`): wrap actions, allow shrinking, close mobile navigation on route changes.
- [x] Conversations (`components/channel-view.tsx`, `components/thread-panel.tsx`): restore DM navigation, show the thread as the content pane on narrow containers, retain desktop split view and composer state.
- [x] Overlays (`packages/ui/src/components/{dialog,sheet,popover}.tsx`): constrain width and height to the viewport, preserve scroll and close access.
- [x] Page-specific audit: organization, repositories, Linear, members, subscriptions, vault, agent creation and all agent tabs, channels, departments, projects, issues, tasks, handovers, profiles, auth and huddles.
- [x] Verify in Chromium at 320, 390, 640, 768, 1024 and 1440px, including navigation, threads, settings tabs, overlays, long content and landscape height. Record the baseline failures before editing.
- [x] Run web/UI typechecks, lint changed code, production build, and inspect final screenshots. Document any limits in actual coverage.

## Verification results

- Chromium widths: 320, 390, 640, 768, 1024 and 1440px. Also tested 640×360 landscape.
- 108 page layout checks: organization, repositories, Linear, members, subscriptions, vault, agents, new agent, agent profile, projects, tasks, handovers, channels, DMs, department settings and channel settings. No unexpected horizontal overflow in the final pass.
- All 10 agent tabs at all six widths; thread layout at all six widths. No remaining failures.
- 30 overlay checks: invite, secret, routine, skill editor, conversation members, and search, at five viewport sizes. All passed.
- 30 populated project/issue/connected Linear checks using intercepted API fixtures. Board columns scroll within the board; issue labels grow their rows instead of overlapping.
- 25 schedule mode checks, 10 login/signup checks, and four profile popover checks. All passed.
- Interaction checks passed: touch reply opens a thread, thread draft survives resizing, reaction picker and message menu are reachable, DM navigation opens and dismisses its drawer, and settings arrow keys follow the displayed orientation.
- Web and shared UI typechecks passed; lint passed for every changed React file; production web/PWA build passed; `git diff --check` passed. Vite retains its large-chunk advisory.

Tests used an isolated seeded server and a separate Chromium context. No live Linear writes, agent executions, or huddle connections were used. Live video/audio, physical devices, Safari keyboard behavior, and remote browser control remain outside the browser layout verification. The existing development servers and pre-existing source edits were preserved.
