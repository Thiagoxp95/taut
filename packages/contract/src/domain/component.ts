import { Schema } from 'effect'
import { SignalId, UserId } from '../ids.js'

const text = (max: number) =>
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(max), Schema.pattern(/\S/))
export const ComponentQuestion = Schema.Struct({
  id: text(64),
  question: text(1000),
  options: Schema.Array(
    Schema.Struct({ label: text(200), description: Schema.optional(text(500)) })
  ).pipe(Schema.minItems(2), Schema.maxItems(6)),
  multiSelect: Schema.optional(Schema.Boolean)
})
export const ComponentQuestions = Schema.Array(ComponentQuestion).pipe(
  Schema.minItems(1),
  Schema.maxItems(4)
)
export const ComponentAnswer = Schema.Struct({
  questionId: text(64),
  selections: Schema.Array(text(200)).pipe(Schema.maxItems(6)),
  text: Schema.optional(Schema.String.pipe(Schema.maxLength(4000)))
})
export type ComponentAnswer = typeof ComponentAnswer.Type

/** Tool data selects trusted application components; it never executes generated code. */
export const RenderComponentRequest = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('timer'),
    title: text(200),
    durationSeconds: Schema.Int.pipe(Schema.between(1, 604800)),
    onComplete: text(2000)
  }),
  Schema.Struct({ kind: Schema.Literal('card'), title: text(200), body: text(12000) })
)
export type RenderComponentRequest = typeof RenderComponentRequest.Type

export const MessageComponent = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('questions'),
    title: text(4000),
    questions: ComponentQuestions,
    recipientId: UserId,
    status: Schema.Literal('pending', 'answered'),
    answers: Schema.optional(Schema.Array(ComponentAnswer)),
    answeredBy: Schema.optional(UserId),
    answeredAt: Schema.optional(Schema.String)
  }),
  Schema.Struct({
    kind: Schema.Literal('timer'),
    title: text(200),
    durationSeconds: Schema.Number,
    endsAt: Schema.String,
    signalId: SignalId,
    onComplete: text(2000)
  }),
  Schema.Struct({ kind: Schema.Literal('card'), title: text(200), body: text(12000) })
)
export type MessageComponent = typeof MessageComponent.Type
