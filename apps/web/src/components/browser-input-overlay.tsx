import * as React from 'react'
import type { BrowserInputEvent } from '@taut/contract/terminal'

/** CDP modifier bits. */
const modifiersOf = (e: {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)

const buttonOf = (button: number): 'left' | 'middle' | 'right' | 'none' =>
  button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : 'none'

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/** Pointer position as a fraction of the frame. */
const positionIn = (
  element: HTMLElement,
  e: { clientX: number; clientY: number }
): { x: number; y: number } => {
  const rect = element.getBoundingClientRect()
  return {
    x: rect.width === 0 ? 0 : clamp01((e.clientX - rect.left) / rect.width),
    y: rect.height === 0 ? 0 : clamp01((e.clientY - rect.top) / rect.height)
  }
}

/** Keys whose `keyDown` carries no text; everything else (one printable char) does. */
const textOf = (e: React.KeyboardEvent): string | undefined =>
  e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : undefined

const MOUSEMOVE_INTERVAL_MS = 33

/** Shared input surface for settings and conversation browser views. */
export function BrowserInputOverlay({
  driving,
  send
}: {
  driving: boolean
  send: (event: BrowserInputEvent) => void
}) {
  const overlayRef = React.useRef<HTMLDivElement>(null)
  const lastMove = React.useRef(0)
  React.useEffect(() => {
    if (driving) overlayRef.current?.focus()
  }, [driving])
  const handleMouse = (
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
    e: React.MouseEvent
  ) => {
    const overlay = overlayRef.current
    if (!driving || overlay === null) return
    e.preventDefault()
    if (type === 'mouseMoved') {
      const now = performance.now()
      if (now - lastMove.current < MOUSEMOVE_INTERVAL_MS) return
      lastMove.current = now
    }
    const { x, y } = positionIn(overlay, e)
    send({
      _tag: 'mouse',
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : buttonOf(e.button),
      clickCount: type === 'mouseMoved' ? 0 : Math.min(3, Math.max(1, e.detail)),
      modifiers: modifiersOf(e)
    })
  }

  React.useEffect(() => {
    const overlay = overlayRef.current
    if (!driving || overlay === null) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const { x, y } = positionIn(overlay, e)
      send({
        _tag: 'mouse',
        type: 'mouseWheel',
        x,
        y,
        button: 'none',
        deltaX: Math.max(-10_000, Math.min(10_000, e.deltaX)),
        deltaY: Math.max(-10_000, Math.min(10_000, e.deltaY)),
        modifiers: modifiersOf(e)
      })
    }
    // React's delegated wheel listener is passive; capture here so scrolling
    // drives the remote page without scrolling the conversation too.
    overlay.addEventListener('wheel', onWheel, { passive: false })
    return () => overlay.removeEventListener('wheel', onWheel)
  }, [driving, send])

  const handleKey = (type: 'keyDown' | 'keyUp', e: React.KeyboardEvent) => {
    if (!driving || e.key === 'Tab') return
    e.preventDefault()
    const text = type === 'keyDown' ? textOf(e) : undefined
    send({
      _tag: 'key',
      type,
      key: e.key.slice(0, 32),
      code: e.code.slice(0, 32),
      ...(text === undefined ? {} : { text }),
      keyCode: Math.min(255, Math.max(0, e.keyCode)),
      modifiers: modifiersOf(e)
    })
  }

  return (
    <div
      ref={overlayRef}
      role="application"
      aria-label={driving ? 'You are driving the browser' : 'Browser live view'}
      tabIndex={driving ? 0 : -1}
      className={
        driving
          ? 'absolute inset-0 cursor-crosshair outline-none ring-2 ring-amber-400 ring-inset'
          : 'absolute inset-0'
      }
      onMouseDown={(e) => handleMouse('mousePressed', e)}
      onMouseUp={(e) => handleMouse('mouseReleased', e)}
      onMouseMove={(e) => handleMouse('mouseMoved', e)}
      onKeyDown={(e) => handleKey('keyDown', e)}
      onKeyUp={(e) => handleKey('keyUp', e)}
      onContextMenu={(e) => {
        if (driving) e.preventDefault()
      }}
    />
  )
}
