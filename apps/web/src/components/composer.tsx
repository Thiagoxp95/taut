import * as React from 'react'
import {
  AtSignIcon,
  BoldIcon,
  CodeIcon,
  HashIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  Loader2Icon,
  PaperclipIcon,
  RotateCcwIcon,
  SendHorizonalIcon,
  SquareCodeIcon,
  StrikethroughIcon,
  TextQuoteIcon,
  XIcon
} from '@taut/ui/components/icons'
import type { Attachment, AttachmentId, Channel, ChannelId, MessageId } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'
import { Button } from '@taut/ui/components/button'
import { Popover, PopoverAnchor, PopoverContent } from '@taut/ui/components/popover'
import { toast } from '@taut/ui/components/sonner'
import { AttachmentIcon } from '@/components/attachment-list'
import { EntityAvatar } from '@/components/entity-avatar'
import { ComposerTools } from '@/components/composer-tools'
import { TypingIndicator } from '@/components/typing-indicator'
import {
  useChannel,
  useChannelGroups,
  useDepartmentList,
  useDmView,
  useLookupHandle,
  useMentionGroups,
  type Mentionable
} from '@/hooks/use-directory'
import { useRunOverride } from '@/hooks/use-run-override'
import { useTypingSender } from '@/hooks/use-realtime'
import { useSendMessage, useUploadAttachment } from '@/lib/api'
import { isInlineImage } from '@/lib/attachments'
import { formatBytes } from '@/lib/format'
import { usePresence } from '@/lib/live'
import { mentionSegments } from '@/lib/mentions'
import { applyFormat, shortcutFor, type MarkdownFormat } from '@/lib/markdown-input'

/** `@` picks a member, `#` picks a channel — both autocomplete the same way. */
const TRIGGER_PATTERN = /(?:^|\s)([@#])([a-z0-9_-]*)$/i
const MAX_SUGGESTIONS = 6
/** Rows the second `@` group (everyone outside this channel) may add below the first. */
const MAX_ELSEWHERE = 4

/** `CreateMessagePayload.attachmentIds` is capped at 10 (docs/build-plan-attachments.md D6). */
const MAX_ATTACHMENTS = 10

/**
 * One file in the pending strip. It is uploaded the moment it is added (D2), so
 * `attachment` is the orphan the server handed back and its id is what `send`
 * puts in `attachmentIds`.
 */
interface Pending {
  readonly key: string
  readonly file: File
  /** `URL.createObjectURL` thumbnail for an image; revoked on remove and unmount. */
  readonly previewUrl?: string
  readonly status: 'uploading' | 'uploaded' | 'error'
  readonly attachment?: Attachment
  readonly error?: string
}

/** Clipboard images arrive as `image.png` (or nameless); give them something readable. */
function pastedFile(file: File): File {
  const subtype = file.type.slice('image/'.length).split('+')[0]
  const extension = subtype === undefined || subtype === '' ? 'png' : subtype
  return new File([file], `pasted-${Date.now()}.${extension}`, { type: file.type })
}

/** The formatting rail, in Slack's order. `hint` shows in the tooltip. */
const FORMATS: ReadonlyArray<{
  readonly format: MarkdownFormat
  readonly label: string
  readonly hint?: string
  readonly Icon: React.ComponentType
}> = [
  { format: 'bold', label: 'Bold', hint: '⌘B', Icon: BoldIcon },
  { format: 'italic', label: 'Italic', hint: '⌘I', Icon: ItalicIcon },
  { format: 'strike', label: 'Strikethrough', hint: '⌘⇧X', Icon: StrikethroughIcon },
  { format: 'link', label: 'Link', hint: '⌘K', Icon: LinkIcon },
  { format: 'bullet', label: 'Bulleted list', Icon: ListIcon },
  { format: 'ordered', label: 'Numbered list', Icon: ListOrderedIcon },
  { format: 'quote', label: 'Blockquote', Icon: TextQuoteIcon },
  { format: 'code', label: 'Code', hint: '⌘⇧C', Icon: CodeIcon },
  { format: 'codeBlock', label: 'Code block', Icon: SquareCodeIcon }
]

type Trigger = '@' | '#'

interface TriggerState {
  readonly trigger: Trigger
  readonly query: string
  /** Index of the `@` or `#` in the textarea value. */
  readonly start: number
}

/**
 * Which list a row belongs to. `here` is this channel's own membership — a
 * mention there actually reaches someone; `elsewhere` is the rest of the
 * company, which the heading says plainly.
 */
type Group = 'here' | 'elsewhere'

/** One row of the picker: a member for `@`, a channel for `#`. */
type Suggestion =
  | {
      readonly kind: 'member'
      readonly group: Group
      readonly id: string
      readonly insert: string
      readonly member: Mentionable
    }
  | {
      readonly kind: 'channel'
      readonly group: Group
      readonly id: string
      readonly insert: string
      readonly name: string
      readonly subtitle: string
    }

const LABEL: Record<Trigger, { readonly heading: string; readonly picker: string }> = {
  '@': { heading: 'In this conversation', picker: 'Mention a member' },
  '#': { heading: 'Channels', picker: 'Link a channel' }
}

const ELSEWHERE_HEADING = 'Elsewhere in the company — not notified here'

function findTrigger(value: string, caret: number): TriggerState | null {
  const match = TRIGGER_PATTERN.exec(value.slice(0, caret))
  const trigger = match?.[1]
  const query = match?.[2]
  if (trigger === undefined || query === undefined) return null
  return { trigger: trigger as Trigger, query, start: caret - query.length - 1 }
}

/** Prefix match first, then anything containing the query — Slack's order. */
const matches = (query: string, ...fields: readonly string[]): boolean =>
  query === '' || fields.some((field) => field.toLowerCase().includes(query))

const rank = (query: string, primary: string): number =>
  primary.toLowerCase().startsWith(query) ? 0 : 1

function MemberRow({ candidate }: { candidate: Mentionable }) {
  const presence = usePresence(candidate.id, candidate.defaultPresence)
  return (
    <>
      <EntityAvatar
        memberId={candidate.id}
        avatar={candidate.avatar}
        kind={candidate.kind}
        face={candidate.face}
        name={candidate.name}
        presence={presence}
        size="sm"
      />
      <span className="font-medium">{candidate.handle}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {candidate.subtitle}
      </span>
    </>
  )
}

function ChannelRow({ name, subtitle }: { name: string; subtitle: string }) {
  return (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground">
        <HashIcon className="size-3.5" />
      </span>
      <span className="font-medium">{name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{subtitle}</span>
    </>
  )
}

function SuggestionRow({ item }: { item: Suggestion }) {
  return item.kind === 'member' ? (
    <MemberRow candidate={item.member} />
  ) : (
    <ChannelRow name={item.name} subtitle={item.subtitle} />
  )
}

/** One tile in the pending strip: thumbnail or icon, name, size / progress / error. */
function PendingTile({
  item,
  onRetry,
  onRemove
}: {
  item: Pending
  onRetry: () => void
  onRemove: () => void
}) {
  return (
    <li
      className={cn(
        'relative flex w-56 max-w-full items-center gap-2 rounded-md border bg-muted/40 p-1.5',
        item.status === 'error' && 'border-destructive/40 bg-destructive/5'
      )}
    >
      {item.previewUrl === undefined ? (
        <span className="flex size-9 shrink-0 items-center justify-center rounded bg-background text-muted-foreground">
          <AttachmentIcon mimeType={item.file.type} className="size-4" />
        </span>
      ) : (
        <img src={item.previewUrl} alt="" className="size-9 shrink-0 rounded object-cover" />
      )}

      <div className="min-w-0 flex-1 pr-4">
        <p className="truncate text-xs font-medium">{item.file.name}</p>
        {item.status === 'error' ? (
          <p className="truncate text-[11px] text-destructive" title={item.error}>
            {item.error ?? 'Upload failed'}
          </p>
        ) : (
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {item.status === 'uploading' ? (
              <Loader2Icon aria-hidden className="size-3 animate-spin" />
            ) : null}
            {item.status === 'uploading' ? 'Uploading…' : formatBytes(item.file.size)}
          </p>
        )}
      </div>

      {item.status === 'error' ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Retry ${item.file.name}`}
          title="Retry"
          onClick={onRetry}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <RotateCcwIcon />
        </Button>
      ) : null}

      <button
        type="button"
        aria-label={`Remove ${item.file.name}`}
        title="Remove"
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-xs transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <XIcon className="size-3" />
      </button>
    </li>
  )
}

/**
 * The `@handle` chips, painted behind the textarea.
 *
 * A textarea cannot style its own content, so the draft is mirrored into a div
 * underneath with the same typography, padding and wrapping; only the mention
 * backgrounds are visible (every glyph is transparent), and the real text sits
 * on top of them. A handle is chipped only once it resolves to someone in the
 * directory, which is what makes a typo — or a handle nobody has — visibly
 * different from a name that will land, whether it was picked from the picker,
 * typed out or pasted in.
 *
 * `TEXT` is shared with the textarea so the two never drift apart: any padding
 * or leading that lives on one has to live on the other or the chips slide off
 * the words.
 */
const TEXT = 'px-4 pt-2.5 pb-2 text-[15px] leading-[1.46667]'

const Backdrop = React.forwardRef<HTMLDivElement, { value: string; known: (h: string) => boolean }>(
  function Backdrop({ value, known }, ref) {
    return (
      <div
        ref={ref}
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden select-none"
      >
        <div className={cn(TEXT, 'break-words whitespace-pre-wrap text-transparent', 'max-w-full')}>
          {mentionSegments(value).map((segment, index) =>
            segment.handle !== undefined && known(segment.handle) ? (
              <span
                key={index}
                className="rounded-[3px] bg-sidebar-primary/10 dark:bg-sidebar-primary/25"
              >
                {segment.text}
              </span>
            ) : (
              <span key={index}>{segment.text}</span>
            )
          )}
          {/* A trailing newline needs a line box of its own, or the last chip scrolls out of step. */}
          {'\n'}
        </div>
      </div>
    )
  }
)

/**
 * Slack-style composer: the textarea grows with its content, Enter sends,
 * Shift+Enter inserts a newline, `@` opens the member picker and `#` the
 * channel picker. Files are dropped, pasted or picked with the paperclip and
 * upload straight away (docs/build-plan-attachments.md D2).
 */
export interface ComposerProps {
  channelId: ChannelId | undefined
  threadId?: MessageId
  placeholder: string
  autoFocus?: boolean
  /**
   * Takes over the send, for the one conversation that has no channel to send to
   * yet: an issue's thread before anybody has opened it
   * (docs/build-plan-issues.md D8). The body posts through `openIssueThread`,
   * which creates the hidden channel, the root message and the thread in one
   * call — so the box must be live *before* `channelId` exists, which is the
   * whole reason this prop is here rather than the page rendering its own.
   *
   * Attachments still need a channel and stay off until there is one: an upload
   * is addressed to a channel (docs/build-plan-attachments.md D2), and there is
   * no honest one to give it.
   */
  onSend?: (body: string) => void
}

/**
 * An archived conversation is readable, not writable — the server refuses the post, and the
 * agent on the other side of an archived DM is not coming back to read it. The box is replaced
 * by the reason rather than left there to fail on send.
 */
export function Composer(props: ComposerProps) {
  const channel = useChannel(props.channelId)
  if (channel?.archivedAt === undefined) return <LiveComposer {...props} />
  return (
    <div className="border-t px-6 py-4">
      <p className="rounded-md border border-dashed px-3 py-2 text-center text-sm text-muted-foreground">
        This conversation is archived. History stays; nothing new can be sent.
      </p>
    </div>
  )
}

function LiveComposer({
  channelId,
  threadId,
  placeholder,
  autoFocus = false,
  onSend
}: ComposerProps) {
  const { here, elsewhere } = useMentionGroups(channelId)
  const lookupHandle = useLookupHandle()
  const { all: channels } = useChannelGroups()
  const { departments } = useDepartmentList()
  const sendMessage = useSendMessage()
  const uploadAttachment = useUploadAttachment()
  const notifyTyping = useTypingSender(channelId, threadId)
  const dm = useDmView(channelId)
  const runOverride = useRunOverride(channelId, threadId)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const backdropRef = React.useRef<HTMLDivElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const [value, setValue] = React.useState('')
  const [active, setActive] = React.useState<TriggerState | null>(null)
  const [highlighted, setHighlighted] = React.useState(0)
  const [pending, setPending] = React.useState<readonly Pending[]>([])
  const [dragging, setDragging] = React.useState(false)

  // Every object URL handed to an <img>, so none of them leaks when the
  // composer unmounts with files still in the strip.
  const previewUrls = React.useRef<string[]>([])
  React.useEffect(
    () => () => {
      for (const url of previewUrls.current) URL.revokeObjectURL(url)
      previewUrls.current = []
    },
    []
  )

  const patch = (key: string, change: Omit<Pending, 'key' | 'file' | 'previewUrl'>): void => {
    setPending((items) => items.map((item) => (item.key === key ? { ...item, ...change } : item)))
  }

  const upload = (key: string, file: File, channel: ChannelId): void => {
    patch(key, { status: 'uploading', error: undefined })
    uploadAttachment
      .mutateAsync({ channelId: channel, file })
      .then((attachment) => patch(key, { status: 'uploaded', attachment }))
      .catch((error: unknown) =>
        patch(key, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Upload failed'
        })
      )
  }

  const keyRef = React.useRef(0)

  const addFiles = (files: readonly File[]): void => {
    if (channelId === undefined || files.length === 0) return
    const room = MAX_ATTACHMENTS - pending.length
    if (room <= 0 || files.length > room) {
      toast.error(`Up to ${MAX_ATTACHMENTS} files per message`)
      if (room <= 0) return
    }

    const added = files.slice(0, room).map((file) => {
      keyRef.current += 1
      const previewUrl = isInlineImage(file.type) ? URL.createObjectURL(file) : undefined
      if (previewUrl !== undefined) previewUrls.current.push(previewUrl)
      return { key: `pending-${keyRef.current}`, file, previewUrl, status: 'uploading' } as const
    })

    setPending((items) => [...items, ...added])
    for (const item of added) upload(item.key, item.file, channelId)
  }

  const forget = (item: Pending): void => {
    if (item.previewUrl === undefined) return
    URL.revokeObjectURL(item.previewUrl)
    previewUrls.current = previewUrls.current.filter((url) => url !== item.previewUrl)
  }

  const removePending = (key: string): void => {
    setPending((items) => {
      const target = items.find((item) => item.key === key)
      if (target !== undefined) forget(target)
      return items.filter((item) => item.key !== key)
    })
  }

  const clearPending = (): void => {
    setPending((items) => {
      for (const item of items) forget(item)
      return []
    })
  }

  const attachmentIds: readonly AttachmentId[] = pending.flatMap((item) =>
    item.attachment === undefined ? [] : [item.attachment.id]
  )
  const uploading = pending.some((item) => item.status === 'uploading')
  /*
   * Somewhere to send to: a channel, or a caller that has taken the send over
   * because there is not one yet (docs/build-plan-issues.md D8).
   */
  const ready = channelId !== undefined || onSend !== undefined
  // Text or at least one uploaded file, and nothing still in flight (D2).
  const canSend = ready && !uploading && (value.trim() !== '' || attachmentIds.length > 0)

  const isKnownHandle = React.useCallback(
    (handle: string) => lookupHandle(handle) !== undefined,
    [lookupHandle]
  )

  /**
   * The agent this draft will wake (docs/build-plan-run-overrides.md D3).
   *
   * A DM with an agent always wakes it. Anywhere else it takes an `@handle` in
   * the draft, so the run controls appear the moment a mention resolves
   * to an agent and goes away again when the mention is deleted. The first
   * mentioned agent wins: a message naming two of them starts two runs, and one
   * popup cannot honestly speak for both.
   */
  const targetAgent = React.useMemo(() => {
    if (dm?.partner?.kind === 'agent' && !dm.partner.archived) return dm.partner.agent
    for (const segment of mentionSegments(value)) {
      if (segment.handle === undefined) continue
      const found = lookupHandle(segment.handle)
      if (found?.kind === 'agent' && !found.archived) return found.agent
    }
    return undefined
  }, [dm, value, lookupHandle])

  const departmentName = React.useMemo(() => {
    const index = new Map(departments.map((department) => [department.id, department.name]))
    return (channel: Channel): string =>
      channel.departmentId === undefined
        ? 'Company-wide'
        : (index.get(channel.departmentId) ?? 'Department')
  }, [departments])

  const suggestions = React.useMemo<readonly Suggestion[]>(() => {
    if (active === null) return []
    const query = active.query.toLowerCase()

    if (active.trigger === '@') {
      const rows = (group: Group, list: readonly Mentionable[], limit: number): Suggestion[] =>
        list
          .filter((candidate) => matches(query, candidate.handle, candidate.name))
          .sort((a, b) => rank(query, a.handle) - rank(query, b.handle))
          .slice(0, limit)
          .map((member) => ({
            kind: 'member',
            group,
            id: member.id,
            insert: member.handle,
            member
          }))
      return [
        ...rows('here', here, MAX_SUGGESTIONS),
        ...rows('elsewhere', elsewhere, MAX_ELSEWHERE)
      ]
    }

    return channels
      .filter((channel) => channel.kind !== 'dm' && matches(query, channel.name))
      .sort((a, b) => rank(query, a.name) - rank(query, b.name) || a.name.localeCompare(b.name))
      .slice(0, MAX_SUGGESTIONS)
      .map((channel) => ({
        kind: 'channel',
        group: 'here',
        id: channel.id,
        insert: channel.name,
        name: channel.name,
        subtitle: departmentName(channel)
      }))
  }, [active, here, elsewhere, channels, departmentName])

  const open = active !== null && suggestions.length > 0

  const autosize = React.useCallback(() => {
    const node = textareaRef.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 320)}px`
  }, [])

  React.useEffect(autosize, [value, autosize])

  const syncTrigger = (next: string, caret: number): void => {
    setActive(findTrigger(next, caret))
    setHighlighted(0)
  }

  const insertSuggestion = (item: Suggestion): void => {
    if (active === null) return
    const node = textareaRef.current
    const caret = node?.selectionStart ?? value.length
    const next = `${value.slice(0, active.start)}${active.trigger}${item.insert} ${value.slice(caret)}`
    setValue(next)
    setActive(null)
    requestAnimationFrame(() => {
      const position = active.start + item.insert.length + 2
      node?.focus()
      node?.setSelectionRange(position, position)
    })
  }

  /** The `@` and `#` rail buttons: drop the trigger in and open the picker. */
  const openPicker = (trigger: Trigger): void => {
    const node = textareaRef.current
    const next = value === '' || value.endsWith(' ') ? `${value}${trigger}` : `${value} ${trigger}`
    setValue(next)
    node?.focus()
    requestAnimationFrame(() => {
      node?.setSelectionRange(next.length, next.length)
      syncTrigger(next, next.length)
    })
  }

  /** Applies a markdown format to the textarea's current selection. */
  const format = (kind: MarkdownFormat): void => {
    const node = textareaRef.current
    if (node === null) return
    const edit = applyFormat({ value, start: node.selectionStart, end: node.selectionEnd }, kind)
    setValue(edit.value)
    setActive(null)
    requestAnimationFrame(() => {
      node.focus()
      node.setSelectionRange(edit.start, edit.end)
    })
  }

  const send = (): void => {
    if (!canSend) return
    if (onSend !== undefined) {
      onSend(value.trim())
    } else if (channelId !== undefined) {
      sendMessage.mutate({
        channelId,
        threadId,
        body: value.trim(),
        attachmentIds: attachmentIds.length === 0 ? undefined : attachmentIds,
        // Only sent when an agent is actually going to read it: an override on a
        // message to a human is noise stored forever (D3).
        ...(targetAgent === undefined || runOverride.override === undefined
          ? {}
          : { runOverride: runOverride.override })
      })
    } else {
      return
    }
    setValue('')
    setActive(null)
    clearPending()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const shortcut = shortcutFor(event)
    if (shortcut !== undefined) {
      event.preventDefault()
      format(shortcut)
      return
    }

    if (open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlighted((index) => (index + 1) % suggestions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlighted((index) => (index - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const candidate = suggestions[highlighted]
        if (candidate !== undefined) {
          event.preventDefault()
          insertSuggestion(candidate)
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setActive(null)
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className="shrink-0 px-6 pt-1 pb-5">
      <Popover open={open}>
        <PopoverAnchor asChild>
          <div
            onDragEnter={(event) => {
              if (channelId === undefined || !event.dataTransfer.types.includes('Files')) return
              event.preventDefault()
              setDragging(true)
            }}
            onDragOver={(event) => {
              if (channelId === undefined || !event.dataTransfer.types.includes('Files')) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
              setDragging(true)
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
              setDragging(false)
            }}
            onDrop={(event) => {
              if (channelId === undefined || !event.dataTransfer.types.includes('Files')) return
              event.preventDefault()
              setDragging(false)
              addFiles(Array.from(event.dataTransfer.files))
            }}
            className={cn(
              '@container/composer rounded-lg border bg-background shadow-xs transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
              dragging && 'border-ring ring-[3px] ring-ring/50'
            )}
          >
            <label htmlFor="composer" className="sr-only">
              Message
            </label>
            <div className="relative">
              <Backdrop ref={backdropRef} value={value} known={isKnownHandle} />
              <textarea
                id="composer"
                ref={textareaRef}
                rows={1}
                autoFocus={autoFocus}
                value={value}
                placeholder={placeholder}
                disabled={!ready}
                onChange={(event) => {
                  setValue(event.target.value)
                  syncTrigger(event.target.value, event.target.selectionStart)
                  if (event.target.value !== '') notifyTyping()
                }}
                onKeyDown={onKeyDown}
                onPaste={(event) => {
                  const images = Array.from(event.clipboardData.files).filter((file) =>
                    file.type.startsWith('image/')
                  )
                  if (images.length === 0) return
                  event.preventDefault()
                  addFiles(images.map(pastedFile))
                }}
                onScroll={(event) => {
                  const node = backdropRef.current
                  if (node !== null) node.scrollTop = event.currentTarget.scrollTop
                }}
                onBlur={() => setActive(null)}
                className={cn(
                  TEXT,
                  'taut-scroll relative block max-h-80 w-full resize-none bg-transparent break-words outline-none placeholder:text-muted-foreground'
                )}
              />
            </div>

            {pending.length === 0 ? null : (
              <ul aria-label="Attachments" className="flex flex-wrap gap-2 px-4 pt-1 pb-2">
                {pending.map((item) => (
                  <PendingTile
                    key={item.key}
                    item={item}
                    onRetry={() => {
                      if (channelId !== undefined) upload(item.key, item.file, channelId)
                    }}
                    onRemove={() => removePending(item.key)}
                  />
                ))}
              </ul>
            )}

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                addFiles(Array.from(event.target.files ?? []))
                // Re-picking the same file must fire `change` again.
                event.target.value = ''
              }}
            />

            <div
              className="taut-composer-footer flex items-center gap-1 px-2 pt-0 pb-3"
              data-agent={targetAgent !== undefined}
            >
              <ComposerTools
                agent={targetAgent}
                state={runOverride}
                disabled={channelId === undefined}
              >
                {FORMATS.map(({ format: kind, label, hint, Icon }) => (
                  <Button
                    key={kind}
                    variant="ghost"
                    size="icon-sm"
                    aria-label={label}
                    title={hint === undefined ? label : `${label} (${hint})`}
                    disabled={!ready}
                    // Keep the caret where it is: a blur would lose the selection.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => format(kind)}
                  >
                    <Icon />
                  </Button>
                ))}
              </ComposerTools>

              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Mention someone"
                  title="Mention someone"
                  disabled={!ready}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => openPicker('@')}
                >
                  <AtSignIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Link a channel"
                  title="Link a channel"
                  disabled={!ready}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => openPicker('#')}
                  className="hidden @xl/composer:inline-flex"
                >
                  <HashIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Attach a file"
                  title="Attach a file"
                  disabled={channelId === undefined || pending.length >= MAX_ATTACHMENTS}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PaperclipIcon />
                </Button>
              </div>

              <span className="hidden shrink-0 text-[11px] text-nowrap text-muted-foreground @5xl/composer:block">
                <kbd className="rounded border px-1 py-px font-sans">Enter</kbd> to send ·{' '}
                <kbd className="rounded border px-1 py-px font-sans">Shift+Enter</kbd> for a new
                line
              </span>

              <Button
                size="sm"
                disabled={!canSend}
                onClick={send}
                className="ml-1 shrink-0 rounded-sm"
              >
                {uploading ? <Loader2Icon className="animate-spin" /> : <SendHorizonalIcon />}
                Send
              </Button>
            </div>
          </div>
        </PopoverAnchor>

        <PopoverContent
          align="start"
          side="top"
          sideOffset={8}
          className="w-72 p-1"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <ul
            role="listbox"
            aria-label={LABEL[active?.trigger ?? '@'].picker}
            className="taut-scroll max-h-72 overflow-y-auto"
          >
            {suggestions.map((item, index) => (
              <li key={item.id}>
                {index === 0 || suggestions[index - 1]?.group !== item.group ? (
                  <p
                    role="presentation"
                    className="px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase first:pt-1"
                  >
                    {item.group === 'here'
                      ? LABEL[active?.trigger ?? '@'].heading
                      : ELSEWHERE_HEADING}
                  </p>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlighted}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    insertSuggestion(item)
                  }}
                  onMouseEnter={() => setHighlighted(index)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none',
                    index === highlighted && 'bg-accent text-accent-foreground'
                  )}
                >
                  <SuggestionRow item={item} />
                </button>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>

      <TypingIndicator channelId={channelId} />
    </div>
  )
}
