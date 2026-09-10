import { describe, expect, it } from 'vitest'
import { AgentId, AttachmentId, ChannelId, CompanyId, MessageId } from '@taut/contract'
import { DateTime } from 'effect'
import { canvasAttachmentFormat } from '../../web/src/lib/attachments'
import { emptyCanvasState, reduceCanvasState } from '../../web/src/lib/canvas-state'

const attachment = {
  id: AttachmentId.make('att_recipe'),
  companyId: CompanyId.make('cmp_test'),
  channelId: ChannelId.make('chn_test'),
  messageId: MessageId.make('msg_reply'),
  uploaderKind: 'agent' as const,
  uploaderId: AgentId.make('agt_test'),
  name: 'chocolate-cake.html',
  mimeType: 'text/html',
  size: 100,
  createdAt: DateTime.unsafeMake('2026-09-10T12:00:00Z')
}
const threadId = MessageId.make('msg_root')
const canvas = {
  id: 'cnv_recipe',
  title: 'Chocolate Cake',
  channelId: attachment.channelId,
  threadId,
  agentId: AgentId.make('agt_test'),
  revision: 1,
  open: false,
  updatedAt: '2026-09-10T12:00:00Z'
}

describe('document attachment canvases', () => {
  it('does not reopen a dismissed attachment when the initial canvas list arrives', () => {
    let state = reduceCanvasState(emptyCanvasState, {
      type: 'show-attachment',
      attachment,
      threadId
    })
    state = reduceCanvasState(state, { type: 'dismiss' })
    state = reduceCanvasState(state, { type: 'seed', canvases: [{ ...canvas, open: true }] })
    expect(state.activeId).toBeUndefined()
    expect(state.attachment).toBeUndefined()
  })
  it.each([
    ['recipe.MD', 'application/octet-stream', 'markdown'],
    ['recipe.markdown', 'text/plain', 'markdown'],
    ['recipe.HTML', 'application/octet-stream', 'html'],
    ['recipe.htm', 'text/plain', 'html'],
    ['recipe', 'text/markdown; charset=utf-8', 'markdown'],
    ['recipe', 'text/html', 'html'],
    ['recipe.pdf', 'application/pdf', undefined],
    ['recipe.txt', 'text/plain', undefined]
  ])('recognizes %s (%s) as %s', (name, mimeType, expected) => {
    expect(canvasAttachmentFormat({ name, mimeType })).toBe(expected)
  })

  it('opens the matching live canvas, even when the agent closed it', () => {
    const seeded = reduceCanvasState(emptyCanvasState, { type: 'seed', canvases: [canvas] })
    const opened = reduceCanvasState(seeded, { type: 'show-attachment', attachment, threadId })
    expect(opened.activeId).toBe('cnv_recipe')
    const updated = reduceCanvasState(opened, {
      type: 'change',
      action: 'update',
      canvas: { ...canvas, revision: 2 }
    })
    expect(updated.activeId).toBe('cnv_recipe')
    expect(updated.canvases.get('cnv_recipe')?.revision).toBe(2)
  })

  it('previews the file itself without guessing another thread or author’s canvas', () => {
    const seeded = reduceCanvasState(emptyCanvasState, {
      type: 'seed',
      canvases: [
        { ...canvas, threadId: MessageId.make('msg_other') },
        { ...canvas, id: 'cnv_other', agentId: AgentId.make('agt_other') }
      ]
    })
    const opened = reduceCanvasState(seeded, { type: 'show-attachment', attachment, threadId })
    expect(opened.activeId).toBeUndefined()
    expect(opened.attachment?.attachment.id).toBe('att_recipe')
  })

  it('connects a file opened before the canvas list loads, and keeps dismissal through updates', () => {
    let state = reduceCanvasState(emptyCanvasState, {
      type: 'show-attachment',
      attachment,
      threadId
    })
    expect(state.attachment?.attachment.id).toBe('att_recipe')
    state = reduceCanvasState(state, { type: 'seed', canvases: [canvas] })
    expect(state.activeId).toBe('cnv_recipe')
    expect(state.attachment).toBeUndefined()
    state = reduceCanvasState(state, { type: 'dismiss' })
    state = reduceCanvasState(state, {
      type: 'change',
      action: 'update',
      canvas: { ...canvas, revision: 2 }
    })
    expect(state.activeId).toBeUndefined()
    expect(state.attachment).toBeUndefined()
  })

  it('dismisses standalone files and does not choose between ambiguous canvas names', () => {
    const seeded = reduceCanvasState(emptyCanvasState, {
      type: 'seed',
      canvases: [canvas, { ...canvas, id: 'cnv_duplicate' }]
    })
    const opened = reduceCanvasState(seeded, { type: 'show-attachment', attachment, threadId })
    expect(opened.activeId).toBeUndefined()
    expect(opened.attachment).toBeDefined()
    expect(reduceCanvasState(opened, { type: 'dismiss' }).attachment).toBeUndefined()
  })
})
