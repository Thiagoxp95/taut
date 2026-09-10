import * as React from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  GlobeIcon,
  HashIcon,
  MessagesSquareIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon
} from '@taut/ui/components/icons'
import type { Channel, MessageId } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@taut/ui/components/tooltip'
import { BrowserPanel, useConversationBrowser } from '@/components/browser-panel'
import { ChannelMembersSheet } from '@/components/channel-members-sheet'
import {
  CanvasPanel,
  CanvasProvider,
  ChannelCanvases,
  useCanvasWorkspace
} from '@/components/canvas-dialog'
import { useCommandPalette } from '@/components/command-palette'
import { Composer } from '@/components/composer'
import { HuddleButton } from '@/components/huddle-bar'
import { MessageList, MessageListSkeleton } from '@/components/message-list'
import { EmptyState, PageHeader } from '@/components/page'
import { PaneLayout } from '@/components/pane-layout'
import { SidebarTrigger } from '@taut/ui/components/sidebar'
import { cn } from '@taut/ui/lib/utils'
import { ThreadPanel } from '@/components/thread-panel'
import { useMarkReadOnView } from '@/hooks/use-realtime'
import { useMessages, useThreadContextSeed } from '@/lib/api'
import { flattenChannel } from '@/lib/message-cache'

function ChannelIntro({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="px-6 pt-8 pb-4">
      <h2 className="text-xl font-bold">{title}</h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">{blurb}</p>
    </div>
  )
}

export function ChannelView(props: React.ComponentProps<typeof ChannelConversation>) {
  return props.channel === undefined ? (
    <ChannelConversation {...props} />
  ) : (
    <CanvasProvider key={props.channel.id} channelId={props.channel.id}>
      <ChannelConversation {...props} />
    </CanvasProvider>
  )
}

function ChannelConversation({
  channel,
  title,
  subtitle,
  icon,
  intro,
  headerAvatar,
  headerActions,
  threadId,
  focusMessageId
}: {
  channel: Channel | undefined
  title: string
  subtitle: string
  icon?: React.ReactNode
  intro: string
  headerAvatar?: React.ReactNode
  /** Trailing DM action, such as the agent settings gear. */
  headerActions?: React.ReactNode
  /** From `?thread=<messageId>`; `undefined` closes the panel. */
  threadId?: MessageId
  /** From `?at=<messageId>` (a search hit): scroll to it, flash it, then drop the param. */
  focusMessageId?: MessageId
}) {
  const navigate = useNavigate()
  const canvas = useCanvasWorkspace()
  const palette = useCommandPalette()
  const channelId = channel?.id
  const browser = useConversationBrowser(channelId, threadId)
  const browserOpen = browser.active !== undefined && !canvas?.open
  const sidePaneOpen = browserOpen || (canvas?.open ?? false)
  const messages = useMessages(channelId)
  // Fills the context rings for this channel's threads, so a refresh mid-run does not blank
  // every meter on screen (docs/build-plan-context-meter.md).
  useThreadContextSeed(channelId)
  const [membersOpen, setMembersOpen] = React.useState(false)

  useMarkReadOnView(channelId)

  const list = React.useMemo(() => flattenChannel(messages.data), [messages.data])

  /*
   * A search hit on a reply arrives as `?thread=<root>&at=<reply>`: the reply is
   * only rendered inside the thread panel, so the main list must not try to find
   * it (it would burn its older-page budget and never flash).
   */
  const focusInThread =
    threadId !== undefined && focusMessageId !== undefined && focusMessageId !== threadId

  const dismissCanvas = canvas?.dismiss
  // A newly browsing task reveals its live view once; opening a document afterwards wins.
  const browserTaskId = browser.active?.taskId
  React.useEffect(() => {
    if (browserTaskId !== undefined) dismissCanvas?.()
  }, [browserTaskId, dismissCanvas])
  const browserButton = (compact = false) =>
    browser.runs.length === 0 ? null : (
      <Button
        variant="ghost"
        size={compact ? 'icon-sm' : 'sm'}
        title="Show agent browser"
        data-browser-trigger="true"
        aria-label="Show agent browser"
        aria-pressed={browserOpen}
        onClick={() => {
          dismissCanvas?.()
          browser.show()
        }}
      >
        <GlobeIcon /> {compact ? null : 'Browser'}
      </Button>
    )
  const closeThread = React.useCallback(() => {
    dismissCanvas?.()
    void navigate({ to: '.', search: {}, replace: true })
  }, [navigate, dismissCanvas])

  // The hit is on screen: drop `?at=` so a refresh or a back-navigation does not re-scroll.
  const clearFocus = React.useCallback(() => {
    void navigate({
      to: '.',
      search: threadId === undefined ? {} : { thread: threadId },
      replace: true
    })
  }, [navigate, threadId])

  const openThread = React.useCallback(
    (messageId: MessageId) => {
      dismissCanvas?.()
      void navigate({ to: '.', search: { thread: messageId } })
    },
    [navigate, dismissCanvas]
  )

  // Escape closes the thread panel from anywhere in the channel.
  React.useEffect(() => {
    if (threadId === undefined) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        document.querySelector(
          '[data-canvas-panel="true"][data-open="true"], [data-browser-panel="true"][data-open="true"]'
        ) === null
      ) {
        closeThread()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [threadId, closeThread])

  const canvasThreadId = canvas?.active?.threadId ?? canvas?.state.attachment?.threadId
  React.useEffect(() => {
    if (canvas?.open && canvasThreadId !== undefined && canvasThreadId !== threadId) {
      void navigate({ to: '.', search: { thread: canvasThreadId }, replace: true })
    }
  }, [canvas?.open, canvasThreadId, threadId, navigate])

  return (
    <PaneLayout
      threadOpen={channel !== undefined && threadId !== undefined}
      canvasOpen={sidePaneOpen}
      data-thread-open={channel !== undefined && threadId !== undefined}
      data-canvas-open={sidePaneOpen}
      className="taut-conversation @container/conversation relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      <div
        className={cn(
          'taut-channel-main flex min-h-0 min-w-0 flex-1 flex-col',
          channel !== undefined && threadId !== undefined && 'hidden @3xl/conversation:flex'
        )}
      >
        {headerAvatar !== undefined ? (
          <header className="taut-topbar flex h-14 shrink-0 items-center justify-between gap-2 border-b px-3 sm:px-5">
            <SidebarTrigger className="shrink-0 md:hidden" />
            <h1 className="min-w-0 flex-1 text-lg font-bold">
              <button
                type="button"
                className="flex max-w-full min-w-0 items-center gap-2.5 rounded-md px-1 py-1.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setMembersOpen(true)}
                disabled={channel === undefined}
                aria-label={`View conversation details for ${title}`}
                title={subtitle}
              >
                {headerAvatar}
                <span className="truncate">{title}</span>
              </button>
            </h1>
            <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
              {browserButton()}
              {channel === undefined ? null : (
                <ChannelCanvases key={channel.id} channelId={channel.id} />
              )}
              {channel === undefined ? null : <HuddleButton channelId={channel.id} iconOnly />}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Search messages"
                    onClick={() => palette.open()}
                  >
                    <SearchIcon className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Search messages</TooltipContent>
              </Tooltip>
              {headerActions}
            </div>
          </header>
        ) : (
          <PageHeader
            title={title}
            description={subtitle}
            icon={headerAvatar ?? icon ?? <HashIcon className="size-4" />}
            actions={
              <>
                {browserButton()}
                {channel === undefined ? null : (
                  <ChannelCanvases key={channel.id} channelId={channel.id} />
                )}
                {channel === undefined ? null : <HuddleButton channelId={channel.id} />}
                {channel === undefined ? null : (
                  <Button variant="ghost" size="sm" onClick={() => setMembersOpen(true)}>
                    <UsersIcon />
                    Members
                  </Button>
                )}
                {channel === undefined || channel.kind === 'dm' ? null : (
                  <Button asChild variant="ghost" size="icon-sm" aria-label="Channel settings">
                    <Link to="/channels/$channelId/settings" params={{ channelId: channel.id }}>
                      <SettingsIcon />
                    </Link>
                  </Button>
                )}
              </>
            }
          />
        )}

        {messages.isPending ? (
          <MessageListSkeleton />
        ) : (
          <MessageList
            messages={list}
            channelId={channelId}
            hasOlder={messages.hasNextPage}
            isLoadingOlder={messages.isFetchingNextPage}
            onLoadOlder={() => void messages.fetchNextPage()}
            onOpenThread={openThread}
            activeThreadId={threadId}
            focusId={focusInThread ? undefined : focusMessageId}
            onFocused={clearFocus}
            header={<ChannelIntro title={title} blurb={intro} />}
            empty={
              <div className="px-6 py-10">
                <EmptyState
                  icon={<MessagesSquareIcon className="size-5" />}
                  title="No messages yet"
                  description="Say something, or @mention an agent to put it to work."
                />
              </div>
            }
          />
        )}

        <Composer channelId={channelId} placeholder={`Message ${title}`} />
      </div>

      {channel !== undefined && threadId !== undefined ? (
        <ThreadPanel
          channelId={channel.id}
          threadId={threadId}
          browserAction={browserButton(true)}
          focusId={focusInThread ? focusMessageId : undefined}
          onFocused={clearFocus}
          onClose={closeThread}
        />
      ) : null}

      <CanvasPanel />
      <BrowserPanel run={browser.active} open={browserOpen} onClose={browser.dismiss} />

      {channel === undefined ? null : (
        <ChannelMembersSheet channel={channel} open={membersOpen} onOpenChange={setMembersOpen} />
      )}
    </PaneLayout>
  )
}
