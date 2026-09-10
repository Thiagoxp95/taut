import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ClaudeDesktopLogin } from '@taut/contract/desktop'

const execute = promisify(execFile)
const LOGIN_TIMEOUT = 5 * 60 * 1000

async function claudeExecutable(): Promise<string> {
  for (const path of [
    join(homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ]) {
    try {
      await access(path, constants.X_OK)
      return path
    } catch {
      /* Try the next installation. */
    }
  }
  return 'claude'
}

function credential(text: string): ClaudeDesktopLogin | undefined {
  try {
    const oauth = JSON.parse(text)?.claudeAiOauth
    if (
      typeof oauth?.accessToken !== 'string' ||
      !oauth.accessToken.trim() ||
      typeof oauth.refreshToken !== 'string' ||
      !oauth.refreshToken.trim()
    )
      return undefined
    return { kind: 'claude.login', secret: JSON.stringify({ claudeAiOauth: oauth }) }
  } catch {
    return undefined
  }
}

/** Own one interactive CLI login. Never read or modify the host's default login. */
export async function signInToClaude(
  options: {
    signal?: AbortSignal
    command?: { executable: string; args?: string[] }
  } = {}
): Promise<ClaudeDesktopLogin> {
  if (options.signal?.aborted) throw new Error('Claude sign-in was cancelled.')
  const config = await realpath(await mkdtemp(join(tmpdir(), 'taut-claude-login-')))
  const service = `Claude Code-credentials-${createHash('sha256').update(config.normalize('NFC')).digest('hex').slice(0, 8)}`
  try {
    const executable = options.command?.executable ?? (await claudeExecutable())
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: config
    }
    for (const key of [
      'CLAUDECODE',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL'
    ])
      delete env[key]
    const timeout = AbortSignal.timeout(LOGIN_TIMEOUT)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Claude sign-in was cancelled.'))
        return
      }
      const child = spawn(
        executable,
        [...(options.command?.args ?? []), 'auth', 'login', '--claudeai'],
        {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        }
      )
      // The CLI opens the system browser and owns its loopback callback. Keep
      // stdin alive until it exits; consuming output prevents pipe deadlocks.
      child.stdout.resume()
      child.stderr.resume()
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const cancel = () => {
        child.kill()
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
        killTimer.unref()
      }
      const cleanup = () => {
        signal.removeEventListener('abort', cancel)
        clearTimeout(killTimer)
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
      }
      signal.addEventListener('abort', cancel, { once: true })
      child.once('error', () => {
        cleanup()
        reject(
          new Error(
            'Could not start Claude Code. Install Claude Code on this computer, then try again.'
          )
        )
      })
      child.once('exit', (code) => {
        cleanup()
        if (signal.aborted)
          reject(
            new Error(
              timeout.aborted
                ? 'Claude sign-in timed out. Try again.'
                : 'Claude sign-in was cancelled.'
            )
          )
        else if (code !== 0) reject(new Error('Claude sign-in did not finish. Try again.'))
        else resolve()
      })
    })
    let login: ClaudeDesktopLogin | undefined
    try {
      login = credential(await readFile(join(config, '.credentials.json'), 'utf8'))
    } catch {
      /* macOS stores the login in Keychain. */
    }
    if (!login && process.platform === 'darwin') {
      try {
        const result = await execute(
          '/usr/bin/security',
          ['find-generic-password', '-s', service, '-w'],
          { timeout: 3000 }
        )
        login = credential(result.stdout)
      } catch {
        /* Report a missing login without exposing security output. */
      }
    }
    if (!login)
      throw new Error('Claude did not return a usable Claude login. Try signing in again.')
    return login
  } finally {
    if (process.platform === 'darwin') {
      try {
        await execute('/usr/bin/security', ['delete-generic-password', '-s', service], {
          timeout: 3000
        })
      } catch {
        /* No scoped item was created. */
      }
    }
    await rm(config, { recursive: true, force: true })
  }
}
