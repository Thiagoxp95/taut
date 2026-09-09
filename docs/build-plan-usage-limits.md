# Build plan — real cooldowns and per-seat usage limits

Status: planned 2026-09-08.

## The bug

`Subscriptions.markRateLimited` parks a seat for a _guessed_ duration:

```ts
agent.runtimeKind === 'claude-code' ? CLAUDE_COOLDOWN_MS : DEFAULT_COOLDOWN_MS
// 5h                                  1h
```

Claude's 5-hour window starts at the first message of the block, not at the
moment the limit is hit. A seat that trips its limit 40 minutes before the
window rolls over is parked for 5 hours. `apps/web/src/routes/_app.subscriptions.tsx`
faithfully renders that fiction as `cooling 3h 52m` next to a `Healthy` pill,
and the seat stays out of the rotation the whole time.

Nothing ever clears `cooldown_until` early. `check` re-runs binary detection
only; it does not look at quota. So the badge cannot self-heal.

## The fix

Ask the provider when the window actually resets, instead of guessing.

### Where the numbers come from

Anthropic exposes the same data the CLI's `/usage` screen renders:

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <oauth access token>
anthropic-beta: oauth-2025-04-20
```

Response (fields all optional):

| field                                   | meaning                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `five_hour.utilization` / `.resets_at`  | rolling session window                                                                                   |
| `seven_day.utilization` / `.resets_at`  | rolling weekly window                                                                                    |
| `seven_day_opus`, `seven_day_sonnet`    | legacy per-model weekly windows                                                                          |
| `limits[]` with `kind: "weekly_scoped"` | newer per-model windows (`scope.model.display_name`, `percent`, `resets_at`) — this is where Fable lands |
| `spend.used` / `spend.limit`            | extra-usage spend meter                                                                                  |

`utilization` and `percent` are _used_, 0–100. `resets_at` is ISO-8601.

OpenAI's equivalent, for Codex seats:

```
GET https://chatgpt.com/backend-api/wham/usage
```

`rate_limit.primary_window` / `.secondary_window`, plus the
`x-codex-primary-used-percent` / `x-codex-secondary-used-percent` headers.

Both shapes are read off tddworks/ClaudeBar, which ships probes against them.

### D1 — Scope of the credential

`claude setup-token` mints a `user:inference` token. That scope **cannot**
read `/api/oauth/usage`; ClaudeBar strips `CLAUDE_CODE_OAUTH_TOKEN` from its
subprocess for exactly this reason. Taut's `claude.oauth` recipe in
`apps/web/src/lib/runtime-meta.ts` tells operators to paste a setup-token, so
today's stored credential is the wrong one for the probe.

Consequence: the probe is best-effort. A seat whose token cannot read usage
gets `limitsError` and keeps the fallback cooldown. The credential recipe grows
a second variant that copies the full `claude login` credential
(`~/.claude/.credentials.json` or the `Claude Code-credentials` keychain item),
which carries `user:profile`.

### D2 — Probing is rate-limited itself

`/api/oauth/usage` returns 429 with hour-long `Retry-After` windows when
polled. The probe therefore:

- caches per seat with a 10-minute TTL,
- honours `Retry-After` and refuses to call again until it elapses,
- never probes on the list endpoint's hot path — only on `check`, after a
  rate-limited task, and from a slow background sweep.

### D3 — Storage

The snapshot is a cache, replaced wholesale. It goes on the `subscriptions`
row as JSON rather than a child table.

```sql
-- 0016_subscription_limits.ts
ALTER TABLE subscriptions ADD COLUMN limits_json       TEXT;
ALTER TABLE subscriptions ADD COLUMN limits_checked_at TEXT;
ALTER TABLE subscriptions ADD COLUMN limits_error      TEXT;
```

### D4 — Contract

```ts
export const LimitWindowKind = Schema.Literal('session', 'weekly', 'weekly-model', 'spend')

export class LimitWindow extends Schema.Class<LimitWindow>('LimitWindow')({
  kind: LimitWindowKind,
  /** "Session", "Weekly", "Opus", "Fable 5". */
  label: Schema.String,
  /** 0–100, what the provider says is consumed. */
  percentUsed: Schema.Number,
  resetsAt: Schema.optional(Schema.DateTimeUtc),
  /** Window length in seconds; pace math falls back to the kind's default. */
  windowSeconds: Schema.optional(Schema.Number)
}) {}
```

`Subscription` gains `limits: ReadonlyArray<LimitWindow>`, `limitsCheckedAt?`,
`limitsError?`.

### D5 — Cooldown is derived, not guessed

`markRateLimited` becomes:

1. Probe the seat.
2. `cooldownUntil = min(resetsAt)` over windows at or above `EXHAUSTED_PCT`
   (95%). That is the moment the seat genuinely returns.
3. If no window is exhausted but the runtime said rate-limited, use the
   session window's `resetsAt` — the runtime saw something the snapshot has
   not caught up to.
4. If the probe fails, fall back to the current fixed guess, clamped to the
   runtime's window length so it can never exceed one real cycle.

### D6 — Cooldowns clear themselves

Any successful probe that shows every window below `EXHAUSTED_PCT` clears
`cooldown_until`. That is what fixes "the seat is available again but the badge
still counts down". `check` probes, so the operator has a manual escape hatch;
a background sweep probes cooling seats so it also heals on its own.

### D7 — UI

Under each seat row, one line per window:

```
5h   ▓▓▓▓▓▓░░░░  62%   resets 1h 12m
7d   ▓▓░░░░░░░░  18%   resets 4d 3h
Opus ▓▓▓▓▓▓▓▓▓░  91%   resets 4d 3h
```

The cooling badge reads its countdown from the exhausted window's `resetsAt`,
so badge and strip can never disagree. A seat with `limitsError` shows the
reason once, not a broken strip.

## Order of work

1. Contract: `LimitWindow`, `Subscription` fields.
2. Migration 0016 + `SubscriptionRow` / `toSubscription`.
3. `services/usageProbe.ts` — Anthropic and OpenAI adapters, TTL cache, 429 handling.
4. `Vault.resolveForProbe` — company-scoped decrypt, `audit_log.purpose = 'probe'`.
5. `Subscriptions`: derived cooldown, probe on `check`, clear-on-headroom.
6. Background sweep for cooling seats.
7. Web: limits strip, badge sourced from `resetsAt`.
8. Credential recipe for the full-scope Claude login.

## Built 2026-09-08

Verified against the live OpenAI endpoint: the background sweep read the Codex
seat's real windows (`Session 4%`, resetting 2026-09-09T03:30; `Weekly 1%`,
resetting 2026-09-15T22:30) and released a seat that had been showing a
guessed countdown.

Anthropic seats stay unverified. The credential Taut stores for `claude.oauth`
is injected as `CLAUDE_CODE_OAUTH_TOKEN`, so it must remain the bare
`claude setup-token` value — and that token is inference-only. Those seats show
the probe's reason instead of a strip. Giving them stats needs a second,
usage-scoped credential per seat, which is a separate piece of work.
`bearerFrom` already accepts a full `claude login` credential file, so the
probe side is ready for it.

## The usage credential (2026-09-08, later the same day)

Item 8, built. A Claude seat now reads its own limits.

### The problem, once more

A seat holds one credential and Taut asks it to do two unrelated jobs: run the
runtime, and answer "how much of the window is left". For Codex those are the
same file — `~/.codex/auth.json` runs `codex` and reads
`chatgpt.com/backend-api/wham/usage`. For Claude they are not. The value Taut
stores is injected as `CLAUDE_CODE_OAUTH_TOKEN`, so it has to be the bare
`claude setup-token` line, and that token carries `user:inference` alone.
`api.anthropic.com/api/oauth/usage` answers it with a 401 forever.

### Decisions

**D1 — a second credential, not a replacement.** The seat keeps its
`setup-token`; a new optional `usage_credential_id` points at a separate vault
item the probe reads. Swapping the seat's own credential for a full login would
have worked too, and would have been less to build, but it puts every Claude
seat behind a token that expires in hours: one failed renewal and nothing runs.
A stale usage credential costs a seat its strip and nothing else.

**D2 — a new kind, `claude.login`, whose injection is `none`.** Read-only by
construction rather than by convention. `injectionFor` returns `{ via: 'none' }`,
so there is no path by which it reaches a runtime even if a future caller asks
for one.

**D3 — validated against its own list.** `RuntimeUsageCredentialKinds` sits
beside `RuntimeCredentialKinds`. A Claude seat runs on `claude.oauth` and reads
quota with `claude.login`, never the reverse, and the two lists say so
separately instead of one list carrying a comment.

**D4 — the normalizer keeps only `claudeAiOauth`.** The Keychain record also
holds `mcpOAuth`, a bag of tokens for whatever MCP servers that machine has
signed into. None of it is the seat's business, so it is dropped at the paste.
A login with no `refreshToken` is refused outright: it would light the strip up
for one afternoon and then go back to showing an error, which is worse than
saying so at the field.

**D5 — the probe rotates the token in place.** A `claude login` access token
lives hours; its refresh token lives weeks. `refreshClaudeLogin` trades one for
the other at `console.anthropic.com/v1/oauth/token` and
`Vault.rewriteForProbe` writes the result back under the same item. The
rotation writes no audit row of its own — it is bookkeeping on a credential the
operator already pasted, and the `probe` row from the read that triggered it is
the trail.

**D6 — `supports()` now refuses `claude.oauth`.** It used to accept it and get
a 401 on every sweep. The refusal is stated on the seat instead: "no usage
credential on this seat — a `claude setup-token` is inference-only", with a
picker underneath.

**D7 — the page presses Check, the service does not.** Attaching a credential
should show the strip without a second click, but a provider call hidden inside
a PATCH turns every test that touches seats into a network client. So
`setUsageCredential` stays local and the subscriptions page fires the Check it
already knows how to fire.

### Not verified

The refresh call has not run against Anthropic's token endpoint. There was no
usable `claude login` record on the build machine — the Keychain entry's
`accessToken` was empty — so the read path and the rotation path are both
covered by unit tests and neither has met the live provider. The Codex seat is
unaffected and still verified.

### The recipe

Run on a Mac signed in to Claude; the connect dialog copies it verbatim.

```
claude auth status >/dev/null 2>&1 || claude /login
{ security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null || cat ~/.claude/.credentials.json; } | base64 | tr -d '\n' | pbcopy
```

## One paste per seat (2026-09-08, later still)

The operator's complaint, in their words: connecting Claude Code should be
"click connect, copy the command, paste the token, and boom — I can see my
usage". What they got instead was a seat that ran fine and reported nothing,
under a line telling them to go to the vault and come back with a second
credential.

### The change

`claude.login` stops being read-only. It is now the _first_ kind
`RuntimeCredentialKinds['claude-code']` offers, and it does both jobs:

|                              | runs the seat | reads `/api/oauth/usage`   |
| ---------------------------- | ------------- | -------------------------- |
| `claude.oauth` (setup-token) | yes           | no — `user:inference` only |
| `claude.login` (whole login) | yes           | yes                        |

So the connect dialog's default path is one command, one paste, and a seat that
shows its windows on the first Check. `refreshLimits` already falls back to the
seat's own `credentialId`, so nothing has to be attached: the strip appears
because the seat can read itself.

### Decisions

**D8 — the login is injected, not written as a file.** `injectionFor` returns
the same `CLAUDE_CODE_OAUTH_TOKEN` it returns for a setup-token, and the adapter
lifts `claudeAiOauth.accessToken` out of the stored record (`accessTokenOf`).
Writing the whole record into the agent's `CLAUDE_CONFIG_DIR` and letting the
CLI refresh it would drift per machine and leave the vault holding a login that
is no longer the live one; injecting a token keeps the vault the single copy.

**D9 — the token is renewed at spawn, not only at probe time.** D1 rejected a
login-backed seat precisely because its access token lives hours. That objection
is answered rather than accepted: `Subscriptions.freshenSeatSecret` runs the
same `rotateIfStale` the probe uses, before the runtime is handed anything, and
writes the rotation back. A refusal there is deliberately _not_ a task failure —
the paste is spent, and the honest way to say so is the runtime's own
`auth-failed` on the seat, not a task that dies before it starts.

**D10 — the setup-token stays.** It is still accepted, still injected, still
runs agents. It simply sits second in the list with "cannot read usage" under
it. Nobody's working seat is invalidated by this change.

**D11 — a rotation keeps the item's hint.** `rewriteForProbe` no longer
recomputes `hint` from the new plaintext. It is the same credential with a newer
token inside; a hint that changed every few hours would read on the seat row as
a credential somebody swapped.

**D12 — the legacy seat gets the paste inline.** A seat still on a setup-token
now shows "Paste a Claude login" on its own row, opening the same
command-copy-paste block; it stores, attaches and Checks in one submit. The trip
to `/vault` and back was three screens for one paste.

### Not verified

No `claude login` record was reachable on the build machine — the Keychain
entries hold `mcpOAuth` and an empty `claudeAiOauth` — so neither half of the
live path has met a real token: that `CLAUDE_CODE_OAUTH_TOKEN` accepts a login
access token for inference, and that the refresh at
`console.anthropic.com/v1/oauth/token` returns what the decoder expects. Both
are covered by unit tests against the shapes. The scopes on that machine's
record (`user:inference` alongside `user:profile`) are why the inference half is
expected to work at all. If it does not, the seat lands as `auth-failed` and the
setup-token path is still there.

## The command was wrong (2026-09-08, same evening)

The one-paste flow above is only as good as the block it tells people to run,
and that block was checked against the CLI for the first time here. Findings, on
`claude 2.1.246`:

- **`claude /login` is not a command.** `/login` is a slash command inside a
  session; the CLI's subcommands are `claude auth login` / `claude auth status`.
  As written, the recipe's fallback would have opened an interactive session and
  sat there. Fixed.
- **The block was macOS-only.** `pbcopy` does not exist on Linux, and the failure
  is silent — the pipeline ends, nothing is on the clipboard, and the operator
  pastes whatever was there before. The clipboard step is now
  `pbcopy || wl-copy || xclip || cat`, so a machine with no clipboard tool (a
  server over SSH) prints the line instead of quietly doing nothing. Both
  branches were run here.
- **A signed-in machine can have no copyable login.** On the machine this was
  written on, `claude auth status` reports a live `claude.ai` session while both
  Keychain records hold only `mcpOAuth` and an empty `claudeAiOauth` — Claude
  Code is authenticated through the desktop app. The old message for that case
  ("Claude is not signed in on that machine") was false and pointed at a command
  that does not exist. The paste now distinguishes three states: a record with no
  `claudeAiOauth` at all, one whose token was never populated, and one with no
  refresh token — each naming what to do, including "use `claude setup-token`
  instead" as the way out.
- **The Copy button assumed a secure context.** `navigator.clipboard` is
  `undefined` over plain HTTP, which is how a self-hosted Taut gets opened on a
  LAN address, so the click threw before any promise existed and no toast ever
  fired. It now falls back to a selection copy, and says so if even that fails.

### D13 — the paste is reduced in the browser, not on the server

The copied record is ~10 kB, and most of it is `mcpOAuth`: access tokens for
every MCP server that machine has signed into. `normalizeCredentialSecret`
already dropped them before storing, but "dropped after it arrives" is a
different promise from "never sent", and for other people's tokens it is the
wrong one. The three paste forms now send `secretToStore(value)` — the same
normaliser, run in the field. It is idempotent, so the server re-running it
changes nothing.

### D14 — a failed probe does not mark a seat `auth-failed`

Considered and rejected. It is tempting to let a credential-level probe refusal
flip the seat's pill, since a seat reading `Healthy` on a dead login is a lie.
But `/api/oauth/usage` is a diagnostics endpoint: a plan or an org that does not
expose it answers 403 to a credential that runs tasks perfectly well, and the
cost of being wrong is a working seat removed from the pool. The runtime already
marks `auth-failed` when it is the one refused (`runTask`), which is the signal
that cannot be a false positive. The probe stays diagnostics and says why on the
row.
