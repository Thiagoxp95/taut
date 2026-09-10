# Agent components

All Taut agent runtimes can render inline components through the shared MCP server. Web and desktop use the same React components, Shadcn primitives, and application theme tokens.

This follows the [AI SDK generative UI pattern](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces): a tool produces structured data that selects a React component. Taut already has an MCP transport and persistent message stream, so this feature uses those rather than adding a second chat transport or an AI SDK dependency. Custom HTML visuals remain available through `canvas_create`.

## Ask a human

`ask_user_question` posts one card containing 1–4 questions. Each question has 2–6 choices, optional descriptions, and optional `multiSelect`. The human can always write a custom answer in **Say more**, with or without selecting a choice. Nothing is selected or submitted automatically.

```json
{
  "to": "@ted",
  "text": "A few details before I begin",
  "questions": [
    {
      "id": "pace",
      "question": "How should I pace the work?",
      "options": [
        { "label": "Steady", "description": "One focused block at a time." },
        { "label": "Fast", "description": "Keep the momentum going." },
        { "label": "Explore", "description": "Compare a few approaches first." }
      ]
    }
  ]
}
```

The tool uses the existing `taut_ask` routing, timeout, and continuation protocol. A parked result means the agent must end its turn without `taut_done`; the human's reply wakes the agent. `taut_ask` also accepts the optional `questions` field, while its existing text-only callers keep working. Terminal `AskUserQuestion` / `request_user_input` tools cannot reach Taut users; agent guidance points to the Taut tool explicitly.

Only the addressed human may submit the card. The authenticated answer endpoint validates every question and choice, saves the complete answer once, posts a human reply in the question's thread, and records the reply against the ask. Concurrent submissions produce one reply; the other receives a conflict. The answered card survives reloads and appears consistently in other clients. Answers do not authorize separate privileged operations such as mandate changes.

## Start a timer

Call `render_component` with:

```json
{
  "kind": "timer",
  "title": "Focus timer",
  "durationSeconds": 1500,
  "onComplete": "Check progress and suggest the next step."
}
```

The timer starts when the tool is called. Its countdown ring uses an absolute server deadline; remounting or reopening the page does not restart it. The server creates a durable signal targeting the calling agent in the current task thread. The tool returns `messageId`, `signalId`, and `endsAt`. The agent finishes its current turn normally and follows the `onComplete` instructions when woken. It must not also call `emit_signal` for the same timer.

Timers accept 1 second through 7 days. The existing signal scheduler checks every five seconds by default, and ordinary agent availability and queue limits still apply. The display says the follow-up is due at zero; it does not claim the action has executed. The browser never triggers the action, so closing it has no effect on delivery. `cancel_signal` can cancel the returned signal; there are no pause/restart controls in this initial component.

Send `durationSeconds` as a whole JSON number (`300` for five minutes). The MCP boundary also normalizes decimal numeric strings such as `"300"` and `"300.0"` before applying the same integer and range validation; the HTTP API still receives a number. Empty strings, fractions, units, and non-decimal formats are rejected.

Agents confirm a timer only after a successful result with `signalId` and `endsAt`. A validation failure permits one correction of the indicated arguments; repeated failure should produce a short explanation that the timer could not be created, without schema traces or an unverified diagnosis. An uncertain network result requires checking `list_signals` before retrying to avoid duplicates. Unsupported component behavior should be explained plainly with a supported alternative when available.

## Informational cards

`render_component({"kind":"card","title":"Next steps","body":"1. Start a focused block.\n2. Review the result."})` renders a themed Markdown card. These components use trusted application renderers; tool input cannot execute JavaScript in the application.

## Development

Migration `0038_message_components` adds the optional message payload. Existing messages and historical events continue to decode without it. Build the MCP bundle with `pnpm --filter @taut/taut-mcp build`; fresh agent turns discover the tools after the updated server is running.

Integration coverage lives in `apps/server/test/message-components.test.ts` and `packages/taut-mcp/test/components.test.ts`. It covers recipient checks, invalid choices, custom answers, concurrent submissions, persisted asks, tool discovery, and durable timer delivery without duplicate dispatch. Browser fixtures in `apps/web/test/message-components.*` exercise the real renderer and answer hook, including keyboard controls, narrow layouts, and unusual question IDs.
