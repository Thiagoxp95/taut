import assert from 'node:assert/strict'
import { argv } from 'node:process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const runtimeRequire = createRequire(require.resolve('../../../packages/runtime/package.json'))
const { chromium } = createRequire(runtimeRequire.resolve('@playwright/mcp'))('playwright')
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (error) => console.error(error.message))
  await page.goto(`${argv[2] ?? 'http://localhost:5174'}/test/browser-pane.html`)
  await page.waitForSelector('[data-browser-panel][data-open=true] img:not([hidden])')
  const viewportMatches = () => {
    const img = document.querySelector('[data-browser-panel] img')
    return (
      img &&
      Math.abs(img.naturalWidth - img.clientWidth) < 2 &&
      Math.abs(img.naturalHeight - img.clientHeight) < 2
    )
  }
  await page.waitForFunction(viewportMatches)
  await page.waitForTimeout(200)
  const space = await page.locator('[data-browser-panel] img').evaluate((img) => {
    const panel = img.closest('[data-browser-panel]').getBoundingClientRect()
    const rect = img.getBoundingClientRect()
    return { bottomGap: panel.bottom - rect.bottom, widthGap: panel.width - rect.width }
  })
  assert.ok(
    space.bottomGap < 2 && space.widthGap < 2,
    `Page should fill available space: ${JSON.stringify(space)}`
  )
  await page.getByRole('textbox', { name: 'Reply' }).fill('Keep my draft')
  await page.evaluate(() => window.browserFixture.end())
  await page.waitForTimeout(100)
  assert.equal(
    await page.locator('[data-browser-panel]').getAttribute('data-open'),
    'true',
    'Pane stays open between prompts'
  )
  await page.evaluate(() => window.browserFixture.next())
  await page.waitForTimeout(100)
  assert.equal(
    await page.evaluate(() => window.browserFixture.sockets.length),
    1,
    'Follow-up prompt reuses socket'
  )
  assert.equal(await page.getByRole('textbox', { name: 'Reply' }).inputValue(), 'Keep my draft')
  await page.getByRole('button', { name: 'Take control', exact: true }).click()
  await page.getByRole('button', { name: 'Release control', exact: true }).waitFor()
  await page.getByRole('application', { name: 'You are driving the browser' }).click()
  assert.ok(
    await page.evaluate(() => window.browserFixture.inputs.some((f) => f._tag === 'input')),
    'Controlling sends browser input'
  )
  await page.getByRole('button', { name: 'Release control', exact: true }).click()
  await page.getByRole('button', { name: 'Take control', exact: true }).waitFor()
  const inputCount = await page.evaluate(
    () => window.browserFixture.inputs.filter((f) => f._tag === 'input').length
  )
  await page.getByRole('application', { name: 'Browser live view' }).click()
  assert.equal(
    await page.evaluate(
      () => window.browserFixture.inputs.filter((f) => f._tag === 'input').length
    ),
    inputCount,
    'Following mode sends no input'
  )
  await page.evaluate(() => window.browserFixture.working())
  await page.getByRole('button', { name: 'Take control', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('button', { name: 'Pause & take control', exact: true }).click()
  await page.getByRole('button', { name: 'Release control', exact: true }).waitFor()
  assert.ok(
    await page.evaluate(() =>
      window.browserFixture.inputs.some((f) => f._tag === 'control' && f.hold && f.pause)
    ),
    'Active agent is explicitly paused'
  )
  const overlay = page.getByRole('application', { name: 'You are driving the browser' })
  await overlay.click()
  await page.keyboard.press('Escape')
  assert.equal(
    await page.locator('[data-browser-panel]').getAttribute('data-open'),
    'true',
    'Remote Escape does not close pane'
  )
  await page.keyboard.press('Tab')
  assert.equal(
    await overlay.evaluate((el) => el === document.activeElement),
    false,
    'Tab can leave browser input'
  )
  await overlay.hover()
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(100)
  assert.ok(
    await page.evaluate(() =>
      window.browserFixture.inputs.some((f) => f._tag === 'input' && f.event.type === 'mouseWheel')
    ),
    'Wheel reaches browser'
  )
  await page.getByRole('button', { name: 'Release control', exact: true }).click()
  await page.evaluate(() => {
    const socket = window.browserFixture.sockets[0]
    socket.emit({ _tag: 'control', holder: 'usr_me', paused: false, owned: false })
    socket.emit({ _tag: 'browser', state: 'starting' })
    socket.page('Menu', 'https://example.test/menu')
  })
  await page.getByText('Controlled in another view', { exact: true }).waitFor()
  assert.ok(
    await page.getByRole('button', { name: 'Take control', exact: true }).isDisabled(),
    'Another view of the same user retains ownership through browser startup'
  )
  await page.evaluate(() => window.browserFixture.sockets[0].close())
  await page.waitForFunction(() => window.browserFixture.sockets.length === 2)
  await page.waitForFunction(() => window.browserFixture.sockets.at(-1).readyState === 1)
  await page.waitForSelector('[data-browser-panel] img:not([hidden])')
  await page.waitForFunction(viewportMatches)
  await page.screenshot({ path: '/tmp/taut-browser-pane-wide.png' })
  await page.setViewportSize({ width: 650, height: 850 })
  await page.waitForFunction(viewportMatches)
  await page.screenshot({ path: '/tmp/taut-browser-pane-narrow.png' })
  await page.getByRole('button', { name: 'Close browser', exact: true }).click()
  assert.equal(
    await page.evaluate(() => window.browserFixture.sockets.at(-1).readyState),
    3,
    'Closing disposes socket'
  )
  await page.waitForTimeout(1200)
  assert.equal(
    await page.evaluate(() => window.browserFixture.sockets.length),
    2,
    'Closing cancels retries'
  )
  await page.getByRole('button', { name: 'Show browser', exact: true }).click()
  await page.waitForFunction(() => window.browserFixture.sockets.length === 3)
  await page.getByRole('button', { name: 'Other thread', exact: true }).click()
  assert.equal(
    await page.locator('[data-browser-panel]').getAttribute('data-open'),
    'false',
    'Leaving conversation closes its browser'
  )
  console.log(
    'PASS pause interlock, keyboard escape, wheel input, ownership, automatic recovery, dismissal, reopening, conversation scope'
  )
  console.log(
    'PASS persistent pane, follow-up socket reuse, draft preservation, take/release control'
  )
} finally {
  await browser.close()
}
