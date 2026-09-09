import { FileSystem, type Multipart, Path } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { SqlClient } from '@effect/sql'
import type { CurrentUserShape } from '@taut/contract/api'
import { type Attachment, AuthorKind, type Message } from '@taut/contract/domain'
import { Forbidden, NotFound, type Unauthorized, Validation } from '@taut/contract/errors'
import {
  type AgentId,
  AttachmentId,
  ChannelId,
  CompanyId,
  MemberId,
  MessageId,
  newAttachmentId
} from '@taut/contract/ids'
import { DateTime, type Duration, Effect, Option, Schema } from 'effect'
import { AppConfig } from '../config.js'
import { findAll, findOne, nowIso, run } from '../db/sql.js'
import { AttachmentRow, toAttachment } from '../domain/rows.js'
import { type Actor, actor } from './access.js'
import { Channels } from './channels.js'

/** Per message (docs/build-plan-attachments.md D4/D6); the contract caps `attachmentIds` the same way. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10

const ATTACHMENT_COLUMNS =
  'id, company_id, channel_id, message_id, uploader_kind, uploader_id, name, mime_type, size, created_at'

/** Who owns an orphan: the human who uploaded it or the agent that sent it. */
export interface Uploader {
  readonly kind: AuthorKind
  readonly id: MemberId
}

/** A file an agent asked to send, already resolved to a regular file inside its home. */
export interface HostFile {
  readonly hostPath: string
  readonly name: string
}

/** One copy of an attachment inside an agent home (D3). */
export interface Materialised {
  readonly name: string
  readonly mimeType: string
  readonly size: number
  /** `inbox/<messageId>/<name>`, POSIX separators — join it to the machine home. */
  readonly relPath: string
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  js: 'text/javascript',
  ts: 'text/plain',
  py: 'text/x-python',
  sh: 'application/x-sh',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

const OCTET_STREAM = 'application/octet-stream'
const SANE_MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i

/**
 * D6: the client's declared type when it is a sane `type/subtype`, else by extension, else
 * `application/octet-stream`. A declared `application/octet-stream` counts as "not declared"
 * (browsers send it for anything they do not recognise), so a `.csv` still becomes `text/csv`.
 */
export const resolveMimeType = (declared: string | undefined, name: string): string => {
  const bare = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (bare !== '' && bare !== OCTET_STREAM && SANE_MIME.test(bare)) return bare
  const dot = name.lastIndexOf('.')
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
  return MIME_BY_EXTENSION[ext] ?? OCTET_STREAM
}

/** D5 allow-list: rendered in the app origin; everything else (SVG included) downloads. */
export const isInlineMimeType = (mimeType: string): boolean =>
  mimeType === 'image/png' ||
  mimeType === 'image/jpeg' ||
  mimeType === 'image/gif' ||
  mimeType === 'image/webp' ||
  mimeType === 'application/pdf' ||
  mimeType === 'text/plain' ||
  mimeType === 'video/mp4' ||
  mimeType.startsWith('audio/')

/** `inline; filename="…"; filename*=UTF-8''…` — ASCII fallback plus the RFC 5987 form. */
export const contentDisposition = (kind: 'inline' | 'attachment', name: string): string => {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** `120 KB`, `1.5 MB` — for the prompt line an agent reads. */
export const humanSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const MAX_NAME_LENGTH = 255

/**
 * Browsers (and undici) percent-encode exactly `"`, CR and LF in a multipart `filename`
 * (HTML spec, "multipart/form-data encoding algorithm"); everything else, UTF-8 included, is
 * sent raw. Undo those three so `report "final".pdf` keeps its name.
 */
const multipartFileName = (raw: string): string =>
  raw
    .replace(/%22/g, '"')
    .replace(/%0[Dd]/g, '')
    .replace(/%0[Aa]/g, '')

/** C0 controls and DEL: never part of a file name a human typed. */
const hasControlChars = (name: string): boolean =>
  [...name].some((ch) => {
    const code = ch.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })

/** A bare file name: no separators, no `.`/`..`, no control characters, ≤ 255 chars. */
const validateName = (raw: string): Effect.Effect<string, Validation> => {
  const name = raw.trim()
  const bad = (message: string) => new Validation({ issues: [{ path: ['file'], message }] })
  if (name === '' || name === '.' || name === '..') return bad('file name is empty')
  if (name.length > MAX_NAME_LENGTH) return bad(`file name is longer than ${MAX_NAME_LENGTH}`)
  if (name.includes('/') || name.includes('\\') || hasControlChars(name))
    return bad('file name must be a bare name without path separators')
  return Effect.succeed(name)
}

/**
 * Chat attachments: the `attachments` table plus the company blob store at
 * `<dataDir>/companies/<slug>/attachments/<id>` (docs/build-plan-attachments.md).
 *
 * Authorization mirrors messages (D8): upload needs post rights on the channel, linking needs
 * the caller's own orphans in that channel, reading needs view rights on the channel.
 * Infrastructure failures (disk, SQL) are defects; only domain errors surface.
 */
export class Attachments extends Effect.Service<Attachments>()('Attachments', {
  effect: Effect.gen(function* () {
    const config = yield* AppConfig
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const sql = yield* SqlClient.SqlClient
    const channels = yield* Channels

    const io = <A>(effect: Effect.Effect<A, PlatformError>): Effect.Effect<A> =>
      Effect.orDie(effect)

    // ── queries ──────────────────────────────────────────────────────────────

    const slugOf = findOne({
      Request: CompanyId,
      Result: Schema.Struct({ slug: Schema.String }),
      execute: (id) => sql`SELECT slug FROM companies WHERE id = ${id}`
    })

    const byId = findOne({
      Request: Schema.Struct({ companyId: CompanyId, attachmentId: AttachmentId }),
      Result: AttachmentRow,
      execute: (r) => sql`
        SELECT ${sql.literal(ATTACHMENT_COLUMNS)} FROM attachments
        WHERE company_id = ${r.companyId} AND id = ${r.attachmentId}`
    })

    const byIds = findAll({
      Request: Schema.Struct({ companyId: CompanyId, ids: Schema.Array(AttachmentId) }),
      Result: AttachmentRow,
      execute: (r) => sql`
        SELECT ${sql.literal(ATTACHMENT_COLUMNS)} FROM attachments
        WHERE company_id = ${r.companyId} AND ${sql.in('id', r.ids)}`
    })

    const byMessages = findAll({
      Request: Schema.Struct({ companyId: CompanyId, ids: Schema.Array(MessageId) }),
      Result: AttachmentRow,
      execute: (r) => sql`
        SELECT ${sql.literal(ATTACHMENT_COLUMNS)} FROM attachments
        WHERE company_id = ${r.companyId} AND ${sql.in('message_id', r.ids)}
        ORDER BY created_at ASC, rowid ASC`
    })

    /** The message's own files plus its replies' — a deleted root cascades its thread. */
    const ofMessageAndReplies = findAll({
      Request: Schema.Struct({ companyId: CompanyId, messageId: MessageId }),
      Result: AttachmentRow,
      execute: (r) => sql`
        SELECT ${sql.literal(ATTACHMENT_COLUMNS)} FROM attachments
        WHERE company_id = ${r.companyId}
          AND (message_id = ${r.messageId}
               OR message_id IN (SELECT id FROM messages WHERE thread_id = ${r.messageId}))
        ORDER BY created_at ASC, rowid ASC`
    })

    /** Every file of one channel, sent or still orphaned — used when the channel itself goes. */
    const ofChannel = findAll({
      Request: Schema.Struct({ companyId: CompanyId, channelId: ChannelId }),
      Result: AttachmentRow,
      execute: (r) => sql`
        SELECT ${sql.literal(ATTACHMENT_COLUMNS)} FROM attachments
        WHERE company_id = ${r.companyId} AND channel_id = ${r.channelId}
        ORDER BY created_at ASC, rowid ASC`
    })

    const allCompanies = findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ id: CompanyId, slug: Schema.String }),
      execute: () => sql`SELECT id, slug FROM companies`
    })

    const idsOfCompany = findAll({
      Request: CompanyId,
      Result: Schema.Struct({ id: AttachmentId }),
      execute: (companyId) => sql`SELECT id FROM attachments WHERE company_id = ${companyId}`
    })

    const orphansBefore = findAll({
      Request: Schema.String,
      Result: AttachmentRow,
      execute: (before) => sql`
        SELECT ${sql.literal(ATTACHMENT_COLUMNS)} FROM attachments
        WHERE message_id IS NULL AND created_at < ${before}`
    })

    const insert = run({
      Request: Schema.Struct({
        id: AttachmentId,
        companyId: CompanyId,
        channelId: ChannelId,
        uploaderKind: AuthorKind,
        uploaderId: MemberId,
        name: Schema.String,
        mimeType: Schema.String,
        size: Schema.Number,
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO attachments (id, company_id, channel_id, message_id, uploader_kind, uploader_id, name, mime_type, size, created_at)
        VALUES (${r.id}, ${r.companyId}, ${r.channelId}, NULL, ${r.uploaderKind}, ${r.uploaderId}, ${r.name}, ${r.mimeType}, ${r.size}, ${r.createdAt})`
    })

    /** Only ever moves an orphan onto a message; a linked row is never re-pointed. */
    const setMessage = run({
      Request: Schema.Struct({
        companyId: CompanyId,
        attachmentId: AttachmentId,
        messageId: MessageId
      }),
      execute: (r) => sql`
        UPDATE attachments SET message_id = ${r.messageId}
        WHERE company_id = ${r.companyId} AND id = ${r.attachmentId} AND message_id IS NULL`
    })

    const remove = run({
      Request: Schema.Struct({ companyId: CompanyId, attachmentId: AttachmentId }),
      execute: (r) =>
        sql`DELETE FROM attachments WHERE company_id = ${r.companyId} AND id = ${r.attachmentId}`
    })

    // ── blob store ───────────────────────────────────────────────────────────

    /** `<dataDir>/companies/<slug>/attachments`; created on first use. The company must exist. */
    const storeDir = (companyId: CompanyId): Effect.Effect<string> =>
      slugOf(companyId).pipe(
        Effect.flatMap(Effect.orDie),
        Effect.map(({ slug }) => path.join(config.dataDir, 'companies', slug, 'attachments'))
      )

    const blobPath = (companyId: CompanyId, id: AttachmentId): Effect.Effect<string> =>
      storeDir(companyId).pipe(Effect.map((dir) => path.join(dir, id)))

    /** Copy `sourcePath` into the store and insert the orphan row. */
    const store = (input: {
      readonly companyId: CompanyId
      readonly channelId: ChannelId
      readonly uploader: Uploader
      readonly sourcePath: string
      readonly name: string
      readonly declaredType: string | undefined
    }): Effect.Effect<Attachment, Validation> =>
      Effect.gen(function* () {
        const name = yield* validateName(input.name)
        const info = yield* io(fs.stat(input.sourcePath))
        if (info.type !== 'File') {
          return yield* new Validation({
            issues: [{ path: ['file'], message: `"${name}" is not a regular file` }]
          })
        }
        const size = Number(info.size)
        if (size > config.attachmentMaxBytes) {
          return yield* new Validation({
            issues: [
              {
                path: ['file'],
                message: `"${name}" is ${humanSize(size)}; the limit is ${humanSize(config.attachmentMaxBytes)} (TAUT_ATTACHMENT_MAX_BYTES)`
              }
            ]
          })
        }
        const id = newAttachmentId()
        const dir = yield* storeDir(input.companyId)
        yield* io(fs.makeDirectory(dir, { recursive: true }))
        yield* io(fs.copyFile(input.sourcePath, path.join(dir, id)))
        yield* insert({
          id,
          companyId: input.companyId,
          channelId: input.channelId,
          uploaderKind: input.uploader.kind,
          uploaderId: input.uploader.id,
          name,
          mimeType: resolveMimeType(input.declaredType, name),
          size,
          createdAt: nowIso()
        })
        const row = yield* byId({ companyId: input.companyId, attachmentId: id }).pipe(
          Effect.flatMap(Effect.orDie)
        )
        return toAttachment(row)
      })

    /** Row + file, best effort on the file (a missing blob is not an error). */
    const purge = (row: AttachmentRow): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* remove({ companyId: row.company_id, attachmentId: row.id })
        const file = yield* blobPath(row.company_id, row.id)
        yield* fs
          .remove(file, { force: true })
          .pipe(
            Effect.catchAll((e) =>
              Effect.logWarning(`attachments: cannot remove ${file}: ${e.message}`)
            )
          )
      })

    // ── authorization ────────────────────────────────────────────────────────

    const load = (who: Actor, attachmentId: AttachmentId) =>
      byId({ companyId: who.companyId, attachmentId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ entity: 'Attachment', id: attachmentId })),
            onSome: Effect.succeed
          })
        )
      )

    /** D8: reading an attachment = viewing its channel (`channels.load` + `requireView`). */
    const loadViewable = (
      who: Actor,
      attachmentId: AttachmentId
    ): Effect.Effect<AttachmentRow, NotFound | Forbidden> =>
      Effect.gen(function* () {
        const row = yield* load(who, attachmentId)
        const channel = yield* channels.load(who, row.channel_id)
        yield* channels.requireView(who, channel)
        return row
      })

    // ── endpoints ────────────────────────────────────────────────────────────

    /** `POST /api/attachments`: an orphan owned by the uploader until a message links it (D2). */
    const upload = (
      me: CurrentUserShape,
      channelId: ChannelId,
      file: Multipart.PersistedFile
    ): Effect.Effect<Attachment, Unauthorized | NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const channel = yield* channels.load(who, channelId)
        yield* channels.requirePost(who, channel)
        return yield* store({
          companyId: who.companyId,
          channelId: channel.id,
          uploader: { kind: 'user', id: who.userId },
          sourcePath: file.path,
          name: path.basename(multipartFileName(file.name)),
          declaredType: file.contentType
        })
      })

    const get = (
      me: CurrentUserShape,
      attachmentId: AttachmentId
    ): Effect.Effect<Attachment, Unauthorized | NotFound | Forbidden> =>
      actor(me).pipe(
        Effect.flatMap((who) => loadViewable(who, attachmentId)),
        Effect.map(toAttachment)
      )

    /** The blob to stream for `GET /api/attachments/:id/content`; a missing file is `NotFound`. */
    const openContent = (
      me: CurrentUserShape,
      attachmentId: AttachmentId
    ): Effect.Effect<
      { readonly path: string; readonly attachment: Attachment },
      Unauthorized | NotFound | Forbidden
    > =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* loadViewable(who, attachmentId)
        const file = yield* blobPath(who.companyId, row.id)
        if (!(yield* io(fs.exists(file)))) {
          return yield* new NotFound({ entity: 'Attachment', id: attachmentId })
        }
        return { path: file, attachment: toAttachment(row) }
      })

    // ── server-internal ──────────────────────────────────────────────────────

    /** One query per page: every attachment of `ids`, grouped by message, upload order. */
    const listForMessages = (
      companyId: CompanyId,
      ids: ReadonlyArray<MessageId>
    ): Effect.Effect<Map<MessageId, Array<Attachment>>> =>
      Effect.gen(function* () {
        const out = new Map<MessageId, Array<Attachment>>()
        if (ids.length === 0) return out
        const rows = yield* byMessages({ companyId, ids })
        for (const row of rows) {
          if (row.message_id === null) continue
          const list = out.get(row.message_id) ?? []
          list.push(toAttachment(row))
          out.set(row.message_id, list)
        }
        return out
      })

    /**
     * Point `ids` at `messageId`, inside the caller's message transaction. `Forbidden` unless
     * every id is an orphan uploaded by `uploader` in `channelId` (D8); a rolled-back
     * transaction leaves them orphans.
     */
    const link = (
      companyId: CompanyId,
      uploader: Uploader,
      channelId: ChannelId,
      messageId: MessageId,
      ids: ReadonlyArray<AttachmentId>
    ): Effect.Effect<void, Forbidden> =>
      Effect.gen(function* () {
        const wanted = [...new Set(ids)]
        if (wanted.length === 0) return
        if (wanted.length > MAX_ATTACHMENTS_PER_MESSAGE) {
          return yield* new Forbidden({
            message: `At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`
          })
        }
        const rows = yield* byIds({ companyId, ids: wanted })
        const found = new Map(rows.map((r) => [r.id, r] as const))
        for (const id of wanted) {
          const row = found.get(id)
          if (
            row === undefined ||
            row.message_id !== null ||
            row.channel_id !== channelId ||
            row.uploader_kind !== uploader.kind ||
            row.uploader_id !== uploader.id
          ) {
            return yield* new Forbidden({
              message: `Attachment ${id} is not an unsent upload of yours in this channel`
            })
          }
        }
        yield* Effect.forEach(
          wanted,
          (attachmentId) => setMessage({ companyId, attachmentId, messageId }),
          {
            discard: true
          }
        )
      })

    /**
     * An agent-sent file (D4): the bytes are copied from `hostPath` (already resolved to a
     * regular file inside the agent home by the caller) into the store as an orphan owned by
     * the agent; `link` attaches it to the posted message.
     */
    const storeFromHost = (
      companyId: CompanyId,
      channelId: ChannelId,
      agentId: AgentId,
      hostPath: string,
      name: string
    ): Effect.Effect<Attachment, Validation> =>
      store({
        companyId,
        channelId,
        uploader: { kind: 'agent', id: agentId },
        sourcePath: hostPath,
        name,
        declaredType: undefined
      })

    /**
     * D7: rows + files of one message and, when it is a thread root, of its replies (the
     * `messages.thread_id` FK cascades those rows). Call before the message row goes — the FK
     * would cascade the rows, not the files.
     */
    const deleteForMessage = (companyId: CompanyId, messageId: MessageId): Effect.Effect<number> =>
      ofMessageAndReplies({ companyId, messageId }).pipe(
        Effect.tap((rows) => Effect.forEach(rows, purge, { discard: true })),
        Effect.map((rows) => rows.length)
      )

    /**
     * Every file of a channel that is about to be deleted. Same reason as `deleteForMessage`:
     * the FK cascades the rows, not the bytes. Returns how many files went.
     */
    const deleteForChannel = (companyId: CompanyId, channelId: ChannelId): Effect.Effect<number> =>
      ofChannel({ companyId, channelId }).pipe(
        Effect.tap((rows) => Effect.forEach(rows, purge, { discard: true })),
        Effect.map((rows) => rows.length)
      )

    /** D7: uploads never sent, older than `olderThan`. Returns how many went. */
    const sweepOrphans = (olderThan: Duration.Duration): Effect.Effect<number> =>
      Effect.gen(function* () {
        const before = DateTime.formatIso(DateTime.subtractDuration(yield* DateTime.now, olderThan))
        const rows = yield* orphansBefore(before)
        yield* Effect.forEach(rows, purge, { discard: true })
        return rows.length
      })

    /**
     * Bytes with no row. A deleted channel or message cascades the rows and leaves the files
     * unless the caller removed them first, so anything that ever missed a `purge` collects
     * here. `olderThan` spares an upload caught mid-`store`, where the file lands a moment
     * before its row exists. Returns how many files went.
     */
    const sweepBlobs = (olderThan: Duration.Duration): Effect.Effect<number> =>
      Effect.gen(function* () {
        const cutoff = DateTime.subtractDuration(yield* DateTime.now, olderThan)
        let removed = 0
        for (const company of yield* allCompanies()) {
          const dir = path.join(config.dataDir, 'companies', company.slug, 'attachments')
          if (!(yield* io(fs.exists(dir)))) continue
          const known = new Set<string>((yield* idsOfCompany(company.id)).map((r) => r.id))
          for (const name of yield* io(fs.readDirectory(dir))) {
            if (known.has(name)) continue
            const file = path.join(dir, name)
            const info = yield* io(fs.stat(file))
            if (info.type !== 'File') continue
            const mtime = Option.map(info.mtime, DateTime.unsafeFromDate)
            if (Option.isSome(mtime) && DateTime.greaterThan(mtime.value, cutoff)) continue
            yield* fs.remove(file, { force: true }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  removed += 1
                })
              ),
              Effect.catchAll((e) =>
                Effect.logWarning(`attachments: cannot remove ${file}: ${e.message}`)
              )
            )
          }
        }
        return removed
      })

    /**
     * D3: copy every attachment of `message` to `<hostHome>/inbox/<messageId>/<name>` — the
     * machine sees the same directory. Idempotent (a copy of the right size is kept). Best
     * effort per file: a copy that fails is logged and left out of the result.
     */
    const materialise = (
      companyId: CompanyId,
      message: Message,
      hostHome: string
    ): Effect.Effect<ReadonlyArray<Materialised>> =>
      Effect.gen(function* () {
        if (message.attachments.length === 0) return []
        const dir = path.join(hostHome, 'inbox', message.id)
        const out: Array<Materialised> = []
        for (const a of message.attachments) {
          const target = path.join(dir, a.name)
          const copied = yield* Effect.gen(function* () {
            const existing = yield* fs.stat(target).pipe(Effect.option)
            if (Option.isSome(existing) && Number(existing.value.size) === a.size) return true
            yield* fs.makeDirectory(dir, { recursive: true })
            yield* fs.copyFile(yield* blobPath(companyId, a.id), target)
            return true
          }).pipe(
            Effect.catchAll((e) =>
              Effect.logWarning(
                `attachments: cannot materialise ${a.id} as ${target}: ${e.message}`
              ).pipe(Effect.as(false))
            )
          )
          if (copied) {
            out.push({
              name: a.name,
              mimeType: a.mimeType,
              size: a.size,
              relPath: `inbox/${message.id}/${a.name}`
            })
          }
        }
        return out
      })

    return {
      upload,
      get,
      openContent,
      listForMessages,
      link,
      storeFromHost,
      deleteForMessage,
      deleteForChannel,
      sweepOrphans,
      sweepBlobs,
      materialise
    } as const
  })
}) {}
