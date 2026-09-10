import { createServer } from 'node:http'
import type { ClaudeDesktopLogin } from '@taut/contract/desktop'
import { CLAUDE_LOGIN_PORT } from '@taut/contract/desktop'

/** One browser-initiated login, reachable only on loopback by its initiating origin. */
export async function serveClaudeBrowserLogin(options: {
  origin: string
  nonce: string
  port?: number
  signIn: (options: { signal: AbortSignal }) => Promise<ClaudeDesktopLogin>
}): Promise<{ port: number; cancel: () => void; finished: Promise<void> }> {
  if (!/^[a-f0-9]{64}$/.test(options.nonce) || new URL(options.origin).origin !== options.origin) {
    throw new Error('Invalid sign-in request.')
  }
  const controller = new AbortController()
  let result:
    | { status: 'pending' }
    | { status: 'connected'; login: ClaudeDesktopLogin }
    | { status: 'error'; message: string } = { status: 'pending' }
  let stopped = false
  let port = 0
  let resolveFinished: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve
  })
  const stop = () => {
    if (stopped) return
    stopped = true
    result = { status: 'pending' }
    clearTimeout(timer)
    controller.abort()
    server.close(() => resolveFinished())
    server.closeIdleConnections()
  }
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (request.headers.origin !== options.origin || request.headers.host !== `127.0.0.1:${port}`) {
      response.writeHead(403).end()
      return
    }
    response.setHeader('Access-Control-Allow-Origin', options.origin)
    response.setHeader('Vary', 'Origin')
    if (request.url !== `/claude-login/${options.nonce}` || stopped) {
      response.writeHead(404).end()
      return
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS')
      response.setHeader('Access-Control-Allow-Private-Network', 'true')
      response.writeHead(204).end()
      return
    }
    if (request.method === 'DELETE') {
      response.writeHead(204).end()
      stop()
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405).end()
      return
    }
    const body = JSON.stringify(result)
    const complete = result.status !== 'pending'
    response.setHeader('Content-Type', 'application/json')
    response.end(body)
    if (complete) stop()
  })
  server.requestTimeout = 10000
  server.headersTimeout = 10000
  const timer = setTimeout(stop, 5 * 60 * 1000)
  timer.unref()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? CLAUDE_LOGIN_PORT, '127.0.0.1', () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Could not open sign-in callback.'))
          return
        }
        port = address.port
        resolve()
      })
    })
  } catch {
    clearTimeout(timer)
    throw new Error('The local sign-in port is busy. Close the other sign-in window and try again.')
  }
  void options.signIn({ signal: controller.signal }).then(
    (login) => {
      if (!stopped) result = { status: 'connected', login }
    },
    () => {
      if (!stopped)
        result = {
          status: 'error',
          message:
            'Claude sign-in did not finish. Check that Claude Code is installed and try again.'
        }
    }
  )
  return { port, cancel: stop, finished }
}
