/* eslint-disable turbo/no-undeclared-env-vars -- Release scripts run directly, outside Turbo caching. */
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prepareRelease, stableVersion } from './prepare-release.mjs'

const args = process.argv.slice(2)
const release = args.includes('--release')
const unsigned = args.includes('--unsigned')
const arch = args.find((arg) => arg.startsWith('--arch='))?.slice(7) ?? process.arch
const fail = (message) => {
  console.error(message)
  process.exit(1)
}
if (
  release === unsigned ||
  !['arm64', 'x64'].includes(arch) ||
  args.some(
    (arg) => !['--release', '--unsigned', '--check', '--arch=arm64', '--arch=x64'].includes(arg)
  )
) {
  fail('Usage: node scripts/package-mac.mjs (--release | --unsigned) [--arch=arm64|x64] [--check]')
}
const cwd = fileURLToPath(new URL('../', import.meta.url))
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (
  release &&
  (!stableVersion.test(version) ||
    (process.env.GITHUB_REF_TYPE === 'tag' &&
      !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(process.env.GITHUB_REF_NAME ?? '')))
) {
  fail(
    'Release version and tag must use stable semver (e.g. 1.0.0 and v1.0.0); prereleases are unsupported'
  )
}
if (
  release &&
  process.env.GITHUB_REF_TYPE === 'tag' &&
  process.env.GITHUB_REF_NAME !== `v${version}`
) {
  fail(`Release tag does not match desktop version v${version}`)
}
if (release) {
  const present = (key) => Boolean(process.env[key]?.trim())
  const missing = ['CSC_LINK', 'CSC_KEY_PASSWORD'].filter((key) => !present(key))
  if (missing.length) fail(`Missing release credentials: ${missing.join(', ')}`)
  const appleId = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
  const apiKey = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
  const methods = [
    { selected: appleId.slice(0, 2).some(present), required: appleId },
    { selected: apiKey.some(present), required: apiKey },
    {
      selected: ['APPLE_KEYCHAIN_PROFILE', 'APPLE_KEYCHAIN'].some(present),
      required: ['APPLE_KEYCHAIN_PROFILE']
    }
  ].filter((method) => method.selected)
  if (methods.length > 1)
    fail('Configure only one notarization method: Apple ID, API key or Keychain profile')
  const notarizationMissing = (methods[0]?.required ?? appleId).filter((key) => !present(key))
  if (notarizationMissing.length)
    fail(`Missing release credentials: ${notarizationMissing.join(', ')}`)
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false')
    fail('Release signing cannot disable identity discovery')
}
const mode = release ? 'release' : 'unsigned'
const repository = process.env.GITHUB_REPOSITORY ?? 'Thiagoxp95/taut'
if (release && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  fail('GITHUB_REPOSITORY must be an owner/repository name')
}
console.log(`${mode} macOS ${arch} preflight passed`)
if (args.includes('--check')) process.exit(0)
if (process.platform !== 'darwin')
  fail('macOS packaging requires a Mac with Xcode command line tools')
const env = { ...process.env }
if (unsigned) {
  for (const key of Object.keys(env))
    if (key.startsWith('CSC_') || key.startsWith('APPLE_')) delete env[key]
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
}
for (const command of [
  ['run', 'build'],
  [
    'exec',
    'electron-builder',
    '--config',
    `electron-builder.${mode}.yml`,
    '--mac',
    `--${arch}`,
    '--publish',
    'never',
    ...(release
      ? [`--config.publish.url=https://github.com/${repository}/releases/latest/download`]
      : [])
  ]
]) {
  const result = spawnSync('pnpm', command, { cwd, env, stdio: 'inherit' })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (release) {
  await prepareRelease({ directory: `${cwd}/dist/release`, version, arch })
}
