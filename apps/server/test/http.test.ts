import { SqlClient } from '@effect/sql'
import { it, layer } from '@effect/vitest'
import { UserId } from '@taut/contract/ids'
import { Effect, Layer } from 'effect'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterAll, describe, expect } from 'vitest'
import { EventLog } from '../src/realtime/eventLog.js'
import { baseUrl, connect, eventFrame, makeClient, sleep } from './_client.js'
import { makeTempDir, removeDir, testApp } from './_harness.js'

const dir = makeTempDir()
const webDist = join(dir, 'web-dist')
mkdirSync(join(webDist, 'assets'), { recursive: true })
writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>taut</title>')
writeFileSync(join(webDist, 'assets', 'app.js'), 'console.log("app")')
afterAll(() => removeDir(dir))

describe('http + ws plumbing', () => {
  layer(testApp(dir, { TAUT_WEB_DIST: webDist }), { excludeTestServices: true })((it) => {
    it.effect('GET /api/health returns 200 { ok, version }; unknown /api routes 404', () =>
      Effect.gen(function* () {
        const { http } = yield* baseUrl
        const res = yield* Effect.promise(() => fetch(`${http}/api/health`))
        expect(res.status).toBe(200)
        expect(yield* Effect.promise(() => res.json())).toEqual({ ok: true, version: '0.0.0' })
        const missing = yield* Effect.promise(() => fetch(`${http}/api/nope`))
        expect(missing.status).toBe(404)
      })
    )

    it.effect('protected endpoints answer 401 without a session cookie', () =>
      Effect.gen(function* () {
        const { http } = yield* baseUrl
        const me = yield* Effect.promise(() => fetch(`${http}/api/auth/me`))
        expect(me.status).toBe(401)
        const channels = yield* Effect.promise(() =>
          fetch(`${http}/api/channels`, { headers: { cookie: 'taut_session=ses_bogus' } })
        )
        expect(channels.status).toBe(401)
      })
    )

    it.effect('serves the web dist with SPA fallback', () =>
      Effect.gen(function* () {
        const { http } = yield* baseUrl
        const index = yield* Effect.promise(() => fetch(`${http}/`))
        expect(index.status).toBe(200)
        expect(yield* Effect.promise(() => index.text())).toContain('<title>taut</title>')
        const asset = yield* Effect.promise(() => fetch(`${http}/assets/app.js`))
        expect(asset.headers.get('content-type')).toContain('javascript')
        expect(yield* Effect.promise(() => asset.text())).toBe('console.log("app")')
        const deep = yield* Effect.promise(() => fetch(`${http}/c/chn_123/thread/msg_9`))
        expect(deep.status).toBe(200)
        expect(yield* Effect.promise(() => deep.text())).toContain('<title>taut</title>')
      })
    )

    it.effect('rejects sockets: 401 without a session, 403 without a company, 404 off /ws', () =>
      Effect.gen(function* () {
        const { ws } = yield* baseUrl
        const noCookie = yield* Effect.flip(
          Effect.tryPromise(() => Effect.runPromise(connect(`${ws}/ws`)))
        )
        expect(String(noCookie.cause)).toContain('401')
        const bogus = yield* Effect.flip(
          Effect.tryPromise(() =>
            Effect.runPromise(connect(`${ws}/ws`, 'taut_session=ses_not_a_session'))
          )
        )
        expect(String(bogus.cause)).toContain('401')

        // a real session, but the user has no company yet
        const client = yield* makeClient
        yield* client.api.auth.signup({
          payload: { email: 'lonely@taut.local', password: 'password123', name: 'Lonely' }
        })
        const cookie = yield* client.cookieHeader
        const noCompany = yield* Effect.flip(
          Effect.tryPromise(() => Effect.runPromise(connect(`${ws}/ws`, cookie)))
        )
        expect(String(noCompany.cause)).toContain('403')

        const notFound = yield* Effect.flip(
          Effect.tryPromise(() => Effect.runPromise(connect(`${ws}/nope`, cookie)))
        )
        expect(String(notFound.cause)).toContain('404')
      })
    )

    it.effect('replays /ws?since=0 past a legacy row that no longer decodes and stays open', () =>
      Effect.gen(function* () {
        const { ws } = yield* baseUrl
        const client = yield* makeClient
        yield* client.api.auth.signup({
          payload: { email: 'legacy@taut.local', password: 'password123', name: 'Legacy' }
        })
        const company = yield* client.api.companies.create({
          payload: { slug: 'legacy', name: 'Legacy', avatar: { kind: 'emoji', value: 'L' } }
        })
        const sql = yield* SqlClient.SqlClient
        const log = yield* EventLog
        const at = new Date().toISOString()
        // a `message.created` written by the pre-0004 `Message` schema (no `seq`) between two valid rows
        const corruptSeq = (yield* log.latestSeq(company.id)) + 1
        const legacy = {
          message: {
            id: 'msg_legacy',
            companyId: company.id,
            channelId: 'chn_1',
            authorKind: 'user',
            authorId: 'usr_1',
            body: 'old',
            status: 'sent',
            createdAt: at
          },
          mentions: []
        }
        yield* sql`INSERT INTO events (company_id, seq, at, type, payload_json)
                   VALUES (${company.id}, ${corruptSeq}, ${at}, 'message.created', ${JSON.stringify(legacy)})`
        const valid = yield* log.append(company.id, {
          type: 'membership.deleted',
          payload: { userId: UserId.make('usr_gone') }
        })
        expect(valid.seq).toBe(corruptSeq + 1)
        expect((yield* log.validate()).invalid).toBe(1)

        const socket = yield* connect(`${ws}/ws?since=0`, yield* client.cookieHeader)
        let closedWith: number | undefined
        socket.ws.on('close', (code) => {
          closedWith = code
        })
        const seen: Array<number> = []
        for (;;) {
          const event = eventFrame(yield* Effect.promise(socket.next))
          seen.push(event.seq)
          if (event.seq === valid.seq) break
        }
        expect(seen).toContain(valid.seq)
        expect(seen).not.toContain(corruptSeq)
        expect(seen).toEqual([...seen].sort((a, b) => a - b))
        yield* sleep(200)
        expect(closedWith).toBeUndefined()
        expect(socket.ws.readyState).toBe(WebSocket.OPEN)
        yield* Effect.promise(socket.close)
      })
    )

    it.effect('a connect with no ?since gets `resync` at the head, not a replay', () =>
      Effect.gen(function* () {
        const { ws } = yield* baseUrl
        const client = yield* makeClient
        yield* client.api.auth.signup({
          payload: { email: 'cold@taut.local', password: 'password123', name: 'Cold' }
        })
        const company = yield* client.api.companies.create({
          payload: { slug: 'cold', name: 'Cold', avatar: { kind: 'emoji', value: 'C' } }
        })
        const log = yield* EventLog
        // History this client was never present for: replaying it would re-fire every toast.
        yield* log.append(company.id, {
          type: 'membership.deleted',
          payload: { userId: UserId.make('usr_old') }
        })
        const head = yield* log.latestSeq(company.id)
        expect(head).toBeGreaterThan(0)

        const socket = yield* connect(`${ws}/ws`, yield* client.cookieHeader)
        expect(yield* Effect.promise(socket.next)).toEqual({ type: 'resync', head })
        // A pong straight after proves the log was not replayed behind it.
        socket.ws.send(JSON.stringify({ type: 'ping' }))
        expect(yield* Effect.promise(socket.next)).toEqual({ type: 'pong' })
        yield* Effect.promise(socket.close)
      })
    )
  })

  it.live('shuts down cleanly with sockets still open', () =>
    Effect.gen(function* () {
      const scopeDir = makeTempDir()
      const layer = testApp(scopeDir)
      const started = Date.now()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer)
          const { ws } = yield* baseUrl.pipe(Effect.provide(context))
          const client = yield* makeClient.pipe(Effect.provide(context))
          yield* client.api.auth.signup({
            payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
          })
          yield* client.api.companies.create({
            payload: { slug: 'acme', name: 'Acme', avatar: { kind: 'emoji', value: 'A' } }
          })
          const socket = yield* connect(`${ws}/ws`, yield* client.cookieHeader)
          expect(socket.ws.readyState).toBe(WebSocket.OPEN)
        })
      )
      expect(Date.now() - started).toBeLessThan(5000)
      removeDir(scopeDir)
    })
  )
})
