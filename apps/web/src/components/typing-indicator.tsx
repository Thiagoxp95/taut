import type { ChannelId } from '@taut/contract'

import { useDirectoryIndex } from '@/hooks/use-directory'
import { useMe } from '@/lib/api'
import { useTypingUsers } from '@/lib/live'

/** "Wren is typing…" under the composer. Cleared 3s after the last frame. */
export function TypingIndicator({ channelId }: { channelId: ChannelId | undefined }) {
  const me = useMe().data
  const index = useDirectoryIndex()
  const typing = useTypingUsers(channelId ?? '', me?.user.id)

  const names = typing.map((userId) => index.get(userId)?.name ?? 'Someone')
  const label =
    names.length === 0
      ? ''
      : names.length === 1
        ? `${names[0]} is typing…`
        : names.length === 2
          ? `${names[0]} and ${names[1]} are typing…`
          : 'Several people are typing…'

  return (
    <p
      aria-live="polite"
      className="h-4 px-1 pt-1 text-[11px] text-muted-foreground transition-opacity"
      data-empty={label === '' ? 'true' : undefined}
    >
      {label}
    </p>
  )
}
