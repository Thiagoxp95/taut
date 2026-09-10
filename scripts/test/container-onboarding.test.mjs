import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const dir = process.env.TAUT_SELF_HOST_TEST_DIR
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60000 })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return result.stdout.trim()
}

test(
  'container installation provisions an agent with persistent files and API access',
  { skip: !dir, timeout: 180000 },
  async () => {
    const installation = JSON.parse(readFileSync(join(dir, 'installation.json')))
    const base = `http://127.0.0.1:${installation.port}`
    let cookie = ''
    const api = async (path, body, method = body ? 'POST' : 'GET') => {
      const result = await fetch(base + path, {
        method,
        // Do not retain a client-side socket across the deliberate server restart.
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Connection: 'close' },
        body: body ? JSON.stringify(body) : undefined
      })
      assert.ok(result.ok, `${path}: ${result.status} ${await result.clone().text()}`)
      if (result.headers.getSetCookie().length)
        cookie = result.headers
          .getSetCookie()
          .map((c) => c.split(';')[0])
          .join('; ')
      return result.json()
    }
    const token = randomBytes(6).toString('hex')
    const owner = await api('/api/auth/signup', {
      email: `${token}@container.test`,
      name: 'Container Owner',
      password: randomBytes(24).toString('base64')
    })
    const company = await api('/api/companies', {
      name: 'Container Test',
      slug: `test-${token}`,
      avatar: { kind: 'emoji', value: '🏢' }
    })
    const department = await api('/api/departments', {
      name: 'Engineering',
      slug: 'engineering',
      headUserId: owner.user.id
    })
    const agent = await api('/api/agents', {
      handle: 'probe',
      name: 'Probe',
      avatar: { kind: 'emoji', value: '🤖' },
      role: 'Deployment verification',
      mandate: 'Verify deployment',
      runtimeKind: 'claude-code',
      permissionMode: 'plan',
      departmentId: department.id
    })
    await api(`/api/agents/${agent.id}/machine/start`, undefined, 'POST')
    const name = `taut-${installation.id}--test-${token}-probe`
    const marker = randomBytes(16).toString('hex')
    docker(
      'exec',
      name,
      'node',
      '-e',
      `require('node:fs').writeFileSync('/home/agent/self-host-smoke.txt', ${JSON.stringify(marker)})`
    )
    const info = JSON.parse(docker('inspect', name))[0]
    assert.equal(info.Config.Labels['taut.instance'], installation.id)
    const home = info.HostConfig.Binds[0].split(':')[0]
    assert.equal(
      docker(
        'compose',
        '-f',
        join(dir, 'compose.json'),
        'exec',
        '-T',
        'taut',
        'node',
        '-e',
        `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(home, 'self-host-smoke.txt'))}, 'utf8'))`
      ),
      marker
    )
    const health = docker(
      'exec',
      name,
      'node',
      '-e',
      "fetch('http://taut-api:3000/api/health').then(async r=>{if(!r.ok)process.exit(1);console.log((await r.json()).ok)}).catch(()=>process.exit(1))"
    )
    assert.equal(health, 'true')
    docker('compose', '-f', join(dir, 'compose.json'), 'restart', 'taut')
    // Compose's wait is the health gate after restart; no guessed delay.
    docker(
      'compose',
      '-f',
      join(dir, 'compose.json'),
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '120'
    )
    assert.equal((await api('/api/auth/me')).user.id, owner.user.id)
    assert.ok(JSON.stringify(await api('/api/companies')).includes(company.id))
    assert.equal(docker('exec', name, 'cat', '/home/agent/self-host-smoke.txt'), marker)
  }
)
