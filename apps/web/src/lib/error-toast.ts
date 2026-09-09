/**
 * One funnel for every failure that reaches React: contract `TaggedError`s
 * become a toast carrying the error's own message, and `Unauthorized` sends
 * the session back to `/login`.
 */
import { toast } from '@taut/ui/components/sonner'

import { toApiError } from '@/lib/api-client'

const AUTH_PATHS = ['/login', '/signup', '/invite', '/onboarding']

let onUnauthorized: () => void = () => undefined

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}

export function isOnAuthRoute(): boolean {
  return AUTH_PATHS.some((path) => window.location.pathname.startsWith(path))
}

export function reportApiError(error: unknown, options?: { silent?: boolean }): void {
  const apiError = toApiError(error)

  if (apiError.tag === 'Unauthorized') {
    if (!isOnAuthRoute()) onUnauthorized()
    return
  }

  if (options?.silent === true) return
  toast.error(apiError.message)
}
