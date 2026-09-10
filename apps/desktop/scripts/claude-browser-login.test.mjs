import assert from 'node:assert/strict'
import { test } from 'node:test'
import { serveClaudeBrowserLogin } from '../src/main/claude-browser-login.ts'

const origin = 'https://taut.example'
const nonce = 'a'.repeat(64)
const login = { kind: 'claude.login', secret: 'fake-login' }

test('loopback handoff binds the result to one origin and nonce, then closes', async () => {
  let finish
  const broker = await serveClaudeBrowserLogin({
    origin,
    nonce,
    port: 0,
    signIn: () =>
      new Promise((resolve) => {
        finish = resolve
      })
  })
  const url = `http://127.0.0.1:${broker.port}/claude-login/${nonce}`
  try {
    const wrongOrigin = await fetch(url, { headers: { Origin: 'https://attacker.example' } })
    assert.equal(wrongOrigin.status, 403)
    assert.equal(wrongOrigin.headers.get('access-control-allow-origin'), null)
    assert.equal(
      (await fetch(url.replace(nonce, 'b'.repeat(64)), { headers: { Origin: origin } })).status,
      404
    )
    const pending = await fetch(url, { headers: { Origin: origin } })
    assert.deepEqual(await pending.json(), { status: 'pending' })
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin } })
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true')
    finish(login)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const completed = await fetch(url, { headers: { Origin: origin } })
    assert.deepEqual(await completed.json(), { status: 'connected', login })
    assert.equal(completed.headers.get('cache-control'), 'no-store')
    await broker.finished
    await assert.rejects(fetch(url, { headers: { Origin: origin } }))
  } finally {
    broker.cancel()
  }
})

test('cancellation aborts the CLI and closes the local listener', async () => {
  let signal
  const broker = await serveClaudeBrowserLogin({
    origin,
    nonce,
    port: 0,
    signIn: (options) => {
      signal = options.signal
      return new Promise(() => {})
    }
  })
  const response = await fetch(`http://127.0.0.1:${broker.port}/claude-login/${nonce}`, {
    method: 'DELETE',
    headers: { Origin: origin }
  })
  assert.equal(response.status, 204)
  assert.equal(signal.aborted, true)
  await broker.finished
})
