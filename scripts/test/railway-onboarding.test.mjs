import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const image = process.env.TAUT_RAILWAY_TEST_IMAGE

test(
  'Railway shared image: onboarding, non-root agents, browser, and persistent replacement',
  { skip: !image, timeout: 240000 },
  async () => {
    const suffix = randomBytes(6).toString('hex')
    const name = `taut-railway-test-${suffix}`
    const volume = `${name}-data`
    const temp = mkdtempSync(join(tmpdir(), 'taut-railway-test-'))
    const env = { ...process.env, TAUT_MASTER_KEY: randomBytes(32).toString('base64') }
    const docker = (...args) => {
      const r = spawnSync('docker', args, { encoding: 'utf8', env, timeout: 90000 })
      assert.equal(r.status, 0, r.stderr || r.error?.message)
      return r.stdout.trim()
    }
    let base
    let cookie = ''
    const api = async (path, body, method = body ? 'POST' : 'GET') => {
      const r = await fetch(base + path, {
        method,
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Connection: 'close' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000)
      })
      assert.ok(r.ok, `${path}: ${r.status} ${await r.clone().text()}`)
      if (r.headers.getSetCookie().length)
        cookie = r.headers
          .getSetCookie()
          .map((c) => c.split(';')[0])
          .join('; ')
      return r.json()
    }
    const start = async () => {
      docker(
        'run',
        '-d',
        '--name',
        name,
        '-p',
        '127.0.0.1::3000',
        '-v',
        `${volume}:/data`,
        '-e',
        'TAUT_MASTER_KEY',
        '-e',
        'TAUT_COOKIE_SECURE=false',
        image
      )
      const info = JSON.parse(docker('inspect', name))[0]
      assert.equal(info.HostConfig.Privileged, false)
      assert.equal(info.Mounts.length, 1)
      base = `http://127.0.0.1:${info.NetworkSettings.Ports['3000/tcp'][0].HostPort}`
      const deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        try {
          if ((await api('/api/health')).ok) return
        } catch {}
        await new Promise((r) => setTimeout(r, 300))
      }
      assert.fail(`server did not become healthy: ${docker('logs', name)}`)
    }
    try {
      docker('volume', 'create', volume)
      await start()
      assert.equal(docker('exec', name, 'stat', '-c', '%u:%g:%a', '/data'), '1000:1000:700')
      const owner = await api('/api/auth/signup', {
        email: `${suffix}@railway.test`,
        name: 'Railway Owner',
        password: randomBytes(24).toString('base64')
      })
      const company = await api('/api/companies', {
        name: 'Railway Test',
        slug: `test-${suffix}`,
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
        role: 'Verification',
        mandate: 'Verify deployment',
        runtimeKind: 'claude-code',
        permissionMode: 'plan',
        browserAccess: true,
        departmentId: department.id
      })
      const machine = await api(`/api/agents/${agent.id}/machine/start`, undefined, 'POST')
      assert.equal(machine.provider, 'local')
      // Exercise the production runtime modules inside the image, including its actual
      // installed packages. No provider credentials or billable model requests are used.
      const require = createRequire(resolve('apps/server/package.json'))
      const { build } = createRequire(require.resolve('tsup'))('esbuild')
      const probe = join(temp, 'probe.mjs')
      await build({
        stdin: {
          contents: `
        import assert from 'node:assert/strict';
        import { existsSync } from 'node:fs';
        import { spawnSync } from 'node:child_process';
        import { Effect } from 'effect';
        import { makeLocalProvider } from './packages/runtime/src/machine/local.ts';
        import { ensureLocalBrowserDaemon, browserMcpSpec, hostChromiumExecutable } from './packages/runtime/src/browser.ts';
        assert.equal(process.getuid(), 1000);
        const homeDir = '/data/railway-probe';
        const machine = await Effect.runPromise(makeLocalProvider().ensure({agentId:'probe',companyId:'probe',companySlug:'probe',handle:'probe',homeDir,limits:{cpus:1,memoryMb:512},network:{egress:'allow-all'}}));
        for (const cmd of [['claude','--version'],['codex','--version'],['opencode','--version'],['node','--check','/opt/taut/mcp.js'],['node','--check','/opt/taut/cli.js']]) {
          const errors = [];
          const r = await Effect.runPromise(machine.exec({cmd,timeoutMs:30000,onStderr:l=>errors.push(l)}));
          assert.equal(r.exitCode,0,errors.join('\\n'));
        }
        const result = await Effect.runPromise(machine.exec({cmd:['node','-e',"require('node:fs').writeFileSync('marker.txt','persistent'); if(process.env.TAUT_MASTER_KEY)process.exit(2); fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(3)})"],timeoutMs:10000}));
        assert.equal(result.exitCode,0);
        const spec = browserMcpSpec({provider:'local',homeDir});
        assert.ok(existsSync(spec.args[0]),'local MCP resolves inside deployed package tree');
        const browser = await Effect.runPromise(ensureLocalBrowserDaemon({agentId:'probe',homeDir})).catch(error => { console.error(spawnSync(hostChromiumExecutable(), ['--headless','--no-sandbox','--user-data-dir='+homeDir+'/.taut/browser/profile','about:blank'], {encoding:'utf8',timeout:2000}).stderr); throw error; });
        assert.equal(browser.state,'started');
        const version = await (await fetch('http://127.0.0.1:'+browser.port+'/json/version')).json();
        assert.ok(version['User-Agent'].includes('HeadlessChrome'));
        assert.equal((await Effect.runPromise(ensureLocalBrowserDaemon({agentId:'probe',homeDir}))).state,'running');
        console.log('agent execution and browser passed');
      `,
          resolveDir: process.cwd(),
          loader: 'ts'
        },
        outfile: probe,
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external'
      })
      docker('cp', probe, `${name}:/app/railway-probe.mjs`)
      assert.match(
        docker('exec', '-u', '1000:1000', name, 'node', '/app/railway-probe.mjs'),
        /passed/
      )
      docker('stop', '-t', '10', name)
      docker('rm', name)
      await start()
      assert.equal((await api('/api/auth/me')).user.id, owner.user.id)
      assert.ok(JSON.stringify(await api('/api/companies')).includes(company.id))
      assert.equal((await api(`/api/agents/${agent.id}`)).agent.id, agent.id)
      assert.equal(
        docker('exec', '-u', '1000:1000', name, 'cat', '/data/railway-probe/marker.txt'),
        'persistent'
      )
      docker('cp', probe, `${name}:/app/railway-probe.mjs`)
      assert.match(
        docker('exec', '-u', '1000:1000', name, 'node', '/app/railway-probe.mjs'),
        /passed/
      )
    } finally {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
      spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' })
      rmSync(temp, { recursive: true, force: true })
    }
  }
)
