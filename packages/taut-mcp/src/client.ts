/**
 * Thin typed HTTP client over `AgentRuntimeRoutes`. Reads `TAUT_URL` / `TAUT_TOKEN` (and the
 * optional `TAUT_TASK_ID` / `TAUT_THREAD_ID`) from config — this is the only place env is read.
 */
import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import type { HttpClientError } from '@effect/platform'
import { Config, Effect, Option, Redacted, Schema } from 'effect'
import type { ParseResult } from 'effect'
import { AGENT_RUNTIME_PREFIX, AgentRuntimeRoutes, ErrorBody, SteerItem } from './protocol.js'
import type {
  AskCreated,
  AskRequest,
  AskStatus,
  DoneRequest,
  DoneResult,
  HandoffRequest,
  HandoffResponse,
  InboxQuery,
  InboxResponse,
  MemoryForgetRequest,
  MemoryForgetResponse,
  MemoryGrepRequest,
  MemoryHits,
  MemoryItems,
  MemoryNoteRequest,
  MemoryNoteResponse,
  MemoryNotesListQuery,
  MemoryRecallThreadRequest,
  MemorySearchRequest,
  MemoryTimelineRequest,
  GitCredentialRequest,
  GitCredentialResponse,
  CreateIssueRequest,
  CreateIssueResponse,
  LinearProjectsQuery,
  LinearProjectsResponse,
  OpenPullRequestRequest,
  OpenPullRequestResponse,
  CancelSignalRequest,
  CancelSignalResponse,
  EmitSignalRequest,
  EmitSignalResponse,
  ListSignalsQuery,
  ListSignalsResponse,
  ReactRequest,
  ReactResponse,
  Route,
  SendRequest,
  SendResult,
  SkillInstallRequest,
  SkillInstallResponse,
  SkillListResponse,
  SkillRemoveRequest,
  SkillRemoveResponse,
  SkillUpdateRequest,
  SkillUpdateResponse,
  SkillWriteRequest,
  SkillWriteResponse,
  VaultAddRequest,
  VaultAddResponse,
  VaultDeleteRequest,
  VaultDeleteResponse,
  VaultGetRequest,
  VaultGetResponse,
  VaultListResponse,
  VaultUpdateRequest,
  VaultUpdateResponse
} from './protocol.js'

// --- errors ---------------------------------------------------------------------

/** The server answered with a non-2xx status. `code` is from `ErrorBody` when the body parsed. */
export class TautApiError extends Schema.TaggedError<TautApiError>()('TautApiError', {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
  gateId: Schema.optional(Schema.String)
}) {}

/** Could not reach the server, or its answer did not match the protocol. */
export class TautTransportError extends Schema.TaggedError<TautTransportError>()(
  'TautTransportError',
  { message: Schema.String }
) {}

export type TautClientError = TautApiError | TautTransportError

/**
 * Every agent-runtime response may carry `steer` — messages that landed in the thread while
 * this run was in flight (docs/build-plan-steering-reactions.md D6). It is merged in by `call`
 * below rather than declared on all twenty-odd response schemas: the server appends it to the
 * encoded body, and `Schema.Struct` would otherwise drop it as an excess property.
 */
export type WithSteer<A> = A & { readonly steer?: ReadonlyArray<SteerItem> }

// --- env ---------------------------------------------------------------------------

export class TautEnv extends Effect.Service<TautEnv>()('@taut/taut-mcp/TautEnv', {
  effect: Effect.gen(function* () {
    const url = (yield* Config.string('TAUT_URL')).replace(/\/+$/, '')
    const token = yield* Config.redacted('TAUT_TOKEN')
    const taskId = yield* Config.option(Config.string('TAUT_TASK_ID'))
    const threadId = yield* Config.option(Config.string('TAUT_THREAD_ID'))
    return {
      url,
      token,
      taskId: Option.getOrUndefined(taskId),
      threadId: Option.getOrUndefined(threadId)
    }
  })
}) {}

// --- client ---------------------------------------------------------------------

const describeError = (e: HttpClientError.HttpClientError | ParseResult.ParseError): string =>
  e._tag === 'ParseError' ? `unexpected response shape: ${e.message}` : e.message

export class TautClient extends Effect.Service<TautClient>()('@taut/taut-mcp/TautClient', {
  effect: Effect.gen(function* () {
    const env = yield* TautEnv
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.bearerToken(Redacted.value(env.token))),
      HttpClient.mapRequest(HttpClientRequest.setHeader('accept', 'application/json'))
    )
    const decodeErrorBody = Schema.decodeUnknown(ErrorBody)
    const SteerEnvelope = Schema.Struct({ steer: Schema.optional(Schema.Array(SteerItem)) })
    /** Pull `steer` off the raw body; a body without it (or a malformed one) yields nothing. */
    const decodeSteer = (
      body: unknown
    ): Effect.Effect<ReadonlyArray<SteerItem> | undefined, never> =>
      Schema.decodeUnknown(SteerEnvelope)(body).pipe(
        Effect.map((e) => (e.steer === undefined || e.steer.length === 0 ? undefined : e.steer)),
        Effect.orElseSucceed(() => undefined)
      )

    const failFromResponse = (
      res: HttpClientResponse.HttpClientResponse
    ): Effect.Effect<never, TautApiError | TautTransportError> =>
      res.json.pipe(
        Effect.flatMap(decodeErrorBody),
        Effect.match({
          onFailure: () =>
            new TautApiError({
              status: res.status,
              code: statusCode(res.status),
              message: `HTTP ${res.status}`
            }),
          onSuccess: (body) =>
            new TautApiError({
              status: res.status,
              code: body.error.code,
              message: body.error.message,
              ...(body.error.gateId !== undefined ? { gateId: body.error.gateId } : {})
            })
        }),
        Effect.flatMap(Effect.fail)
      )

    const call = <Req extends Schema.Schema.AnyNoContext, Res extends Schema.Schema.AnyNoContext>(
      r: Route<Req, Res>,
      input: Schema.Schema.Type<Req>,
      params: Readonly<Record<string, string>> = {}
    ): Effect.Effect<WithSteer<Schema.Schema.Type<Res>>, TautClientError> =>
      Effect.gen(function* () {
        const path = Object.entries(params).reduce(
          (p, [k, v]) => p.replace(`:${k}`, encodeURIComponent(v)),
          r.path
        )
        const url = `${env.url}${AGENT_RUNTIME_PREFIX}${path}`
        const encoded: unknown = yield* Schema.encodeUnknown(r.request)(input)
        const request =
          r.method === 'GET'
            ? HttpClientRequest.get(url).pipe(HttpClientRequest.setUrlParams(toUrlParams(encoded)))
            : yield* HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJson(encoded))
        const response = yield* http.execute(request)
        if (response.status < 200 || response.status >= 300) {
          return yield* failFromResponse(response)
        }
        const body: unknown = yield* response.json
        const decoded: Schema.Schema.Type<Res> = yield* Schema.decodeUnknown(r.response)(body)
        const steer = yield* decodeSteer(body)
        return (steer === undefined ? decoded : { ...decoded, steer }) as WithSteer<
          Schema.Schema.Type<Res>
        >
      }).pipe(
        Effect.scoped,
        Effect.catchTags({
          RequestError: (e) => new TautTransportError({ message: describeError(e) }),
          ResponseError: (e) => new TautTransportError({ message: describeError(e) }),
          ParseError: (e) => new TautTransportError({ message: describeError(e) }),
          HttpBodyError: (e) =>
            new TautTransportError({
              message: `could not encode request body: ${String(e.reason)}`
            })
        })
      )

    const R = AgentRuntimeRoutes
    return {
      env,
      send: (input: SendRequest): Effect.Effect<WithSteer<SendResult>, TautClientError> =>
        call(R.send, input),
      inbox: (input: InboxQuery = {}): Effect.Effect<InboxResponse, TautClientError> =>
        call(R.inbox, input),
      ask: (input: AskRequest): Effect.Effect<AskCreated, TautClientError> => call(R.ask, input),
      askStatus: (askId: string, waitMs?: number): Effect.Effect<AskStatus, TautClientError> =>
        call(R.askStatus, waitMs === undefined ? {} : { wait: Math.trunc(waitMs) }, { id: askId }),
      done: (input: DoneRequest): Effect.Effect<WithSteer<DoneResult>, TautClientError> =>
        call(R.done, input),
      handoff: (
        input: HandoffRequest
      ): Effect.Effect<WithSteer<HandoffResponse>, TautClientError> => call(R.handoff, input),
      react: (input: ReactRequest): Effect.Effect<WithSteer<ReactResponse>, TautClientError> =>
        call(R.react, input),
      memorySearch: (input: MemorySearchRequest): Effect.Effect<MemoryHits, TautClientError> =>
        call(R.memorySearch, input),
      memoryGrep: (input: MemoryGrepRequest): Effect.Effect<MemoryItems, TautClientError> =>
        call(R.memoryGrep, input),
      memoryRecall: (
        input: MemoryRecallThreadRequest
      ): Effect.Effect<MemoryItems, TautClientError> => call(R.memoryRecall, input),
      memoryTimeline: (input: MemoryTimelineRequest): Effect.Effect<MemoryItems, TautClientError> =>
        call(R.memoryTimeline, input),
      memoryNote: (input: MemoryNoteRequest): Effect.Effect<MemoryNoteResponse, TautClientError> =>
        call(R.memoryNote, input),
      memoryNotesList: (
        input: MemoryNotesListQuery = {}
      ): Effect.Effect<MemoryItems, TautClientError> => call(R.memoryNotesList, input),
      memoryForget: (
        input: MemoryForgetRequest
      ): Effect.Effect<MemoryForgetResponse, TautClientError> => call(R.memoryForget, input),
      vaultList: (): Effect.Effect<VaultListResponse, TautClientError> => call(R.vaultList, {}),
      vaultGet: (input: VaultGetRequest): Effect.Effect<VaultGetResponse, TautClientError> =>
        call(R.vaultGet, input),
      vaultAdd: (input: VaultAddRequest): Effect.Effect<VaultAddResponse, TautClientError> =>
        call(R.vaultAdd, input),
      vaultUpdate: (
        input: VaultUpdateRequest
      ): Effect.Effect<VaultUpdateResponse, TautClientError> => call(R.vaultUpdate, input),
      vaultDelete: (
        input: VaultDeleteRequest
      ): Effect.Effect<VaultDeleteResponse, TautClientError> => call(R.vaultDelete, input),
      // Skills (docs/build-plan-skills.md). Every one acts on the calling agent's own skills.
      skillList: (): Effect.Effect<SkillListResponse, TautClientError> => call(R.skillList, {}),
      skillWrite: (input: SkillWriteRequest): Effect.Effect<SkillWriteResponse, TautClientError> =>
        call(R.skillWrite, input),
      skillInstall: (
        input: SkillInstallRequest
      ): Effect.Effect<SkillInstallResponse, TautClientError> => call(R.skillInstall, input),
      skillUpdate: (
        input: SkillUpdateRequest
      ): Effect.Effect<SkillUpdateResponse, TautClientError> => call(R.skillUpdate, input),
      skillRemove: (
        input: SkillRemoveRequest
      ): Effect.Effect<SkillRemoveResponse, TautClientError> => call(R.skillRemove, input),
      /**
       * The credential helper's one call (docs/build-plan-repositories.md D4). The answer holds
       * a live push token: it goes straight to the `git` process that asked, and is never
       * logged, stored or put in an error.
       */
      gitCredential: (
        input: GitCredentialRequest
      ): Effect.Effect<GitCredentialResponse, TautClientError> => call(R.gitCredential, input),
      githubOpenPr: (
        input: OpenPullRequestRequest
      ): Effect.Effect<OpenPullRequestResponse, TautClientError> => call(R.githubOpenPr, input),
      linearProjects: (
        input: LinearProjectsQuery
      ): Effect.Effect<LinearProjectsResponse, TautClientError> => call(R.linearProjects, input),
      linearCreateIssue: (
        input: CreateIssueRequest
      ): Effect.Effect<CreateIssueResponse, TautClientError> => call(R.linearCreateIssue, input),
      /** Signals (docs/build-plan-triggers.md Part II): arm, list, and take one back. */
      emitSignal: (input: EmitSignalRequest): Effect.Effect<EmitSignalResponse, TautClientError> =>
        call(R.emitSignal, input),
      listSignals: (input: ListSignalsQuery): Effect.Effect<ListSignalsResponse, TautClientError> =>
        call(R.listSignals, input),
      cancelSignal: (
        input: CancelSignalRequest
      ): Effect.Effect<CancelSignalResponse, TautClientError> => call(R.cancelSignal, input)
    }
  }),
  dependencies: [TautEnv.Default]
}) {}

const statusCode = (status: number): string => {
  switch (status) {
    case 401:
      return 'unauthorized'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 409:
      return 'task_mismatch'
    case 422:
      return 'validation'
    case 429:
      return 'rate_limited'
    default:
      return status >= 500 ? 'server_error' : 'error'
  }
}

/** GET requests carry their (already encoded) schema fields as query parameters. */
const toUrlParams = (encoded: unknown): ReadonlyArray<readonly [string, string]> => {
  if (typeof encoded !== 'object' || encoded === null) return []
  return Object.entries(encoded).flatMap(([k, v]) =>
    v === undefined || v === null ? [] : [[k, String(v)] as const]
  )
}
