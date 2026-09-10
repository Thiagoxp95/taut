import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'

import { CREDENTIAL_RECIPE } from '../src/lib/runtime-meta.ts'

const empty = { claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } }
const valid = {
  claudeAiOauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh' },
  mcpOAuth: { unrelated: { clientSecret: 'must-not-copy' } }
}

function runRecipe({
  keychain = empty,
  file,
  afterLogin,
  loginExit = 0,
  clipboardFails = false
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'taut-claude-login-'))
  try {
    const script = (name, body) =>
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 })
    writeFileSync(join(dir, 'keychain.json'), JSON.stringify(keychain))
    if (file) writeFileSync(join(dir, '.credentials.json'), JSON.stringify(file))
    if (afterLogin) writeFileSync(join(dir, 'after.json'), JSON.stringify(afterLogin))
    script('security', 'cat "$CLAUDE_CONFIG_DIR/keychain.json"')
    script(
      'claude',
      `
if [ "$1 $2" = "auth status" ]; then exit 0; fi
if [ "$1 $2" != "auth login" ]; then exit 2; fi
if [ -f "$CLAUDE_CONFIG_DIR/after.json" ]; then cp "$CLAUDE_CONFIG_DIR/after.json" "$CLAUDE_CONFIG_DIR/keychain.json"; fi
exit ${loginExit}`
    )
    script(
      'pbcopy',
      clipboardFails ? 'cat >/dev/null; exit 1' : 'cat > "$CLAUDE_CONFIG_DIR/clipboard"'
    )
    script('wl-copy', 'cat > "$CLAUDE_CONFIG_DIR/clipboard"')
    script('xclip', 'exit 1')
    const result = spawnSync('/bin/sh', ['-c', CREDENTIAL_RECIPE['claude.login'].command], {
      // The fixture binaries must precede the host tools for this shell integration test.
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: dir },
      encoding: 'utf8',
      timeout: 5000
    })
    let copied
    try {
      copied = JSON.parse(
        Buffer.from(readFileSync(join(dir, 'clipboard'), 'utf8'), 'base64').toString()
      )
    } catch {
      // Failed exports deliberately leave the clipboard untouched.
    }
    return { ...result, copied }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('empty stored tokens trigger login even when auth status succeeds', () => {
  const result = runRecipe({ afterLogin: valid })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.copied, { claudeAiOauth: valid.claudeAiOauth })
})

test('empty keychain entry falls back to a usable credentials file', () => {
  const result = runRecipe({ file: valid, loginExit: 1 })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.copied, { claudeAiOauth: valid.claudeAiOauth })
})

test('login with no exportable tokens fails without copying credentials', () => {
  const result = runRecipe()
  assert.notEqual(result.status, 0)
  assert.equal(result.copied, undefined)
  assert.match(result.stderr, /setup-token/)
})

test('cancelled login fails without copying credentials', () => {
  const result = runRecipe({ loginExit: 1 })
  assert.notEqual(result.status, 0)
  assert.equal(result.copied, undefined)
})

test('clipboard fallback receives the complete sanitized login', () => {
  const result = runRecipe({ keychain: valid, clipboardFails: true })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.copied, { claudeAiOauth: valid.claudeAiOauth })
})
