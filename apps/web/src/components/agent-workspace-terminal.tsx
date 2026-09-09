/**
 * The Terminal pane (docs/build-plan-workspace.md D7, D9, D14): `@xterm/xterm` +
 * `@xterm/addon-fit` over one `WorkspaceSocket`. Loaded lazily by
 * `agent-workspace.tsx` so the agent page's bundle is unchanged for anyone who
 * never opens the tab.
 *
 * Bytes in, bytes out: xterm's `onData` strings are UTF-8 encoded and base64'd
 * into `stdin`; `data` frames are decoded to bytes and written as bytes, so a
 * multi-byte sequence split across two chunks renders correctly. The fit addon
 * follows the pane's size and every refit sends a `resize`, so the shell's
 * `COLUMNS`/`LINES` match what the viewer sees.
 */
import * as React from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import {
  base64ToBytes,
  textToBase64,
  type SocketClosed,
  type WorkspaceSocket
} from '@/lib/workspace'

/** The colours xterm gets; the page's own theme is not consulted on purpose (a terminal is dark). */
const THEME = {
  background: '#0b0f14',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  selectionBackground: '#264f78'
}

const notice = (text: string): string => `\r\n\x1b[1;33m— ${text}\x1b[0m\r\n`

export default function AgentWorkspaceTerminal({
  socket,
  onGeometry
}: {
  socket: WorkspaceSocket
  /** Reported after every fit, so the tab can open the socket with the right size. */
  onGeometry?: (cols: number, rows: number) => void
}) {
  const hostRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: THEME,
      allowProposedApi: false
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)

    const refit = () => {
      try {
        fit.fit()
      } catch {
        return
      }
      onGeometry?.(terminal.cols, terminal.rows)
      socket.send({ _tag: 'resize', cols: terminal.cols, rows: terminal.rows })
    }
    refit()
    const observer = new ResizeObserver(() => refit())
    observer.observe(host)

    const offData = socket.on('data', (frame) => {
      terminal.write(base64ToBytes(frame.data))
    })
    const offReady = socket.on('ready', (frame) => {
      terminal.writeln(`\x1b[2mConnected to ${frame.machineId} (${frame.shell})\x1b[0m`)
      refit()
      terminal.focus()
    })
    const offError = socket.on('error', (frame) => {
      terminal.write(notice(frame.message))
    })
    const offExit = socket.on('exit', (frame) => {
      terminal.write(notice(`Shell exited with code ${frame.exitCode}.`))
    })
    const offState = socket.onState((state: string, closed?: SocketClosed) => {
      if (state === 'closed') {
        terminal.write(notice(`Disconnected${closed?.reason ? ` (${closed.reason})` : ''}.`))
        terminal.options.cursorBlink = false
      }
    })
    const input = terminal.onData((text) => {
      socket.send({ _tag: 'stdin', data: textToBase64(text) })
    })

    return () => {
      input.dispose()
      offData()
      offReady()
      offError()
      offExit()
      offState()
      observer.disconnect()
      terminal.dispose()
    }
  }, [socket, onGeometry])

  return (
    <div
      ref={hostRef}
      className="h-[26rem] w-full overflow-hidden rounded-lg border bg-[#0b0f14] p-2"
      aria-label="Terminal"
    />
  )
}
