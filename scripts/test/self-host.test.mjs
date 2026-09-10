import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const cli = resolve('scripts/self-host.mjs')
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
test('initialize isolated installations; rerunning never rotates encryption keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'taut-install-'))
  try {
    const first = join(root, 'first')
    const second = join(root, 'second')
    const result = run('init', first, '--port', '3081')
    assert.equal(result.status, 0, result.stderr)
    const secret = readFileSync(join(first, 'secrets.env'), 'utf8')
    assert.match(secret, /TAUT_MASTER_KEY=[A-Za-z0-9+/]{43}=/)
    assert.equal(statSync(join(first, 'secrets.env')).mode & 0o777, 0o600)
    assert.equal(run('init', first, '--port', '3081').status, 0)
    assert.equal(readFileSync(join(first, 'secrets.env'), 'utf8'), secret)
    assert.equal(run('init', second, '--port', '3082').status, 0)
    assert.notEqual(readFileSync(join(second, 'secrets.env'), 'utf8'), secret)
    const a = JSON.parse(readFileSync(join(first, 'compose.json')))
    const b = JSON.parse(readFileSync(join(second, 'compose.json')))
    assert.notEqual(a.name, b.name)
    assert.notEqual(a.services.taut.image, b.services.taut.image)
    assert.notEqual(
      a.services.taut.environment.TAUT_AGENT_IMAGE,
      b.services.taut.environment.TAUT_AGENT_IMAGE
    )
    assert.equal(a.services.taut.environment.TAUT_INSTANCE_ID, a.name)
    assert.equal(a.services.taut.environment.TAUT_MACHINE_PROVIDER, 'docker')
    const data = a.services.taut.volumes.find(
      (v) => v.type === 'bind' && v.target !== '/var/run/docker.sock'
    )
    assert.equal(data.source, data.target)
    assert.equal(data.source, a.services.taut.environment.TAUT_DATA_DIR)
    assert.equal(a.services.taut.environment.TAUT_COOKIE_SECURE, 'false')
    assert.equal(a.services.taut.environment.TAUT_PUBLIC_URL, 'http://localhost:3081')
    assert.equal(a.services.taut.environment.TAUT_AGENT_API_URL, 'http://taut-api:3000')
    assert.equal(a.services.taut.ports[0], '127.0.0.1:3081:3000')
    assert.ok(!JSON.stringify(a).includes(secret.split('=')[1]))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('reject invalid public URLs and ports before writing an installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'taut-invalid-'))
  try {
    for (const flags of [
      ['--port', '0'],
      ['--port', 'abc'],
      ['--url', 'javascript:alert(1)'],
      ['--url', 'https://example.com/path']
    ]) {
      const r = run('init', join(root, 'invalid'), ...flags)
      assert.notEqual(r.status, 0)
      assert.match(r.stderr, /port|URL/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('calls init requires reachable URLs and generates a self-contained stack', () => {
  const root = mkdtempSync(join(tmpdir(), 'taut-calls-'))
  try {
    assert.notEqual(run('init', join(root, 'missing'), '--calls').status, 0)
    const dir = join(root, 'complete')
    const r = run(
      'init',
      dir,
      '--url',
      'https://taut.example.com',
      '--calls',
      '--calls-url',
      'wss://calls.example.com',
      '--turn-host',
      'turn.example.com',
      '--turn-ip',
      '203.0.113.10'
    )
    assert.equal(r.status, 0, r.stderr)
    const spec = JSON.parse(readFileSync(join(dir, 'compose.json')))
    assert.ok(spec.services.livekit)
    assert.ok(spec.services.redis)
    assert.ok(spec.services.eturnal)
    assert.equal(spec.services.taut.environment.TAUT_LIVEKIT_URL, 'wss://calls.example.com')
    assert.equal(spec.services.taut.environment.TAUT_COOKIE_SECURE, 'true')
    assert.equal(spec.services.taut.environment.TAUT_PUBLIC_URL, 'https://taut.example.com')
    assert.match(readFileSync(join(dir, 'secrets.env'), 'utf8'), /TAUT_LIVEKIT_API_SECRET=/)
    assert.match(
      readFileSync(join(dir, 'livekit.yaml'), 'utf8'),
      /http:\/\/taut-api:3000\/api\/hooks\/livekit/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('failed backups remove partial secret archives and restart stopped agents', () => {
  const root = mkdtempSync(join(tmpdir(), 'taut-backup-'))
  try {
    const dir = join(root, 'install')
    assert.equal(run('init', dir).status, 0)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const log = join(root, 'commands')
    const mock = `#!${process.execPath}\nimport { appendFileSync, statSync, writeFileSync } from 'node:fs';\nconst args=process.argv.slice(2); appendFileSync(process.env.COMMAND_LOG, JSON.stringify(args)+'\\n');\nif(process.argv[1].endsWith('docker')){if(args[0]==='ps') console.log('agent-a');else if(args.includes('ps')) console.log('taut');}else{if((statSync(args[1]).mode&0o777)!==0o600)process.exit(9);writeFileSync(args[1],'partial-secret');process.exit(5);}\n`
    for (const name of ['docker', 'tar']) writeFileSync(join(bin, name), mock, { mode: 0o755 })
    const r = spawnSync(process.execPath, [cli, 'backup', dir], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log }
    })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /tar failed \(5\)/)
    const commands = readFileSync(log, 'utf8')
    assert.match(commands, /\["start","agent-a"\]/)
    assert.ok(!readdirSync(dir).some((name) => name.startsWith('backup-')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('refuses remote Docker hosts before attempting to mount local installation data', () => {
  const root = mkdtempSync(join(tmpdir(), 'taut-remote-'))
  try {
    assert.equal(run('init', root).status, 0)
    const r = spawnSync(process.execPath, [cli, 'up', root, '--skip-build'], {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, DOCKER_HOST: 'ssh://remote.example' }
    })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /local Docker/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
