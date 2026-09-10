import * as React from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  HashIcon,
  Loader2Icon,
  MessageSquareTextIcon,
  SparklesIcon,
  StickyNoteIcon,
  UserIcon
} from '@taut/ui/components/icons'
import type { AgentNoteHit, MemberId, MemberKind, MessageHit } from '@taut/contract'
import { SNIPPET_CLOSE, SNIPPET_OPEN } from '@taut/contract'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@taut/ui/components/command'
import { EntityAvatar } from '@/components/entity-avatar'
import {
  type DirectoryAgent,
  useChannelGroups,
  useDirectoryAgents,
  useDirectoryUsers,
  useDmViews,
  useLookupMember
} from '@/hooks/use-directory'
import { SEARCH_MIN_CHARS, useMe, useOpenDm, useSearch, useSendMessage } from '@/lib/api'
import { formatRelative } from '@/lib/format'

export type PaletteMode = 'all' | 'dm'

interface PaletteApi {
  readonly open: (mode?: PaletteMode) => void
}

const PaletteContext = React.createContext<PaletteApi>({ open: () => undefined })

export function useCommandPalette(): PaletteApi {
  return React.useContext(PaletteContext)
}

/** Keystrokes settle for this long before the server is asked. */
const SEARCH_DEBOUNCE_MS = 180

function useDebounced<A>(value: A, ms: number): A {
  const [settled, setSettled] = React.useState(value)
  React.useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/**
 * What the palette sends when the user picks "Ask @agent". The agent already has
 * `memory_search` / `memory_recall_thread` over everything it could see, so the
 * question is phrased to make it use them and cite what it found.
 */
const askBody = (question: string): string =>
  `Search your memory (memory_search, then memory_recall_thread for context) for "${question}" and tell me what we said about it: who said what, when, and in which channel. Quote the relevant lines. If you find nothing, say so.`

/** FTS snippet → text with the matched terms marked. */
function Snippet({ text, className }: { text: string; className?: string }) {
  const parts = React.useMemo(() => {
    const out: Array<{ hit: boolean; text: string }> = []
    text.split(SNIPPET_OPEN).forEach((chunk, index) => {
      if (index === 0) {
        if (chunk !== '') out.push({ hit: false, text: chunk })
        return
      }
      const close = chunk.indexOf(SNIPPET_CLOSE)
      if (close === -1) {
        out.push({ hit: false, text: chunk })
        return
      }
      out.push({ hit: true, text: chunk.slice(0, close) })
      const rest = chunk.slice(close + SNIPPET_CLOSE.length)
      if (rest !== '') out.push({ hit: false, text: rest })
    })
    return out
  }, [text])
  return (
    <p className={className ?? 'truncate text-sm'}>
      {parts.map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded bg-primary/15 px-0.5 text-foreground">
            {part.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{part.text}</React.Fragment>
        )
      )}
    </p>
  )
}

/**
 * Cmd/Ctrl+K. Channels, DMs, people and agents are filtered locally (cmdk's fuzzy
 * match); from two characters on the server is asked too — `GET /api/search` returns
 * messages the user can read and notes of agents they manage — and every agent
 * becomes an "Ask @agent about …" entry that DMs it a memory question.
 */
export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const [mode, setMode] = React.useState<PaletteMode>('all')
  const [query, setQuery] = React.useState('')
  const navigate = useNavigate()
  const me = useMe().data
  const { company } = useChannelGroups()
  const dms = useDmViews()
  const { users } = useDirectoryUsers()
  const { agents } = useDirectoryAgents()
  const lookup = useLookupMember()
  const openDm = useOpenDm()
  const openDmMutate = openDm.mutateAsync
  const sendMessage = useSendMessage()
  const sendMutate = sendMessage.mutateAsync

  const settled = useDebounced(query, SEARCH_DEBOUNCE_MS)
  const searching = mode === 'all' && query.trim().length >= SEARCH_MIN_CHARS
  const search = useSearch(searching ? settled : '')
  const hits = searching ? (search.data?.messages ?? []) : []
  const notes = searching ? (search.data?.notes ?? []) : []

  const api = React.useMemo<PaletteApi>(
    () => ({
      open: (next: PaletteMode = 'all') => {
        setMode(next)
        setQuery('')
        setOpen(true)
      }
    }),
    []
  )

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setMode('all')
        setQuery('')
        setOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const startDm = async (memberKind: MemberKind, memberId: MemberId): Promise<void> => {
    setOpen(false)
    const channel = await openDmMutate({ memberKind, memberId })
    void navigate({ to: '/dm/$channelId', params: { channelId: channel.id } })
  }

  /** A reply opens its thread; a top-level message is scrolled to and flashed. */
  const jumpTo = (hit: MessageHit): void => {
    setOpen(false)
    const params = { channelId: hit.channel.id }
    const search =
      hit.message.threadId === undefined
        ? { at: hit.message.id }
        : { thread: hit.message.threadId, at: hit.message.id }
    void (hit.channel.kind === 'dm'
      ? navigate({ to: '/dm/$channelId', params, search })
      : navigate({ to: '/c/$channelId', params, search }))
  }

  const askAgent = async (agent: DirectoryAgent, question: string): Promise<void> => {
    setOpen(false)
    const channel = await openDmMutate({ memberKind: 'agent', memberId: agent.id })
    await sendMutate({ channelId: channel.id, body: askBody(question) })
    void navigate({ to: '/dm/$channelId', params: { channelId: channel.id } })
  }

  const openNote = (note: AgentNoteHit): void => {
    setOpen(false)
    void navigate({ to: '/agents/$agentId', params: { agentId: note.agentId } })
  }

  const question = query.trim()

  /**
   * cmdk fuzzy-filters every item against the input, including the ones the
   * server already matched — and stemming means a server hit often does not
   * contain what was typed (`forced` matches a message saying "forcing").
   *
   * `keywords` is the documented way to feed it extra matchable text, but
   * cmdk 1.1.1 only re-registers an item when its `value` string changes, so a
   * keyword that tracks the query goes stale the moment the item stays mounted
   * across a keystroke: results found at `forc` vanish at `forcing`. Carrying
   * the query inside `value` changes the string on every keystroke, which is
   * what makes the re-registration happen.
   */
  const serverValue = (id: string): string => `${id} ${question}`

  return (
    <PaletteContext.Provider value={api}>
      {children}
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search Taut"
        description="Search messages, jump to a channel or a person, or ask an agent what was said."
        className="sm:max-w-2xl"
      >
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={
            mode === 'dm' ? 'Message someone…' : 'Search messages, channels, people, agents…'
          }
        />
        <CommandList className="max-h-[60vh]">
          <CommandEmpty>
            {searching && search.isFetching ? 'Searching…' : 'Nothing matches.'}
          </CommandEmpty>

          {searching ? (
            <CommandGroup
              heading={
                <span className="inline-flex items-center gap-1.5">
                  Messages
                  {search.isFetching ? <Loader2Icon className="size-3 animate-spin" /> : null}
                </span>
              }
            >
              {hits.map((hit) => {
                const author = lookup(hit.message.authorId)
                return (
                  <CommandItem
                    key={hit.message.id}
                    value={serverValue(`message ${hit.message.id}`)}
                    onSelect={() => jumpTo(hit)}
                  >
                    <MessageSquareTextIcon />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
                        <span className="truncate">
                          {hit.channel.kind === 'dm' ? 'Direct message' : `#${hit.channel.name}`}
                        </span>
                        <span aria-hidden>·</span>
                        <span className="truncate">{author?.name ?? 'Unknown member'}</span>
                        <span aria-hidden>·</span>
                        <span className="shrink-0">{formatRelative(hit.message.createdAt)}</span>
                        {hit.message.threadId === undefined ? null : (
                          <span className="shrink-0 rounded border px-1 text-[10px]">reply</span>
                        )}
                      </div>
                      <Snippet text={hit.snippet} />
                    </div>
                  </CommandItem>
                )
              })}
              {hits.length === 0 && search.isSuccess && !search.isFetching ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">
                  No messages mention “{question}”.
                </div>
              ) : null}
            </CommandGroup>
          ) : null}

          {searching && notes.length > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="Agent notes">
                {notes.map((note) => {
                  const agent = agents.find((a) => a.id === note.agentId)
                  return (
                    <CommandItem
                      key={note.noteId}
                      value={serverValue(`note ${note.noteId}`)}
                      onSelect={() => openNote(note)}
                    >
                      <StickyNoteIcon />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
                          <span className="truncate">@{agent?.handle ?? 'agent'}</span>
                          <span aria-hidden>·</span>
                          <span className="shrink-0">{formatRelative(note.at)}</span>
                          {note.tags.map((tag) => (
                            <span key={tag} className="shrink-0 rounded border px-1 text-[10px]">
                              {tag}
                            </span>
                          ))}
                        </div>
                        <p className="truncate text-sm">{note.body}</p>
                      </div>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </>
          ) : null}

          {searching && agents.length > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="Ask an agent">
                {agents.map((agent) => (
                  <CommandItem
                    key={`ask-${agent.id}`}
                    value={serverValue(`ask ${agent.handle} ${agent.name}`)}
                    onSelect={() => void askAgent(agent, question)}
                  >
                    <SparklesIcon />
                    <span className="min-w-0 truncate">
                      Ask <span className="font-medium">@{agent.handle}</span> what we said about “
                      {question}”
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          ) : null}

          {mode === 'all' && company.length > 0 ? (
            <>
              {searching ? <CommandSeparator /> : null}
              <CommandGroup heading="Channels">
                {company.map((channel) => (
                  <CommandItem
                    key={channel.id}
                    value={`#${channel.name}`}
                    onSelect={() => {
                      setOpen(false)
                      void navigate({ to: '/c/$channelId', params: { channelId: channel.id } })
                    }}
                  >
                    <HashIcon />
                    {channel.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          ) : null}

          {mode === 'all' && dms.length > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="Direct messages">
                {dms.map((view) => (
                  <CommandItem
                    key={view.channel.id}
                    value={`dm ${view.label}`}
                    onSelect={() => {
                      setOpen(false)
                      void navigate({
                        to: '/dm/$channelId',
                        params: { channelId: view.channel.id }
                      })
                    }}
                  >
                    {view.partner === undefined ? (
                      <UserIcon />
                    ) : (
                      <EntityAvatar
                        onProfileNavigate={() => setOpen(false)}
                        memberId={view.partner.id}
                        avatar={view.partner.avatar}
                        kind={view.partner.kind}
                        face={view.partner.face}
                        name={view.partner.name}
                        size="sm"
                      />
                    )}
                    {view.partner?.name ?? view.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          ) : null}

          <CommandSeparator />
          <CommandGroup heading="People">
            {users
              .filter((user) => user.id !== me?.user.id)
              .map((user) => (
                <CommandItem
                  key={user.id}
                  value={`${user.name} ${user.handle} ${user.email}`}
                  onSelect={() => void startDm('user', user.id)}
                >
                  <EntityAvatar
                    onProfileNavigate={() => setOpen(false)}
                    memberId={user.id}
                    avatar={user.avatar}
                    name={user.name}
                    size="sm"
                  />
                  <span>{user.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">@{user.handle}</span>
                </CommandItem>
              ))}
          </CommandGroup>

          <CommandSeparator />
          <CommandGroup heading="Agents">
            {agents.map((agent) => (
              <CommandItem
                key={agent.id}
                value={`${agent.name} ${agent.handle}`}
                onSelect={() => void startDm('agent', agent.id)}
              >
                <EntityAvatar
                  onProfileNavigate={() => setOpen(false)}
                  memberId={agent.id}
                  kind="agent"
                  face={agent.face}
                  name={agent.name}
                  size="sm"
                />
                <span>{agent.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">@{agent.handle}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </PaletteContext.Provider>
  )
}
