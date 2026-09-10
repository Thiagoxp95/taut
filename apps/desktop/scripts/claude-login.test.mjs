import assert from 'node:assert/strict'
import process from 'node:process'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signInToClaude } from '../src/main/claude-login.ts'

async function fixture(mode, run) {
  const dir = await mkdtemp(join(tmpdir(), 'taut-login-test-'))
  const capture = join(dir, 'capture')
  const file = join(dir, 'claude.mjs')
  await writeFile(
    file,
    `
    import {writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify({config:process.env.CLAUDE_CONFIG_DIR, args:process.argv.slice(2)}));
    if (${JSON.stringify(mode)} === 'wait') { setInterval(()=>{},100); }
    else if (${JSON.stringify(mode)} === 'fail') { console.error('private-output-must-not-leak'); process.exit(1); }
    else {
      writeFileSync(join(process.env.CLAUDE_CONFIG_DIR,'.credentials.json'),JSON.stringify({
        claudeAiOauth:{accessToken:${JSON.stringify(mode === 'empty' ? '' : 'fake-access')},refreshToken:'fake-refresh'},
        mcpOAuth:{secret:'must-not-transfer'}
      }));
    }
  `
  )
  try {
    await run({ executable: process.execPath, args: [file] }, capture)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('browser sign-in captures only Claude credentials and removes its isolated config', async () => {
  await fixture('ok', async (command, capture) => {
    const result = await signInToClaude({ command })
    assert.equal(result.kind, 'claude.login')
    assert.deepEqual(JSON.parse(result.secret), {
      claudeAiOauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh' }
    })
    const recorded = JSON.parse(await readFile(capture, 'utf8'))
    assert.deepEqual(recorded.args, ['auth', 'login', '--claudeai'])
    await assert.rejects(readFile(join(recorded.config, '.credentials.json')), { code: 'ENOENT' })
  })
})

test('empty tokens are rejected after sign-in', async () => {
  await fixture('empty', async (command) => {
    await assert.rejects(signInToClaude({ command }), /usable Claude login/)
  })
})

test('failed sign-in never exposes CLI output', async () => {
  await fixture('fail', async (command) => {
    await assert.rejects(signInToClaude({ command }), /^Error: Claude sign-in did not finish\./)
  })
})

test('cancel closes the login process and cleans its config', async () => {
  await fixture('wait', async (command, capture) => {
    const controller = new AbortController()
    const result = signInToClaude({ command, signal: controller.signal })
    const rejected = assert.rejects(result, /cancelled/)
    for (let i = 0; i < 100; i++) {
      try {
        await readFile(capture)
        break
      } catch {
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    controller.abort()
    await rejected
    const recorded = JSON.parse(await readFile(capture, 'utf8'))
    await assert.rejects(readFile(recorded.config), { code: 'ENOENT' })
  })
})
