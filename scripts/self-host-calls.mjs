import { randomBytes } from 'node:crypto'
import { isIPv4 } from 'node:net'
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

export function validateCalls(values) {
  if (!values.calls) return
  if (!values.url) throw new Error('calls requires --url https://taut.example.com')
  if (!values['calls-url']) throw new Error('calls requires --calls-url wss://calls.example.com')
  const url = new URL(values['calls-url'])
  if (
    url.protocol !== 'wss:' ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('calls URL must be a wss:// origin')
  if (!/^[a-zA-Z0-9.-]+$/.test(values['turn-host'] ?? ''))
    throw new Error('calls requires --turn-host with a public hostname')
  if (!isIPv4(values['turn-ip'] ?? ''))
    throw new Error('calls requires --turn-ip with the public IPv4')
}

export function addCalls(spec, dir, repo, values) {
  const key = randomBytes(16).toString('hex')
  const secret = randomBytes(32).toString('hex')
  const turn = randomBytes(32).toString('hex')
  appendFileSync(
    join(dir, 'secrets.env'),
    `TAUT_LIVEKIT_API_KEY=${key}\nTAUT_LIVEKIT_API_SECRET=${secret}\n`
  )
  Object.assign(spec.services.taut.environment, {
    TAUT_LIVEKIT_URL: new URL(values['calls-url']).origin,
    TAUT_LIVEKIT_INTERNAL_URL: 'http://livekit:7880'
  })
  const config = {
    port: 7880,
    rtc: {
      tcp_port: 7881,
      udp_port: 7882,
      use_external_ip: true,
      turn_servers: ['udp', 'tcp'].map((protocol) => ({
        host: values['turn-host'],
        port: 3478,
        protocol,
        secret: turn
      }))
    },
    redis: { address: 'redis:6379' },
    keys: { [key]: secret },
    webhook: { api_key: key, urls: ['http://taut-api:3000/api/hooks/livekit'] },
    turn: { enabled: false }
  }
  // JSON is a YAML subset accepted by LiveKit's YAML loader.
  writeFileSync(join(dir, 'livekit.yaml'), JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx'
  })
  writeFileSync(join(dir, 'eturnal.yaml'), readFileSync(join(repo, 'deploy/eturnal.yml')), {
    mode: 0o644,
    flag: 'wx'
  })
  writeFileSync(
    join(dir, 'turn.env'),
    `ETURNAL_SECRET=${turn}\nETURNAL_RELAY_IPV4_ADDR=${values['turn-ip']}\n`,
    { mode: 0o600, flag: 'wx' }
  )
  const common = { restart: 'unless-stopped', networks: ['api'] }
  spec.services.livekit = {
    ...common,
    image: 'livekit/livekit-server:v1.13.6',
    command: ['--config', '/etc/livekit.yaml'],
    volumes: ['./livekit.yaml:/etc/livekit.yaml:ro'],
    ports: ['127.0.0.1:7880:7880', '7881:7881', '7882:7882/udp'],
    depends_on: ['redis']
  }
  spec.services.redis = { ...common, image: 'redis:8.8-alpine', volumes: ['calls-redis:/data'] }
  spec.services.eturnal = {
    ...common,
    image: 'eturnal/eturnal:1.12.2-alpine',
    env_file: ['./turn.env'],
    environment: { ETURNAL_RELAY_MIN_PORT: '49160', ETURNAL_RELAY_MAX_PORT: '49200' },
    volumes: ['./eturnal.yaml:/etc/eturnal.yml:ro'],
    ports: ['3478:3478', '3478:3478/udp', '49160-49200:49160-49200/udp']
  }
  spec.volumes = { 'calls-redis': {} }
}
