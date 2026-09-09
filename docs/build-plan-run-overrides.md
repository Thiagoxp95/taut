# Run overrides — picking the runtime, seat, model and reasoning per conversation

An agent has one runtime, one model and one permission mode, set once on its
settings page. That is right for what the agent _is_ and wrong for what a single
conversation _needs_: the same agent should answer a throwaway question on a
cheap model and a hard refactor on the best one, without anybody editing the
agent between the two messages.

So the composer gets a settings button. It opens next to Send whenever the
message you are about to post will actually wake an agent, and it carries four
rows: runtime, seat, model, reasoning effort. What you pick rides on the message
and the run it spawns.

The model list is not a list we maintain. It comes from the provider, through
the seat's own credential — the same credential that runs the task.

## Decisions

**D1 — The override rides on the message.** `messages.create` takes an optional
`runOverride`; it is stored on the `messages` row and read back on `Message`. The
scheduler needs no new argument and routines, `taut_send` and every other message
producer keep working unchanged, because the field is absent for them. `runTask`
already loads the trigger message, so applying the override is a local change
there.

**D2 — Sticky per conversation, in the client.** The popup remembers its choice
per `channelId:threadId`, in `localStorage`. The server stores nothing sticky:
every message says in full what it wanted, so the history of a thread stays
readable a year later without replaying anybody's settings. Clearing a row
("Agent default") sends nothing for it and the agent's own setting wins.

**D3 — The button appears only when an agent will read the message.** In a DM
with an agent it is always there. In a channel or a thread it appears the moment
the draft contains an `@handle` that resolves to an agent in that channel, and
it disappears when the mention is removed. Nothing else changes about mention
parsing: the composer already highlights handles and already knows which
mentionables are agents.

**D4 — Override fields are all optional and all independent.** Runtime alone,
model alone, or all four. `runtimeKind` overrides `agent.runtimeKind`,
`subscriptionId` overrides `agent.pinnedSubscriptionId`, `model` overrides
`agent.model ?? subscription.defaultModel`, `reasoningEffort` has no agent-level
counterpart today and is override-only.

**D5 — Changing the runtime starts a new session.** Sessions are keyed
`(agent, thread, runtimeKind)` (build-plan-sessions.md D1), so a message that
switches runtime resumes nothing and opens a fresh session for the new runtime.
That is the honest behaviour: a Codex session id means nothing to `claude`.

**D6 — Models come from the provider, cached, with a named fallback.**
`GET /api/subscriptions/models?runtime=&subscriptionId=` answers a
`ModelCatalog`: the models, whether they are `live` or `fallback`, and — when
`fallback` — one line saying why. Per runtime:

| runtime     | source                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| claude-code | `GET https://api.anthropic.com/v1/models`, with the seat's API key or its OAuth access token                         |
| codex       | `GET https://api.openai.com/v1/models`, API key only — a ChatGPT login has no models endpoint                        |
| cursor      | fallback list; Cursor publishes no models API                                                                        |
| opencode    | `GET https://models.dev/api.json`, flattened to `provider/model`, restricted to the providers the seat has a key for |

The result is cached in memory for 30 minutes per credential, so opening the
popup does not hit the provider on every keystroke. A failure is never an error
the operator has to clear: the dropdown falls back to the same short list the
free-text field used to suggest, labelled as such.

**D7 — Reasoning effort is per runtime, and empty is a valid answer.**
`claude-code` takes `low | medium | high | max` and gets them as
`MAX_THINKING_TOKENS`; `codex` takes `minimal | low | medium | high` and gets
them as `-c model_reasoning_effort=…`. `cursor` and `opencode` expose no such
control, so the row is hidden for them rather than shown and ignored.

**D8 — The agent settings model field becomes a dropdown too.** Same catalog,
same fallback, on the agent page, the new-agent form and the subscription's
default model. "Subscription default" / "Runtime default" stays as the empty
choice, so nothing that has no override keeps one by accident.

**D9 — An override never widens permission.** `permissionMode` is not a field
of `RunOverride`, so it cannot arrive at all. A `subscriptionId` is checked at
`messages.create`: a seat in another company reads as absent and is a
`Validation` 422, and so is a seat whose runtime contradicts a `runtimeKind` the
same override names. A seat that merely disagrees with the agent's own runtime
is left to the run, which refuses it with a reason the thread can show — the
message does not know which agents it will wake.
