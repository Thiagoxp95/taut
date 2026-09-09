import * as React from 'react'
import { useRouter } from '@tanstack/react-router'

import { useChannelGroups } from '@/hooks/use-directory'
import { desktop } from '@/lib/desktop'

/**
 * Routes when the shell says so (a clicked OS notification, a `taut://` link).
 * The main process only knows a channel id, so `/c/<id>` is rewritten to
 * `/dm/<id>` here, where the channel directory lives.
 */
export function useDesktopNavigation(): void {
  const router = useRouter()
  const { all } = useChannelGroups()
  const channels = React.useRef(all)

  React.useEffect(() => {
    channels.current = all
  }, [all])

  React.useEffect(
    () =>
      desktop?.onNavigate((path) => {
        const [pathname = '', search] = path.split('?')
        const id = pathname.startsWith('/c/') ? pathname.slice(3) : undefined
        const isDm = channels.current.some((c) => c.id === id && c.kind === 'dm')
        router.history.push(isDm ? `/dm/${id}${search === undefined ? '' : `?${search}`}` : path)
      }),
    [router]
  )
}
