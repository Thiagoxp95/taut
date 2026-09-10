import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Attachment, ChannelId, MessageId } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { DownloadIcon, MonitorIcon, XIcon } from '@taut/ui/components/icons'
import { PaneHandle, PaneLayout } from '@/components/pane-layout'
import { attachmentUrl, useAttachmentText, useCanvasDocument, useChannelCanvases } from '@/lib/api'
import { canvasAttachmentFormat } from '@/lib/attachments'
import { CANVAS_ESCAPE_MESSAGE, isCanvasEscapeMessage } from '@/lib/canvas-bridge'
import { live, useCanvasState } from '@/lib/live'

// This policy is parsed before any agent markup. The opaque-origin sandbox prevents
// preview scripts from reaching the application, its session, or the desktop bridge.
const PREVIEW_POLICY = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`
const ESCAPE_MESSAGE = JSON.stringify(CANVAS_ESCAPE_MESSAGE)
const PREVIEW_HEAD = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}; frame-src 'none'"><meta name="referrer" content="no-referrer"><script>window.addEventListener('keydown',function(event){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();parent.postMessage({type:${ESCAPE_MESSAGE}},'*')}},true)</script>`
const WRAPPER_ESCAPE_BRIDGE = `<script>const preview=document.querySelector('iframe');window.addEventListener('message',function(event){if(event.source===preview.contentWindow&&event.data&&event.data.type===${ESCAPE_MESSAGE}){parent.postMessage({type:${ESCAPE_MESSAGE}},'*')}})</script>`

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function previewDocument(html: string, title: string): string {
  // A trusted parent applies frame-src to the preview's own navigation. A CSP inside
  // the untrusted frame alone would still let its scripts navigate that frame away.
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}; frame-src about:"><meta name="referrer" content="no-referrer"><style>html,body{height:100%;margin:0}iframe{display:block;width:100%;height:100%;border:0}</style><iframe title="${escapeAttribute(title)}" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeAttribute(PREVIEW_HEAD + html)}"></iframe>${WRAPPER_ESCAPE_BRIDGE}`
}

type Workspace = ReturnType<typeof useWorkspaceState>
const CanvasContext = React.createContext<Workspace | null>(null)

export function useCanvasWorkspace() {
  return React.useContext(CanvasContext)
}

function useWorkspaceState(channelId: ChannelId, threadId?: MessageId) {
  const list = useChannelCanvases(channelId)
  const state = useCanvasState(channelId, threadId)
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const active = state.activeId === undefined ? undefined : state.canvases.get(state.activeId)
  const open = active !== undefined || state.attachment !== undefined
  const canvases = React.useMemo(
    () => [...state.canvases.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [state.canvases]
  )

  React.useEffect(() => {
    if (list.data !== undefined) {
      live.canvas(
        channelId,
        {
          type: 'seed',
          canvases:
            threadId === undefined
              ? list.data
              : list.data.filter((canvas) => canvas.threadId === threadId)
        },
        threadId
      )
    }
  }, [channelId, threadId, list.data])

  const dismiss = React.useCallback(() => {
    live.canvas(channelId, { type: 'dismiss' }, threadId)
    const trigger = triggerRef.current
    if (trigger?.isConnected) trigger.focus({ preventScroll: true })
  }, [channelId, threadId])

  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')
      )
        return
      event.preventDefault()
      dismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, dismiss])

  const rememberTrigger = () => {
    if (
      document.activeElement instanceof HTMLElement &&
      !document.activeElement.closest('[data-canvas-panel]')
    ) {
      triggerRef.current = document.activeElement
    }
  }
  const show = (id: string) => {
    rememberTrigger()
    live.canvas(channelId, { type: 'show', id }, threadId)
  }
  const showAttachment = (attachment: Attachment, attachmentThreadId?: MessageId) => {
    rememberTrigger()
    live.canvas(
      channelId,
      { type: 'show-attachment', attachment, threadId: attachmentThreadId },
      threadId
    )
  }
  return { channelId, state, active, open, canvases, show, showAttachment, dismiss }
}

/** One viewer per conversation. Keeping it outside the header lets the thread
 * and the page remain mounted and interactive while the canvas is open. */
export function CanvasProvider({
  channelId,
  threadId,
  children
}: {
  channelId: ChannelId
  threadId?: MessageId
  children: React.ReactNode
}) {
  const workspace = useWorkspaceState(channelId, threadId)
  return <CanvasContext.Provider value={workspace}>{children}</CanvasContext.Provider>
}

export function ChannelCanvases({ threadId }: { channelId?: ChannelId; threadId?: MessageId }) {
  const workspace = useCanvasWorkspace()
  const canvases =
    workspace?.canvases.filter(
      (canvas) => threadId === undefined || canvas.threadId === threadId
    ) ?? []
  if (canvases.length === 0) return null
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="Open canvases"
      onClick={() => {
        const latest = canvases[0]
        if (latest !== undefined) workspace?.show(latest.id)
      }}
    >
      <MonitorIcon aria-hidden="true" />
      <span className="hidden sm:inline">Canvases</span>
      <span className="text-xs tabular-nums text-muted-foreground">{canvases.length}</span>
    </Button>
  )
}

export function CanvasPanel() {
  const workspace = useCanvasWorkspace()
  if (workspace === null) return null
  return <CanvasPanelContent workspace={workspace} />
}

function CanvasPanelContent({ workspace }: { workspace: Workspace }) {
  const { channelId, active, open, state, canvases, dismiss, show } = workspace
  const document = useCanvasDocument(channelId, active)
  const attachment = state.attachment?.attachment
  const file = useAttachmentText(attachment?.id)
  const title = active?.title ?? attachment?.name ?? 'Canvas'
  const format = attachment === undefined ? 'html' : canvasAttachmentFormat(attachment)
  const source = active === undefined ? file.data : document.data?.html
  const error = active === undefined ? file.isError : document.isError
  const frameRef = React.useRef<HTMLIFrameElement>(null)
  const selectId = React.useId()
  // Hold the last page during the close transition, then release the frame.
  const pageKey = active?.id ?? attachment?.id ?? ''
  const page = React.useMemo(
    () =>
      source === undefined
        ? undefined
        : {
            title,
            source,
            format,
            key: pageKey
          },
    [title, source, format, pageKey]
  )
  const [lastPage, setLastPage] = React.useState(page)
  if (page !== undefined && page !== lastPage) setLastPage(page)
  React.useEffect(() => {
    if (open) return
    const timer = window.setTimeout(() => setLastPage(undefined), 240)
    return () => window.clearTimeout(timer)
  }, [open])
  const visiblePage = open ? page : lastPage
  const preview = React.useMemo(
    () =>
      visiblePage?.format === 'html'
        ? previewDocument(visiblePage.source, visiblePage.title)
        : undefined,
    [visiblePage]
  )

  React.useEffect(() => {
    if (!open) return
    const onMessage = (event: MessageEvent<unknown>) => {
      if (isCanvasEscapeMessage(event, frameRef.current?.contentWindow)) dismiss()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [open, dismiss])

  return (
    <aside
      aria-label="Canvas"
      aria-hidden={!open}
      inert={!open}
      data-canvas-panel="true"
      data-open={open}
      className="taut-canvas-panel flex min-h-0 flex-col bg-background"
    >
      <PaneHandle pane="canvas" label="Resize document" />
      <header className="taut-topbar flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <MonitorIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold">
            {open ? title : (visiblePage?.title ?? title)}
          </h2>
          <p className="text-xs text-muted-foreground">
            {active === undefined ? 'Document preview' : 'Live canvas'}
          </p>
        </div>
        {attachment === undefined ? null : (
          <Button asChild variant="ghost" size="icon-sm" aria-label="Download document">
            <a href={attachmentUrl(attachment.id, { download: true })} download={attachment.name}>
              <DownloadIcon />
            </a>
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Close canvas" onClick={dismiss}>
          <XIcon />
        </Button>
      </header>
      {canvases.length > 1 || (attachment !== undefined && canvases.length > 0) ? (
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
          <label htmlFor={selectId} className="text-xs text-muted-foreground">
            Canvas
          </label>
          <select
            id={selectId}
            value={active?.id ?? ''}
            onChange={(event) => show(event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {attachment === undefined ? null : <option value="">{attachment.name}</option>}
            {canvases.map((canvas) => (
              <option key={canvas.id} value={canvas.id}>
                {canvas.title}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="taut-canvas-desk taut-scroll min-h-0 flex-1 overflow-auto bg-muted/30 p-3 sm:p-5">
        {open && error ? (
          <div
            role="alert"
            className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm"
          >
            <p>Could not load this document.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void (active === undefined ? file.refetch() : document.refetch())}
            >
              Try again
            </Button>
          </div>
        ) : visiblePage === undefined ? (
          open ? (
            <p role="status" className="p-6 text-center text-sm text-muted-foreground">
              Loading canvas…
            </p>
          ) : null
        ) : (
          <div className="taut-canvas-page mx-auto overflow-hidden border bg-white text-neutral-900 shadow-sm">
            {preview === undefined ? (
              <article className="taut-canvas-markdown p-6 sm:p-12">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  skipHtml
                  components={{
                    a: ({ href, children }) => (
                      <a href={href} target="_blank" rel="noreferrer noopener">
                        {children}
                      </a>
                    )
                  }}
                >
                  {visiblePage.source}
                </ReactMarkdown>
              </article>
            ) : (
              <iframe
                key={visiblePage.key}
                ref={frameRef}
                title={visiblePage.title}
                srcDoc={preview}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                className="block h-full min-h-[inherit] w-full border-0 bg-white"
              />
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

/** Issue discussions use the same document viewer as channel threads. */
export function DocumentWorkspace({
  channelId,
  threadId,
  children
}: {
  channelId?: ChannelId
  threadId?: MessageId
  children: React.ReactNode
}) {
  if (channelId === undefined) return <div className="flex min-h-0 flex-1 flex-col">{children}</div>
  return (
    <CanvasProvider
      key={`${channelId}:${threadId ?? ''}`}
      channelId={channelId}
      threadId={threadId}
    >
      <DocumentWorkspaceLayout>{children}</DocumentWorkspaceLayout>
    </CanvasProvider>
  )
}

function DocumentWorkspaceLayout({ children }: { children: React.ReactNode }) {
  const canvas = useCanvasWorkspace()
  return (
    <PaneLayout
      threadOpen={false}
      canvasOpen={canvas?.open ?? false}
      className="taut-document-workspace @container/conversation relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      data-canvas-open={canvas?.open ?? false}
    >
      <div className="taut-document-content flex min-h-0 min-w-0 flex-col">{children}</div>
      <CanvasPanel />
    </PaneLayout>
  )
}
