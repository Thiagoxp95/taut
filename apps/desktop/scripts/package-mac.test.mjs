/* eslint-disable turbo/no-undeclared-env-vars -- Release scripts run directly, outside Turbo caching. */
import process from 'node:process'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const script = new URL('./package-mac.mjs', import.meta.url)
const run = (args, env = {}) =>
  spawnSync(process.execPath, [script.pathname, '--check', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env }
  })

test('release fails before building when signing credentials are absent', () => {
  const result = run(['--release'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Missing release credentials: CSC_LINK/)
})

test('release requires all notarization credentials', () => {
  const result = run(['--release'], { CSC_LINK: 'certificate.p12', CSC_KEY_PASSWORD: 'password' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID/)
})

test('unsigned builds require no credentials and accept both Mac architectures', () => {
  for (const arch of ['arm64', 'x64']) {
    const result = run(['--unsigned', `--arch=${arch}`])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, new RegExp(`unsigned macOS ${arch} preflight passed`))
  }
})

test('release preflight accepts complete credentials without leaking them', () => {
  const env = Object.fromEntries(
    [
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_TEAM_ID'
    ].map((key) => [key, 'secret-value'])
  )
  const result = run(['--release', '--arch=x64'], env)
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout + result.stderr, /secret-value/)
})

test('release accepts API key and Keychain notarization without an Apple account password', () => {
  for (const notarization of [
    { APPLE_API_KEY: 'private-key.p8', APPLE_API_KEY_ID: 'KEYID', APPLE_API_ISSUER: 'issuer-id' },
    { APPLE_KEYCHAIN_PROFILE: 'release-profile' }
  ]) {
    const result = run(['--release'], {
      CSC_LINK: 'certificate.p12',
      CSC_KEY_PASSWORD: 'certificate-password',
      ...notarization
    })
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout + result.stderr, /certificate-password|private-key.p8/)
  }
})

test('release rejects incomplete and competing notarization methods before building', () => {
  for (const notarization of [
    { APPLE_API_KEY: 'private-key.p8', APPLE_API_KEY_ID: 'KEYID' },
    { APPLE_KEYCHAIN: 'login.keychain-db' },
    {
      APPLE_ID: 'account@example.test',
      APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
      APPLE_TEAM_ID: 'TEAMID',
      APPLE_KEYCHAIN_PROFILE: 'release-profile'
    }
  ]) {
    const result = run(['--release'], {
      CSC_LINK: 'certificate.p12',
      CSC_KEY_PASSWORD: 'certificate-password',
      ...notarization
    })
    assert.notEqual(result.status, 0)
  }
})

test('an explicit mode and supported architecture are required', () => {
  for (const args of [
    [],
    ['--unsigned', '--arch=universal'],
    ['--unsigned', '--release'],
    ['--unsigned', '--publish=always']
  ]) {
    const result = run(args)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Usage:/)
  }
})

test('tagged releases must match the desktop version', () => {
  const result = run(['--release'], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v999.0.0' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not match desktop version/)
})

test('rejects malformed and prerelease tags before requesting credentials', () => {
  for (const tag of ['v1.0.0-beta.1', 'v01.0.0', 'v1.0', 'v1.0.0+build']) {
    const result = run(['--release'], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /stable semver/)
  }
})

test('fork releases accept an owner/repository feed and reject malformed names', () => {
  const credentials = {
    CSC_LINK: 'certificate.p12',
    CSC_KEY_PASSWORD: 'password',
    APPLE_KEYCHAIN_PROFILE: 'profile'
  }
  assert.equal(
    run(['--release'], { ...credentials, GITHUB_REPOSITORY: 'fork-owner/taut-fork' }).status,
    0
  )
  const result = run(['--release'], { ...credentials, GITHUB_REPOSITORY: '../bad/path' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /owner\/repository/)
})
