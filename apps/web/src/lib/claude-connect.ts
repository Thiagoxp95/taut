import { isCredentialSecretUsable } from '@taut/contract'
import { CLAUDE_LOGIN_PORT, type ClaudeDesktopLogin } from '@taut/contract/desktop'

function readLogin(value: unknown): ClaudeDesktopLogin {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('kind' in value) ||
    value.kind !== 'claude.login' ||
    !('secret' in value) ||
    typeof value.secret !== 'string' ||
    !isCredentialSecretUsable('claude.login', value.secret)
  ) {
    throw new Error('Claude did not return a usable login. Try again.')
  }
  return { kind: 'claude.login', secret: value.secret }
}

/** Subscription sign-in stays local even when the Taut server is remote. */
export async function connectClaude(signal: AbortSignal): Promise<ClaudeDesktopLogin> {
  if (signal.aborted) throw new Error('Sign-in cancelled.')
  if (window.taut) {
    if (!window.taut.connectClaude)
      throw new Error('Update Taut desktop to connect Claude from this button.')
    const cancel = () => window.taut?.cancelClaudeConnect()
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return readLogin(await window.taut.connectClaude())
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
          : 'Claude sign-in did not finish. Try again.'
      throw new Error(message)
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
    n.toString(16).padStart(2, '0')
  ).join('')
  const endpoint = `http://127.0.0.1:${CLAUDE_LOGIN_PORT}/claude-login/${nonce}`
  const handoff = new URL('taut://connect/claude')
  handoff.searchParams.set('origin', window.location.origin)
  handoff.searchParams.set('nonce', nonce)
  const cancel = () => {
    void fetch(endpoint, {
      method: 'DELETE',
      mode: 'cors',
      credentials: 'omit',
      signal: AbortSignal.timeout(2000)
    }).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    window.open(handoff.href, '_self')
    const started = Date.now()
    let reachedDesktop = false
    while (!signal.aborted && Date.now() - started < 5 * 60 * 1000) {
      let response: Response | undefined
      try {
        response = await fetch(endpoint, {
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
          signal: AbortSignal.any([signal, AbortSignal.timeout(2000)])
        })
      } catch {
        /* The desktop app may still be launching. */
      }
      if (signal.aborted) break
      if (response) {
        if (!response.ok)
          throw new Error('Open this same Taut workspace in the desktop app, then try again.')
        reachedDesktop = true
        const value: unknown = await response.json()
        if (typeof value !== 'object' || value === null || !('status' in value))
          throw new Error('Invalid response from Taut desktop.')
        if (value.status === 'connected' && 'login' in value) return readLogin(value.login)
        if (value.status === 'error')
          throw new Error(
            'Claude sign-in did not finish. Check that Claude Code is installed, then try again.'
          )
      } else if (!reachedDesktop && Date.now() - started > 30000) {
        throw new Error(
          'Open Taut desktop on this computer and connect it to this workspace, then try again. Allow local-network access if your browser asks.'
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 750))
    }
    cancel()
    throw new Error(signal.aborted ? 'Sign-in cancelled.' : 'Claude sign-in timed out. Try again.')
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
