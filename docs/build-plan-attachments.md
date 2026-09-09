# Build plan: attachments (images + files in chat, both directions)

Engineering contract for one owner requirement (2026-09-08 evening): **humans and agents must be
able to exchange images and files in chat, the way Slack does.** Extends `docs/build-plan.md`;
amends `docs/agent-model.md` §5 (home folder / `inbox/`), §9 (tool surface), §11 (message → task).
Effect everywhere, pinned versions from `docs/CHANGELOG.md` (effect 3.22.1 / platform 0.97.1 /
vitest 3.2.7). Migrations are append-only; the next free id is `0011`.

## Owner requirement (verbatim intent)

> "Neither me nor the agent are capable to exchange images. Please make sure this is capable and
> supported. Also files with files included as well. It just like slack does."

Concretely:

1. A human drops / pastes / picks an image or any file in the composer, optionally with text, and
   sends it. It renders inline (images) or as a file card (everything else) in the channel, the
   thread panel, and the desktop app.
2. An agent that is @mentioned or DM'd **sees** the attachment: the file is on its disk and the
   prompt tells it where. Claude Code reads PNG/JPEG natively, so "what is in this screenshot?"
   just works.
3. An agent can **send** files back (a screenshot it took, a CSV it produced) and the human sees
   them exactly like a human-sent attachment.

## Decisions (do not re-litigate; flag in the report if you had to deviate)

| #   | decision                                                                                                                                                                                                                                                                                                                                               | why                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **One company-scoped blob store**: bytes at `<dataDir>/companies/<slug>/attachments/<attachmentId>` (no extension; the name lives in the DB). Table `attachments` (below). An attachment belongs to exactly one message once sent; before that it is an _orphan_ owned by its uploader.                                                                | One source of truth; a channel message may address several agents, so the file cannot live in one agent's home.                                             |
| D2  | **Two-step send, Slack style**: `POST /api/attachments` (multipart, one file) returns `Attachment` immediately so the composer can show it; `POST /api/messages` then carries `attachmentIds`. `body` may be empty when there is at least one attachment.                                                                                              | Upload progress and retries per file; the message is created atomically with its attachments linked.                                                        |
| D3  | **Agents receive files by materialisation**: when a task is built (`runTask`) and when `taut_inbox` returns a message, every attachment of that message is copied (host side, idempotent) to `<hostHome>/inbox/<messageId>/<name>` and referred to by its **machine path** `<machine.paths.home>/inbox/<messageId>/<name>` in the prompt / inbox item. | The home is bind-mounted at `/home/agent` in docker and is the same dir on `local`, so a host-side copy is visible inside the machine with no new plumbing. |
| D4  | **Agents send files through the existing tools**: `taut_send` and `taut_done` gain `attachments?: string[]` — machine-absolute or home-relative paths **inside the agent home**. The server maps them to the host home, copies the bytes into the blob store, and links them to the posted message. Max 10 per message, max size as D6.                | No new tool to learn; the agent already writes files under its home. File grants outside the home are a later step (`// TODO(plan)`).                       |
| D5  | **Serving**: `GET /api/attachments/:attachmentId/content` streams the bytes behind the session cookie, `Content-Disposition: inline` only for an allow-list (`image/png                                                                                                                                                                                | jpeg                                                                                                                                                        | gif | webp`, `application/pdf`, `text/plain`, `video/mp4`, `audio/*`), `attachment`otherwise (SVG included),`X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=31536000, immutable`. `?download=1`forces`attachment`. | Same-origin cookie auth means a plain `<img src>` works in web and desktop; the allow-list keeps HTML/SVG from executing in the app origin. |
| D6  | **Limits**: `TAUT_ATTACHMENT_MAX_BYTES` (default 25 MiB) per file, 10 attachments per message. Mime type = the client's declared type when it is a sane `type/subtype`, else by extension, else `application/octet-stream`. No thumbnails, no image dimensions in the MVP (`// TODO(plan)`).                                                           | Slack's free-tier shape, one env var.                                                                                                                       |
| D7  | **Lifecycle**: deleting a message deletes its attachments (rows + files). Orphans older than 24 h are removed by a sweep at server start (`Attachments.sweepOrphans`). Editing a message never changes attachments.                                                                                                                                    | Keeps the data dir from filling with abandoned uploads without a scheduler.                                                                                 |
| D8  | **Authorization**: upload requires post rights on `channelId` (`channels.requirePost`); linking requires the ids to be orphans uploaded by the same user in the same channel; download requires read access to the attachment's channel (member of the channel, or a public channel of the company — reuse `channels.load`).                           | Mirrors message permissions exactly; no separate ACL.                                                                                                       |
| D9  | Message search / memory ingest ignore attachment bytes; the name is not indexed either in the MVP. `// TODO(plan): text extraction into memory kind=file`.                                                                                                                                                                                             | Out of scope for this pass.                                                                                                                                 |

## Interfaces every agent must honour

### `@taut/contract`

```ts
// ids.ts
AttachmentId = brand 'AttachmentId', prefix 'att_'; newAttachmentId()

// domain/attachment.ts (new, re-exported from domain/index.ts)
export class Attachment extends Schema.Class<Attachment>('Attachment')({
  id: AttachmentId,
  companyId: CompanyId,
  channelId: ChannelId,
  /** Unset while the upload is an orphan (not yet sent). */
  messageId: Schema.optional(MessageId),
  uploaderKind: AuthorKind,
  uploaderId: MemberId,
  /** Bare file name as shown to humans and as written into inbox/. */
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.NonNegativeInt,
  createdAt: Schema.DateTimeUtc
}) {}

// domain/message.ts
Message: + attachments: Schema.optionalWith(Schema.Array(Attachment), { default: () => [] })
//   -> `message.attachments` is always an array in memory; absent-or-array on the wire.

// api/messages.ts
CreateMessagePayload = Struct({
  channelId: ChannelId,
  threadId: optional(MessageId),
  body: Schema.String,                                     // was NonEmptyString
  attachmentIds: optional(Array(AttachmentId).pipe(maxItems(10)))
})
// server: body.trim() === '' && no attachments -> Validation 422 (add .addError(Validation) to `create`)

// api/attachments.ts (new group 'attachments', prefix '/attachments', Authentication middleware)
UploadAttachmentPayload = HttpApiSchema.Multipart(Struct({ channelId: ChannelId, file: Multipart.SingleFileSchema }))
upload:   POST '/'                         -> Attachment 201 | NotFound | Forbidden | Validation (too large / bad name)
get:      GET  '/:attachmentId'            -> Attachment     | NotFound | Forbidden
content:  GET  '/:attachmentId/content'    -> raw bytes (implement with `handlers.handleRaw` + `HttpServerResponse.file`),
                                              urlParams { download?: Schema.BooleanFromString }; NotFound | Forbidden
// register in api/index.ts (TautApi.add) + export from api/index.ts
```

### `@taut/taut-mcp` protocol (`protocol.ts`) — the server implements it

```ts
AttachmentPath = Schema.String.pipe(minLength(1), maxLength(1024))   // machine-absolute or home-relative
SendRequest: + attachments: optional(Array(AttachmentPath).pipe(maxItems(10)))
DoneRequest: + attachments: optional(Array(AttachmentPath).pipe(maxItems(10)))
InboxAttachment = Struct({ name, mimeType, size: NonNegativeInt, path: String /* machine path in inbox/ */ })
InboxMessage:  + attachments: optional(Array(InboxAttachment))
SendResponse:  + attachments: optional(Array(Struct({ id: String, name: String })))
// error for a path outside the home / missing / too large: 422 code 'validation' with the offending path in `message`
```

Tool descriptions (`tools.ts`) must say, in one sentence each: _"To share a file or an image
(screenshot, CSV, PDF…) pass `attachments: ["<path inside your home>"]`; the human sees it inline."_

### Server (`apps/server`)

- Migration `0011_attachments.ts`:
  ```sql
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id TEXT NULL REFERENCES messages(id) ON DELETE CASCADE,
    uploader_kind TEXT NOT NULL, uploader_id TEXT NOT NULL,
    name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX attachments_message ON attachments(message_id);
  CREATE INDEX attachments_orphans ON attachments(created_at) WHERE message_id IS NULL;
  ```
- `services/attachments.ts` — `Attachments` Effect.Service: `upload(me, channelId, file)`,
  `get(me, id)`, `openContent(me, id) -> { path, attachment }`, `listForMessages(companyId, ids) ->
Map<MessageId, Attachment[]>`, `link(companyId, userId, channelId, messageId, ids)` (inside the
  message transaction; fails `Forbidden` when an id is not that user's orphan in that channel),
  `storeFromHost(companyId, channelId, agentId, hostPath, name)` (agent-sent), `deleteForMessage`,
  `sweepOrphans(olderThan)`, `materialise(companyId, message, hostHome) -> ReadonlyArray<{ name,
mimeType, size, relPath: 'inbox/<messageId>/<name>' }>`.
- `services/messages.ts`: every read path (`list`, `thread`, `byId`, `loadMessage`) hydrates
  `attachments` via `listForMessages` (one query per page, not per row). `create` takes
  `attachmentIds`, validates D2, links inside the same `publisher.transact`. `postAsAgent` takes
  `attachments: ReadonlyArray<{ hostPath, name }>` already resolved. `delete` cascades files.
- `agents/agentApi.ts`: `send` / `done` resolve `attachments` paths: strip the machine home
  prefix (`machine.paths.home`) or treat as home-relative, then `path.resolve(hostHome, rel)` must
  stay inside `hostHome` (reuse `AgentHomes.resolveInside` semantics), the file must exist and be
  a regular file under `TAUT_ATTACHMENT_MAX_BYTES`. `inbox` calls `materialise` and fills
  `attachments[].path` with machine paths.
- `agents/prompt.ts`: a message with attachments renders as
  `[10:01] @acme: <body or "(no text)"> [attachments: /home/agent/inbox/msg_x/shot.png (image/png, 120 KB); …]`.
  `tautSection` gains one bullet: _"Files humans send you are in `inbox/<messageId>/`; read images
  with your file-reading tool. To send a file or image back, pass `attachments: ["<path>"]` to
  `taut_send` or `taut_done`."_
- `agents/runTask.ts`: `materialise` for the trigger and for every context message with
  attachments before rendering the prompt (best effort per file: log + skip on failure).
- `config.ts`: `attachmentMaxBytes: Config.integer('TAUT_ATTACHMENT_MAX_BYTES').pipe(withDefault(25 * 1024 * 1024))`;
  pass to the multipart layer (`Multipart.withMaxFileSize` or the equivalent in platform 0.97.1).
- `main.ts`: run `sweepOrphans(24h)` once at start, after migrations.
- Tests: `apps/server/test/attachments.test.ts` covering upload → create with ids → `list` and
  `thread` carry `attachments` → `content` bytes round-trip + headers (D5) → non-member 403 →
  orphan of another user cannot be linked → empty body without attachments 422 → delete cascades
  the file → agent `send` with a home-relative path posts an attachment and a path outside the
  home returns 422 → `inbox` materialises into `inbox/<messageId>/` → prompt line format.

### Web (`apps/web`)

- `components/composer.tsx`: paperclip button (`PaperclipIcon`) opening a hidden
  `<input type="file" multiple>`; drag-and-drop onto the composer box (highlight ring while
  dragging); paste of image blobs from the clipboard. A **pending strip** above the format rail
  shows each file (image thumbnail via `URL.createObjectURL`, or icon + name + size), an upload
  spinner, an error state with retry, and a remove ×. Send is enabled when there is text **or**
  at least one uploaded attachment and no upload is still running. Enter sends as today.
- `lib/api.ts`: `useUploadAttachment()` (FormData: `channelId`, `file` → `Attachment`);
  `useSendMessage` accepts `attachmentIds`.
- `components/message-bubble.tsx` (+ thread panel reuses it): under the body, images render in a
  responsive grid (`max-h-80`, rounded, `object-cover`, click → a `Dialog` lightbox with the full
  image and a Download link using `?download=1`); other files render as a card (file-type icon,
  name, human size, Download). Source URL: `/api/attachments/<id>/content` (same origin; the Vite
  proxy already forwards `/api`). Failed messages still show their attachments.
- Message cache (`lib/message-cache.ts`, `realtime-cache.ts`): nothing special — `Message` now
  carries `attachments`; make sure optimistic/streamed updates keep the array.
- Desktop (`apps/desktop`) loads the web bundle from the server, so no change; verify the CSP in
  `apps/desktop/src/main/window.ts` allows `img-src 'self'` if it sets one.

### Docs

- `docs/agent-model.md`: §5 `inbox/` comment → "attachments humans send it, one folder per
  message"; §9 tool table: `taut_send(to, text, refs?, attachments?)`, `taut_done(..., attachments?)`;
  §12 add the `attachments` table.
- `docs/CHANGELOG.md`: a new section at the end **"Attachments (images + files in chat)"** — what
  works, how to try it (composer, DM an agent a screenshot and ask what it shows, ask an agent to
  send a file back), known gaps (D6/D9 TODOs, no thumbnails). Update the "Status for the morning"
  block: one line in "Click first" and remove nothing else.

## Verification the final agent runs

1. `pnpm typecheck` and `pnpm test` green across the workspace.
2. `pnpm e2e` extended in `scripts/e2e.sh` with two steps: (a) upload a 1×1 PNG to the DM with
   bruno, send it with the text "reply with the pixel color of the attached image, nothing else"
   and assert the reply is non-empty and the file exists at `<home>/inbox/<messageId>/pixel.png`;
   (b) DM bruno "create `work/hello.txt` containing `hi` and send it to me with taut_send
   attachments, then reply done" and assert a message in that DM has an attachment named
   `hello.txt` whose `content` endpoint returns `hi`.
3. Report: what is verified (test names), what is not, and any deviation from D1–D9.
