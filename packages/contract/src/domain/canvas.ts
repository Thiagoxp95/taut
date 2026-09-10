import { Schema } from 'effect'
import { AgentId, ChannelId, MessageId } from '../ids.js'

/** Metadata travels on the event stream; HTML is fetched through an authorized read. */
export const Canvas = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  channelId: ChannelId,
  threadId: Schema.optional(MessageId),
  agentId: AgentId,
  open: Schema.Boolean,
  revision: Schema.Int.pipe(Schema.positive()),
  updatedAt: Schema.String
})
export type Canvas = typeof Canvas.Type
export const CanvasDocument = Schema.Struct({ ...Canvas.fields, html: Schema.String })
export type CanvasDocument = typeof CanvasDocument.Type
