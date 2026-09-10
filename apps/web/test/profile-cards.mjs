// Run with the web dev server up: node apps/web/test/profile-cards.mjs
// Reuse the browser dependency already installed by @taut/runtime.
import assert from 'node:assert/strict'
import process from 'node:process'
import { createRequire } from 'node:module'
const runtimeRequire = createRequire(
  new URL('../../../packages/runtime/package.json', import.meta.url)
)
const { chromium } = createRequire(runtimeRequire.resolve('@playwright/mcp/package.json'))(
  'playwright'
)
const browser = await chromium.launch({
  channel: process.argv[3] ?? 'chrome',
  headless: true
})
const page = await browser.newPage({
  viewport: { width: 1512, height: 862 },
  serviceWorkers: 'block'
})
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const base = process.argv[2] ?? 'http://localhost:5173'
const reset = async () => {
  await page.goto(`${base}/test/profile-cards.html`)
  await page.locator('[data-testid=human] [role=button]').waitFor()
  await page.mouse.move(10, 10)
}
const hover = async (selector) => {
  await page.locator(selector).hover()
  await page.getByRole('dialog').last().waitFor()
}
const destination = async (path) => {
  await page.waitForFunction(
    (expected) => window.profileRouter.state.location.pathname === expected,
    path
  )
}
const requests = () => page.evaluate(() => window.profileRequests)
try {
  await reset()
  await hover('[data-testid=human]')
  assert.match(
    await page.getByRole('dialog').innerText(),
    /Ada Lovelace[\s\S]*Member[\s\S]*Engineering/
  )
  assert.deepEqual(await requests(), [])
  await page.getByRole('dialog').hover()
  await page.waitForTimeout(350)
  assert.equal(await page.getByRole('dialog').count(), 1)
  await page.mouse.move(10, 10)
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  console.log('PASS human hover, existing details, pointer travel and dismissal')

  await page.locator('[data-testid=human] [role=button]').click()
  await destination('/dm/chn_testdm')
  assert.deepEqual(await requests(), [{ memberKind: 'user', memberId: 'usr_ada' }])
  console.log('PASS human click opens the correct DM once')

  await reset()
  await page.locator('[data-testid=self] [role=button]').click()
  assert.match(await page.getByRole('dialog').innerText(), /Grace Hopper/)
  assert.deepEqual(await requests(), [])
  assert.equal(await page.getByRole('button', { name: 'Huddle', exact: true }).count(), 0)
  console.log('PASS own avatar respects existing self-DM restriction')

  await reset()
  await hover('[data-testid=agent]')
  assert.match(await page.getByRole('dialog').innerText(), /code-review/)
  assert.doesNotMatch(await page.getByRole('dialog').innerText(), /pending-skill|Huddle/)
  await page.getByRole('link', { name: 'Configure agent' }).click()
  await destination('/agents/agt_bruno')
  assert.deepEqual(await requests(), [])
  console.log('PASS active agent skills and configuration action')

  await reset()
  await page.locator('[data-testid=parent] [role=button]').click()
  await destination('/agents/agt_bruno')
  assert.equal(await page.evaluate(() => Boolean(window.parentClicked)), false)
  assert.deepEqual(await requests(), [])
  console.log('PASS agent click overrides containing control')

  await reset()
  await page.locator('[data-testid=human] [role=button]').focus()
  await page.getByRole('dialog').waitFor()
  await page.keyboard.press('Tab')
  assert.equal(
    await page.evaluate(() =>
      document.querySelector('[role=dialog]').contains(document.activeElement)
    ),
    true
  )
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(
    await page
      .locator('[data-testid=human] [role=button]')
      .evaluate((el) => el === document.activeElement),
    true
  )
  await page.keyboard.press('Enter')
  await destination('/dm/chn_testdm')
  console.log('PASS keyboard focus, Tab to actions, Escape restoration and Enter')

  await reset()
  await hover('[data-testid=human]')
  await page.getByRole('button', { name: 'Huddle', exact: true }).click()
  await page.getByRole('button', { name: 'Start Huddle', exact: true }).waitFor()
  assert.deepEqual(await requests(), [{ memberKind: 'user', memberId: 'usr_ada' }])
  console.log('PASS human huddle opens existing prejoin without joining')

  await reset()
  await hover('[data-testid=context]')
  assert.equal(await page.getByRole('dialog').count(), 1)
  assert.match(await page.getByRole('dialog').innerText(), /code-review[\s\S]*Context window/)
  assert.equal(await page.getByRole('tooltip').count(), 0)
  console.log('PASS context and profile use one hover card')

  await reset()
  await hover('[data-testid=linear]')
  assert.match(await page.getByRole('dialog').innerText(), /Ada Lovelace/)
  await page.locator('[data-testid=linear] [role=button]').click()
  await destination('/dm/chn_testdm')
  console.log('PASS explicit Linear mapping opens workspace profile and DM')

  await reset()
  await page.getByTestId('modal-open').click()
  await hover('[data-testid=modal-agent]')
  await page.locator('[data-testid=modal-agent] [role=button]').click()
  await destination('/agents/agt_bruno')
  assert.equal(await page.getByRole('dialog').count(), 0)
  console.log('PASS profile navigation closes containing dialog')

  await reset()
  await page.evaluate(() =>
    window.profileClient.setQueryData(['calls', 'config'], { enabled: false })
  )
  await hover('[data-testid=human]')
  assert.equal(await page.getByRole('button', { name: 'Huddle', exact: true }).count(), 0)
  console.log('PASS huddle availability follows deployment configuration')

  await reset()
  await page
    .getByRole('button', { name: 'Message Ada Lovelace' })
    .filter({ hasText: '@ada' })
    .hover()
  await page.getByRole('dialog').waitFor()
  assert.match(await page.getByRole('dialog').innerText(), /Ada Lovelace/)
  console.log('PASS mentions use the same hover card')

  await reset()
  await page.setViewportSize({ width: 375, height: 812 })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await hover('[data-testid=human]')
  const rect = await page.getByRole('dialog').boundingBox()
  assert.ok(rect.x >= 0 && rect.x + rect.width <= 375 && rect.y + rect.height <= 812)
  await page.screenshot({ path: '/tmp/taut-profile-mobile.png', animations: 'disabled' })
  console.log('PASS narrow viewport and dark theme')
  assert.deepEqual(errors, [])
  console.log('PASS all profile-card browser checks; no page errors')
} finally {
  await browser.close()
}
