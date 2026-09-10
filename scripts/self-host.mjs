#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  realpathSync,
  rmSync
} from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { addCalls, validateCalls } from './self-host-calls.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const usage =
  'Usage: node scripts/self-host.mjs <init|up|status|stop|backup> <installation-directory> [--port 3080] [--url https://taut.example.com]'
const exec = (bin, args, options = {}) => {
  const result = spawnSync(bin, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${bin} failed (${result.status})`)
  return result
}
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', default: '3080' },
      url: { type: 'string' },
      'skip-build': { type: 'boolean' },
      calls: { type: 'boolean' },
      'calls-url': { type: 'string' },
      'turn-host': { type: 'string' },
      'turn-ip': { type: 'string' }
    }
  })
  const [command, destination] = positionals
  if (
    !destination ||
    positionals.length !== 2 ||
    !['init', 'up', 'status', 'stop', 'backup'].includes(command)
  )
    throw new Error(usage)
  const dir = resolve(destination)
  // Compose interpolates dollar signs even inside JSON strings; volume syntax also reserves colons.
  if (/[$\n\r:,]/.test(dir))
    throw new Error('Installation path cannot contain dollar signs, colons, commas, or newlines')
  const manifest = join(dir, 'installation.json')
  const composePath = join(dir, 'compose.json')
  const compose = (...args) => exec('docker', ['compose', '-f', composePath, ...args], { cwd: dir })
  if (command === 'init') {
    validateCalls(values)
    const port = Number(values.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('port must be an integer from 1 to 65535')
    let publicUrl = `http://localhost:${port}`
    if (values.url) {
      const url = new URL(values.url)
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw new Error('URL must be an HTTPS origin without credentials, path, query, or fragment')
      publicUrl = url.origin
    }
    if (existsSync(manifest)) {
      if (!existsSync(join(dir, 'secrets.env')) || !existsSync(composePath))
        throw new Error(
          'Incomplete installation: restore missing configuration from backup; refusing to rotate secrets'
        )
      console.log(`Existing installation preserved: ${dir}\n${read(manifest).url}`)
    } else {
      if (existsSync(join(dir, 'secrets.env')) || existsSync(composePath))
        throw new Error(
          'Installation files already exist without a manifest; refusing to overwrite'
        )
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const canonicalDir = realpathSync(dir)
      if (/[$\n\r:,]/.test(canonicalDir))
        throw new Error('Canonical installation path contains reserved characters')
      const data = join(canonicalDir, 'data')
      mkdirSync(data, { mode: 0o700 })
      const id = `taut-${randomBytes(6).toString('hex')}`
      writeFileSync(
        join(dir, 'secrets.env'),
        `TAUT_MASTER_KEY=${randomBytes(32).toString('base64')}\n`,
        { mode: 0o600, flag: 'wx' }
      )
      const spec = {
        name: id,
        services: {
          taut: {
            image: `taut/server:${id}`,
            restart: 'unless-stopped',
            ports: [`127.0.0.1:${port}:3000`],
            env_file: ['./secrets.env'],
            environment: {
              NODE_ENV: 'production',
              PORT: '3000',
              TAUT_DATA_DIR: data,
              TAUT_INSTANCE_ID: id,
              TAUT_DOCKER_NETWORK: `${id}-api`,
              TAUT_MACHINE_PROVIDER: 'docker',
              TAUT_AGENT_IMAGE: `taut/agent:${id}`,
              TAUT_PUBLIC_URL: publicUrl,
              TAUT_AGENT_API_URL: 'http://taut-api:3000',
              TAUT_COOKIE_SECURE: String(publicUrl.startsWith('https:')),
              TAUT_MCP_COMMAND: 'node /opt/taut/mcp.js'
            },
            volumes: [
              { type: 'bind', source: data, target: data },
              { type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }
            ],
            group_add: [
              String(existsSync('/var/run/docker.sock') ? statSync('/var/run/docker.sock').gid : 0)
            ],
            networks: { api: { aliases: ['taut-api'] } },
            healthcheck: {
              test: [
                'CMD',
                'node',
                '-e',
                "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
              ],
              interval: '10s',
              timeout: '5s',
              retries: 12,
              start_period: '30s'
            }
          }
        },
        networks: { api: { name: `${id}-api`, labels: { 'taut.instance': id } } }
      }
      if (values.calls) addCalls(spec, dir, repo, values)
      writeFileSync(composePath, JSON.stringify(spec, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      writeFileSync(
        manifest,
        JSON.stringify(
          { schemaVersion: 1, id, url: publicUrl, port, data, calls: !!values.calls },
          null,
          2
        ) + '\n',
        { mode: 0o600, flag: 'wx' }
      )
      console.log(
        `Initialized ${id} at ${dir}\nRun: node scripts/self-host.mjs up ${JSON.stringify(dir)}\nOpen: ${publicUrl}`
      )
    }
  } else {
    const installation = read(manifest)
    if (command === 'up') {
      const endpoint =
        process.env.DOCKER_HOST ??
        exec('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
          timeout: 10000
        }).stdout.trim()
      if (!endpoint.startsWith('unix://'))
        throw new Error(
          'Self-host requires a local Docker daemon; remote contexts cannot mount these data files'
        )
      exec('docker', ['info'], { stdio: 'ignore', timeout: 30000 })
      const specification = read(composePath)
      const serverImage = specification.services.taut.image
      const agentImage = specification.services.taut.environment.TAUT_AGENT_IMAGE
      if (!values['skip-build']) {
        exec('docker', ['build', '-t', serverImage, repo])
        exec('docker', [
          'build',
          '-f',
          join(repo, 'packages/runtime/docker/agent.Dockerfile'),
          '-t',
          agentImage,
          repo
        ])
      }
      // Only the new installation's data root; never recursively chown user files.
      exec('docker', [
        'run',
        '--rm',
        '--user',
        '0:0',
        '--entrypoint',
        'chown',
        '--mount',
        `type=bind,source=${installation.data},target=/installation-data`,
        serverImage,
        '1000:1000',
        '/installation-data'
      ])
      // Docker Desktop's socket group inside its VM may differ from the macOS socket.
      const socketGroup = exec(
        'docker',
        [
          'run',
          '--rm',
          '--user',
          '0:0',
          '--entrypoint',
          'stat',
          '--mount',
          'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
          serverImage,
          '-c',
          '%g',
          '/var/run/docker.sock'
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 30000 }
      ).stdout.trim()
      if (!/^\d+$/.test(socketGroup)) throw new Error('Cannot determine Docker socket group')
      specification.services.taut.group_add = [socketGroup]
      writeFileSync(composePath, JSON.stringify(specification, null, 2) + '\n')
      compose('up', '-d', '--wait', '--wait-timeout', '180')
      console.log(`Taut is ready: ${installation.url}\nCreate your account, then your company.`)
    } else if (command === 'status') compose('ps')
    else if (command === 'stop') {
      compose('stop')
      const agents = spawnSync(
        'docker',
        ['ps', '-q', '--filter', `label=taut.instance=${installation.id}`],
        { encoding: 'utf8' }
      )
      if (agents.status !== 0) throw new Error('Cannot determine running agents')
      const ids = agents.stdout.trim().split(/\s+/).filter(Boolean)
      if (ids.length) exec('docker', ['stop', ...ids])
    } else {
      const backup = join(dir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`)
      const ps = spawnSync(
        'docker',
        ['compose', '-f', composePath, 'ps', '--status', 'running', '--services'],
        { encoding: 'utf8' }
      )
      if (ps.status !== 0) throw new Error('Cannot determine installation state')
      const running = ps.stdout.trim().split('\n').includes('taut')
      if (running) compose('stop', 'taut')
      try {
        // Agents must stop too: their homes are part of the archive.
        const agents = spawnSync(
          'docker',
          ['ps', '-q', '--filter', `label=taut.instance=${installation.id}`],
          { encoding: 'utf8' }
        )
        if (agents.status !== 0) throw new Error('Cannot determine running agents')
        const ids = agents.stdout.trim().split(/\s+/).filter(Boolean)
        try {
          if (ids.length) exec('docker', ['stop', ...ids])
          writeFileSync(backup, '', { mode: 0o600, flag: 'wx' })
          exec('tar', [
            '-czf',
            backup,
            '-C',
            dir,
            'installation.json',
            'compose.json',
            'secrets.env',
            'data',
            ...(installation.calls ? ['livekit.yaml', 'eturnal.yaml', 'turn.env'] : [])
          ])
        } catch (error) {
          rmSync(backup, { force: true })
          throw error
        } finally {
          if (ids.length) exec('docker', ['start', ...ids])
        }
      } finally {
        if (running) compose('start', 'taut')
      }
      exec('chmod', ['600', backup])
      console.log(`Backup (includes encryption key): ${backup}`)
    }
  }
} catch (error) {
  console.error(`self-host: ${error.message}`)
  process.exitCode = 1
}
