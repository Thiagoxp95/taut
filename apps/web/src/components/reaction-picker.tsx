import * as React from 'react'
import { SearchIcon } from '@taut/ui/components/icons'
import { cn } from '@taut/ui/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@taut/ui/components/popover'
import { recentEmoji } from '@/lib/message-actions'

interface EmojiEntry {
  readonly emoji: string
  readonly name: string
}

/**
 * The curated set (D9). Six groups of twenty, searched by `name` — enough for a
 * chat reaction without pulling a picker library in.
 *
 * TODO(plan): full picker + skin tones.
 */
const GROUPS: ReadonlyArray<{ readonly name: string; readonly emoji: readonly EmojiEntry[] }> = [
  {
    name: 'Smileys',
    emoji: [
      { emoji: '😀', name: 'grinning' },
      { emoji: '😄', name: 'smile' },
      { emoji: '😁', name: 'beaming' },
      { emoji: '😂', name: 'joy' },
      { emoji: '🤣', name: 'rolling on the floor' },
      { emoji: '🙂', name: 'slight smile' },
      { emoji: '😉', name: 'wink' },
      { emoji: '😊', name: 'blush' },
      { emoji: '😍', name: 'heart eyes' },
      { emoji: '😘', name: 'kiss' },
      { emoji: '🤩', name: 'star struck' },
      { emoji: '🤔', name: 'thinking' },
      { emoji: '🤨', name: 'raised eyebrow' },
      { emoji: '👀', name: 'eyes' },
      { emoji: '😴', name: 'sleeping' },
      { emoji: '😅', name: 'sweat smile' },
      { emoji: '😭', name: 'sob' },
      { emoji: '😱', name: 'scream' },
      { emoji: '🤯', name: 'mind blown' },
      { emoji: '😎', name: 'sunglasses' }
    ]
  },
  {
    name: 'Gestures',
    emoji: [
      { emoji: '👍', name: 'thumbs up' },
      { emoji: '👎', name: 'thumbs down' },
      { emoji: '👌', name: 'ok hand' },
      { emoji: '🙌', name: 'raised hands' },
      { emoji: '👏', name: 'clap' },
      { emoji: '🙏', name: 'thank you' },
      { emoji: '🤝', name: 'handshake' },
      { emoji: '💪', name: 'muscle' },
      { emoji: '👋', name: 'wave' },
      { emoji: '✌️', name: 'victory' },
      { emoji: '🤞', name: 'fingers crossed' },
      { emoji: '🫡', name: 'salute' },
      { emoji: '🤙', name: 'call me' },
      { emoji: '👉', name: 'point right' },
      { emoji: '👈', name: 'point left' },
      { emoji: '👇', name: 'point down' },
      { emoji: '☝️', name: 'point up' },
      { emoji: '✋', name: 'raised hand' },
      { emoji: '🖐️', name: 'hand splayed' },
      { emoji: '🫶', name: 'heart hands' }
    ]
  },
  {
    name: 'Hearts',
    emoji: [
      { emoji: '❤️', name: 'red heart' },
      { emoji: '🧡', name: 'orange heart' },
      { emoji: '💛', name: 'yellow heart' },
      { emoji: '💚', name: 'green heart' },
      { emoji: '💙', name: 'blue heart' },
      { emoji: '💜', name: 'purple heart' },
      { emoji: '🖤', name: 'black heart' },
      { emoji: '🤍', name: 'white heart' },
      { emoji: '🤎', name: 'brown heart' },
      { emoji: '💔', name: 'broken heart' },
      { emoji: '❣️', name: 'heart exclamation' },
      { emoji: '💕', name: 'two hearts' },
      { emoji: '💞', name: 'revolving hearts' },
      { emoji: '💓', name: 'beating heart' },
      { emoji: '💗', name: 'growing heart' },
      { emoji: '💖', name: 'sparkling heart' },
      { emoji: '💘', name: 'heart with arrow' },
      { emoji: '💝', name: 'heart with ribbon' },
      { emoji: '💟', name: 'heart decoration' },
      { emoji: '💌', name: 'love letter' }
    ]
  },
  {
    name: 'Objects',
    emoji: [
      { emoji: '🎉', name: 'party popper' },
      { emoji: '🎊', name: 'confetti' },
      { emoji: '🎁', name: 'gift' },
      { emoji: '🏆', name: 'trophy' },
      { emoji: '🥇', name: 'gold medal' },
      { emoji: '🔥', name: 'fire' },
      { emoji: '💡', name: 'idea' },
      { emoji: '📌', name: 'pin' },
      { emoji: '📎', name: 'paperclip' },
      { emoji: '📝', name: 'memo' },
      { emoji: '📚', name: 'books' },
      { emoji: '💻', name: 'laptop' },
      { emoji: '🖥️', name: 'desktop' },
      { emoji: '📱', name: 'phone' },
      { emoji: '⌛', name: 'hourglass' },
      { emoji: '⏰', name: 'alarm clock' },
      { emoji: '🔒', name: 'lock' },
      { emoji: '🔑', name: 'key' },
      { emoji: '🛠️', name: 'tools' },
      { emoji: '🚀', name: 'rocket' }
    ]
  },
  {
    name: 'Symbols',
    emoji: [
      { emoji: '✅', name: 'check' },
      { emoji: '☑️', name: 'ballot check' },
      { emoji: '❌', name: 'cross' },
      { emoji: '⚠️', name: 'warning' },
      { emoji: '❓', name: 'question' },
      { emoji: '❗', name: 'exclamation' },
      { emoji: '⭐', name: 'star' },
      { emoji: '✨', name: 'sparkles' },
      { emoji: '💯', name: 'hundred' },
      { emoji: '🔴', name: 'red circle' },
      { emoji: '🟠', name: 'orange circle' },
      { emoji: '🟡', name: 'yellow circle' },
      { emoji: '🟢', name: 'green circle' },
      { emoji: '🔵', name: 'blue circle' },
      { emoji: '🟣', name: 'purple circle' },
      { emoji: '⚫', name: 'black circle' },
      { emoji: '⚪', name: 'white circle' },
      { emoji: '♻️', name: 'recycle' },
      { emoji: '🔁', name: 'repeat' },
      { emoji: '➕', name: 'plus' }
    ]
  },
  {
    name: 'Nature',
    emoji: [
      { emoji: '🌱', name: 'seedling' },
      { emoji: '🌳', name: 'tree' },
      { emoji: '🌸', name: 'blossom' },
      { emoji: '🌻', name: 'sunflower' },
      { emoji: '🍀', name: 'four leaf clover' },
      { emoji: '🌈', name: 'rainbow' },
      { emoji: '☀️', name: 'sun' },
      { emoji: '⛅', name: 'partly cloudy' },
      { emoji: '☔', name: 'rain' },
      { emoji: '❄️', name: 'snowflake' },
      { emoji: '⚡', name: 'zap' },
      { emoji: '🌊', name: 'wave' },
      { emoji: '🌙', name: 'moon' },
      { emoji: '🐝', name: 'bee' },
      { emoji: '🦫', name: 'beaver' },
      { emoji: '🦉', name: 'owl' },
      { emoji: '🐙', name: 'octopus' },
      { emoji: '🐢', name: 'turtle' },
      { emoji: '🦊', name: 'fox' },
      { emoji: '🐬', name: 'dolphin' }
    ]
  }
]

const ALL: readonly EmojiEntry[] = GROUPS.flatMap((group) => group.emoji)

/** Arrow keys walk the grid, so the layout width is a constant, not a guess. */
const COLUMNS = 8

interface Slot {
  readonly entry: EmojiEntry
  /** Position in the flattened, currently visible list — what the arrows move. */
  readonly index: number
}

export function ReactionPicker({
  onPick,
  children,
  align = 'start'
}: {
  onPick: (emoji: string) => void
  /** The trigger; rendered `asChild`. */
  children: React.ReactNode
  align?: 'start' | 'center' | 'end'
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)
  const listRef = React.useRef<HTMLDivElement>(null)

  const sections = React.useMemo<ReadonlyArray<{ name: string; slots: readonly Slot[] }>>(() => {
    const needle = query.trim().toLowerCase()
    const found: Array<{ name: string; entries: readonly EmojiEntry[] }> = []

    if (needle === '') {
      const recent = recentEmoji()
        .map((emoji) => ALL.find((entry) => entry.emoji === emoji))
        .filter((entry): entry is EmojiEntry => entry !== undefined)
      if (recent.length > 0) found.push({ name: 'Frequently used', entries: recent })
      found.push(...GROUPS.map((group) => ({ name: group.name, entries: group.emoji })))
    } else {
      for (const group of GROUPS) {
        const entries = group.emoji.filter((entry) => entry.name.includes(needle))
        if (entries.length > 0) found.push({ name: group.name, entries })
      }
    }

    let index = 0
    return found.map((group) => ({
      name: group.name,
      slots: group.entries.map((entry) => ({ entry, index: index++ }))
    }))
    // Reopening re-reads the recent row from `localStorage`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open])

  const flat = React.useMemo(
    () => sections.flatMap((section) => section.slots.map((slot) => slot.entry)),
    [sections]
  )

  React.useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const search = (next: string): void => {
    setQuery(next)
    setActive(0)
  }

  const pick = (emoji: string): void => {
    onPick(emoji)
    setOpen(false)
    search('')
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      const entry = flat[active]
      if (entry !== undefined) pick(entry.emoji)
      return
    }
    const step =
      event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowLeft'
          ? -1
          : event.key === 'ArrowDown'
            ? COLUMNS
            : event.key === 'ArrowUp'
              ? -COLUMNS
              : 0
    if (step === 0) return
    event.preventDefault()
    setActive((current) => Math.min(Math.max(current + step, 0), flat.length - 1))
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) search('')
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-80 p-0">
        <div className="flex h-9 items-center gap-2 border-b px-3">
          <SearchIcon className="size-4 shrink-0 opacity-50" />
          <input
            autoFocus
            value={query}
            onChange={(event) => search(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Search emoji"
            placeholder="Search emoji…"
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div ref={listRef} className="taut-scroll max-h-64 overflow-y-auto p-2">
          {flat.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No emoji matches.</p>
          ) : (
            sections.map((section) => (
              <div key={section.name} className="pb-1">
                <p className="px-1 py-1 text-[11px] font-medium text-muted-foreground">
                  {section.name}
                </p>
                <div className="grid grid-cols-8 gap-0.5">
                  {section.slots.map(({ entry, index }) => (
                    <button
                      key={`${section.name}-${entry.emoji}`}
                      type="button"
                      title={entry.name}
                      aria-label={entry.name}
                      data-active={index === active}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => pick(entry.emoji)}
                      className={cn(
                        'flex size-8 items-center justify-center rounded-md text-lg outline-none',
                        index === active && 'bg-accent'
                      )}
                    >
                      <span aria-hidden>{entry.emoji}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
