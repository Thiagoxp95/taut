// With the web dev server running: node apps/web/test/message-components.mjs [base URL]
import assert from 'node:assert/strict'
import process from 'node:process'
import { createRequire } from 'node:module'
const runtimeRequire = createRequire(
  new URL('../../../packages/runtime/package.json', import.meta.url)
)
const { chromium } = createRequire(runtimeRequire.resolve('@playwright/mcp/package.json'))(
  'playwright'
)
const browser = await chromium.launch({ channel: process.argv[3] ?? 'chrome', headless: true })
const page = await browser.newPage({
  viewport: { width: 900, height: 1000 },
  serviceWorkers: 'block'
})
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const reset = async () => {
  await page.goto(`${process.argv[2] ?? 'http://localhost:5173'}/test/message-components.html`)
  await page.getByRole('radio', { name: 'Steady', exact: true }).waitFor()
}
const submit = () => page.getByRole('button', { name: 'Send answers', exact: true })
const requests = () => page.evaluate(() => window.componentRequests)
try {
  await reset()
  assert.equal(await submit().isDisabled(), true)
  await page.getByRole('radio', { name: 'Steady', exact: true }).check()
  await page.getByRole('textbox').first().fill('Keep it calm.')
  await page.getByRole('checkbox', { name: 'Design', exact: true }).check()
  await page.getByRole('checkbox', { name: 'Code', exact: true }).check()
  await submit().click()
  await page.getByRole('button', { name: 'Answers sent', exact: true }).waitFor()
  assert.deepEqual(await requests(), [
    {
      answers: [
        { questionId: '__proto__', selections: ['Steady'], text: 'Keep it calm.' },
        { questionId: 'toString', selections: ['Design', 'Code'] }
      ]
    }
  ])
  assert.equal(await page.getByRole('radio', { name: 'Steady', exact: true }).isDisabled(), true)
  console.log('PASS inherited question IDs, single/multiple choices, custom text and submit once')

  await page.evaluate(() => {
    window.componentQuestions.status = 'answered'
    window.componentQuestions.answers = window.componentRequests[0].answers
    window.renderComponents()
  })
  await page.getByText('Answers submitted.', { exact: true }).waitFor()
  assert.match(
    await page.getByRole('form').innerText(),
    /Steady[\s\S]*Keep it calm.[\s\S]*Design[\s\S]*Code/
  )
  assert.equal(await page.getByRole('textbox').count(), 0)
  console.log('PASS authoritative answer summary on remount')

  await reset()
  await page.getByRole('textbox').first().fill('A custom pace')
  await page.getByRole('textbox').last().fill('Documentation only')
  await submit().click()
  await page.getByRole('button', { name: 'Answers sent', exact: true }).waitFor()
  assert.deepEqual(
    (await requests())[0].answers.map((answer) => answer.selections),
    [[], []]
  )
  console.log('PASS text-only answers')

  await reset()
  await page.evaluate(() => {
    window.componentFail = true
  })
  await page.getByRole('textbox').first().fill('Keep my first answer')
  await page.getByRole('textbox').last().fill('Keep my second answer')
  await submit().click()
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByRole('textbox').first().inputValue(), 'Keep my first answer')
  assert.equal(await submit().isDisabled(), false)
  await page.evaluate(() => {
    window.componentFail = false
  })
  await submit().click()
  await page.getByRole('button', { name: 'Answers sent', exact: true }).waitFor()
  assert.equal((await requests()).length, 2)
  console.log('PASS submission failure preserves drafts and permits retry')

  await reset()
  await page.evaluate(() => {
    window.componentQuestions.recipientId = 'usr_other'
    window.renderComponents()
  })
  await page
    .getByText('Waiting for the person this question was sent to.', { exact: true })
    .waitFor()
  assert.equal(await page.getByRole('button').count(), 0)
  assert.equal(await page.getByRole('textbox').first().isDisabled(), true)
  console.log('PASS other recipients cannot answer')

  await reset()
  await page.clock.install()
  const endsAt = await page.evaluate(() => Date.parse(window.componentTimer.endsAt))
  await page.clock.setFixedTime(endsAt - 45_000)
  await page.evaluate(() => window.renderComponents())
  await page.getByRole('timer', { name: '0:45 remaining', exact: true }).waitFor()
  await page.clock.setFixedTime(endsAt + 1000)
  await page.evaluate(() => window.renderComponents())
  await page.getByRole('timer', { name: '0:00 remaining', exact: true }).waitFor()
  assert.equal(await page.getByText('Time’s up', { exact: true }).count(), 1)
  assert.deepEqual(await requests(), [])
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(
    await page
      .locator('circle')
      .last()
      .evaluate((el) => getComputedStyle(el).transitionProperty),
    'none'
  )
  console.log('PASS absolute timer on remount, expiry without client execution and reduced motion')

  await page.setViewportSize({ width: 320, height: 740 })
  await page.evaluate(() => {
    document.documentElement.classList.add('dark')
    window.componentQuestions.title = 'T'.repeat(200)
    window.componentQuestions.questions[0].options[0].label = 'A'.repeat(200)
    window.componentTimer.durationSeconds = 604800
    window.componentTimer.endsAt = new Date(Date.now() + 604800_000).toISOString()
    window.renderComponents()
  })
  await page.getByRole('timer', { name: '168:00:00 remaining', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.equal(
    await page
      .locator('[data-slot=card]')
      .evaluateAll((cards) => cards.every((card) => card.scrollWidth <= card.clientWidth)),
    true
  )
  await page.screenshot({
    path: '/tmp/taut-message-components-mobile.png',
    fullPage: true,
    animations: 'disabled'
  })
  console.log('PASS mobile/dark theme, long titles/choices and week-long timer')
  assert.deepEqual(errors, [])
  console.log('PASS all message component browser checks; no page errors')
} finally {
  await browser.close()
}
