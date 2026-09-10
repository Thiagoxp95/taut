import assert from 'node:assert/strict'
import process from 'node:process'
import { createRequire } from 'node:module'
import { serveClaudeBrowserLogin } from '../../desktop/src/main/claude-browser-login.ts'

const runtimeRequire = createRequire(
  new URL('../../../packages/runtime/package.json', import.meta.url)
)
const { chromium } = createRequire(runtimeRequire.resolve('@playwright/mcp/package.json'))(
  'playwright'
)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const base = process.argv[2] ?? 'http://localhost:5173'
try {
  const page = await browser.newPage({ serviceWorkers: 'block' })
  await page.addInitScript(() => {
    window.connectCalls = 0
    window.cancelCalls = 0
    window.taut = {
      connectClaude: () => {
        window.connectCalls++
        return new Promise((resolve, reject) => {
          window.finishClaude = () =>
            resolve({
              kind: 'claude.login',
              secret: JSON.stringify({
                claudeAiOauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh' }
              })
            })
          window.rejectClaude = reject
        })
      },
      cancelClaudeConnect: () => {
        window.cancelCalls++
        window.rejectClaude(new Error('Cancelled'))
      }
    }
  })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.setDefaultTimeout(10000)
  const credentials = []
  const accounts = []
  let failAccountOnce = false
  const account = {
    id: 'sub_test',
    companyId: 'cmp_test',
    runtime: 'claude-code',
    label: 'Claude Code account',
    credentialId: 'vlt_test',
    status: 'ok',
    weight: 1,
    limits: [],
    tasksToday: 0
  }
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname.replace(/\/$/, '')
      if (path === '/api/vault' && request.method() === 'POST') {
        const input = request.postDataJSON()
        credentials.push(input)
        return route.fulfill({
          status: 201,
          json: {
            id: 'vlt_test',
            companyId: 'cmp_test',
            kind: input.kind,
            label: input.label,
            hint: 'test',
            createdAt: '2026-09-10T00:00:00.000Z'
          }
        })
      }
      if (path === '/api/subscriptions' && request.method() === 'POST') {
        accounts.push(request.postDataJSON())
        if (failAccountOnce) {
          failAccountOnce = false
          return route.fulfill({ status: 500, json: { message: 'Test account save failure' } })
        }
        return route.fulfill({ status: 201, json: account })
      }
      if (path.endsWith('/check')) return route.fulfill({ json: account })
      return route.fulfill({ json: { items: [] } })
    }
  )
  await page.goto(`${base}/test/provider-connect.html`)
  await page.getByRole('dialog').waitFor()
  assert.deepEqual(
    await page
      .getByRole('group', { name: 'Connection method' })
      .getByRole('button')
      .allTextContents(),
    ['Subscription', 'API key']
  )
  assert.equal(await page.getByRole('button', { name: 'Advanced options' }).count(), 0)
  assert.equal(await page.getByLabel('Account name', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Copy login command' }).count(), 0)
  assert.equal(await page.locator('input').count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Connect', exact: true }).isEnabled(), true)
  await page.getByRole('button', { name: 'API key', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Copy login command' }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Connect', exact: true }).isDisabled(), true)
  await page.locator('input[type=password]').fill('fake-anthropic-key')
  assert.equal(await page.getByRole('button', { name: 'Connect', exact: true }).isEnabled(), true)
  await page.getByRole('button', { name: 'Subscription', exact: true }).click()
  assert.equal(await page.locator('input').count(), 0)
  console.log('PASS two methods, no advanced login choices, automatic name, clean method switching')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.waitForFunction(() => window.connectCalls === 1)
  assert.equal(credentials.length, 0)
  await page.evaluate(() => window.finishClaude())
  await page.getByText('Connected', { exact: true }).waitFor()
  assert.deepEqual(credentials, [
    {
      kind: 'claude.login',
      label: 'Claude Code account',
      secret: JSON.stringify({
        claudeAiOauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh' }
      })
    }
  ])
  assert.deepEqual(accounts, [
    { runtime: 'claude-code', label: 'Claude Code account', credentialId: 'vlt_test' }
  ])
  console.log('PASS Connect starts browser sign-in and automatically saves the returned login')
  await page.reload()
  await page.getByRole('button', { name: 'API key', exact: true }).click()
  await page.locator('input[type=password]').fill('fake-anthropic-key')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByText('Connected', { exact: true }).waitFor()
  assert.equal(credentials[1].kind, 'anthropic.api_key')
  assert.equal(accounts.length, 2)
  console.log('PASS API key connects through the same action')
  await page.reload()
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.waitForFunction(() => window.connectCalls === 1)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.waitForFunction(() => window.cancelCalls === 1)
  assert.equal(credentials.length, 2)
  console.log('PASS Cancel stops sign-in without saving a connection')
  await page.reload()
  failAccountOnce = true
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.waitForFunction(() => window.connectCalls === 1)
  await page.evaluate(() => window.finishClaude())
  await page.getByRole('alert').waitFor()
  const savedCount = credentials.length
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByText('Connected', { exact: true }).waitFor()
  assert.equal(credentials.length, savedCount)
  assert.equal(await page.evaluate(() => window.connectCalls), 1)
  console.log('PASS A failed account save retries without another sign-in or duplicate credential')
  await page.reload()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('dialog').waitFor()
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true
  )
  await page.screenshot({ path: '/tmp/taut-provider-connect.png', animations: 'disabled' })
  const web = await browser.newPage({ serviceWorkers: 'block' })
  let broker
  let webLaunches = 0
  let webSaved = false
  await web.exposeFunction('launchTaut', async (raw) => {
    const handoff = new URL(raw)
    assert.equal(handoff.protocol, 'taut:')
    assert.equal(handoff.hostname, 'connect')
    assert.equal(handoff.pathname, '/claude')
    assert.equal(handoff.searchParams.get('origin'), new URL(base).origin)
    webLaunches++
    broker = await serveClaudeBrowserLogin({
      origin: handoff.searchParams.get('origin'),
      nonce: handoff.searchParams.get('nonce'),
      signIn: async () => ({
        kind: 'claude.login',
        secret: JSON.stringify({
          claudeAiOauth: { accessToken: 'fake-web-access', refreshToken: 'fake-web-refresh' }
        })
      })
    })
  })
  await web.addInitScript(() => {
    window.open = (url) => {
      void window.launchTaut(url)
      return null
    }
  })
  await web.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname.replace(/\/$/, '')
      if (path === '/api/vault' && request.method() === 'POST') {
        const input = request.postDataJSON()
        assert.equal(input.kind, 'claude.login')
        assert.equal(JSON.parse(input.secret).claudeAiOauth.accessToken, 'fake-web-access')
        webSaved = true
        return route.fulfill({
          status: 201,
          json: {
            id: 'vlt_test',
            companyId: 'cmp_test',
            kind: input.kind,
            label: input.label,
            hint: 'test',
            createdAt: '2026-09-10T00:00:00.000Z'
          }
        })
      }
      return route.fulfill({ status: path === '/api/subscriptions' ? 201 : 200, json: account })
    }
  )
  try {
    await web.goto(`${base}/test/provider-connect.html`)
    assert.equal(await web.locator('input').count(), 0)
    await web.getByRole('button', { name: 'Connect', exact: true }).click()
    await web.getByText('Connected', { exact: true }).waitFor()
    assert.equal(webLaunches, 1)
    assert.equal(webSaved, true)
    console.log(
      'PASS Web Connect opens the desktop handoff and saves the real loopback callback automatically'
    )
  } finally {
    broker?.cancel()
    await web.close()
  }
  assert.deepEqual(pageErrors, [])
} finally {
  await browser.close()
}
