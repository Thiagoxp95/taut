# Build plan: calls — huddles, screen share, self-hosted LiveKit

Engineering contract for one owner requirement (2026-09-09): **audio and video capability like
Slack**, on infrastructure we run ourselves — _"Run the LiveKit server container with Redis for
multi-node room distribution. Run your own TURN. coturn is still what everything assumes, and it
shipped 4.8.0 in January 2026, but it has no full-time maintainer. eturnal is the easier
operational choice."_

Extends `docs/build-plan.md`. Effect everywhere, pinned versions from `docs/CHANGELOG.md`
(effect 3.22.1 / platform 0.97.1 / vitest 3.2.7). Migrations are append-only; `0022` is taken by
the thread-sessions build — **this build owns `0023`.**

## Scope

**In:** a Slack huddle per channel and per DM — one live room, join/leave, mic with mute,
screen share, an optional camera toggle (off by default), a live participant strip everyone in
the channel can see, and a one-line summary message when the huddle ends. Self-hosted LiveKit +
Redis + eturnal behind a `calls` compose profile.

**Out, recorded as `// TODO(plan)`:** recording/egress, agents joining a room (schema and identity
scheme are already shaped for it — see D5), ringing/dial-out beyond the DM notification, speaker
view and layout switching, background blur, captions, huddle threads, per-huddle emoji reactions.

## Owner decisions taken before writing this (2026-09-09)

Pass one ships **huddles + screen share**; the containers go in under a **`calls` compose
profile** so `docker compose up -d` stays one container; calls are **humans only now, agents
soon**.

## Pinned versions

| thing                            | pin             | checked                |
| -------------------------------- | --------------- | ---------------------- |
| `livekit/livekit-server`         | `v1.13.6`       | 2026-08-26 tag, latest |
| `redis`                          | `8.8-alpine`    | latest alpine          |
| `eturnal/eturnal`                | `1.12.2-alpine` | 1.12.2 is current      |
| `livekit-server-sdk` (server)    | `2.19.0`        | npm latest             |
| `livekit-client` (web + desktop) | `2.22.3`        | npm latest             |

`@livekit/components-react` is **not** used (D12).

## Decisions (do not re-litigate; flag in the report if you had to deviate)

| #   | decision                                                                                                                                                                                                                                                                                                                                                                                                                                   | why                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **One huddle per channel.** The LiveKit room name is derived, `huddle_<channelId>`, so "start a huddle" and "join the huddle" are the same call: `POST /api/calls/channels/:channelId/join` creates the `calls` row if none is open and joins it otherwise. A partial unique index enforces at most one open row per channel.                                                                                                              | Slack's model. No race between two people pressing the button at the same moment.                                                                            |
| D2  | **LiveKit webhooks are the source of truth for who is in a room**, not the client. `participant_joined`, `participant_left`, `track_published`/`track_unpublished` (screen share) and `room_finished` drive `call_participants` and emit `call.updated` / `call.ended`. The explicit `leave` endpoint only makes the leaver's own UI instant.                                                                                              | A browser that crashes or a laptop that sleeps still leaves the room. Nothing else can reconcile that.                                                       |
| D3  | **Calls are off unless configured**, exactly like Web Push: `TAUT_LIVEKIT_URL` + `TAUT_LIVEKIT_API_KEY` + `TAUT_LIVEKIT_API_SECRET` must all be set. `GET /api/calls/config` returns `{ enabled }` and the UI hides every huddle affordance when it is false.                                                                                                                                                                              | The single-container deployment must keep working untouched.                                                                                                 |
| D4  | **Access = channel view rights.** `channels.requireView` gates join, and the token is minted for that one room only. Cap of `TAUT_CALL_MAX_PARTICIPANTS` (default 30) per huddle, `Validation` 422 past it.                                                                                                                                                                                                                                | One rule, already tested, already used by messages and attachments.                                                                                          |
| D5  | **Participant identity is `<kind>:<memberId>`** — `user:usr_…` today, `agent:agt_…` reserved. `call_participants.member_kind` exists from day one; the server rejects an agent join with `Validation` until the agent pass lands.                                                                                                                                                                                                          | Agents join later without a migration and without an identity re-scheme.                                                                                     |
| D6  | **Rejoining from a second device moves you.** LiveKit identities are unique per room, so the older connection is disconnected. We do not fight it.                                                                                                                                                                                                                                                                                         | Slack does the same thing, and the alternative is two microphones in one room.                                                                               |
| D7  | **No new message kind.** A live huddle is realtime state only. When the last participant leaves, the server posts **one** message into the channel authored by whoever started it: `🎧 Huddle · 12 min · @ana, @bruno` and stores its id on the call row.                                                                                                                                                                                  | The messages table stays as it is; history still shows the huddle happened.                                                                                  |
| D8  | **Notification on DM huddles only** — new `NotificationKind` `'huddle'`, fired at `call.started` to the other member of a DM. Channel huddles notify nobody; they surface as a live indicator on the channel row.                                                                                                                                                                                                                          | Slack rings for DMs and stays quiet for channels. Anything louder is unusable in a busy company.                                                             |
| D9  | **Single-port UDP mux.** LiveKit runs on bridge networking with `rtc.udp_port: 7882`, not a 10k port range, so the profile publishes exactly `7880/tcp` (signal), `7881/tcp` (ICE-TCP) and `7882/udp`. `docs/deploy.md` documents switching to `network_mode: host` + a port range past roughly 100 concurrent participants on one node.                                                                                                   | A published 50000-60000 range spawns one docker-proxy per port and is unusable on Docker Desktop.                                                            |
| D10 | **eturnal, not coturn, and not LiveKit's embedded TURN.** eturnal takes its shared secret from `ETURNAL_SECRET`, its public address from `ETURNAL_RELAY_IPV4_ADDR`, and a narrowed relay range `49160-49200/udp`. LiveKit advertises it to clients through `rtc.turn_servers` with the **same** `secret`, which mints ephemeral TURN REST credentials. LiveKit's built-in `turn:` block stays `enabled: false` so nothing else binds 3478. | Owner's call on eturnal. Two TURN servers on one host is the failure mode to avoid.                                                                          |
| D11 | **TLS TURN is opt-in.** The default profile listens UDP+TCP on 3478 (two `rtc.turn_servers` entries). TURN over TLS on 5349/443 needs `tls_crt_file`/`tls_key_file` and is a documented production step, not a default.                                                                                                                                                                                                                    | Cert provisioning is a deployment decision; shipping a broken TLS listener is worse than none.                                                               |
| D12 | **`livekit-client` only on the web, no `@livekit/components-react`.** One wrapper (`lib/livekit.ts`) and one hook (`hooks/use-huddle.ts`) drive Taut's own components.                                                                                                                                                                                                                                                                     | Taut has its own Tailwind design system; the component kit brings its own styles, its own theme and ~200 KB we would spend the rest of the build overriding. |
| D13 | **One huddle at a time per tab**, held in a React context mounted in `_app.tsx` so the bar survives route changes. Joining a second huddle leaves the first.                                                                                                                                                                                                                                                                               | The bar is global chrome; a per-route hook would drop the call on navigation.                                                                                |
| D14 | **Redis is part of the profile even for one node.** `redis:8.8-alpine`, no published port, LiveKit `redis.address: redis:6379`.                                                                                                                                                                                                                                                                                                            | Owner asked for multi-node room distribution; a second LiveKit node is then a `--scale` away instead of a migration.                                         |
| D15 | **Screen share is a track, not a mode.** `setScreenShareEnabled(true)` publishes `screen_share` (+ `screen_share_audio` where the browser offers it). The tile panel appears when any participant is sharing; the bar alone is enough when nobody is.                                                                                                                                                                                      | No layout engine in pass one.                                                                                                                                |
| D16 | **Camera is a toggle, off by default**, rendering into the same tile grid as screen share. No speaker view, no pinning (`// TODO(plan)`).                                                                                                                                                                                                                                                                                                  | Owner asked for huddles with camera off by default; the plumbing is one LiveKit call, so leaving it out would be a fake constraint.                          |

## Interfaces every agent must honour

### `@taut/contract`

```ts
// ids.ts — add to IdPrefix
call: 'cal'
export const CallId = idSchema('cal', 'CallId')
export type CallId = typeof CallId.Type

// domain/enums.ts — extend the existing literal
export const NotificationKind = Schema.Literal(
  'mention',
  'dm',
  'thread_reply',
  'agent_done',
  'agent_failed',
  'huddle'
)

// domain/call.ts (new, owned by this build)
export class CallParticipant extends Schema.Class<CallParticipant>('CallParticipant')({
  kind: MemberKind,
  id: MemberId,
  joinedAt: Schema.DateTimeUtc,
  /** Publishing a screen-share track right now (D15). */
  sharing: Schema.Boolean
}) {}

/** A huddle. `participants` is everyone currently in it, join order. */
export class Call extends Schema.Class<Call>('Call')({
  id: CallId,
  companyId: CompanyId,
  channelId: ChannelId,
  /** LiveKit room name, always `huddle_<channelId>` (D1). */
  room: Schema.String,
  startedByKind: MemberKind,
  startedById: MemberId,
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.optional(Schema.DateTimeUtc),
  participants: Schema.optionalWith(Schema.Array(CallParticipant), { default: () => [] })
}) {}

/** What the browser needs to connect. The token is room-scoped and short-lived. */
export class CallCredentials extends Schema.Class<CallCredentials>('CallCredentials')({
  call: Call,
  /** `wss://…` as the *browser* must reach it (`TAUT_LIVEKIT_URL`). */
  url: Schema.String,
  token: Schema.String,
  expiresAt: Schema.DateTimeUtc
}) {}

// api/calls.ts (new)
export class CallsGroup extends HttpApiGroup.make('calls')
  .add(
    HttpApiEndpoint.get('config', '/config').addSuccess(Schema.Struct({ enabled: Schema.Boolean }))
  )
  .add(HttpApiEndpoint.get('active', '/active').addSuccess(Schema.Array(Call)))
  .add(
    HttpApiEndpoint.post('join', '/channels/:channelId/join')
      .setPath(Schema.Struct({ channelId: ChannelId }))
      .addSuccess(CallCredentials)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Validation)
  )
  .add(
    HttpApiEndpoint.post('leave', '/:callId/leave')
      .setPath(Schema.Struct({ callId: CallId }))
      .addSuccess(Call)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .middleware(Authentication)
  .prefix('/calls') {}

/** Unauthenticated by construction: LiveKit signs the body, we verify it (D2). */
export class CallHooksGroup extends HttpApiGroup.make('callHooks')
  .add(HttpApiEndpoint.post('livekit', '/livekit').addSuccess(Schema.Void).addError(Unauthorized))
  .prefix('/hooks') {}

// events.ts — three variants, `call.updated` carries the whole call (same trick as message.updated)
export const CallStarted = variant('call.started', Schema.Struct({ call: Call }))
export const CallUpdated = variant('call.updated', Schema.Struct({ call: Call }))
export const CallEnded = variant(
  'call.ended',
  Schema.Struct({
    callId: CallId,
    channelId: ChannelId,
    endedAt: Schema.DateTimeUtc
  })
)
```

Both groups go into `TautApi` in `api/index.ts`; `domain/call.ts` and `api/calls.ts` are re-exported
from their barrels.

### Schema — `0023_calls.ts`

```sql
CREATE TABLE calls (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel_id         TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  room               TEXT NOT NULL,
  started_by_kind    TEXT NOT NULL,
  started_by_id      TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  ended_at           TEXT,
  summary_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL
);
-- D1: at most one open huddle per channel.
CREATE UNIQUE INDEX calls_open_per_channel ON calls(channel_id) WHERE ended_at IS NULL;
CREATE INDEX calls_company_started ON calls(company_id, started_at DESC);

CREATE TABLE call_participants (
  call_id     TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  member_kind TEXT NOT NULL,          -- 'user' today, 'agent' reserved (D5)
  member_id   TEXT NOT NULL,
  joined_at   TEXT NOT NULL,
  left_at     TEXT,
  sharing     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (call_id, member_kind, member_id)
);
CREATE INDEX call_participants_live ON call_participants(call_id) WHERE left_at IS NULL;
```

Rejoining after leaving updates the existing row (`left_at = NULL`, new `joined_at`) — the primary
key is deliberately not time-scoped, since the huddle only needs "who is here now".

### Server config (`apps/server/src/config.ts`)

| var                           | default | notes                                                                                                                   |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `TAUT_LIVEKIT_URL`            | unset   | `wss://…` handed to browsers. Calls off when unset (D3).                                                                |
| `TAUT_LIVEKIT_API_KEY`        | unset   |                                                                                                                         |
| `TAUT_LIVEKIT_API_SECRET`     | unset   | `Config.redacted`, never logged, never sent to a client.                                                                |
| `TAUT_LIVEKIT_INTERNAL_URL`   | derived | `http(s)://` for `RoomServiceClient`. Default = `TAUT_LIVEKIT_URL` with `ws`→`http`. In compose: `http://livekit:7880`. |
| `TAUT_CALL_MAX_PARTICIPANTS`  | `30`    | D4.                                                                                                                     |
| `TAUT_CALL_TOKEN_TTL_SECONDS` | `21600` | 6 h; the client refetches on token expiry.                                                                              |

### Server service — `apps/server/src/services/calls.ts`

`Calls extends Effect.Service<Calls>()('Calls', …)` with:

- `config: Effect<{ enabled: boolean }>`
- `join(who: Actor, channelId): Effect<CallCredentials, NotFound | Forbidden | Validation>` — view
  rights, participant cap, open-or-create the row inside one `sql.withTransaction` alongside its
  `call.started` event, mint the token with `AccessToken` (`roomJoin`, `room`, `canPublish`,
  `canSubscribe`, `canPublishData`; `identity = user:<userId>`, `name` = display name, `metadata` =
  `{"kind":"user","id":"usr_…"}`).
- `leave(who, callId): Effect<Call, NotFound | Forbidden>` — marks `left_at`, emits `call.updated`;
  the webhook confirms it a moment later and must be idempotent with this.
- `active(who): Effect<ReadonlyArray<Call>>` — open calls in channels the actor can view.
- `handleWebhook(body: string, authHeader: string): Effect<void, Unauthorized>` — `WebhookReceiver`
  verifies the JWT against the raw body; unknown events are ignored, every handled event is
  idempotent, `room_finished` closes the call, posts the D7 summary message and emits `call.ended`.

Every mutation appends its event in the same transaction, per `EventLog` rules. The HTTP layer is
`apps/server/src/http/calls.ts` (+ the raw webhook handler reading `HttpServerRequest.text`), wired
into `serverApi.ts` and `layers.ts` next to `Attachments`.

### Web — `apps/web`

- `lib/livekit.ts` — `connect`, `setMicEnabled`, `setCameraEnabled`, `setScreenShareEnabled`,
  `disconnect`, plus a `RoomState` snapshot (participants, their tracks, speaking, muted).
- `hooks/use-huddle.ts` + a provider mounted in `routes/_app.tsx` (D13).
- `components/huddle-bar.tsx` — docked above the composer / at the foot of the sidebar: avatars with
  a speaking ring, mic toggle, screen-share toggle, camera toggle, leave.
- `components/huddle-tiles.tsx` — the grid, shown only when someone shares or turns a camera on.
- Channel and DM headers get a headphones button ("Huddle" / "Join · 2"); `app-sidebar.tsx` shows a
  live dot on channels with an open huddle.
- `lib/realtime-cache.ts` folds `call.started` / `call.updated` / `call.ended` into a
  `['calls','active']` query.

### Desktop — `apps/desktop`

Screen share in Electron needs `session.setDisplayMediaRequestHandler` with `desktopCapturer`;
without it `getDisplayMedia` rejects silently and the button looks broken. One handler, screen
sources only, no audio loopback (`// TODO(plan)`).

## Infrastructure

`docker-compose.yml` gains three services, all `profiles: [calls]`:

```yaml
livekit:
  image: livekit/livekit-server:v1.13.6
  command: --config /etc/livekit.yaml
  ports: ['7880:7880', '7881:7881', '7882:7882/udp']
redis:
  image: redis:8.8-alpine # no published port
eturnal:
  image: eturnal/eturnal:1.12.2-alpine
  ports: ['3478:3478/udp', '3478:3478', '49160-49200:49160-49200/udp']
  environment:
    ETURNAL_SECRET: ${TAUT_TURN_SECRET:?}
    ETURNAL_RELAY_IPV4_ADDR: ${TAUT_TURN_PUBLIC_IP:?}
    ETURNAL_RELAY_MIN_PORT: 49160
    ETURNAL_RELAY_MAX_PORT: 49200
```

The LiveKit config lives in the top-level `configs:` block of `docker-compose.yml`, not in a
mounted file: **livekit-server does not expand `${VAR}` inside its own config** (it does that for
`key_file` and nothing else), so the substitution has to happen before the container sees it, and
compose is what substitutes. It carries `port: 7880`, `rtc.udp_port: 7882`,
`rtc.tcp_port: 7881`, `rtc.use_external_ip: true`, `redis.address: redis:6379`, `keys`, a
`webhook` block pointing at `http://taut:3000/api/hooks/livekit`, and the two `rtc.turn_servers`
entries (udp + tcp on `${TAUT_TURN_HOST}:3478`, `secret: ${TAUT_TURN_SECRET}`). `turn.enabled`
stays `false` (D10). Only `deploy/eturnal.yml` is a mounted file — eturnal _does_ read
`ETURNAL_*` from its environment, so nothing in it needs substituting.

New `.env.example` entries: `TAUT_LIVEKIT_URL`, `TAUT_LIVEKIT_API_KEY`, `TAUT_LIVEKIT_API_SECRET`,
`TAUT_LIVEKIT_INTERNAL_URL`, `TAUT_TURN_SECRET`, `TAUT_TURN_HOST`, `TAUT_TURN_PUBLIC_IP`,
`TAUT_CALL_MAX_PARTICIPANTS`. `docs/deploy.md` gains a "Calls" section: generate the key pair and
TURN secret, the ports to open, the host-networking note from D9, and the TURN/TLS step from D11.

## Developing against it

`pnpm dev` leaves calls off, exactly as production does without the three LiveKit variables.
`pnpm dev:calls` is the same turbo task with a development SFU in front of it: one
`livekit/livekit-server` container, no Redis (a single node needs none) and no TURN (a browser and
a server on one host need none), started before turbo and torn down after it. The container is
handed a route back to the dev server on the host, because a huddle whose webhooks cannot land
shows an empty participant list and nothing says why.

Two things this depends on, both easy to break:

- **`turbo.json` runs in strict env mode**, so `TAUT_LIVEKIT_*` and `TAUT_CALL_*` must stay listed
  in `globalEnv`. An undeclared variable is filtered out of the task and the server sees calls as
  disabled no matter what the shell exports.
- **Over Tailscale (`pnpm dev:ts --calls`), the SFU needs its own TLS front door.** The page is
  https, so a `ws://` signalling socket is blocked as mixed content; the script maps a second
  `tailscale serve` port to 7880 and tells LiveKit to advertise the tailnet address for media.

`pnpm calls:up` / `pnpm calls:down` run the SFU on its own, for driving the API by hand.

## Verification

1. `pnpm typecheck && pnpm lint && pnpm test` clean.
2. Server unit tests: token grants for a member vs a non-member, the participant cap, webhook
   signature rejection, and the join → participant_joined → track_published → room_finished
   sequence driving exactly one `call.started`, N `call.updated` and one `call.ended`.
3. `pnpm dev:calls`, then two browsers in the same channel: both hear each
   other, the bar lists both, one shares a screen and the other sees the tile, closing one tab
   removes it from the other's bar within a few seconds, and the summary message lands when the
   second one leaves.
4. `docker compose up -d` with no profile still starts exactly one container and the UI shows no
   huddle button.
