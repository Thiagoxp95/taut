import type { Attachment, Canvas, MessageId } from '@taut/contract'

interface CanvasAttachment {
  readonly attachment: Attachment
  readonly threadId?: MessageId
}

export interface CanvasState {
  readonly canvases: ReadonlyMap<string, Canvas>
  readonly activeId: string | undefined
  readonly seeded: boolean
  readonly attachment?: CanvasAttachment
}

export type CanvasAction =
  | { readonly type: 'seed'; readonly canvases: readonly Canvas[] }
  | {
      readonly type: 'change'
      readonly canvas: Canvas
      readonly action: 'create' | 'update' | 'open' | 'close'
    }
  | { readonly type: 'show'; readonly id: string }
  | ({ readonly type: 'show-attachment' } & CanvasAttachment)
  | { readonly type: 'dismiss' }

export const emptyCanvasState: CanvasState = {
  canvases: new Map(),
  activeId: undefined,
  seeded: false
}

export function reduceCanvasScopes(
  scopes: ReadonlyMap<string, CanvasState>,
  channelId: string,
  action: CanvasAction,
  threadId?: string
): ReadonlyMap<string, CanvasState> {
  const keys = [threadId === undefined ? channelId : `${channelId}:${threadId}`]
  if (action.type === 'change' && threadId === undefined && action.canvas.threadId !== undefined) {
    keys.push(`${channelId}:${action.canvas.threadId}`)
  }
  let updated = scopes
  for (const key of keys) {
    const previous = updated.get(key) ?? emptyCanvasState
    const next = reduceCanvasState(previous, action)
    if (next !== previous) {
      const copy = new Map(updated)
      copy.set(key, next)
      updated = copy
    }
  }
  return updated
}

/** Metadata revisions arbitrate REST/socket races; presentation is local to this viewer. */
export function reduceCanvasState(state: CanvasState, action: CanvasAction): CanvasState {
  if (action.type === 'dismiss') {
    return state.activeId === undefined && state.attachment === undefined
      ? state
      : { ...state, activeId: undefined, attachment: undefined, seeded: true }
  }
  if (action.type === 'show-attachment') {
    return connectAttachment({ ...state, activeId: undefined, attachment: action })
  }
  if (action.type === 'show') {
    return state.canvases.has(action.id)
      ? { ...state, activeId: action.id, attachment: undefined }
      : state
  }
  if (action.type === 'change') {
    const previous = state.canvases.get(action.canvas.id)
    if (previous !== undefined && previous.revision >= action.canvas.revision) return state
    const canvases = new Map(state.canvases)
    canvases.set(action.canvas.id, action.canvas)
    let activeId = state.activeId
    if (
      state.attachment === undefined &&
      (action.action === 'create' || action.action === 'open') &&
      action.canvas.open
    ) {
      activeId = action.canvas.id
    } else if (action.action === 'close' && activeId === action.canvas.id) {
      activeId = undefined
    }
    return connectAttachment({ ...state, canvases, activeId })
  }

  const canvases = new Map(state.canvases)
  let activeId = state.activeId
  let latestOpen: Canvas | undefined
  for (const canvas of action.canvases) {
    const previous = canvases.get(canvas.id)
    if (previous !== undefined && previous.revision >= canvas.revision) continue
    canvases.set(canvas.id, canvas)
    if (!canvas.open && previous?.open && activeId === canvas.id) activeId = undefined
    if (canvas.open && (latestOpen === undefined || canvas.updatedAt > latestOpen.updatedAt)) {
      latestOpen = canvas
    }
  }
  // Only a fresh viewer restores an open preview. Refetches must not undo a dismissal,
  // nor should a slow initial response replace a preview already opened by the socket.
  if (!state.seeded && state.canvases.size === 0 && state.attachment === undefined)
    activeId = latestOpen?.id
  return connectAttachment({ ...state, canvases, activeId, seeded: true })
}

function documentName(name: string): string {
  return name
    .replace(/\.(html?|md|markdown)$/i, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim()
}

/** Legacy attachments have no canvas ID. Only an unambiguous name in the same
 * conversation and from the same agent can select a live document. */
function connectAttachment(state: CanvasState): CanvasState {
  if (state.attachment === undefined) return state
  const { attachment, threadId } = state.attachment
  if (attachment.uploaderKind !== 'agent') return state
  const matches = [...state.canvases.values()].filter(
    (canvas) =>
      canvas.channelId === attachment.channelId &&
      canvas.threadId === threadId &&
      canvas.agentId === attachment.uploaderId &&
      documentName(canvas.title) === documentName(attachment.name)
  )
  return matches.length === 1
    ? { ...state, activeId: matches[0]?.id, attachment: undefined }
    : state
}
