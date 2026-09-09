import { layer } from '@effect/vitest'
import type { Channel, Company } from '@taut/contract/domain'
import type { UserId } from '@taut/contract/ids'
import { Effect } from 'effect'
import { execFileSync } from 'node:child_process'
import { createECDH, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect } from 'vitest'
import ece from 'http_ece'
import { PushDevices } from '../src/services/pushDevices.js'
import { makeClient, sleep, type TestClient } from './_client.js'
import { makeTempDir, removeDir, testApp } from './_harness.js'

/**
 * Phase 8 (PWA · Web Push), end to end and for real: a message that notifies dana
 * must arrive at her registered endpoint as an RFC 8291 aes128gcm payload that
 * decrypts to exactly what `src/sw.ts` renders.
 *
 * The "push service" here is an HTTPS server this test owns (web-push refuses plain
 * http, as it should), so nothing leaves the machine and the assertions can look at
 * the actual ciphertext.
 */

// The fake push service uses a throwaway self-signed cert. Scoped to this vitest
// worker; it is set before any request is made and never leaves the file.
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'

/** openssl ships with macOS and every CI image we use; a clear failure beats a skip. */
const selfSignedCert = (): { key: Buffer; cert: Buffer } => {
  const dir = mkdtempSync(join(tmpdir(), 'taut-push-tls-'))
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1'
  ])
  return { key: readFileSync(key), cert: readFileSync(cert) }
}

const VAPID_PUBLIC =
  'BJ0e1XR5KggnQuZCLQMCjrcrPlxws-4ptCu9H_y84R1PQ0xPgiOjn6evBr01N490J30LDHfnFX4A8pRKk7KyBzs'
const VAPID_PRIVATE = 'dloxSxgnc6DB2doWxpoTS3ky3sy5xNAfKDCLKh7ufg8'

const dir = makeTempDir()
const avatar = { kind: 'emoji', value: 'A' } as const

/** One captured push, decoded far enough to assert on. */
interface Captured {
  readonly path: string
  readonly headers: Record<string, string | undefined>
  readonly body: Buffer
}

const b64url = (buffer: Buffer): string => buffer.toString('base64url')

/** A browser's half of the exchange: an ECDH keypair plus the 16-byte auth secret. */
const makeReceiver = () => {
  const curve = createECDH('prime256v1')
  curve.generateKeys()
  const auth = randomBytes(16)
  return {
    p256dh: b64url(curve.getPublicKey()),
    auth: b64url(auth),
    /** Exactly what the service worker's `event.data.json()` would give. */
    open: (body: Buffer): unknown =>
      JSON.parse(
        ece
          .decrypt(body, {
            version: 'aes128gcm',
            privateKey: curve,
            dh: b64url(curve.getPublicKey()),
            authSecret: b64url(auth)
          })
          .toString('utf8')
      )
  }
}

const captured: Array<Captured> = []
let status = 201
let pushService: Server | undefined
let origin = ''

const startPushService = (): Promise<string> =>
  new Promise((resolve) => {
    const server = createServer(selfSignedCert(), (req: IncomingMessage, res) => {
      const chunks: Array<Buffer> = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        captured.push({
          path: req.url ?? '',
          headers: req.headers as Record<string, string | undefined>,
          body: Buffer.concat(chunks)
        })
        res.writeHead(status)
        res.end()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      pushService = server
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      resolve(`https://127.0.0.1:${address.port}`)
    })
  })

afterAll(() => {
  pushService?.close()
  removeDir(dir)
})

const state: {
  owner?: TestClient
  dana?: TestClient
  acme?: Company
  channel?: Channel
  receiver?: ReturnType<typeof makeReceiver>
  danaId?: UserId
} = {}

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

/** Poll instead of a fixed sleep: the notifier runs on its own fiber. */
const waitForPush = (count: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (captured.length >= count) return
      yield* sleep(50)
    }
    throw new Error(`expected ${count} push(es), got ${captured.length}`)
  })

describe('phase 8 (PWA · web push)', () => {
  layer(
    testApp(dir, {
      TAUT_VAPID_PUBLIC_KEY: VAPID_PUBLIC,
      TAUT_VAPID_PRIVATE_KEY: VAPID_PRIVATE,
      TAUT_VAPID_SUBJECT: 'mailto:test@taut.local'
    }),
    { excludeTestServices: true }
  )((it) => {
    it.effect('setup: owner + dana in #general, dana subscribed on a fake push service', () =>
      Effect.gen(function* () {
        origin = yield* Effect.promise(() => startPushService())

        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        const acme = yield* owner.api.companies.create({
          payload: { slug: 'acme', name: 'Acme', avatar }
        })
        const invite = yield* owner.api.invites.create({
          payload: { email: 'dana@taut.local', role: 'member' }
        })
        const dana = yield* makeClient
        yield* dana.api.invites.accept({
          payload: { token: invite.token, name: 'Dana', password: 'password123' }
        })
        const danaMe = yield* dana.api.auth.me()

        const engineering = yield* owner.api.departments.create({
          payload: {
            name: 'Engineering',
            slug: 'engineering',
            headUserId: (yield* owner.api.auth.me()).user.id
          }
        })
        const channel = yield* owner.api.channels.create({
          payload: { name: 'general', departmentId: engineering.id }
        })
        yield* owner.api.channels.addMember({
          path: { channelId: channel.id },
          payload: { memberKind: 'user', memberId: danaMe.user.id }
        })

        const receiver = makeReceiver()
        const devices = yield* PushDevices
        yield* devices.register(danaMe.user.id, {
          endpoint: `${origin}/ep/dana`,
          keys: { p256dh: receiver.p256dh, auth: receiver.auth },
          label: 'iPhone · Safari'
        })

        state.owner = owner
        state.dana = dana
        state.acme = acme
        state.channel = channel
        state.receiver = receiver
        state.danaId = danaMe.user.id
      })
    )

    it.effect('a mention pushes an encrypted, decryptable notification to the endpoint', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const channel = need(state.channel, 'channel')
        const receiver = need(state.receiver, 'receiver')

        yield* owner.api.messages.create({
          payload: { channelId: channel.id, body: '@dana can you take a look at the deploy?' }
        })

        yield* waitForPush(1)
        const push = captured[0]
        if (push === undefined) throw new Error('no push captured')

        expect(push.path).toBe('/ep/dana')
        expect(push.headers['content-encoding']).toBe('aes128gcm')
        expect(push.headers['ttl']).toBe('600')
        expect(push.headers['urgency']).toBe('high')
        // VAPID: signed JWT + the server's public key.
        expect(push.headers['authorization']).toMatch(/^vapid t=[\w.-]+, k=/)
        expect(push.headers['authorization']).toContain(VAPID_PUBLIC)
        // Ciphertext, not the message: the push service must not be able to read it.
        expect(push.body.toString('utf8')).not.toContain('deploy')

        expect(receiver.open(push.body)).toEqual({
          title: 'Owner in #general',
          body: '@dana can you take a look at the deploy?',
          tag: `taut:${channel.id}`,
          url: `/c/${channel.id}`
        })
      })
    )

    it.effect('a DM titles the notification with the sender and links to /dm', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const receiver = need(state.receiver, 'receiver')
        const danaId = need(state.danaId, 'danaId')
        captured.length = 0

        const dm = yield* owner.api.channels.dm({
          payload: { memberKind: 'user', memberId: danaId }
        })
        yield* owner.api.messages.create({
          payload: { channelId: dm.id, body: 'ping' }
        })

        yield* waitForPush(1)
        const push = captured[0]
        if (push === undefined) throw new Error('no push captured')
        expect(receiver.open(push.body)).toEqual({
          title: 'Owner',
          body: 'ping',
          tag: `taut:${dm.id}`,
          url: `/dm/${dm.id}`
        })
      })
    )

    it.effect('a 410 from the push service deletes the endpoint', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const channel = need(state.channel, 'channel')
        const danaId = need(state.danaId, 'danaId')
        const devices = yield* PushDevices
        captured.length = 0
        status = 410

        yield* owner.api.messages.create({
          payload: { channelId: channel.id, body: '@dana one more' }
        })
        yield* waitForPush(1)

        // The delete happens after the response; give the notifier a beat.
        for (let attempt = 0; attempt < 50; attempt++) {
          if ((yield* devices.list(danaId)).length === 0) break
          yield* sleep(50)
        }
        expect(yield* devices.list(danaId)).toHaveLength(0)

        // And nothing is sent to a user with no endpoints left.
        captured.length = 0
        status = 201
        yield* owner.api.messages.create({
          payload: { channelId: channel.id, body: '@dana and another' }
        })
        yield* sleep(400)
        expect(captured).toHaveLength(0)
      })
    )

    it.effect('the HTTP endpoint refuses a non-https push endpoint', () =>
      Effect.gen(function* () {
        const dana = need(state.dana, 'dana')
        const receiver = need(state.receiver, 'receiver')
        const result = yield* dana.api.push
          .subscribe({
            payload: {
              endpoint: 'http://evil.example/ep',
              keys: { p256dh: receiver.p256dh, auth: receiver.auth }
            }
          })
          .pipe(Effect.either)
        expect(result._tag).toBe('Left')
        if (result._tag === 'Left') expect(result.left._tag).toBe('Validation')
      })
    )

    it.effect('the VAPID public key is served to authenticated clients', () =>
      Effect.gen(function* () {
        const dana = need(state.dana, 'dana')
        expect((yield* dana.api.push.key()).publicKey).toBe(VAPID_PUBLIC)
      })
    )
  })
})
