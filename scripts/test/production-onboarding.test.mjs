import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  copyFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'

test(
  'production onboarding survives restart and installer backup/restore',
  { timeout: 60000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'taut-production-'))
    const installation = join(root, 'installation')
    const initialized = spawnSync(
      process.execPath,
      ['scripts/self-host.mjs', 'init', installation],
      { encoding: 'utf8' }
    )
    assert.equal(initialized.status, 0, initialized.stderr)
    const data = JSON.parse(readFileSync(join(installation, 'installation.json'))).data
    const socket = createServer()
    await new Promise((r) => socket.listen(0, '127.0.0.1', r))
    const port = socket.address().port
    await new Promise((r) => socket.close(r))
    const base = `http://127.0.0.1:${port}`
    let child
    let output = ''
    let cookie = ''
    const key = readFileSync(join(installation, 'secrets.env'), 'utf8')
      .trim()
      .slice('TAUT_MASTER_KEY='.length)
    const start = async () => {
      child = spawn(process.execPath, ['dist/main.js'], {
        cwd: resolve('apps/server'),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          PORT: String(port),
          TAUT_MASTER_KEY: key,
          TAUT_DATA_DIR: data,
          TAUT_WEB_DIST: resolve('apps/web/dist'),
          TAUT_COOKIE_SECURE: 'false',
          TAUT_MACHINE_PROVIDER: 'local',
          TAUT_DEV_HOST_LOGIN: 'false'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child.stdout.on('data', (b) => {
        output += b
      })
      child.stderr.on('data', (b) => {
        output += b
      })
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(`Production server exited: ${output}`)
        try {
          if ((await fetch(`${base}/api/health`)).ok) return
        } catch {}
        await delay(100)
      }
      throw new Error(`Production startup timed out: ${output}`)
    }
    const stop = async () => {
      if (!child || child.exitCode !== null) return
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timer)
    }
    const api = async (path, body) => {
      const res = await fetch(base + path, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: body ? JSON.stringify(body) : undefined
      })
      assert.ok(res.ok, `${path}: ${res.status} ${await res.clone().text()}`)
      const cookies = res.headers.getSetCookie()
      if (cookies.length) cookie = cookies.map((c) => c.split(';')[0]).join('; ')
      return res.json()
    }
    try {
      await start()
      for (const route of ['/', '/signup', '/onboarding']) {
        const res = await fetch(base + route)
        assert.match(res.headers.get('content-type'), /text\/html/)
        assert.match(await res.text(), /<div id="root">/)
      }
      const signup = await api('/api/auth/signup', {
        email: 'owner@production.test',
        name: 'Owner',
        password: randomBytes(24).toString('base64')
      })
      assert.ok(signup.user.id)
      const company = await api('/api/companies', {
        slug: 'production-test',
        name: 'Production Test',
        avatar: { kind: 'emoji', value: '🏢' }
      })
      assert.ok(company.id)
      const before = await api('/api/auth/me')
      await stop()
      await start()
      const after = await api('/api/auth/me')
      assert.equal(after.user.id, before.user.id)
      const companies = await api('/api/companies')
      assert.ok(JSON.stringify(companies).includes(company.id))
      await stop()
      // Exercise the real backup/archive/restore against a stopped production DB.
      // Only daemon discovery is stubbed; this test does not prove container lifecycle.
      const bin = join(root, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const backup = spawnSync(
        process.execPath,
        ['scripts/self-host.mjs', 'backup', installation],
        { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }
      )
      assert.equal(backup.status, 0, backup.stderr)
      const archive = readdirSync(installation).find((name) => name.startsWith('backup-'))
      assert.ok(archive)
      const saved = join(root, 'saved.tar.gz')
      copyFileSync(join(installation, archive), saved)
      rmSync(installation, { recursive: true })
      mkdirSync(installation, { mode: 0o700 })
      const restore = spawnSync('tar', ['-xzf', saved, '-C', installation], { encoding: 'utf8' })
      assert.equal(restore.status, 0, restore.stderr)
      assert.equal(
        readFileSync(join(installation, 'secrets.env'), 'utf8').trim(),
        `TAUT_MASTER_KEY=${key}`
      )
      await start()
      assert.equal((await api('/api/auth/me')).user.id, signup.user.id)
      assert.ok(JSON.stringify(await api('/api/companies')).includes(company.id))
    } finally {
      await stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
