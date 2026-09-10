import * as React from 'react'

/**
 * The conversation's vertical splits — channel | thread | document — dragged by
 * the border between them.
 *
 * The panes stay absolutely positioned and animate by transform, so a drag only
 * moves two custom properties (`--thread-width`, `--canvas-width`) and never
 * remounts a list or loses a draft. Widths live in `localStorage`: the same
 * store the desktop shell gets, since it loads this app from its own origin.
 * A browser that refuses storage simply starts from the defaults every time.
 */

const STORAGE_KEY = 'taut.pane-widths'

export type PaneKey = 'thread' | 'canvas'

const DEFAULTS: Record<PaneKey, number> = { thread: 384, canvas: 520 }
const MIN: Record<PaneKey, number> = { thread: 260, canvas: 320 }
/** The channel column keeps this much room no matter where a border is dragged. */
const CHANNEL_MIN = 320
/** One arrow-key press. */
const STEP = 16

type Widths = Record<PaneKey, number>

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), Math.max(low, high))

const readStored = (): Widths => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULTS
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULTS
    const record = parsed as Partial<Record<PaneKey, unknown>>
    const pick = (pane: PaneKey): number =>
      typeof record[pane] === 'number' && Number.isFinite(record[pane])
        ? Math.max(MIN[pane], record[pane])
        : DEFAULTS[pane]
    return { thread: pick('thread'), canvas: pick('canvas') }
  } catch {
    return DEFAULTS
  }
}

const writeStored = (widths: Widths): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(widths))
  } catch {
    // Remembering the split is a convenience; a browser that blocks site data
    // loses it between sessions and nothing else.
  }
}

/** What the panes may actually take once the window has had its say. */
function fit(widths: Widths, open: Record<PaneKey, boolean>, container: number): Widths {
  if (container === 0) return widths
  const room = container - CHANNEL_MIN
  const canvas = open.canvas ? clamp(widths.canvas, MIN.canvas, room) : widths.canvas
  const thread = open.thread
    ? clamp(widths.thread, MIN.thread, room - (open.canvas ? canvas : 0))
    : widths.thread
  return { thread, canvas }
}

interface PaneLayoutState {
  readonly widths: Widths
  /** Sets one pane's width in pixels, held inside the room the others leave. */
  readonly resize: (pane: PaneKey, width: number) => void
  readonly commit: () => void
  readonly reset: (pane: PaneKey) => void
}

const PaneContext = React.createContext<PaneLayoutState | null>(null)

export function PaneLayout({
  threadOpen,
  canvasOpen,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & { threadOpen: boolean; canvasOpen: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [stored, setStored] = React.useState<Widths>(readStored)
  const [container, setContainer] = React.useState(0)

  React.useEffect(() => {
    const element = ref.current
    if (element === null) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry !== undefined) setContainer(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const open = React.useMemo(
    () => ({ thread: threadOpen, canvas: canvasOpen }),
    [threadOpen, canvasOpen]
  )
  const widths = React.useMemo(() => fit(stored, open, container), [stored, open, container])

  const state = React.useMemo<PaneLayoutState>(() => {
    const bound = (pane: PaneKey, width: number): number => {
      if (container === 0) return Math.max(MIN[pane], width)
      const other = pane === 'thread' && open.canvas ? widths.canvas : 0
      const taken = pane === 'canvas' && open.thread ? widths.thread : other
      return clamp(width, MIN[pane], container - CHANNEL_MIN - taken)
    }
    return {
      widths,
      resize: (pane, width) => setStored((current) => ({ ...current, [pane]: bound(pane, width) })),
      commit: () => setStored((current) => (writeStored(current), current)),
      reset: (pane) =>
        setStored((current) => {
          const next = { ...current, [pane]: DEFAULTS[pane] }
          writeStored(next)
          return next
        })
    }
  }, [widths, open, container])

  return (
    <PaneContext.Provider value={state}>
      <div
        ref={ref}
        style={
          {
            ...style,
            '--thread-width': `${widths.thread}px`,
            '--canvas-width': `${widths.canvas}px`
          } as React.CSSProperties
        }
        {...props}
      >
        {children}
      </div>
    </PaneContext.Provider>
  )
}

function Triangle({ pointing }: { pointing: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 5 8" aria-hidden="true" className="h-2 w-[5px] fill-current">
      <path d={pointing === 'left' ? 'M5 0 0 4l5 4z' : 'M0 0l5 4-5 4z'} />
    </svg>
  )
}

/**
 * The border a pane is dragged by. It sits on the pane's own left edge, so it
 * travels with the pane when the document slides in behind it.
 */
export function PaneHandle({ pane, label }: { pane: PaneKey; label: string }) {
  const layout = React.useContext(PaneContext)
  const [dragging, setDragging] = React.useState(false)

  if (layout === null) return null

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const startX = event.clientX
    const startWidth = layout.widths[pane]
    handle.setPointerCapture(event.pointerId)
    setDragging(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    // Dragging left grows a pane: every one of them is anchored to the right.
    const onMove = (move: PointerEvent): void =>
      layout.resize(pane, startWidth + (startX - move.clientX))
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setDragging(false)
      layout.commit()
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const step = event.key === 'ArrowLeft' ? STEP : event.key === 'ArrowRight' ? -STEP : 0
    if (step === 0) return
    event.preventDefault()
    layout.resize(pane, layout.widths[pane] + step)
    layout.commit()
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(layout.widths[pane])}
      tabIndex={0}
      data-dragging={dragging}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => layout.reset(pane)}
      title="Drag to resize, double-click to reset"
      className="taut-pane-handle group absolute inset-y-0 -left-[3px] z-30 w-[7px] cursor-col-resize touch-none focus-visible:outline-none"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-primary opacity-0 transition-opacity group-hover:opacity-50 group-focus-visible:opacity-50 group-data-[dragging=true]:opacity-100"
      />
      <span
        aria-hidden="true"
        className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-[3px] rounded-full border bg-popover px-[5px] py-2 text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[dragging=true]:opacity-100"
      >
        <Triangle pointing="left" />
        <Triangle pointing="right" />
      </span>
    </div>
  )
}
