import { afterEach, describe, expect, it, vi } from 'vitest'

// Read the actual external-store snapshots without mounting a browser renderer.
vi.mock('../../web/node_modules/react', async (original) => ({
  ...(await original<object>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useMemo: (compute: () => unknown) => compute()
}))

import { live, useThreadRuns, useMessageActivity, useMessageTaskId } from '../../web/src/lib/live'

const reply = { threadId: 'root', messageId: 'reply', agentId: 'agent' }
afterEach(() => live.reset())

describe('activity in an unopened thread', () => {
  it('targets the task for each activity line and forgets it when the run ends', () => {
    live.startRun('root', 'task', reply)
    live.startRun('root', 'other-task', { ...reply, messageId: 'other-reply' })
    expect(useMessageTaskId('reply')).toBe('task')
    expect(useMessageTaskId('other-reply')).toBe('other-task')
    expect(useMessageTaskId('unknown')).toBeUndefined()
    live.endRun('task')
    expect(useMessageTaskId('reply')).toBeUndefined()
    expect(useMessageTaskId('other-reply')).toBe('other-task')
    live.reset()
    live.seedRuns([{ taskId: 'restored-task', triggerMessageId: 'root', ...reply }])
    expect(useMessageTaskId('reply')).toBe('restored-task')
    live.reset()
    expect(useMessageTaskId('reply')).toBeUndefined()
  })

  it('exposes the pending reply and its latest activity without loading thread messages', () => {
    live.startRun('root', 'task', reply)
    live.startRun('root', 'task', reply)
    live.setActivity('reply', { kind: 'thinking', text: 'Reading the skill' })
    expect(useThreadRuns('root')).toEqual([reply])
    expect(useMessageActivity(useThreadRuns('root')[0]!.messageId)?.text).toBe('Reading the skill')
    expect(useThreadRuns('another-root')).toEqual([])
    live.endRun('task')
    expect(useThreadRuns('root')).toEqual([])
  })

  it('keeps the root working when a reply inside the thread invokes another agent', () => {
    live.startRun('follow-up', 'task', reply)
    expect(useThreadRuns('root')).toEqual([reply])
    expect(useThreadRuns('follow-up')).toEqual([])
  })

  it('restores pending replies on reload and preserves starts newer than a refetch', () => {
    const since = live.runEpoch()
    live.startRun('root', 'task', reply)
    live.seedRuns([], since)
    expect(useThreadRuns('root')).toEqual([reply])
    live.endRun('task')
    live.seedRuns([{ taskId: 'task', triggerMessageId: 'root', ...reply }], since)
    expect(useThreadRuns('root')).toEqual([])
    live.reset()
    live.seedRuns([{ taskId: 'task', triggerMessageId: 'root', ...reply }])
    expect(useThreadRuns('root')).toEqual([reply])
    live.seedRuns([])
    expect(useThreadRuns('root')).toEqual([])
  })

  it('keeps other agents working when one finishes, and clears on company switch', () => {
    const other = { ...reply, messageId: 'reply-2', agentId: 'agent-2' }
    live.startRun('root', 'task', reply)
    live.startRun('root', 'task-2', other)
    live.endRun('task')
    expect(useThreadRuns('root')).toEqual([other])
    live.reset()
    expect(useThreadRuns('root')).toEqual([])
  })
})
