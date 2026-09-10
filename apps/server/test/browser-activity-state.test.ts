import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../web/node_modules/react', async (original) => ({
  ...(await original<object>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useMemo: (compute: () => unknown) => compute()
}))
import { live, useBrowserRuns } from '../../web/src/lib/live'

const run = {
  taskId: 'task',
  messageId: 'reply',
  agentId: 'agent',
  channelId: 'channel',
  threadId: 'root'
}
afterEach(() => live.reset())

describe('conversation browser activity', () => {
  it('shows browser activity only in its conversation and keeps it through thinking', () => {
    live.setBrowserRun(run)
    live.setActivity('reply', { kind: 'thinking', text: 'Considering the page' })
    expect(useBrowserRuns('channel')).toEqual([run])
    expect(useBrowserRuns('channel', 'root')).toEqual([run])
    expect(useBrowserRuns('other')).toEqual([])
    expect(useBrowserRuns('channel', 'other-root')).toEqual([])
    live.setBrowserRun(run)
    expect(useBrowserRuns('channel')).toHaveLength(1)
  })

  it('stops viewing when the task ends even if its start event was missed', () => {
    live.setBrowserRun(run)
    live.endRun('task')
    expect(useBrowserRuns('channel')).toEqual([])
  })

  it('clears a missed finish on reconnect and ignores late activity after completion', () => {
    live.startRun('root', 'task', run)
    live.setBrowserRun(run)
    live.seedRuns([])
    expect(useBrowserRuns('channel')).toEqual([])
    live.endRun('task')
    live.setBrowserRun(run)
    expect(useBrowserRuns('channel')).toEqual([])
  })

  it('keeps another browser run when one ends and clears on company switch', () => {
    const other = { ...run, taskId: 'second', agentId: 'second-agent' }
    live.setBrowserRun(run)
    live.setBrowserRun(other)
    live.endRun('task')
    expect(useBrowserRuns('channel')).toEqual([other])
    live.reset()
    expect(useBrowserRuns('channel')).toEqual([])
  })
})
