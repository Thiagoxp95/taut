import { Message } from '@taut/contract/domain'
/**
 * `/api/agent-runtime/*` — the routes of `AgentRuntimeRoutes` (`@taut/taut-mcp/protocol`),
 * `Authorization: Bearer <TAUT_TOKEN>`. A plain `HttpRouter` mounted next to the `TautApi`
 * groups: the web contract never sees these. Requests are decoded with the protocol schemas,
 * responses encoded with them; every failure is `{ error: { code, message, gateId? } }`.
 */
import { HttpApiBuilder, HttpRouter, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { AGENT_RUNTIME_PREFIX, AgentRuntimeRoutes, type ErrorBody } from '@taut/taut-mcp/protocol'
import { Cause, Effect, Option, Schema } from 'effect'
import {
  AgentApi,
  ApiFailure,
  GitCredentialRequest,
  GitCredentialResponse,
  OpenPullRequestRequest,
  OpenPullRequestResponse
} from '../agents/agentApi.js'
import { TaskTokens, type TokenPrincipal } from '../agents/tokens.js'

const errorResponse = (status: number, code: string, message: string, gateId?: string) =>
  HttpServerResponse.unsafeJson(
    { error: { code, message, ...(gateId === undefined ? {} : { gateId }) } } satisfies ErrorBody,
    { status }
  )

const AskIdParam = Schema.Struct({ id: Schema.String })

/** Second mount point for the same routes; see the note where it is used. */
const AGENT_ALIAS_PREFIX = '/api/agent'

export const AgentRuntimeLive = HttpApiBuilder.Router.use((router) =>
  Effect.gen(function* () {
    const api = yield* AgentApi
    const tokens = yield* TaskTokens

    const authenticate: Effect.Effect<
      TokenPrincipal,
      ApiFailure,
      HttpServerRequest.HttpServerRequest
    > = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const header = request.headers['authorization'] ?? ''
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
      if (token.length === 0) {
        return yield* new ApiFailure({
          status: 401,
          code: 'unauthorized',
          message: 'missing bearer token'
        })
      }
      const principal = yield* tokens.verify(token)
      if (Option.isNone(principal)) {
        return yield* new ApiFailure({
          status: 401,
          code: 'unauthorized',
          message: 'invalid or expired task token'
        })
      }
      return principal.value
    })

    /** GET requests carry their fields as query strings; numeric-looking values are coerced. */
    const searchParams = (
      request: HttpServerRequest.HttpServerRequest
    ): Record<string, unknown> => {
      const out: Record<string, unknown> = {}
      for (const [key, value] of new URL(request.url, 'http://localhost').searchParams) {
        out[key] = /^-?\d+$/.test(value) ? Number(value) : value
      }
      return out
    }

    /** Decode → run → encode; failures become `ErrorBody` with their status. */
    const handle = <
      Req extends Schema.Schema.AnyNoContext,
      Res extends Schema.Schema.AnyNoContext,
      E
    >(
      route: { readonly method: 'GET' | 'POST'; readonly request: Req; readonly response: Res },
      body: (
        principal: TokenPrincipal,
        input: Schema.Schema.Type<Req>
      ) => Effect.Effect<Schema.Schema.Type<Res>, E>,
      /**
       * D6: set for a response the **agent** never reads — `git-credential`'s answer goes to the
       * `git` process that asked, so draining the steer queue into it would throw those messages
       * away. Everything else the agent calls carries them.
       */
      options: { readonly steer: boolean } = { steer: true }
    ) =>
      Effect.gen(function* () {
        const principal = yield* authenticate
        const request = yield* HttpServerRequest.HttpServerRequest
        const input: Schema.Schema.Type<Req> =
          route.method === 'GET'
            ? yield* Schema.decodeUnknown(route.request)(searchParams(request))
            : yield* HttpServerRequest.schemaBodyJson(route.request)
        const result = yield* body(principal, input)
        const encoded = Schema.encodeSync(route.response)(result)
        // D6: whatever landed in this task's thread while the run was in flight rides on the
        // response, merged after encoding — `Schema.Struct` would drop it as an excess key,
        // and declaring it on all twenty-odd response schemas says the same thing worse.
        const steer = options.steer ? yield* api.drainSteer(principal) : []
        return HttpServerResponse.unsafeJson(
          steer.length === 0 || typeof encoded !== 'object' || encoded === null
            ? encoded
            : { ...(encoded as Record<string, unknown>), steer }
        )
      }).pipe(
        Effect.catchAll((e: unknown) => {
          if (e instanceof ApiFailure)
            return Effect.succeed(errorResponse(e.status, e.code, e.message, e.gateId))
          if (Schema.is(Schema.Struct({ _tag: Schema.Literal('ParseError') }))(e)) {
            return Effect.succeed(
              errorResponse(
                422,
                'validation',
                String((e as { message?: unknown }).message ?? 'invalid request')
              )
            )
          }
          if (Schema.is(Schema.Struct({ _tag: Schema.Literal('RequestError') }))(e)) {
            return Effect.succeed(errorResponse(400, 'bad_request', 'unreadable request body'))
          }
          if (Schema.is(Schema.Struct({ _tag: Schema.Literal('MemoryError') }))(e)) {
            return Effect.succeed(
              errorResponse(
                422,
                'validation',
                String((e as { message?: unknown }).message ?? 'memory error')
              )
            )
          }
          return Effect.fail(e)
        }),
        Effect.catchAllCause((cause) =>
          Effect.logError('agent-runtime: handler failed', cause).pipe(
            Effect.as(
              errorResponse(
                500,
                'server_error',
                Cause.pretty(cause).split('\n')[0] ?? 'internal error'
              )
            )
          )
        )
      )

    const R = AgentRuntimeRoutes
    const memory = (principal: TokenPrincipal) => api.memory(principal)

    const coreRoutes = HttpRouter.empty.pipe(
      HttpRouter.post(
        '/send',
        handle(R.send, (p, input) => api.send(p, input))
      ),
      HttpRouter.get(
        '/inbox',
        handle(R.inbox, (p, input) => api.inbox(p, input.since))
      ),
      HttpRouter.post(
        '/ask',
        handle(R.ask, (p, input) => api.ask(p, input))
      ),
      HttpRouter.get(
        '/ask/:id',
        Effect.gen(function* () {
          const { id } = yield* HttpRouter.schemaPathParams(AskIdParam)
          return yield* handle(R.askStatus, (p, input) => api.askStatus(p, id, input.wait))
        }).pipe(
          Effect.catchAll(() => Effect.succeed(errorResponse(404, 'not_found', 'ask not found')))
        )
      ),
      HttpRouter.post(
        '/done',
        handle(R.done, (p, input) => api.done(p, input))
      ),
      HttpRouter.post(
        '/handoff',
        handle(R.handoff, (p, input) => api.handoff(p, input))
      ),
      HttpRouter.post(
        '/memory/search',
        handle(R.memorySearch, (p, i) =>
          memory(p).pipe(
            Effect.flatMap((m) => m.search(i.query, i)),
            Effect.map((items) => ({ items }))
          )
        )
      ),
      HttpRouter.post(
        '/memory/grep',
        handle(R.memoryGrep, (p, i) =>
          memory(p).pipe(
            Effect.flatMap((m) => m.grep(i.pattern, i)),
            Effect.map((items) => ({ items }))
          )
        )
      ),
      HttpRouter.post(
        '/memory/recall-thread',
        handle(R.memoryRecall, (p, i) =>
          memory(p).pipe(
            Effect.flatMap((m) => m.recallThread(i.threadId, i)),
            Effect.map((items) => ({ items }))
          )
        )
      ),
      HttpRouter.post(
        '/memory/timeline',
        handle(R.memoryTimeline, (p, i) =>
          memory(p).pipe(
            Effect.flatMap((m) => m.timeline(i)),
            Effect.map((items) => ({ items }))
          )
        )
      ),
      HttpRouter.post(
        '/memory/note',
        handle(R.memoryNote, (p, i) =>
          memory(p).pipe(
            Effect.flatMap((m) => m.note(i.text, i.tags)),
            Effect.map((item) => ({ item }))
          )
        )
      ),
      HttpRouter.get(
        '/memory/notes',
        handle(R.memoryNotesList, (p, i) =>
          memory(p).pipe(
            Effect.flatMap((m) => m.notes.list(i)),
            Effect.map((items) => ({ items }))
          )
        )
      ),
      HttpRouter.post(
        '/memory/forget',
        handle(R.memoryForget, (p, i) =>
          memory(p).pipe(
            Effect.flatMap((m) => m.forget(i.id)),
            Effect.map((deleted) => ({ deleted }))
          )
        )
      ),
      HttpRouter.get(
        '/vault',
        handle(R.vaultList, (p) => api.vaultList(p))
      ),
      HttpRouter.post(
        '/vault/get',
        handle(R.vaultGet, (p, input) => api.vaultGet(p, input))
      ),
      // Writes: own vault only. The owner is the token's agent, never a request field.
      HttpRouter.post(
        '/vault/add',
        handle(R.vaultAdd, (p, input) => api.vaultAdd(p, input))
      ),
      HttpRouter.post(
        '/vault/update',
        handle(R.vaultUpdate, (p, input) => api.vaultUpdate(p, input))
      ),
      HttpRouter.post(
        '/vault/delete',
        handle(R.vaultDelete, (p, input) => api.vaultDelete(p, input))
      ),
      /**
       * Repositories (docs/build-plan-repositories.md). `git-credential` answers
       * git's credential helper inside the box; `github/pull-request` backs the
       * `github_open_pr` tool. Both are declared here rather than in
       * `AgentRuntimeRoutes` so this half of the feature does not have to land in
       * the same commit as the `taut` CLI's half.
       */
      HttpRouter.post(
        '/git-credential',
        handle(
          { method: 'POST', request: GitCredentialRequest, response: GitCredentialResponse },
          (p, input) => api.gitCredential(p, input),
          { steer: false }
        )
      ),
      HttpRouter.post(
        '/github/pull-request',
        handle(
          { method: 'POST', request: OpenPullRequestRequest, response: OpenPullRequestResponse },
          (p, input) => api.githubOpenPr(p, input)
        )
      )
    )

    /**
     * Skills (docs/build-plan-skills.md). A second `pipe` because `HttpRouter.empty.pipe` takes
     * at most twenty route combinators, not because these are any different: own skills only,
     * the agent taken from the token and never from a request field, and `skills/install`
     * landing `pending` unless the company has said otherwise (D7, D12).
     */
    const routes = coreRoutes.pipe(
      HttpRouter.post(
        '/agents/search',
        handle(R.agentSearch, (p, input) => api.agentSearch(p, input))
      ),
      HttpRouter.get(
        '/skills',
        handle(R.skillList, (p) => api.skillList(p))
      ),
      HttpRouter.post(
        '/react',
        handle(R.react, (p, input) => api.react(p, input))
      ),
      HttpRouter.post(
        '/skills/write',
        handle(R.skillWrite, (p, input) => api.skillWrite(p, input))
      ),
      HttpRouter.post(
        '/skills/install',
        handle(R.skillInstall, (p, input) => api.skillInstall(p, input))
      ),
      HttpRouter.post(
        '/skills/update',
        handle(R.skillUpdate, (p, input) => api.skillUpdate(p, input))
      ),
      HttpRouter.post(
        '/skills/remove',
        handle(R.skillRemove, (p, input) => api.skillRemove(p, input))
      ),
      /**
       * Linear (docs/build-plan-projects.md D21, D22). `linear/projects` is the
       * read every agent may do; `linear/issue` is the one write an agent can
       * cause in Linear, and it refuses unless the human of this conversation is
       * mapped to a Linear person. The gate is in `services/projects.ts`, not
       * here and not in a prompt.
       */
      HttpRouter.get(
        '/linear/projects',
        handle(R.linearProjects, (p) => api.linearProjects(p))
      ),
      HttpRouter.post(
        '/linear/issue',
        handle(R.linearCreateIssue, (p, input) => api.linearCreateIssue(p, input))
      ),
      /**
       * One ticket, read and changed (docs/build-plan-issues.md D18). Same gate as
       * the create above, in the same words: an agent may do to a ticket exactly
       * what the human it is answering could do, and nothing more.
       */
      HttpRouter.get(
        '/linear/issue',
        handle(R.linearGetIssue, (p, input) => api.linearGetIssue(p, input))
      ),
      HttpRouter.post(
        '/linear/issue/update',
        handle(R.linearUpdateIssue, (p, input) => api.linearUpdateIssue(p, input))
      ),
      /**
       * Signals (docs/build-plan-triggers.md Part II). Own signals only: the emitter is the
       * token's agent and never a request field, the same rule the vault and the skills
       * routes above enforce. `emit` is the one call whose whole purpose is to let the turn
       * end — the budgets that keep that safe (D23, D24, D25) live in `services/signals.ts`.
       */
      HttpRouter.post(
        '/signals/emit',
        handle(R.emitSignal, (p, input) => api.emitSignal(p, input))
      ),
      HttpRouter.get(
        '/signals',
        handle(R.listSignals, (p, input) => api.listSignals(p, input))
      ),
      HttpRouter.post(
        '/signals/cancel',
        handle(R.cancelSignal, (p, input) => api.cancelSignal(p, input))
      )
    )

    const withCanvases = routes.pipe(
      HttpRouter.post(
        '/components/render',
        handle(R.renderComponent, (p, i) => api.renderComponent(p, i))
      ),
      HttpRouter.post(
        '/delete',
        handle(R.delete, (p, i) => api.delete(p, i))
      ),
      HttpRouter.post(
        '/mandate/propose',
        handle({ ...R.proposeMandate, response: Schema.Struct({ message: Message }) }, (p, i) =>
          api.proposeMandate(p, i)
        )
      ),
      HttpRouter.post(
        '/canvases/create',
        handle(R.canvasCreate, (p, i) => api.canvasCreate(p, i))
      ),
      HttpRouter.post(
        '/canvases/update',
        handle(R.canvasUpdate, (p, i) => api.canvasChange(p, i.canvasId, 'update', i))
      ),
      HttpRouter.post(
        '/canvases/open',
        handle(R.canvasOpen, (p, i) => api.canvasChange(p, i.canvasId, 'open'))
      ),
      HttpRouter.post(
        '/canvases/close',
        handle(R.canvasClose, (p, i) => api.canvasChange(p, i.canvasId, 'close'))
      ),
      HttpRouter.get(
        '/canvases',
        handle(R.canvasList, (p) => api.canvasList(p))
      )
    )
    yield* router.mount(AGENT_RUNTIME_PREFIX, withCanvases)
    /**
     * The build plan writes these two as `/agent/git-credential` and
     * `/agent/github/pull-request`, and W1b is coding against those literal
     * paths. Mounting the same handlers at both prefixes costs one line and
     * removes the only place the two waves could miss each other.
     */
    yield* router.mount(AGENT_ALIAS_PREFIX, withCanvases)
    yield* Effect.logDebug(
      `agent-runtime: mounted at ${AGENT_RUNTIME_PREFIX} (alias ${AGENT_ALIAS_PREFIX})`
    )
  })
)
