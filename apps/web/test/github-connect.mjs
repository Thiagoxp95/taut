// Run with Vite up: node apps/web/test/github-connect.mjs
import assert from 'node:assert/strict'
import process from 'node:process'
import { createRequire } from 'node:module'
const runtimeRequire = createRequire(
  new URL('../../../packages/runtime/package.json', import.meta.url)
)
const { chromium } = createRequire(runtimeRequire.resolve('@playwright/mcp/package.json'))(
  'playwright'
)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const base = process.argv[2] ?? 'http://localhost:5173'
const manifest = {
  postUrl: 'https://github.com/settings/apps/new?state=test-state',
  manifest: JSON.stringify({
    name: 'Taut test',
    url: base,
    default_permissions: { contents: 'write' }
  }),
  state: 'test-state',
  browserUrl: `${base}/api/repositories/github/start?token=test-token`
}
try {
  const page = await browser.newPage({ serviceWorkers: 'block' })
  await page.addInitScript(() => {
    window.taut = {}
    window.externalUrls = []
    // Electron opens URLs externally and keeps the renderer on its current page.
    window.open = (url) => {
      window.externalUrls.push(url)
      return null
    }
    HTMLFormElement.prototype.submit = function () {
      window.externalUrls.push(this.action)
    }
  })
  await page.route('**/api/repositories/github/manifest', (route) =>
    route.fulfill({ json: manifest })
  )
  await page.goto(`${base}/test/github-connect.html`)
  await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click()
  await page.waitForFunction(() => window.externalUrls.length === 1)
  assert.deepEqual(await page.evaluate(() => window.externalUrls), [manifest.browserUrl])
  assert.equal(
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).isEnabled(),
    true
  )
  await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click()
  await page.waitForFunction(() => window.externalUrls.length === 2)
  console.log('PASS desktop opens the browser handoff and can retry without reloading')

  const web = await browser.newPage({ serviceWorkers: 'block' })
  await web.route('**/api/repositories/github/manifest', (route) =>
    route.fulfill({ json: manifest })
  )
  await web.route('https://github.com/**', (route) => route.fulfill({ body: 'GitHub' }))
  await web.goto(`${base}/test/github-connect.html`)
  const request = web.waitForRequest('https://github.com/**')
  await web.getByRole('button', { name: 'Connect GitHub', exact: true }).click()
  const post = await request
  assert.equal(post.method(), 'POST')
  assert.equal(new URLSearchParams(post.postData()).get('manifest'), manifest.manifest)
  console.log('PASS ordinary browsers submit the complete manifest to GitHub')
} finally {
  await browser.close()
}
