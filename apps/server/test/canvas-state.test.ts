import { describe, expect, it } from 'vitest'
import { AgentId, ChannelId, MessageId } from '@taut/contract'
import {
  emptyCanvasState,
  reduceCanvasState,
  reduceCanvasScopes,
  type CanvasState
} from '../../web/src/lib/canvas-state'

const canvas = (id = 'canvas-a', revision = 1, open = true) => ({
  id,
  revision,
  open,
  title: id,
  channelId: ChannelId.make('chn_test'),
  agentId: AgentId.make('agt_test'),
  updatedAt: '2026-09-09T12:00:00.000Z'
})
const change = (
  state: CanvasState,
  action: 'create' | 'update' | 'open' | 'close',
  value = canvas()
) => reduceCanvasState(state, { type: 'change', action, canvas: value })

describe('canvas presentation', () => {
  it('opens agent-created canvases and retains every preview for selection', () => {
    let state = change(emptyCanvasState, 'create')
    state = change(state, 'create', canvas('canvas-b'))
    expect(state.activeId).toBe('canvas-b')
    expect([...state.canvases.keys()]).toEqual(['canvas-a', 'canvas-b'])
    state = reduceCanvasState(state, { type: 'show', id: 'canvas-a' })
    expect(state.activeId).toBe('canvas-a')
  })

  it('keeps a local dismissal through updates and refetches, until an agent opens again', () => {
    let state = change(emptyCanvasState, 'create')
    state = reduceCanvasState(state, { type: 'dismiss' })
    state = change(state, 'update', canvas('canvas-a', 2))
    state = reduceCanvasState(state, { type: 'seed', canvases: [canvas('canvas-a', 2)] })
    expect(state.activeId).toBeUndefined()
    state = change(state, 'open', canvas('canvas-a', 3))
    expect(state.activeId).toBe('canvas-a')
  })

  it('ignores duplicate and stale events after dismissal', () => {
    let state = change(emptyCanvasState, 'open', canvas('canvas-a', 3))
    expect(state.activeId).toBe('canvas-a')
    state = reduceCanvasState(state, { type: 'dismiss' })
    expect(change(state, 'open', canvas('canvas-a', 3))).toBe(state)
    expect(change(state, 'create', canvas('canvas-a', 1))).toBe(state)
  })

  it('closes only the targeted preview, including a locally reopened closed canvas', () => {
    let state = change(emptyCanvasState, 'create')
    state = change(state, 'create', canvas('canvas-b'))
    state = change(state, 'close', canvas('canvas-a', 2, false))
    expect(state.activeId).toBe('canvas-b')
    state = reduceCanvasState(state, { type: 'show', id: 'canvas-a' })
    state = change(state, 'close', canvas('canvas-a', 3, false))
    expect(state.activeId).toBeUndefined()
  })

  it('restores persisted open canvases once without reopening after every list fetch', () => {
    let state = reduceCanvasState(emptyCanvasState, { type: 'seed', canvases: [canvas()] })
    expect(state.activeId).toBe('canvas-a')
    state = reduceCanvasState(state, { type: 'dismiss' })
    state = reduceCanvasState(state, { type: 'seed', canvases: [canvas('canvas-a', 2)] })
    expect(state.activeId).toBeUndefined()
    expect(state.canvases.get('canvas-a')?.revision).toBe(2)
  })

  it('does not let an older initial list undo an event or a dismissal during loading', () => {
    let state = change(emptyCanvasState, 'create', canvas('canvas-a', 2))
    state = reduceCanvasState(state, { type: 'dismiss' })
    state = reduceCanvasState(state, { type: 'seed', canvases: [canvas(), canvas('canvas-b')] })
    expect(state.activeId).toBeUndefined()
    expect(state.canvases.get('canvas-a')?.revision).toBe(2)
    expect(state.canvases.has('canvas-b')).toBe(true)
  })

  it('recovers a missed close on resync while retaining a manually reopened closed canvas', () => {
    let state = change(emptyCanvasState, 'create')
    state = reduceCanvasState(state, { type: 'seed', canvases: [canvas('canvas-a', 2, false)] })
    expect(state.activeId).toBeUndefined()
    state = reduceCanvasState(state, { type: 'show', id: 'canvas-a' })
    state = reduceCanvasState(state, { type: 'seed', canvases: [canvas('canvas-a', 2, false)] })
    expect(state.activeId).toBe('canvas-a')
  })
})

describe('canvas conversation scope', () => {
  it('keeps issue previews separate while including thread canvases in their channel', () => {
    const first = { ...canvas(), threadId: MessageId.make('msg_first') }
    const second = { ...canvas('canvas-b'), threadId: MessageId.make('msg_second') }
    let scopes = reduceCanvasScopes(new Map(), 'chn_test', {
      type: 'change',
      action: 'create',
      canvas: first
    })
    scopes = reduceCanvasScopes(scopes, 'chn_test', {
      type: 'change',
      action: 'create',
      canvas: second
    })
    expect(scopes.get('chn_test')?.activeId).toBe('canvas-b')
    expect(scopes.get('chn_test:msg_first')?.activeId).toBe('canvas-a')
    expect(scopes.get('chn_test:msg_second')?.activeId).toBe('canvas-b')
    expect(scopes.get('chn_test:msg_first')?.canvases.has('canvas-b')).toBe(false)
    scopes = reduceCanvasScopes(scopes, 'chn_test', { type: 'dismiss' }, 'msg_first')
    expect(scopes.get('chn_test:msg_first')?.activeId).toBeUndefined()
    expect(scopes.get('chn_test:msg_second')?.activeId).toBe('canvas-b')
  })
})
