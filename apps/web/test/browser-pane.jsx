import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PaneLayout } from '../src/components/pane-layout'
import { BrowserPanel, useConversationBrowser } from '../src/components/browser-panel'
import { live } from '../src/lib/live'
import { qk } from '../src/lib/query-keys'
import '../src/styles/globals.css'

// Only the transport is simulated; the production pane, hook and controls run unchanged.
const sockets = []
const inputs = []
const canvas = document.createElement('canvas')
canvas.width = 1280
canvas.height = 720
const ctx = canvas.getContext('2d')
ctx.fillStyle = '#fff'
ctx.fillRect(0, 0, 1280, 720)
ctx.fillStyle = '#151515'
ctx.font = '32px sans-serif'
ctx.fillText('Live browser preview', 70, 100)
const jpeg = canvas.toDataURL('image/jpeg').split(',')[1]
class PreviewWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  readyState = 0
  constructor() {
    sockets.push(this)
    setTimeout(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.({})
      this.emit({ _tag: 'control', holder: null, paused: false, owned: false })
      this.page('Example', 'https://example.test/')
    }, 50)
  }
  emit(frame) {
    if (frame._tag === 'tabs') this.tabs = frame
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  page(title, url) {
    this.emit({ _tag: 'browser', state: 'live' })
    this.emit({ _tag: 'tabs', tabs: [{ id: 'page', title, url }], activeTabId: 'page' })
    this.emit({ _tag: 'frame', data: jpeg, width: 1280, height: 720 })
  }
  send(value) {
    const frame = JSON.parse(value)
    inputs.push(frame)
    if (frame._tag === 'selectTab') {
      this.emit({ ...this.tabs, activeTabId: frame.tabId ?? 'page' })
      this.emit({
        _tag: 'frame',
        data: canvas.toDataURL('image/jpeg').split(',')[1],
        width: canvas.width,
        height: canvas.height
      })
    }
    if (frame._tag === 'viewport') {
      canvas.width = frame.width
      canvas.height = frame.height
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#151515'
      ctx.font = '24px sans-serif'
      ctx.fillText('Live browser preview', 24, 60)
      ctx.fillText(`${frame.width} × ${frame.height}`, 24, 100)
      this.emit({
        _tag: 'frame',
        data: canvas.toDataURL('image/jpeg').split(',')[1],
        width: frame.width,
        height: frame.height
      })
    }
    if (frame._tag === 'control')
      this.emit({
        _tag: 'control',
        holder: frame.hold ? 'usr_me' : null,
        paused: frame.hold && frame.pause,
        owned: frame.hold
      })
  }
  close() {
    this.readyState = 3
    this.onclose?.({ code: 1000, reason: 'viewer left' })
  }
}
window.WebSocket = PreviewWebSocket
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } }
})
client.setQueryData(qk.me, { user: { id: 'usr_me' }, activeCompanyId: 'cmp_test', memberships: [] })
client.setQueryData(qk.agents, {
  items: [{ id: 'agt_browser', name: 'Browser agent', departmentIds: [] }]
})
client.setQueryData(qk.departments, { items: [] })
const run = {
  taskId: 'task-1',
  messageId: 'reply',
  agentId: 'agt_browser',
  channelId: 'channel',
  threadId: 'thread'
}
live.setBrowserRun(run)
window.browserFixture = {
  sockets,
  inputs,
  end: () => live.endRun('task-1'),
  next: () => live.setBrowserRun({ ...run, taskId: 'task-2' }),
  working: () => live.setPresence('agt_browser', 'working')
}
function Fixture() {
  const [thread, setThread] = React.useState('thread')
  const browser = useConversationBrowser('channel', thread)
  return (
    <PaneLayout
      className="taut-conversation relative h-dvh overflow-hidden"
      threadOpen={false}
      canvasOpen={!!browser.active}
      data-thread-open={false}
      data-canvas-open={!!browser.active}
    >
      <main className="taut-channel-main flex flex-col p-6">
        <h1>Thread</h1>
        <button onClick={browser.show} data-browser-trigger>
          Show browser
        </button>
        <button onClick={() => setThread('other')}>Other thread</button>
        <textarea aria-label="Reply" className="mt-auto border" />
      </main>
      <BrowserPanel run={browser.active} open={!!browser.active} onClose={browser.dismiss} />
    </PaneLayout>
  )
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}>
    <Fixture />
  </QueryClientProvider>
)
