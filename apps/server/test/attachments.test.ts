/**
 * Attachments (docs/build-plan-attachments.md), end to end: human upload → send → list/thread
 * carry them → bytes + D5 headers → D8 authorization → D7 lifecycle → the agent side against
 * the fake machine provider (materialisation into `inbox/<messageId>/`, `taut_send` /
 * `taut_done` with paths inside the home, the prompt line).
 */
import { HttpClient, HttpClientRequest } from '@effect/platform'
import { NodeHttpClient } from '@effect/platform-node'
import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import { Attachment, Message } from '@taut/contract/domain'
import type { Agent, Channel, Company, Task } from '@taut/contract/domain'
import type { AgentId, AttachmentId, MessageId, UserId } from '@taut/contract/ids'
import { DateTime, Duration, Effect, Option, Redacted } from 'effect'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it as plainIt } from 'vitest'
import { attachmentsSuffix, renderPrompt, tautSection } from '../src/agents/prompt.js'
import { Scheduler } from '../src/agents/scheduler.js'
import {
  Attachments,
  contentDisposition,
  humanSize,
  isInlineMimeType,
  resolveMimeType
} from '../src/services/attachments.js'
import { agentHomePath } from '../src/services/homes.js'
import { Messages } from '../src/services/messages.js'
import { baseUrl, makeClient, type TestClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const fake = makeFakeRuntime()
const avatar = { kind: 'emoji', value: 'A' } as const
const GOOD_SECRET = 'sk-ant-api03-good-seat-000000000000000000'
/** Small on purpose: the "too large" case needs a file the test can afford to build. */
const MAX_BYTES = 4096

/** 1×1 red PNG (69 bytes), the same one `scripts/e2e.sh` sends. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
)

const state: {
  owner?: TestClient
  dana?: TestClient
  eve?: TestClient
  ownerId?: UserId
  danaId?: UserId
  acme?: Company
  general?: Channel
  dm?: Channel
  bruno?: Agent
  home?: string
  /** The message the first test sends with two files. */
  sent?: Message
  pixelId?: AttachmentId
  notesId?: AttachmentId
  /** Dana's orphan in #general (never sent; the sweep test removes it). */
  danaOrphanId?: AttachmentId
  token?: string
  trigger?: Message
  task?: Task
} = {}

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

/** Raw multipart upload, the way the composer does it (the typed client has no FormData). */
const upload = (
  client: TestClient,
  channelId: string,
  file: { readonly name: string; readonly type: string; readonly bytes: Uint8Array | string }
) =>
  Effect.gen(function* () {
    const { http } = yield* baseUrl
    const form = new FormData()
    form.append('channelId', channelId)
    form.append('file', new Blob([file.bytes], { type: file.type }), file.name)
    const cookie = yield* client.cookieHeader
    const response = yield* Effect.promise(() =>
      fetch(`${http}/api/attachments`, { method: 'POST', headers: { cookie }, body: form })
    )
    const text = yield* Effect.promise(() => response.text())
    // Typed as the success shape: every caller checks `status` before reading fields.
    return { status: response.status, json: (text === '' ? {} : JSON.parse(text)) as Attachment }
  })

/** `GET /api/attachments/:id/content` with (or without) a session cookie. */
const content = (client: TestClient | undefined, id: string, query = '') =>
  Effect.gen(function* () {
    const { http } = yield* baseUrl
    const cookie = client === undefined ? undefined : yield* client.cookieHeader
    const response = yield* Effect.promise(() =>
      fetch(`${http}/api/attachments/${id}/content${query}`, {
        headers: cookie === undefined ? {} : { cookie }
      })
    )
    const bytes = Buffer.from(yield* Effect.promise(() => response.arrayBuffer()))
    return { status: response.status, headers: response.headers, bytes }
  })

/** Raw call to `/api/agent-runtime/*` with a bearer token. */
const runtimeCall = (token: string, method: 'GET' | 'POST', path: string, body?: unknown) =>
  Effect.gen(function* () {
    const { http } = yield* baseUrl
    const client = yield* HttpClient.HttpClient
    const url = `${http}/api/agent-runtime${path}`
    const request =
      method === 'GET'
        ? HttpClientRequest.get(url)
        : yield* HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJson(body ?? {}))
    const response = yield* client.execute(
      request.pipe(HttpClientRequest.setHeader('authorization', `Bearer ${token}`))
    )
    const json = (yield* response.json) as Record<string, unknown>
    return { status: response.status, json }
  }).pipe(Effect.scoped, Effect.provide(NodeHttpClient.layer))

const errorCode = (json: Record<string, unknown>) => (json['error'] as { code: string }).code
const errorMessage = (json: Record<string, unknown>) =>
  (json['error'] as { message: string }).message

/** Poll `probe` until it returns `Some`, or fail after `timeoutMs`. */
const waitFor = <A, E, R>(
  what: string,
  probe: Effect.Effect<Option.Option<A>, E, R>,
  timeoutMs = 10_000
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = yield* probe
      if (Option.isSome(found)) return found.value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      yield* Effect.sleep(Duration.millis(50))
    }
  })

const taskFor = (agentId: AgentId, triggerId: MessageId) =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler
    const acme = need(state.acme, 'acme')
    return yield* scheduler.taskOf(acme.id, agentId, triggerId)
  })

const blobPath = (id: string) => join(dir, 'companies', 'acme', 'attachments', id)

describe('attachments (upload → send → serve → agent inbox/send/done)', () => {
  layer(testAppWith(dir, fake.layer, { TAUT_ATTACHMENT_MAX_BYTES: String(MAX_BYTES) }), {
    excludeTestServices: true
  })((it) => {
    it.effect('setup: owner, dana (member of #general), eve (not), bruno with a seat, a DM', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        const acme = yield* owner.api.companies.create({
          payload: { slug: 'acme', name: 'Acme', avatar }
        })
        const me = yield* owner.api.auth.me()
        const accept = (email: string, name: string) =>
          Effect.gen(function* () {
            const invite = yield* owner.api.invites.create({ payload: { email, role: 'member' } })
            const client = yield* makeClient
            const accepted = yield* client.api.invites.accept({
              payload: { token: invite.token, name, password: 'password123' }
            })
            return { client, id: accepted.user.id }
          })
        const dana = yield* accept('dana@taut.local', 'Dana')
        const eve = yield* accept('eve@taut.local', 'Eve')
        const engineering = yield* owner.api.departments.create({
          payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
        })
        const general = yield* owner.api.channels.create({
          payload: { name: 'general', departmentId: engineering.id }
        })
        yield* owner.api.channels.addMember({
          path: { channelId: general.id },
          payload: { memberKind: 'user', memberId: dana.id }
        })

        const good = yield* owner.api.vault.add({
          payload: { kind: 'anthropic.api_key', label: 'good', secret: Redacted.make(GOOD_SECRET) }
        })
        const seat = yield* owner.api.subscriptions.add({
          payload: { runtime: 'claude-code', label: 'Good seat', credentialId: good.id }
        })
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE subscriptions SET status = 'ok' WHERE id = ${seat.id}`

        const bruno = yield* owner.api.agents.create({
          payload: {
            handle: 'bruno',
            name: 'Bruno',
            avatar,
            role: 'Backend engineer',
            mandate: '# Mandate\n\nAnswer briefly.',
            runtimeKind: 'claude-code',
            permissionMode: 'plan',
            departmentId: engineering.id
          }
        })
        const dm = yield* owner.api.channels.dm({
          payload: { memberKind: 'agent', memberId: bruno.id }
        })
        Object.assign(state, {
          owner,
          dana: dana.client,
          eve: eve.client,
          ownerId: me.user.id,
          danaId: dana.id,
          acme,
          general,
          dm,
          bruno,
          home: agentHomePath(dir, 'acme', 'bruno')
        })
      })
    )

    it.effect('upload → create with ids → list and thread carry attachments', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const general = need(state.general, 'general')

        const pixel = yield* upload(owner, general.id, {
          name: 'pixel.png',
          type: 'image/png',
          bytes: PIXEL
        })
        expect(pixel.status).toBe(201)
        expect(pixel.json).toMatchObject({
          channelId: general.id,
          uploaderKind: 'user',
          uploaderId: state.ownerId,
          name: 'pixel.png',
          mimeType: 'image/png',
          size: PIXEL.length
        })
        expect(pixel.json.messageId).toBeUndefined()
        expect(existsSync(blobPath(pixel.json.id))).toBe(true)

        // D6: a browser's `application/octet-stream` is "undeclared" — the extension decides.
        const notes = yield* upload(owner, general.id, {
          name: 'notes.csv',
          type: 'application/octet-stream',
          bytes: 'a,b\n1,2\n'
        })
        expect(notes.status).toBe(201)
        expect(notes.json.mimeType).toBe('text/csv')

        // The orphan is visible to its uploader before it is sent.
        const orphan = yield* owner.api.attachments.get({ path: { attachmentId: pixel.json.id } })
        expect(orphan.messageId).toBeUndefined()

        // D2: no text, two files.
        const sent = yield* owner.api.messages.create({
          payload: {
            channelId: general.id,
            body: '',
            attachmentIds: [pixel.json.id, notes.json.id]
          }
        })
        expect(sent.body).toBe('')
        expect(sent.attachments.map((a) => a.id)).toEqual([pixel.json.id, notes.json.id])
        expect(sent.attachments.every((a) => a.messageId === sent.id)).toBe(true)

        const page = yield* owner.api.messages.list({ urlParams: { channelId: general.id } })
        const listed = need(
          page.items.find((m) => m.id === sent.id),
          'sent message in list'
        )
        expect(listed.attachments.map((a) => a.name)).toEqual(['pixel.png', 'notes.csv'])
        expect(
          page.items.filter((m) => m.id !== sent.id).every((m) => m.attachments.length === 0)
        ).toBe(true)

        // The realtime payload the web renders from carries them too.
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ payload_json: string }>`
          SELECT payload_json FROM events WHERE type = 'message.created' ORDER BY seq DESC LIMIT 1`
        const payload = JSON.parse(need(rows[0], 'event').payload_json) as {
          message: { id: string; attachments: Array<{ name: string }> }
        }
        expect(payload.message.id).toBe(sent.id)
        expect(payload.message.attachments.map((a) => a.name)).toEqual(['pixel.png', 'notes.csv'])

        // A reply with a file: `thread` hydrates as well.
        const inThread = yield* upload(owner, general.id, {
          name: 'reply.txt',
          type: 'text/plain',
          bytes: 'see attached'
        })
        const reply = yield* owner.api.messages.create({
          payload: {
            channelId: general.id,
            threadId: sent.id,
            body: 'in thread',
            attachmentIds: [inThread.json.id]
          }
        })
        const thread = yield* owner.api.messages.thread({
          path: { threadId: sent.id },
          urlParams: {}
        })
        expect(thread.items.map((m) => m.id)).toEqual([reply.id])
        expect(need(thread.items[0], 'reply').attachments.map((a) => a.name)).toEqual(['reply.txt'])

        // Linked: the id now answers with its message.
        const linked = yield* owner.api.attachments.get({ path: { attachmentId: pixel.json.id } })
        expect(linked.messageId).toBe(sent.id)

        state.sent = sent
        state.pixelId = pixel.json.id
        state.notesId = notes.json.id
      })
    )

    it.effect(
      'content: bytes round-trip with the D5 headers; ?download=1 and non-inline types',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const general = need(state.general, 'general')
          const pixelId = need(state.pixelId, 'pixelId')

          const png = yield* content(owner, pixelId)
          expect(png.status).toBe(200)
          expect(Buffer.compare(png.bytes, PIXEL)).toBe(0)
          expect(png.headers.get('content-type')).toBe('image/png')
          expect(png.headers.get('content-disposition')).toBe(
            `inline; filename="pixel.png"; filename*=UTF-8''pixel.png`
          )
          expect(png.headers.get('x-content-type-options')).toBe('nosniff')
          expect(png.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
          expect(png.headers.get('content-length')).toBe(String(PIXEL.length))

          const forced = yield* content(owner, pixelId, '?download=true')
          expect(forced.status).toBe(200)
          expect(forced.headers.get('content-disposition')).toMatch(/^attachment; /)

          // The allow-list: text/csv is not on it, so it downloads even without ?download.
          const csv = yield* content(owner, need(state.notesId, 'notesId'))
          expect(csv.headers.get('content-type')).toBe('text/csv')
          expect(csv.headers.get('content-disposition')).toMatch(/^attachment; /)

          // SVG is explicitly excluded (it would execute in the app origin).
          const svg = yield* upload(owner, general.id, {
            name: 'logo.svg',
            type: 'image/svg+xml',
            bytes: '<svg xmlns="http://www.w3.org/2000/svg"/>'
          })
          expect(svg.status).toBe(201)
          const served = yield* content(owner, svg.json.id)
          expect(served.headers.get('content-type')).toBe('image/svg+xml')
          expect(served.headers.get('content-disposition')).toMatch(/^attachment; /)

          // A name with a quote and non-ASCII: the ASCII fallback is sanitised, the UTF-8 form exact.
          const odd = yield* upload(owner, general.id, {
            name: 'résumé "final".txt',
            type: 'text/plain',
            bytes: 'x'
          })
          expect(odd.status).toBe(201)
          const oddServed = yield* content(owner, odd.json.id)
          expect(oddServed.headers.get('content-disposition')).toBe(
            `inline; filename="r_sum_ _final_.txt"; filename*=UTF-8''${encodeURIComponent('résumé "final".txt')}`
          )

          const anonymous = yield* content(undefined, pixelId)
          expect(anonymous.status).toBe(401)
          const missing = yield* content(owner, 'att_00000000-0000-4000-8000-000000000000')
          expect(missing.status).toBe(404)
        })
    )

    it.effect(
      "authorization (D8): non-member 403, another user's orphan cannot be linked, empty message 422",
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dana = need(state.dana, 'dana')
          const eve = need(state.eve, 'eve')
          const general = need(state.general, 'general')
          const dm = need(state.dm, 'dm')
          const pixelId = need(state.pixelId, 'pixelId')

          // Eve is in the company but not in #general: no metadata, no bytes, no upload.
          const denied = yield* Effect.flip(
            eve.api.attachments.get({ path: { attachmentId: pixelId } })
          )
          expect(denied._tag).toBe('Forbidden')
          expect((yield* content(eve, pixelId)).status).toBe(403)
          const eveUpload = yield* upload(eve, general.id, {
            name: 'x.txt',
            type: 'text/plain',
            bytes: 'x'
          })
          expect(eveUpload.status).toBe(403)
          // Dana is a member: she may read what was sent there.
          expect((yield* content(dana, pixelId)).status).toBe(200)

          // Dana's own orphan: the owner cannot send it.
          const danaOrphan = yield* upload(dana, general.id, {
            name: 'dana.txt',
            type: 'text/plain',
            bytes: 'mine'
          })
          expect(danaOrphan.status).toBe(201)
          const stolen = yield* Effect.flip(
            owner.api.messages.create({
              payload: {
                channelId: general.id,
                body: 'yours?',
                attachmentIds: [danaOrphan.json.id]
              }
            })
          )
          expect(stolen._tag).toBe('Forbidden')
          // …and the failed create left no message and the orphan untouched.
          const page = yield* owner.api.messages.list({ urlParams: { channelId: general.id } })
          expect(page.items.some((m) => m.body === 'yours?')).toBe(false)
          const still = yield* dana.api.attachments.get({
            path: { attachmentId: danaOrphan.json.id }
          })
          expect(still.messageId).toBeUndefined()

          // An id already linked cannot be linked again; an orphan of another channel neither.
          const twice = yield* Effect.flip(
            owner.api.messages.create({
              payload: { channelId: general.id, body: 'again', attachmentIds: [pixelId] }
            })
          )
          expect(twice._tag).toBe('Forbidden')
          const elsewhere = yield* upload(owner, dm.id, {
            name: 'dm.txt',
            type: 'text/plain',
            bytes: 'dm'
          })
          const crossChannel = yield* Effect.flip(
            owner.api.messages.create({
              payload: { channelId: general.id, body: 'moved', attachmentIds: [elsewhere.json.id] }
            })
          )
          expect(crossChannel._tag).toBe('Forbidden')

          // D2: neither text nor files is a 422, whitespace included.
          for (const body of ['', '   \n']) {
            const empty = yield* Effect.flip(
              owner.api.messages.create({ payload: { channelId: general.id, body } })
            )
            expect(empty._tag, JSON.stringify(body)).toBe('Validation')
          }

          // D6: over the per-file limit.
          const big = yield* upload(owner, general.id, {
            name: 'big.bin',
            type: 'application/octet-stream',
            bytes: new Uint8Array(MAX_BYTES + 1)
          })
          expect(big.status).toBeGreaterThanOrEqual(400)
          expect(big.status).toBeLessThan(500)
          // Far over the limit (past the 4 KiB multipart headroom too): refused by the declared
          // Content-Length before parsing. With the parser's own cap this request hung forever.
          const wayOver = yield* upload(owner, general.id, {
            name: 'huge.bin',
            type: 'application/octet-stream',
            bytes: new Uint8Array(MAX_BYTES + 3 * 4096)
          }).pipe(Effect.timeoutFail({ duration: '5 seconds', onTimeout: () => 'upload hung' }))
          expect(wayOver.status).toBe(422)
          expect((wayOver.json as unknown as { _tag?: string })._tag).toBe('Validation')
          const atLimit = yield* upload(owner, general.id, {
            name: 'limit.bin',
            type: 'application/octet-stream',
            bytes: new Uint8Array(MAX_BYTES)
          })
          expect(atLimit.status).toBe(201)

          state.danaOrphanId = danaOrphan.json.id
        })
    )

    it.effect(
      'lifecycle (D7): deleting a message removes rows and files; the sweep removes old orphans',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const sent = need(state.sent, 'sent')
          const pixelId = need(state.pixelId, 'pixelId')
          const notesId = need(state.notesId, 'notesId')
          const danaOrphanId = need(state.danaOrphanId, 'danaOrphanId')

          // The thread reply (`reply.txt`) goes with its root: the FK cascades the row, the
          // service removes the blob.
          const thread = yield* owner.api.messages.thread({
            path: { threadId: sent.id },
            urlParams: {}
          })
          const replyFileId = need(need(thread.items[0], 'reply').attachments[0], 'reply.txt').id
          expect(existsSync(blobPath(replyFileId))).toBe(true)

          expect(existsSync(blobPath(pixelId))).toBe(true)
          yield* owner.api.messages.delete({ path: { messageId: sent.id } })
          expect(existsSync(blobPath(pixelId))).toBe(false)
          expect(existsSync(blobPath(notesId))).toBe(false)
          expect(existsSync(blobPath(replyFileId))).toBe(false)

          // A message that stays keeps its file through the sweep below.
          const general = need(state.general, 'general')
          const keptUpload = yield* upload(owner, general.id, {
            name: 'kept.txt',
            type: 'text/plain',
            bytes: 'kept'
          })
          const keptMessage = yield* owner.api.messages.create({
            payload: { channelId: general.id, body: 'kept', attachmentIds: [keptUpload.json.id] }
          })
          expect(keptMessage.attachments.length).toBe(1)
          const gone = yield* Effect.flip(
            owner.api.attachments.get({ path: { attachmentId: pixelId } })
          )
          expect(gone._tag).toBe('NotFound')
          expect((yield* content(owner, pixelId)).status).toBe(404)

          // The sweep: orphans older than the cut-off go, linked rows stay.
          const attachments = yield* Attachments
          expect(existsSync(blobPath(danaOrphanId))).toBe(true)
          const kept = yield* attachments.sweepOrphans(Duration.hours(24))
          expect(kept).toBe(0)
          expect(existsSync(blobPath(danaOrphanId))).toBe(true)
          const removed = yield* attachments.sweepOrphans(Duration.zero)
          expect(removed).toBeGreaterThanOrEqual(1)
          expect(existsSync(blobPath(danaOrphanId))).toBe(false)
          const sql = yield* SqlClient.SqlClient
          const orphans = yield* sql<{
            n: number
          }>`SELECT COUNT(*) AS n FROM attachments WHERE message_id IS NULL`
          expect(need(orphans[0], 'count').n).toBe(0)
          expect(existsSync(blobPath(keptUpload.json.id))).toBe(true)
          const survivor = yield* owner.api.attachments.get({
            path: { attachmentId: keptUpload.json.id }
          })
          expect(survivor.messageId).toBe(keptMessage.id)

          // Bytes left behind by a cascade: no row, so the blob sweep takes them. A file young
          // enough to be an upload still mid-`store` is spared, and rows keep their files.
          const stray = blobPath('att_00000000-0000-4000-8000-000000000000')
          writeFileSync(stray, 'left behind')
          expect(yield* attachments.sweepBlobs(Duration.hours(24))).toBe(0)
          expect(existsSync(stray)).toBe(true)
          expect(yield* attachments.sweepBlobs(Duration.zero)).toBe(1)
          expect(existsSync(stray)).toBe(false)
          expect(existsSync(blobPath(keptUpload.json.id))).toBe(true)
        })
    )

    it.effect(
      'agent (D3): a DM with a file is materialised into inbox/<messageId>/ and named in the prompt',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dm = need(state.dm, 'dm')
          const bruno = need(state.bruno, 'bruno')
          const home = need(state.home, 'home')

          const pixel = yield* upload(owner, dm.id, {
            name: 'pixel.png',
            type: 'image/png',
            bytes: PIXEL
          })
          const trigger = yield* owner.api.messages.create({
            payload: { channelId: dm.id, body: 'wait for release', attachmentIds: [pixel.json.id] }
          })
          const task = yield* waitFor(
            'task to run',
            taskFor(bruno.id, trigger.id).pipe(
              Effect.map(Option.filter((t) => t.status === 'running'))
            )
          )
          const exec = yield* waitFor(
            'the runtime to start',
            Effect.sync(() =>
              Option.fromNullable(
                fake.execs.find((e) => (e.stdin ?? '').includes('wait for release'))
              )
            )
          )

          // The bytes are on disk where the machine sees its home (== host home on `local`).
          const materialised = join(home, 'inbox', trigger.id, 'pixel.png')
          expect(existsSync(materialised)).toBe(true)
          expect(Buffer.compare(readFileSync(materialised), PIXEL)).toBe(0)

          // The runtime scopes itself to the work dir, so every home directory it has to read
          // is granted on the command line: `inbox/` for these bytes, `skills/` and `memory/`
          // for what CLAUDE.md imports.
          const addDirs = exec.cmd.slice(exec.cmd.indexOf('--add-dir') + 1)
          expect(addDirs.slice(0, 3)).toEqual([`${home}/inbox`, `${home}/skills`, `${home}/memory`])

          // The prompt names the machine path, type and size, in the documented shape.
          expect(exec.stdin).toContain(
            `[dm] @owner: wait for release [attachments: ${home}/inbox/${trigger.id}/pixel.png (image/png, 69 B)]`
          )
          const claudeMd = [...fake.files.entries()].find(([p]) =>
            p.endsWith(`/work/${task.threadId}/CLAUDE.md`)
          )
          expect(need(claudeMd, 'CLAUDE.md')[1]).toContain('inbox/<messageId>/')
          expect(need(claudeMd, 'CLAUDE.md')[1]).toContain('attachments: ["<path>"]')

          const mcp = need(fake.mcpConfigs().pop(), 'mcp config')
          expect(mcp.taskId).toBe(task.id)
          state.token = mcp.token
          state.trigger = trigger
          state.task = task
        })
    )

    it.effect('agent: taut_inbox lists the file with its machine path', () =>
      Effect.gen(function* () {
        const token = need(state.token, 'token')
        const trigger = need(state.trigger, 'trigger')
        const home = need(state.home, 'home')

        const inbox = yield* runtimeCall(token, 'GET', '/inbox?since=0')
        expect(inbox.status).toBe(200)
        const items = inbox.json['items'] as Array<{
          messageId: string
          text: string
          attachments?: Array<{ name: string; mimeType: string; size: number; path: string }>
        }>
        const item = need(
          items.find((i) => i.messageId === trigger.id),
          'trigger in inbox'
        )
        expect(item.attachments).toEqual([
          {
            name: 'pixel.png',
            mimeType: 'image/png',
            size: PIXEL.length,
            path: `${home}/inbox/${trigger.id}/pixel.png`
          }
        ])
        // Items without files carry no `attachments` key at all.
        expect(
          items.filter((i) => i.messageId !== trigger.id).every((i) => i.attachments === undefined)
        ).toBe(true)
      })
    )

    it.effect(
      'agent (D4): taut_send with a home-relative or machine-absolute path posts the file; outside → 422',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const token = need(state.token, 'token')
          const dm = need(state.dm, 'dm')
          const home = need(state.home, 'home')
          const acme = need(state.acme, 'acme')

          mkdirSync(join(home, 'work'), { recursive: true })
          writeFileSync(join(home, 'work', 'hello.txt'), 'hi')
          writeFileSync(join(dir, 'outside.txt'), 'not yours')

          const before = (yield* owner.api.messages.list({ urlParams: { channelId: dm.id } })).items
            .length

          const relative = yield* runtimeCall(token, 'POST', '/send', {
            to: '@owner',
            text: 'here is the file',
            attachments: ['work/hello.txt']
          })
          expect(relative.status).toBe(200)
          expect(relative.json['attachments']).toEqual([
            { id: expect.stringMatching(/^att_/), name: 'hello.txt' }
          ])
          const sentId = (relative.json['attachments'] as Array<{ id: string }>)[0]?.id ?? ''
          const served = yield* content(owner, sentId)
          expect(served.status).toBe(200)
          expect(served.bytes.toString('utf8')).toBe('hi')
          expect(served.headers.get('content-type')).toBe('text/plain')
          expect(served.headers.get('content-disposition')).toMatch(/^inline; filename="hello.txt"/)

          const messages = yield* Messages
          const posted = yield* messages
            .byId(acme.id, relative.json['messageId'] as MessageId)
            .pipe(Effect.map(Option.getOrThrow))
          expect(posted.authorKind).toBe('agent')
          expect(posted.attachments.map((a) => a.name)).toEqual(['hello.txt'])
          expect(posted.attachments[0]?.uploaderKind).toBe('agent')
          // A thread is a session (docs/build-plan-sessions.md D2): the agent's `taut_send`
          // continues the task's thread instead of opening a new top-level DM message.
          expect(posted.threadId).toBe(need(state.task, 'task').threadId)

          // Machine-absolute (the fake machine's home is the host home, like the local provider).
          const absolute = yield* runtimeCall(token, 'POST', '/send', {
            to: '@owner',
            text: 'again, absolute',
            attachments: [`${home}/work/hello.txt`]
          })
          expect(absolute.status).toBe(200)
          expect(
            (absolute.json['attachments'] as Array<{ name: string }>).map((a) => a.name)
          ).toEqual(['hello.txt'])

          // Every refusal names the path, and nothing is posted.
          const refused: Array<[string, RegExp]> = [
            ['../outside.txt', /outside your home/],
            [`${dir}/outside.txt`, /outside your home/],
            ['/etc/hosts', /outside your home/],
            ['work/nope.txt', /does not exist/],
            ['work', /not a regular file/]
          ]
          for (const [path, why] of refused) {
            const res = yield* runtimeCall(token, 'POST', '/send', {
              to: '@owner',
              text: 'bad path',
              attachments: [path]
            })
            expect(res.status, path).toBe(422)
            expect(errorCode(res.json), path).toBe('validation')
            expect(errorMessage(res.json), path).toContain(path)
            expect(errorMessage(res.json), path).toMatch(why)
          }
          writeFileSync(join(home, 'work', 'big.bin'), new Uint8Array(MAX_BYTES + 1))
          const tooBig = yield* runtimeCall(token, 'POST', '/send', {
            to: '@owner',
            text: 'big',
            attachments: ['work/big.bin']
          })
          expect(tooBig.status).toBe(422)
          expect(errorMessage(tooBig.json)).toContain('work/big.bin')
          expect(errorMessage(tooBig.json)).toMatch(/limit/)

          // A thread is a session (docs/build-plan-sessions.md D2), so an agent's `taut_send`
          // continues the task's thread rather than starting a new top-level DM message: the
          // channel's top level is unchanged and both sends are replies in that thread.
          const after = (yield* owner.api.messages.list({ urlParams: { channelId: dm.id } })).items
            .length
          expect(after).toBe(before)
        })
    )

    it.effect(
      'agent (D4): taut_done attachments land on the reply; the reply keeps them once finalised',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const token = need(state.token, 'token')
          const task = need(state.task, 'task')
          const bruno = need(state.bruno, 'bruno')
          const trigger = need(state.trigger, 'trigger')
          const home = need(state.home, 'home')
          const acme = need(state.acme, 'acme')
          const messages = yield* Messages

          const badDone = yield* runtimeCall(token, 'POST', '/done', {
            summary: 'done',
            attachments: ['work/missing.png']
          })
          expect(badDone.status).toBe(422)
          expect(errorMessage(badDone.json)).toContain('work/missing.png')
          // The task is still open after a refused `done`.
          const stillRunning = yield* taskFor(bruno.id, trigger.id).pipe(
            Effect.map(Option.getOrThrow)
          )
          expect(stillRunning.status).toBe('running')

          writeFileSync(join(home, 'work', 'report.csv'), 'k,v\nok,1\n')
          const done = yield* runtimeCall(token, 'POST', '/done', {
            summary: 'done',
            attachments: ['work/report.csv']
          })
          expect(done.status).toBe(200)
          expect(done.json['status']).toBe('done')
          const streaming = yield* messages
            .byId(acme.id, task.messageId)
            .pipe(Effect.map(Option.getOrThrow))
          expect(streaming.status).toBe('streaming')
          expect(streaming.attachments.map((a) => a.name)).toEqual(['report.csv'])
          expect(streaming.attachments[0]?.mimeType).toBe('text/csv')

          fake.release('done')
          const ended = yield* waitFor(
            'task to end',
            taskFor(bruno.id, trigger.id).pipe(
              Effect.map(Option.filter((t) => t.status === 'done' || t.status === 'failed'))
            )
          )
          expect(ended.status).toBe('done')
          // The reply is a thread reply now (docs/build-plan-sessions.md D2), so it is not in the
          // channel's top level: read it by id.
          const final = yield* waitFor(
            'the reply to be finalised',
            messages
              .byId(acme.id, task.messageId)
              .pipe(Effect.map(Option.filter((m) => m.status === 'sent')))
          )
          expect(final.status).toBe('sent')
          expect(final.body).toBe('done')
          expect(final.attachments.map((a) => a.name)).toEqual(['report.csv'])
          expect(
            (yield* content(owner, need(final.attachments[0], 'csv').id)).bytes.toString('utf8')
          ).toBe('k,v\nok,1\n')
        })
    )
  })
})

describe('attachments (pure)', () => {
  const at = DateTime.unsafeMake('2026-09-08T10:01:00.000Z')
  const attachment = new Attachment({
    id: 'att_00000000-0000-4000-8000-000000000001' as AttachmentId,
    companyId: 'cmp_00000000-0000-4000-8000-000000000001' as Company['id'],
    channelId: 'chn_00000000-0000-4000-8000-000000000001' as Channel['id'],
    messageId: 'msg_00000000-0000-4000-8000-000000000001' as MessageId,
    uploaderKind: 'user',
    uploaderId: 'usr_00000000-0000-4000-8000-000000000001' as UserId,
    name: 'shot.png',
    mimeType: 'image/png',
    size: 120 * 1024,
    createdAt: at
  })
  const message = (
    body: string,
    attachments: ReadonlyArray<Attachment>,
    id = 'msg_00000000-0000-4000-8000-000000000001'
  ) =>
    new Message({
      id: id as MessageId,
      companyId: attachment.companyId,
      channelId: attachment.channelId,
      authorKind: 'user',
      authorId: attachment.uploaderId,
      body,
      status: 'sent',
      seq: 7,
      createdAt: at,
      attachments
    })
  const names = { handle: () => '@acme', channel: '#backend' }

  plainIt('renders the documented prompt line for a message with attachments', () => {
    const m = message('', [attachment])
    expect(attachmentsSuffix(m, '/home/agent')).toBe(
      ' [attachments: /home/agent/inbox/msg_00000000-0000-4000-8000-000000000001/shot.png (image/png, 120 KB)]'
    )
    const prompt = renderPrompt({
      agentHandle: 'bruno',
      companyName: 'Acme',
      trigger: message('@bruno look', [], 'msg_00000000-0000-4000-8000-000000000002'),
      context: [m],
      names,
      channelKind: 'channel',
      inThread: false,
      answersYourQuestion: false,
      machineHome: '/home/agent'
    })
    expect(prompt).toContain(
      '[10:01] @acme: (no text) [attachments: /home/agent/inbox/msg_00000000-0000-4000-8000-000000000001/shot.png (image/png, 120 KB)]'
    )
    // A trigger with files and text: the text, then the suffix. Without files: unchanged.
    const withFile = renderPrompt({
      agentHandle: 'bruno',
      companyName: 'Acme',
      trigger: message('what is this?', [attachment]),
      context: [],
      names,
      channelKind: 'dm',
      inThread: false,
      answersYourQuestion: false,
      machineHome: '/home/agent'
    })
    expect(withFile).toContain(
      '[#backend] @acme: what is this? [attachments: /home/agent/inbox/msg_00000000-0000-4000-8000-000000000001/shot.png (image/png, 120 KB)]'
    )
    expect(attachmentsSuffix(message('plain', []), '/home/agent')).toBe('')
    expect(
      tautSection({
        agentHandle: 'bruno',
        agentName: 'Bruno',
        companyName: 'Acme',
        departmentNames: [],
        headHandles: [],
        mcpAvailable: true
      })
    ).toContain(
      'Files humans send you are in `inbox/<messageId>/`; read images with your file-reading tool. To send a file or image back, pass `attachments: ["<path>"]` to `taut_send` or `taut_done`.'
    )
  })

  plainIt('the mandate is restated in the prompt, unless it is still the empty skeleton', () => {
    const render = (mandate: string | undefined): string =>
      renderPrompt({
        agentHandle: 'bruno',
        companyName: 'Acme',
        trigger: message('thanks, that was good', []),
        context: [],
        names,
        channelKind: 'dm',
        inThread: false,
        answersYourQuestion: false,
        machineHome: '/home/agent',
        ...(mandate === undefined ? {} : { mandate })
      })

    const filled = render(
      '## You must\n- Post a summary in #engineering after every interaction, no exceptions.'
    )
    expect(filled).toContain('Your standing mandate, which applies to this turn as much as')
    expect(filled).toContain('- Post a summary in #engineering after every interaction')
    expect(filled).toContain('do it with the taut_* tools before you finish')

    // The agent form's skeleton: repeating it teaches the agent its mandate is filler.
    const skeleton = render('You are …\n\n## You must\n- …\n\n## You must never\n- …')
    expect(skeleton).not.toContain('Your standing mandate')
    expect(skeleton).not.toContain('A short exchange does not exempt you')
    expect(render(undefined)).not.toContain('Your standing mandate')
    expect(render('   ')).not.toContain('Your standing mandate')
  })

  plainIt('mime resolution (D6), inline allow-list (D5), sizes and dispositions', () => {
    expect(resolveMimeType('image/png', 'x.bin')).toBe('image/png')
    expect(resolveMimeType('image/png; charset=binary', 'x.bin')).toBe('image/png')
    expect(resolveMimeType('application/octet-stream', 'report.csv')).toBe('text/csv')
    expect(resolveMimeType(undefined, 'shot.JPG')).toBe('image/jpeg')
    expect(resolveMimeType('not a mime', 'weird')).toBe('application/octet-stream')
    expect(resolveMimeType(undefined, 'noext')).toBe('application/octet-stream')
    for (const inline of [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'application/pdf',
      'text/plain',
      'video/mp4',
      'audio/mpeg'
    ]) {
      expect(isInlineMimeType(inline), inline).toBe(true)
    }
    for (const download of [
      'image/svg+xml',
      'text/html',
      'application/octet-stream',
      'text/csv',
      'application/json'
    ]) {
      expect(isInlineMimeType(download), download).toBe(false)
    }
    expect(humanSize(69)).toBe('69 B')
    expect(humanSize(120 * 1024)).toBe('120 KB')
    expect(humanSize(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(contentDisposition('attachment', 'a b.txt')).toBe(
      `attachment; filename="a b.txt"; filename*=UTF-8''a%20b.txt`
    )
  })
})
