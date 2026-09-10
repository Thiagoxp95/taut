import { Effect, Stream } from 'effect'
import { Bus } from '../realtime/bus.js'
import type { BusMessage } from '../realtime/events.js'
import { Projects } from './projects.js'

/**
 * Taut replies about a ticket, out to Linear as comments
 * (docs/build-plan-issues.md D11, D12).
 *
 * This hangs off the event bus and not off an HTTP handler, which is the whole
 * decision: **a chat message must never fail because Linear is down.** By the time
 * a `message.created` reaches here the message is posted, the mentions have
 * resolved and the agents are awake; a push that fails is logged and dropped, and
 * the ledger in `project_issue_comments` is what keeps a later one from saying the
 * same thing twice.
 *
 * One subscriber for the whole process, like `PushNotifier`: it reads
 * `Bus.streamAll()`, so it sees every company. It asks one indexed question of
 * every message — "is this thread some issue's thread?" — and for every ordinary
 * message in the workspace the answer is no and nothing else happens.
 */
export class IssueCommentPush extends Effect.Service<IssueCommentPush>()('IssueCommentPush', {
  scoped: Effect.gen(function* () {
    const bus = yield* Bus
    const projects = yield* Projects

    const handle = (message: BusMessage): Effect.Effect<void> => {
      if (message._tag !== 'Event') return Effect.void
      const event = message.event
      if (event.type !== 'message.created') return Effect.void
      const posted = event.payload.message
      // A streaming placeholder has no words yet; the finalize is not a create,
      // so an agent's own answer is pushed when it lands, not when it starts.
      if (posted.status === 'streaming') return Effect.void
      return projects
        .pushIssueComment(message.companyId, {
          id: posted.id,
          threadId: posted.threadId,
          authorKind: posted.authorKind,
          authorId: posted.authorId,
          body: posted.body
        })
        .pipe(Effect.annotateLogs({ companyId: message.companyId, messageId: posted.id }))
    }

    // One failed push must never take the subscriber down with it.
    yield* bus
      .streamAll()
      .pipe(
        Stream.runForEach((message) =>
          handle(message).pipe(
            Effect.catchAllCause((cause) => Effect.logWarning('linear: comment push error', cause))
          )
        )
      )
      .pipe(Effect.forkScoped)

    yield* Effect.logInfo('linear: watching for replies on issue threads')
    return {} as const
  })
}) {}
