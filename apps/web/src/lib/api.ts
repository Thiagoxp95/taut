/**
 * Every call the web makes to the server, as a typed hook.
 *
 * The client is derived from `@taut/contract`'s `HttpApi` (see `api-client.ts`)
 * so payloads, url params and errors are checked at compile time and decoded
 * with Effect Schema at runtime. There is no hand-written `fetch` in the app.
 */
import * as React from 'react'
import {
  keepPreviousData,
  queryOptions,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'
import type {
  Agent,
  AgentDetail,
  AgentId,
  AgentSkill,
  AgentSkillDetail,
  AttachmentId,
  AvailableRepository,
  Avatar,
  Call,
  CallId,
  CallsConfig,
  Channel,
  ChannelId,
  ChannelMember,
  CompanyId,
  CompanyMember,
  CompanyWithRole,
  Department,
  DepartmentDetail,
  DepartmentId,
  DepartmentShape,
  FileEntry,
  FileGrantMode,
  GithubConnection,
  Handover,
  HandoverId,
  HandoverStatus,
  Invite,
  InviteId,
  InvitePreview,
  Me,
  MemberId,
  MemberKind,
  MembershipRole,
  LinearConnection,
  LinearUser,
  Message,
  ModelCatalog,
  Project,
  ProjectDetail,
  ProjectIssue,
  ProjectId,
  Repository,
  RepositoryId,
  Routine,
  RoutineId,
  RunOverride,
  RuntimeKind,
  SearchResults,
  Signal,
  SignalId,
  Subscription,
  SubscriptionId,
  Task,
  ThreadContext,
  TaskId,
  TaskStatus,
  Trigger,
  UserId,
  VaultItemId,
  VaultItemMeta
} from '@taut/contract'
import { MessageId } from '@taut/contract'
import { Effect, Redacted } from 'effect'

import { call, type Api, type ApiError } from '@/lib/api-client'
import { live } from '@/lib/live'
import { addMessage, removeMessage, updateMessage, type MessagePages } from '@/lib/message-cache'
import { qk, type PageOf } from '@/lib/query-keys'
import {
  runEffect,
  useEffectInfiniteQuery,
  useEffectMutation,
  useEffectQuery,
  type Cursor,
  type EffectInfiniteQueryResult
} from '@/lib/runtime'

export { qk } from '@/lib/query-keys'
export type { PageOf } from '@/lib/query-keys'

const DIRECTORY_LIMIT = 200
const MESSAGE_PAGE = 50

const emptyPage = <A>(): Effect.Effect<PageOf<A>, never, Api> =>
  Effect.succeed<PageOf<A>>({ items: [] })

/** Page cursors travel as plain strings; the contract wants a branded id. */
const asMessageId = (cursor: Cursor): MessageId | undefined =>
  cursor === undefined ? undefined : MessageId.make(cursor)

// --- session --------------------------------------------------------------

/** Used by the route guards through `queryClient.ensureQueryData`. */
export const meQueryOptions = queryOptions({
  queryKey: qk.me,
  queryFn: () => runEffect(call((api) => api.auth.me())),
  staleTime: 60_000,
  retry: false,
  // The guard turns a 401 into a redirect; a toast would be noise.
  meta: { silent: true }
})

export function useMe(): UseQueryResult<Me, ApiError> {
  return useEffectQuery<Me>(
    qk.me,
    call((api) => api.auth.me()),
    {
      staleTime: 60_000,
      retry: false,
      meta: { silent: true }
    }
  )
}

export function useActiveCompanyId(): CompanyId | undefined {
  return useMe().data?.activeCompanyId
}

/** The current user's role in the active company. `undefined` while loading. */
export function useMyRole(): MembershipRole | undefined {
  const me = useMe().data
  if (me === undefined) return undefined
  return me.memberships.find((entry) => entry.company.id === me.activeCompanyId)?.role
}

export function useCanAdminister(): boolean {
  const role = useMyRole()
  return role === 'owner' || role === 'admin'
}

export function useSignup() {
  return useEffectMutation((input: { email: string; password: string; name: string }) =>
    call((api) => api.auth.signup({ payload: input }))
  )
}

export function useLogin() {
  return useEffectMutation((input: { email: string; password: string }) =>
    call((api) => api.auth.login({ payload: input }))
  )
}

export function useLogout() {
  return useEffectMutation(() => call((api) => api.auth.logout()))
}

// --- companies ------------------------------------------------------------

export function useCompanies(): UseQueryResult<PageOf<CompanyWithRole>, ApiError> {
  return useEffectQuery<PageOf<CompanyWithRole>>(
    qk.companies,
    call((api) => api.companies.list({ urlParams: { limit: DIRECTORY_LIMIT } }))
  )
}

export function useCreateCompany() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (input: { name: string; slug: string; avatar: Avatar }) =>
      call((api) => api.companies.create({ payload: input })),
    {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: qk.companies })
        void queryClient.invalidateQueries({ queryKey: qk.me })
      }
    }
  )
}

/** Admin+. The slug is fixed at creation; name and avatar are not. */
export function useUpdateCompany() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (input: { companyId: CompanyId; name?: string; avatar?: Avatar }) =>
      call((api) =>
        api.companies.update({
          path: { companyId: input.companyId },
          payload: { name: input.name, avatar: input.avatar }
        })
      ),
    {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: qk.companies })
        void queryClient.invalidateQueries({ queryKey: qk.me })
      }
    }
  )
}

export function useSwitchCompany() {
  return useEffectMutation((companyId: CompanyId) =>
    call((api) => api.companies.switch({ path: { companyId } }))
  )
}

export function useMembers(): UseQueryResult<PageOf<CompanyMember>, ApiError> {
  const companyId = useActiveCompanyId()
  return useEffectQuery<PageOf<CompanyMember>>(
    [...qk.members, companyId ?? 'none'],
    companyId === undefined
      ? emptyPage<CompanyMember>()
      : call((api) =>
          api.companies.members({
            path: { companyId },
            urlParams: { limit: DIRECTORY_LIMIT }
          })
        ),
    { enabled: companyId !== undefined }
  )
}

export function useSetRole() {
  const queryClient = useQueryClient()
  const companyId = useActiveCompanyId()
  return useEffectMutation(
    (input: { userId: UserId; role: MembershipRole }) =>
      companyId === undefined
        ? Effect.dieMessage('No active company')
        : call((api) =>
            api.companies.setRole({
              path: { companyId, userId: input.userId },
              payload: { role: input.role }
            })
          ),
    {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: qk.members })
        void queryClient.invalidateQueries({ queryKey: qk.me })
      }
    }
  )
}

// --- invites --------------------------------------------------------------

export function useInvites(): UseQueryResult<PageOf<Invite>, ApiError> {
  return useEffectQuery<PageOf<Invite>>(
    qk.invites,
    call((api) => api.invites.list({ urlParams: { limit: DIRECTORY_LIMIT } }))
  )
}

/**
 * Public: the token is the capability, so this works logged out. A bad or
 * unknown token answers `NotFound`; the caller renders that, so no toast.
 */
export function useInvitePreview(token: string): UseQueryResult<InvitePreview, ApiError> {
  return useEffectQuery<InvitePreview>(
    qk.invitePreview(token),
    call((api) => api.invites.preview({ path: { token } })),
    { retry: false, staleTime: 60_000, meta: { silent: true } }
  )
}

export function useCreateInvite() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (input: { email: string; role: MembershipRole }) =>
      call((api) => api.invites.create({ payload: input })),
    { onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.invites }) }
  )
}

export function useRevokeInvite() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (inviteId: InviteId) => call((api) => api.invites.revoke({ path: { inviteId } })),
    { onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.invites }) }
  )
}

/** Public: a logged-out visitor supplies `name` + `password`, a member does not. */
export function useAcceptInvite() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (input: { token: string; name?: string; password?: string }) =>
      call((api) => api.invites.accept({ payload: input })),
    { onSuccess: () => queryClient.clear() }
  )
}

// --- departments ----------------------------------------------------------

export function useDepartments(): UseQueryResult<PageOf<Department>, ApiError> {
  return useEffectQuery<PageOf<Department>>(
    qk.departments,
    call((api) => api.departments.list({ urlParams: { limit: DIRECTORY_LIMIT } }))
  )
}

export function useDepartment(
  departmentId: DepartmentId | undefined
): UseQueryResult<DepartmentDetail, ApiError> {
  return useEffectQuery<DepartmentDetail>(
    qk.department(departmentId ?? 'none'),
    departmentId === undefined
      ? Effect.dieMessage('No department')
      : call((api) => api.departments.get({ path: { departmentId } })),
    { enabled: departmentId !== undefined }
  )
}

function useDepartmentInvalidation(): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: qk.departments })
    // `Agent.departmentIds` is derived from department membership.
    void queryClient.invalidateQueries({ queryKey: qk.agents })
  }
}

export function useCreateDepartment() {
  const invalidate = useDepartmentInvalidation()
  return useEffectMutation(
    (input: { name: string; slug: string; headUserId: UserId; shape?: DepartmentShape }) =>
      call((api) => api.departments.create({ payload: input })),
    { onSuccess: invalidate }
  )
}

export function useUpdateDepartment() {
  const invalidate = useDepartmentInvalidation()
  return useEffectMutation(
    (input: {
      departmentId: DepartmentId
      name?: string
      slug?: string
      /** `null` puts the department back on the auto silhouette. */
      shape?: DepartmentShape | null
    }) =>
      call((api) =>
        api.departments.update({
          path: { departmentId: input.departmentId },
          payload: { name: input.name, slug: input.slug, shape: input.shape }
        })
      ),
    { onSuccess: invalidate }
  )
}

export function useDeleteDepartment() {
  const invalidate = useDepartmentInvalidation()
  return useEffectMutation(
    (departmentId: DepartmentId) =>
      call((api) => api.departments.delete({ path: { departmentId } })),
    { onSuccess: invalidate }
  )
}

export function useAddDepartmentMember() {
  const invalidate = useDepartmentInvalidation()
  return useEffectMutation(
    (input: { departmentId: DepartmentId; memberKind: MemberKind; memberId: MemberId }) =>
      call((api) =>
        api.departments.addMember({
          path: { departmentId: input.departmentId },
          payload: { memberKind: input.memberKind, memberId: input.memberId }
        })
      ),
    { onSuccess: invalidate }
  )
}

export function useRemoveDepartmentMember() {
  const invalidate = useDepartmentInvalidation()
  return useEffectMutation(
    (input: { departmentId: DepartmentId; memberKind: MemberKind; memberId: MemberId }) =>
      call((api) => api.departments.removeMember({ path: input })),
    { onSuccess: invalidate }
  )
}

export function useSetDepartmentHead() {
  const invalidate = useDepartmentInvalidation()
  return useEffectMutation(
    (input: { departmentId: DepartmentId; headUserId: UserId }) =>
      call((api) =>
        api.departments.setHead({
          path: { departmentId: input.departmentId },
          payload: { headUserId: input.headUserId }
        })
      ),
    { onSuccess: invalidate }
  )
}

// --- channels -------------------------------------------------------------

export function useChannels(): UseQueryResult<PageOf<Channel>, ApiError> {
  return useEffectQuery<PageOf<Channel>>(
    qk.channels,
    call((api) => api.channels.list({ urlParams: { limit: DIRECTORY_LIMIT } }))
  )
}

export function useChannelMembers(
  channelId: ChannelId | undefined
): UseQueryResult<PageOf<ChannelMember>, ApiError> {
  return useEffectQuery<PageOf<ChannelMember>>(
    qk.channelMembers(channelId ?? 'none'),
    channelId === undefined
      ? emptyPage<ChannelMember>()
      : call((api) =>
          api.channels.members({
            path: { channelId },
            urlParams: { limit: DIRECTORY_LIMIT }
          })
        ),
    { enabled: channelId !== undefined }
  )
}

function useChannelInvalidation(): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: qk.channels })
  }
}

export function useCreateChannel() {
  const invalidate = useChannelInvalidation()
  return useEffectMutation(
    (input: {
      name: string
      departmentId?: DepartmentId
      members?: readonly { memberKind: MemberKind; memberId: MemberId }[]
    }) => call((api) => api.channels.create({ payload: input })),
    { onSuccess: invalidate }
  )
}

export function useUpdateChannel() {
  const invalidate = useChannelInvalidation()
  return useEffectMutation(
    (input: { channelId: ChannelId; name?: string }) =>
      call((api) =>
        api.channels.update({
          path: { channelId: input.channelId },
          payload: { name: input.name }
        })
      ),
    { onSuccess: invalidate }
  )
}

export function useDeleteChannel() {
  const invalidate = useChannelInvalidation()
  return useEffectMutation(
    (channelId: ChannelId) => call((api) => api.channels.delete({ path: { channelId } })),
    { onSuccess: invalidate }
  )
}

export function useAddChannelMember() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (input: { channelId: ChannelId; memberKind: MemberKind; memberId: MemberId }) =>
      call((api) =>
        api.channels.addMember({
          path: { channelId: input.channelId },
          payload: { memberKind: input.memberKind, memberId: input.memberId }
        })
      ),
    {
      onSuccess: (_result, input) => {
        void queryClient.invalidateQueries({ queryKey: qk.channelMembers(input.channelId) })
      }
    }
  )
}

export function useRemoveChannelMember() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (input: { channelId: ChannelId; memberKind: MemberKind; memberId: MemberId }) =>
      call((api) => api.channels.removeMember({ path: input })),
    {
      onSuccess: (_result, input) => {
        void queryClient.invalidateQueries({ queryKey: qk.channelMembers(input.channelId) })
      }
    }
  )
}

/** Opens — or returns — the DM between the current user and a user or agent. */
export function useOpenDm() {
  const invalidate = useChannelInvalidation()
  return useEffectMutation(
    (input: { memberKind: MemberKind; memberId: MemberId }) =>
      call((api) => api.channels.dm({ payload: input })),
    { onSuccess: invalidate }
  )
}

export function useMarkRead() {
  return useEffectMutation((input: { channelId: ChannelId; lastReadSeq: number }) =>
    call((api) =>
      api.channels.markRead({
        path: { channelId: input.channelId },
        payload: { lastReadSeq: input.lastReadSeq }
      })
    )
  )
}

// --- messages -------------------------------------------------------------

/**
 * Newest-first pages; `before` is the id of the oldest message already loaded.
 * `flattenChannel` puts them back in reading order.
 */
export function useMessages(
  channelId: ChannelId | undefined
): EffectInfiniteQueryResult<PageOf<Message>> {
  return useEffectInfiniteQuery<PageOf<Message>>(
    qk.messages(channelId ?? 'none'),
    (cursor) =>
      channelId === undefined
        ? emptyPage<Message>()
        : call((api) =>
            api.messages.list({
              urlParams: { channelId, limit: MESSAGE_PAGE, before: asMessageId(cursor) }
            })
          ),
    (last) =>
      last.items.length < MESSAGE_PAGE ? undefined : last.items[last.items.length - 1]?.id,
    { enabled: channelId !== undefined }
  )
}

/** Replies to a root message, oldest first. */
export function useThread(
  threadId: MessageId | undefined
): EffectInfiniteQueryResult<PageOf<Message>> {
  return useEffectInfiniteQuery<PageOf<Message>>(
    qk.thread(threadId ?? 'none'),
    (cursor) =>
      threadId === undefined
        ? emptyPage<Message>()
        : call((api) =>
            api.messages.thread({
              path: { threadId },
              urlParams: { limit: MESSAGE_PAGE, before: asMessageId(cursor) }
            })
          ),
    (last) => (last.items.length < MESSAGE_PAGE ? undefined : last.items[0]?.id),
    { enabled: threadId !== undefined }
  )
}

export function useSendMessage() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (input: {
      channelId: ChannelId
      threadId?: MessageId
      /** May be empty when `attachmentIds` is not (docs/build-plan-attachments.md D2). */
      body: string
      /** Orphan uploads from `useUploadAttachment`, linked to the message on create. */
      attachmentIds?: readonly AttachmentId[]
      /** Runtime/seat/model/reasoning for the run this message spawns (D1). */
      runOverride?: RunOverride
    }) => call((api) => api.messages.create({ payload: input })),
    { onSuccess: (message) => addMessage(queryClient, message) }
  )
}

export function useEditMessage() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (input: { messageId: MessageId; body: string }) =>
      call((api) =>
        api.messages.edit({ path: { messageId: input.messageId }, payload: { body: input.body } })
      ),
    { onSuccess: (message) => updateMessage(queryClient, message) }
  )
}

export function useDeleteMessage() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (messageId: MessageId) => call((api) => api.messages.delete({ path: { messageId } })),
    { onSuccess: (_result, messageId) => removeMessage(queryClient, messageId) }
  )
}

// --- attachments ----------------------------------------------------------

/**
 * Where the bytes are served (docs/build-plan-attachments.md D5). Same origin,
 * so the session cookie rides along and a plain `<img src>` works in the web
 * app and inside the desktop shell; the Vite dev proxy already forwards `/api`.
 *
 * `download` maps to `?download=true` — the contract decodes it with
 * `Schema.BooleanFromString`, which takes the literal `"true"` / `"false"`.
 */
export function attachmentUrl(
  attachmentId: AttachmentId,
  options?: { readonly download?: boolean }
): string {
  const path = `/api/attachments/${attachmentId}/content`
  return options?.download === true ? `${path}?download=true` : path
}

/**
 * One file, one request (D2). The result is an orphan until a `messages.create`
 * carries its id, so the composer can show it while the message is still a draft.
 *
 * `attachments.upload` is declared with `HttpApiSchema.Multipart`, and the
 * derived client types that endpoint's payload as `FormData` — so the browser
 * sets the boundary and this stays inside the typed client.
 */
export function useUploadAttachment() {
  return useEffectMutation((input: { channelId: ChannelId; file: File }) => {
    const form = new FormData()
    form.append('channelId', input.channelId)
    form.append('file', input.file)
    return call((api) => api.attachments.upload({ payload: form }))
  })
}

// --- search ---------------------------------------------------------------

/** Shortest query the palette sends to the server; below it only the local fuzzy filter runs. */
export const SEARCH_MIN_CHARS = 2
const SEARCH_LIMIT = 20

/**
 * `GET /api/search` for the ⌘K palette: messages the user can read plus notes of the agents
 * they manage. Off below `SEARCH_MIN_CHARS`; the previous result stays on screen while the
 * next one loads so the list does not flicker between keystrokes.
 */
export function useSearch(q: string): UseQueryResult<SearchResults, ApiError> {
  const trimmed = q.trim()
  return useEffectQuery<SearchResults>(
    qk.search(trimmed),
    call((api) => api.search.query({ urlParams: { q: trimmed, limit: SEARCH_LIMIT } })),
    {
      enabled: trimmed.length >= SEARCH_MIN_CHARS,
      staleTime: 15_000,
      placeholderData: keepPreviousData
    }
  )
}

// --- agents ---------------------------------------------------------------

export function useAgents(): UseQueryResult<PageOf<Agent>, ApiError> {
  return useEffectQuery<PageOf<Agent>>(
    qk.agents,
    call((api) => api.agents.list({ urlParams: { limit: DIRECTORY_LIMIT } }))
  )
}

export function useAgent(agentId: AgentId | undefined): UseQueryResult<AgentDetail, ApiError> {
  return useEffectQuery<AgentDetail>(
    qk.agent(agentId ?? 'none'),
    agentId === undefined
      ? Effect.dieMessage('No agent')
      : call((api) => api.agents.get({ path: { agentId } })),
    { enabled: agentId !== undefined }
  )
}

function useAgentInvalidation(): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: qk.agents })
  }
}

export function useCreateAgent() {
  const invalidate = useAgentInvalidation()
  return useEffectMutation(
    (input: {
      handle: string
      name: string
      avatar: Avatar
      role: string
      mandate: string
      runtimeKind: Agent['runtimeKind']
      pinnedSubscriptionId?: SubscriptionId
      model?: string
      permissionMode: Agent['permissionMode']
      /** A headless browser inside the agent's machine. Off unless asked for. */
      browserAccess?: boolean
      /** Joins this department (and its channels) on creation. */
      departmentId?: DepartmentId
      /** Repositories it may use from its first task. Each must already be attached. */
      repoGrants?: readonly { repositoryId: RepositoryId; mode: FileGrantMode }[]
    }) => call((api) => api.agents.create({ payload: input })),
    { onSuccess: invalidate }
  )
}

export function useUpdateAgent() {
  const invalidate = useAgentInvalidation()
  return useEffectMutation(
    (input: {
      agentId: AgentId
      name?: string
      avatar?: Avatar
      role?: string
      mandate?: string
      runtimeKind?: Agent['runtimeKind']
      pinnedSubscriptionId?: SubscriptionId | null
      model?: string | null
      permissionMode?: Agent['permissionMode']
      browserAccess?: boolean
      status?: Agent['status']
      /** `false` un-archives the agent and the DMs that were archived with it. */
      archived?: boolean
    }) => {
      const { agentId, ...payload } = input
      return call((api) => api.agents.update({ path: { agentId }, payload }))
    },
    { onSuccess: invalidate }
  )
}

export function useDeleteAgent() {
  const invalidate = useAgentInvalidation()
  return useEffectMutation(
    (agentId: AgentId) => call((api) => api.agents.delete({ path: { agentId } })),
    { onSuccess: invalidate }
  )
}

export function useAgentFiles(
  agentId: AgentId | undefined,
  path?: string
): UseQueryResult<PageOf<FileEntry>, ApiError> {
  return useEffectQuery<PageOf<FileEntry>>(
    qk.agentFiles(agentId ?? 'none', path ?? ''),
    agentId === undefined
      ? emptyPage<FileEntry>()
      : call((api) =>
          api.agents.listFiles({
            path: { agentId },
            urlParams: { limit: DIRECTORY_LIMIT, path }
          })
        ),
    { enabled: agentId !== undefined }
  )
}

/**
 * Multipart upload into the agent's home (usually `inbox`).
 *
 * `agents.uploadFile` is declared with `HttpApiSchema.Multipart`, and the
 * derived client types that endpoint's payload as `FormData` — so the browser
 * sets the boundary and this stays inside the typed client.
 */
export function useUploadAgentFile() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (input: { agentId: AgentId; path: string; file: File }) => {
      const form = new FormData()
      form.append('path', input.path)
      form.append('file', input.file)
      return call((api) =>
        api.agents.uploadFile({ path: { agentId: input.agentId }, payload: form })
      )
    },
    {
      onSuccess: (_result, input) => {
        void queryClient.invalidateQueries({ queryKey: qk.agent(input.agentId) })
      }
    }
  )
}

export function useGrantFile() {
  const invalidate = useAgentInvalidation()
  return useEffectMutation(
    (input: { agentId: AgentId; path: string; mode: FileGrantMode }) =>
      call((api) =>
        api.agents.grantFile({
          path: { agentId: input.agentId },
          payload: { path: input.path, mode: input.mode }
        })
      ),
    { onSuccess: invalidate }
  )
}

export function useRevokeFileGrant() {
  const invalidate = useAgentInvalidation()
  return useEffectMutation(
    (input: { agentId: AgentId; path: string }) =>
      call((api) =>
        api.agents.revokeFileGrant({
          path: { agentId: input.agentId },
          urlParams: { path: input.path }
        })
      ),
    { onSuccess: invalidate }
  )
}

/**
 * Give the agent a repository, or change how it may use it
 * (docs/build-plan-repositories.md D13). `ro` is a checkout of the default
 * branch it cannot push from; `rw` adds its own branch and a pull request.
 *
 * Managers only on the server — admin+ or the head of one of the agent's
 * departments — and the repository must already be attached to the company.
 */
export function useGrantRepo() {
  const invalidate = useAgentInvalidation()
  return useEffectMutation(
    (input: { agentId: AgentId; repositoryId: RepositoryId; mode: FileGrantMode }) =>
      call((api) =>
        api.agents.grantRepo({
          path: { agentId: input.agentId, repositoryId: input.repositoryId },
          payload: { mode: input.mode }
        })
      ),
    { onSuccess: invalidate }
  )
}

/** Managers only. The repository stops existing for that agent (D14). */
export function useRevokeRepo() {
  const invalidate = useAgentInvalidation()
  return useEffectMutation(
    (input: { agentId: AgentId; repositoryId: RepositoryId }) =>
      call((api) => api.agents.revokeRepo({ path: input })),
    { onSuccess: invalidate }
  )
}

/** The skill row plus its `SKILL.md` body — what the editor loads before it overwrites. */
export function useSkill(
  agentId: AgentId | undefined,
  name: string | undefined
): UseQueryResult<AgentSkillDetail, ApiError> {
  const enabled = agentId !== undefined && name !== undefined
  return useEffectQuery<AgentSkillDetail>(
    qk.skill(agentId ?? 'none', name ?? 'none'),
    !enabled
      ? Effect.dieMessage('No skill')
      : call((api) =>
          api.agents.getSkill({ path: { agentId, name: name as AgentSkillDetail['name'] } })
        ),
    { enabled, staleTime: 0 }
  )
}

export function usePutSkill() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (input: { agentId: AgentId; name: string; description: string; body: string }) =>
      call((api) =>
        api.agents.putSkill({
          path: { agentId: input.agentId, name: input.name },
          payload: { description: input.description, body: input.body }
        })
      ),
    {
      onSuccess: (_result, input) => {
        void queryClient.invalidateQueries({ queryKey: qk.agents })
        void queryClient.invalidateQueries({ queryKey: qk.skill(input.agentId, input.name) })
      }
    }
  )
}

export function useDeleteSkill() {
  const invalidate = useAgentInvalidation()
  return useEffectMutation(
    (input: { agentId: AgentId; name: string }) =>
      call((api) => api.agents.deleteSkill({ path: input })),
    { onSuccess: invalidate }
  )
}

// --- absorbing a skill from a source (docs/build-plan-skills.md) -----------

/**
 * What is installable at a source, without installing it. Deliberately a mutation and not a
 * query: it hits the network on the other end and the person pressed a button to make it happen.
 */
export function usePreviewSkill() {
  return useEffectMutation((input: { agentId: AgentId; source: string }) =>
    call((api) =>
      api.agents.previewSkill({
        path: { agentId: input.agentId },
        payload: { source: input.source }
      })
    )
  )
}

export function useInstallSkill() {
  const invalidate = useAgentInvalidation()
  return useEffectMutation(
    (input: {
      agentId: AgentId
      source: string
      name?: string
      updatePolicy?: 'manual' | 'notify' | 'auto'
    }) =>
      call((api) =>
        api.agents.installSkill({
          path: { agentId: input.agentId },
          payload: {
            source: input.source,
            ...(input.name === undefined ? {} : { name: input.name as AgentSkill['name'] }),
            ...(input.updatePolicy === undefined ? {} : { updatePolicy: input.updatePolicy })
          }
        })
      ),
    { onSuccess: invalidate }
  )
}

/** Accept a skill the agent installed for itself; its files move into `skills/`. */
export function useApproveSkill() {
  const invalidate = useAgentInvalidation()
  return useEffectMutation(
    (input: { agentId: AgentId; name: string }) =>
      call((api) =>
        api.agents.approveSkill({
          path: { agentId: input.agentId, name: input.name as AgentSkill['name'] }
        })
      ),
    { onSuccess: invalidate }
  )
}

/** Ask upstream what it looks like now. Returns the detail, so the caller can diff on it. */
export function useCheckSkill() {
  const queryClient = useQueryClient()
  const invalidate = useAgentInvalidation()
  return useEffectMutation(
    (input: { agentId: AgentId; name: string }) =>
      call((api) =>
        api.agents.checkSkill({
          path: { agentId: input.agentId, name: input.name as AgentSkill['name'] }
        })
      ),
    {
      onSuccess: (_result, input) => {
        invalidate()
        void queryClient.invalidateQueries({ queryKey: qk.skill(input.agentId, input.name) })
      }
    }
  )
}

export function useUpdateSkill() {
  const queryClient = useQueryClient()
  const invalidate = useAgentInvalidation()
  return useEffectMutation(
    (input: { agentId: AgentId; name: string }) =>
      call((api) =>
        api.agents.updateSkill({
          path: { agentId: input.agentId, name: input.name as AgentSkill['name'] }
        })
      ),
    {
      onSuccess: (_result, input) => {
        invalidate()
        void queryClient.invalidateQueries({ queryKey: qk.skill(input.agentId, input.name) })
      }
    }
  )
}

export function useSetSkillPolicy() {
  const invalidate = useAgentInvalidation()
  return useEffectMutation(
    (input: { agentId: AgentId; name: string; updatePolicy: 'manual' | 'notify' | 'auto' }) =>
      call((api) =>
        api.agents.skillSettings({
          path: { agentId: input.agentId, name: input.name as AgentSkill['name'] },
          payload: { updatePolicy: input.updatePolicy }
        })
      ),
    { onSuccess: invalidate }
  )
}

/** Both scopes at once: the caller rarely knows which list an item landed in. */
function useVaultInvalidation(): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: qk.allVaults })
  }
}

// --- vault ----------------------------------------------------------------

/**
 * Company items (no `agentId`) or one agent's own items.
 *
 * The scope is a server-side filter, so the two never mix in one cache entry.
 * Company metadata is readable by any member; an agent's items are admin+ or
 * the head of one of its departments, so pass `enabled` when you are not sure.
 */
export function useVaultItems(
  agentId?: AgentId,
  options: { enabled?: boolean } = {}
): UseQueryResult<PageOf<VaultItemMeta>, ApiError> {
  return useEffectQuery<PageOf<VaultItemMeta>>(
    qk.vault(agentId),
    call((api) => api.vault.list({ urlParams: { limit: DIRECTORY_LIMIT, agentId } })),
    { enabled: options.enabled ?? true }
  )
}

/** `agentId` present = an item only that agent may resolve; absent = a company item. */
export function useAddVaultItem() {
  const invalidate = useVaultInvalidation()
  return useEffectMutation(
    (input: { kind: VaultItemMeta['kind']; label: string; secret: string; agentId?: AgentId }) =>
      call((api) =>
        api.vault.add({
          payload: {
            kind: input.kind,
            label: input.label,
            secret: Redacted.make(input.secret),
            agentId: input.agentId
          }
        })
      ),
    { onSuccess: invalidate }
  )
}

export function useRevokeVaultItem() {
  const invalidate = useVaultInvalidation()
  return useEffectMutation(
    (vaultItemId: VaultItemId) => call((api) => api.vault.revoke({ path: { vaultItemId } })),
    { onSuccess: invalidate }
  )
}

// --- subscriptions --------------------------------------------------------

/** Any member may list; add/remove/setWeight/check are admin+ on the server. */
export function useSubscriptions(
  options: { enabled?: boolean } = {}
): UseQueryResult<PageOf<Subscription>, ApiError> {
  return useEffectQuery<PageOf<Subscription>>(
    qk.subscriptions,
    call((api) => api.subscriptions.list({ urlParams: { limit: DIRECTORY_LIMIT } })),
    { enabled: options.enabled ?? true }
  )
}

/**
 * The models `runtime` can actually reach, read from the provider through a
 * seat's credential (docs/build-plan-run-overrides.md D6).
 *
 * Never an error state worth rendering: the endpoint answers a `fallback`
 * catalogue with a reason rather than failing, so the dropdown always opens.
 * Cached for the session — the server caches for half an hour behind it.
 */
export function useModelCatalog(
  runtime: RuntimeKind | undefined,
  subscriptionId?: SubscriptionId,
  options: { enabled?: boolean } = {}
): UseQueryResult<ModelCatalog, ApiError> {
  return useEffectQuery<ModelCatalog>(
    qk.modelCatalog(runtime ?? 'none', subscriptionId),
    call((api) =>
      api.subscriptions.models({
        urlParams: {
          runtime: runtime ?? 'claude-code',
          ...(subscriptionId === undefined ? {} : { subscriptionId })
        }
      })
    ),
    {
      enabled: runtime !== undefined && (options.enabled ?? true),
      staleTime: 5 * 60 * 1000
    }
  )
}

function useSubscriptionInvalidation(): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: qk.subscriptions })
  }
}

export function useAddSubscription() {
  const invalidate = useSubscriptionInvalidation()
  return useEffectMutation(
    (input: {
      runtime: Subscription['runtime']
      label: string
      credentialId: VaultItemId
      defaultModel?: string
      weight?: number
    }) => call((api) => api.subscriptions.add({ payload: input })),
    { onSuccess: invalidate }
  )
}

export function useRemoveSubscription() {
  const invalidate = useSubscriptionInvalidation()
  return useEffectMutation(
    (subscriptionId: SubscriptionId) =>
      call((api) => api.subscriptions.remove({ path: { subscriptionId } })),
    { onSuccess: invalidate }
  )
}

export function useSetSubscriptionWeight() {
  const invalidate = useSubscriptionInvalidation()
  return useEffectMutation(
    (input: { subscriptionId: SubscriptionId; weight: number }) =>
      call((api) =>
        api.subscriptions.setWeight({
          path: { subscriptionId: input.subscriptionId },
          payload: { weight: input.weight }
        })
      ),
    { onSuccess: invalidate }
  )
}

/** Attach (or, with `undefined`, detach) the read-only credential the usage probe reads. */
export function useSetSubscriptionUsageCredential() {
  const invalidate = useSubscriptionInvalidation()
  return useEffectMutation(
    (input: { subscriptionId: SubscriptionId; usageCredentialId: VaultItemId | undefined }) =>
      call((api) =>
        api.subscriptions.setUsageCredential({
          path: { subscriptionId: input.subscriptionId },
          payload: { usageCredentialId: input.usageCredentialId }
        })
      ),
    { onSuccess: invalidate }
  )
}

/**
 * Hand a parked seat back to the rotation now, without asking the provider.
 * A limit is per-model, so one exhausted model parks a seat whose other models
 * still have room; `check` cannot release that one, but the operator can.
 */
export function useClearSubscriptionCooldown() {
  const invalidate = useSubscriptionInvalidation()
  return useEffectMutation(
    (subscriptionId: SubscriptionId) =>
      call((api) => api.subscriptions.clearCooldown({ path: { subscriptionId } })),
    { onSuccess: invalidate }
  )
}

export function useCheckSubscription() {
  const invalidate = useSubscriptionInvalidation()
  return useEffectMutation(
    (subscriptionId: SubscriptionId) =>
      call((api) => api.subscriptions.check({ path: { subscriptionId } })),
    { onSuccess: invalidate }
  )
}

// --- repositories (docs/build-plan-repositories.md) -------------------------

/** Any member: `none` → `app-created` → `connected`. Never carries a secret (D8). */
export function useGithubConnection(): UseQueryResult<GithubConnection, ApiError> {
  return useEffectQuery<GithubConnection>(
    qk.githubConnection,
    call((api) => api.repositories.githubConnection())
  )
}

/** Any member: the repositories attached to the company. */
export function useRepositories(): UseQueryResult<PageOf<Repository>, ApiError> {
  return useEffectQuery<PageOf<Repository>>(
    qk.repositoryList,
    call((api) => api.repositories.list({ urlParams: { limit: DIRECTORY_LIMIT } }))
  )
}

/**
 * Everything GitHub lets the installation see, with `attached` resolved (D3).
 * Admin+ on the server, so pass `enabled` when the viewer is not one.
 */
export function useAvailableRepositories(
  options: { enabled?: boolean } = {}
): UseQueryResult<PageOf<AvailableRepository>, ApiError> {
  return useEffectQuery<PageOf<AvailableRepository>>(
    qk.availableRepositories,
    call((api) => api.repositories.available({ urlParams: { limit: DIRECTORY_LIMIT } })),
    { enabled: options.enabled ?? true }
  )
}

/**
 * `https://github.com/apps/<slug>/installations/new` — where the owner picks
 * the account and ticks the repositories. Admin+, and only once the App exists.
 */
export function useGithubInstallUrl(
  options: { enabled?: boolean } = {}
): UseQueryResult<{ readonly url: string }, ApiError> {
  return useEffectQuery<{ readonly url: string }>(
    qk.githubInstallUrl,
    call((api) => api.repositories.githubInstallUrl()),
    { enabled: options.enabled ?? true }
  )
}

/** Detaching cascades every agent grant on the repository, so both lists move. */
function useRepositoryInvalidation(): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: qk.repositories })
    void queryClient.invalidateQueries({ queryKey: qk.agents })
  }
}

/**
 * Admin+. Builds the App manifest and its signed, ten-minute `state`; nothing
 * is stored until GitHub calls the server back. The browser must then POST
 * `manifest` to `postUrl` as a real form — `fetch` cannot do it, because the
 * response is GitHub's own create-app page.
 */
export function useGithubManifest() {
  return useEffectMutation(() => call((api) => api.repositories.githubManifest()))
}

/** Admin+. Drops the App row, every repository, and every grant on them. */
export function useDisconnectGithub() {
  const invalidate = useRepositoryInvalidation()
  return useEffectMutation(() => call((api) => api.repositories.githubDisconnect()), {
    onSuccess: invalidate
  })
}

/** Admin+. Idempotent: attaching something already attached changes nothing. */
export function useAttachRepositories() {
  const invalidate = useRepositoryInvalidation()
  return useEffectMutation(
    (githubIds: readonly number[]) =>
      call((api) => api.repositories.attach({ payload: { githubIds } })),
    { onSuccess: invalidate }
  )
}

/** Admin+. Takes the repository away from every agent that held it. */
export function useDetachRepository() {
  const invalidate = useRepositoryInvalidation()
  return useEffectMutation(
    (repositoryId: RepositoryId) =>
      call((api) => api.repositories.detach({ path: { repositoryId } })),
    { onSuccess: invalidate }
  )
}

// --- projects (docs/build-plan-projects.md) ---------------------------------

/**
 * How stale the mirror may be before the Projects page pulls Linear again (D5).
 * Five minutes: long enough that opening the page twice does not hit Linear
 * twice, short enough that a project renamed over lunch is right after coffee.
 */
export const SYNC_STALE_MS = 5 * 60 * 1000

/** Any member: `none` → `connected`. Never carries the API key (D2). */
export function useLinearConnection(): UseQueryResult<LinearConnection, ApiError> {
  return useEffectQuery<LinearConnection>(
    qk.linearConnection,
    call((api) => api.projects.linearConnection())
  )
}

/** Any member: the mirrored projects, most recent Linear activity first. */
export function useProjects(): UseQueryResult<PageOf<Project>, ApiError> {
  return useEffectQuery<PageOf<Project>>(
    qk.projectList,
    call((api) => api.projects.list({ urlParams: { limit: DIRECTORY_LIMIT } }))
  )
}

/** Any member: one project and its milestones (D10). */
export function useProject(
  projectId: ProjectId | undefined
): UseQueryResult<ProjectDetail, ApiError> {
  return useEffectQuery<ProjectDetail>(
    qk.project(projectId ?? 'none'),
    projectId === undefined
      ? Effect.dieMessage('No project')
      : call((api) => api.projects.get({ path: { projectId } })),
    { enabled: projectId !== undefined }
  )
}

/**
 * One project's issues (docs/build-plan-projects.md D19). Its own query rather
 * than a field on `useProject`, because the Overview tab never needs them and a
 * project of a busy team has hundreds.
 */
export function useProjectIssues(
  projectId: ProjectId | undefined
): UseQueryResult<ReadonlyArray<ProjectIssue>, ApiError> {
  return useEffectQuery<ReadonlyArray<ProjectIssue>>(
    qk.projectIssues(projectId ?? 'none'),
    projectId === undefined
      ? Effect.dieMessage('No project')
      : call((api) => api.projects.issues({ path: { projectId } })).pipe(
          Effect.map((page) => page.items)
        ),
    { enabled: projectId !== undefined }
  )
}

/** Connecting, syncing and disconnecting all move the list and the connection. */
function useProjectInvalidation(): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: qk.projects })
  }
}

/**
 * Admin+. The key is validated against Linear before anything is stored, so a
 * rejected key leaves the previous connection intact (D3) and surfaces as a
 * `Validation` on the field.
 */
export function useConnectLinear() {
  const invalidate = useProjectInvalidation()
  return useEffectMutation(
    (apiKey: string) => call((api) => api.projects.connectLinear({ payload: { apiKey } })),
    { onSuccess: invalidate }
  )
}

/** Admin+. Drops the key and every mirrored project with it. */
export function useDisconnectLinear() {
  const invalidate = useProjectInvalidation()
  return useEffectMutation(() => call((api) => api.projects.disconnectLinear()), {
    onSuccess: invalidate
  })
}

/**
 * Admin+. Drops a card in another board column (D13). The move goes to Linear
 * first and the row is written from Linear's answer, so the mutation settling is
 * the moment the board is telling the truth again — until then the page shows the
 * optimistic position and puts it back if Linear refuses.
 */
export function useMoveProject() {
  const invalidate = useProjectInvalidation()
  return useEffectMutation(
    (input: { readonly projectId: ProjectId; readonly statusId: string }) =>
      call((api) =>
        api.projects.move({
          path: { projectId: input.projectId },
          payload: { statusId: input.statusId }
        })
      ),
    { onSuccess: invalidate }
  )
}

/**
 * Any member: the Linear workspace's people, each with the Taut human they map
 * to (D15). Active people first, then by name.
 */
export function useLinearUsers(): UseQueryResult<PageOf<LinearUser>, ApiError> {
  return useEffectQuery<PageOf<LinearUser>>(
    qk.linearUsers,
    call((api) => api.projects.linearUsers())
  )
}

/**
 * Admin+. Points one Linear person at one Taut human, or at nobody (D16). The
 * server refuses a human who already stands for somebody else in Linear, which
 * surfaces as a `Validation` on the row.
 */
export function useLinkLinearUser() {
  const invalidate = useProjectInvalidation()
  return useEffectMutation(
    (input: { readonly linearUserId: string; readonly member: UserId | null }) =>
      call((api) =>
        api.projects.linkLinearUser({
          path: { linearUserId: input.linearUserId },
          payload: { member: input.member }
        })
      ),
    { onSuccess: invalidate }
  )
}

/** Admin+. Pulls Linear and reconciles; a failure leaves the mirror standing (D7). */
export function useSyncProjects() {
  const invalidate = useProjectInvalidation()
  return useEffectMutation(() => call((api) => api.projects.sync()), { onSuccess: invalidate })
}

// --- tasks ----------------------------------------------------------------

export interface TaskFilters {
  readonly agentId?: AgentId
  readonly channelId?: ChannelId
  readonly status?: TaskStatus
}

const TASK_PAGE = 50

/**
 * `/tasks`, the "recent tasks" list on an agent's Runtime tab, and the channel-scoped read the
 * message list uses to badge a signal-woken turn. `enabled` is there for that last one: a list
 * with no channel yet must not ask for every task in the company.
 */
export function useTasks(
  filters: TaskFilters = {},
  enabled = true
): UseQueryResult<PageOf<Task>, ApiError> {
  const scope = `${filters.agentId ?? ''}|${filters.channelId ?? ''}|${filters.status ?? ''}`
  return useEffectQuery<PageOf<Task>>(
    qk.taskList(scope),
    call((api) =>
      api.tasks.list({
        urlParams: {
          limit: TASK_PAGE,
          agentId: filters.agentId,
          channelId: filters.channelId,
          status: filters.status
        }
      })
    ),
    { enabled }
  )
}

/**
 * Seeds the shimmer set (docs/build-plan-shimmer.md D9). Without it a refresh mid-run leaves
 * every in-flight message flat, because the `agent.task.started` event is long gone. Live runs
 * are few, so this is one small query, refreshed whenever a task event invalidates `qk.tasks`.
 */
export function useLiveRunSeed(): void {
  const query = useEffectQuery<PageOf<Task>>(
    qk.taskList('live'),
    call((api) => api.tasks.list({ urlParams: { limit: TASK_PAGE, live: true } }))
  )
  const items = query.data?.items
  /**
   * The epoch when the request in flight went out. Every task event invalidates `qk.tasks`, so
   * this query refetches constantly, and a run that starts while one is in flight is missing from
   * an answer that was already stale when it left the server — two agents on one message hit that
   * every time. `seedRuns` keeps anything newer than this instead of trusting the snapshot whole.
   */
  const since = React.useRef(0)
  const fetching = query.isFetching
  React.useEffect(() => {
    if (fetching) since.current = live.runEpoch()
  }, [fetching])
  React.useEffect(() => {
    if (items === undefined) return
    live.seedRuns(
      items.map((task) => ({
        taskId: task.id,
        ...(task.triggerMessageId === undefined ? {} : { triggerMessageId: task.triggerMessageId })
      })),
      since.current
    )
  }, [items])
}

/**
 * Seeds the context rings for one channel (docs/build-plan-context-meter.md).
 *
 * Same problem the shimmer seed solves, with a gentler answer: `agent.context.updated` is a
 * broadcast, not a log, so a client that joins mid-conversation has never heard one. This
 * asks once per channel. No epoch bookkeeping is needed here — the seed only ever fills in
 * windows the socket has not spoken about, and a socket update that arrives during the fetch
 * simply wins on the next event, because occupancy is a value, not a count.
 */
export function useThreadContextSeed(channelId: ChannelId | undefined): void {
  const query = useEffectQuery<ReadonlyArray<ThreadContext>>(
    qk.channelContext(channelId ?? 'none'),
    channelId === undefined
      ? Effect.succeed<ReadonlyArray<ThreadContext>>([])
      : call((api) => api.channels.context({ path: { channelId } }))
  )
  const items = query.data
  React.useEffect(() => {
    if (items !== undefined) live.seedThreadContexts(items)
  }, [items])
}

export function useCancelTask() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (taskId: TaskId) => call((api) => api.tasks.cancel({ path: { taskId } })),
    { onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.tasks }) }
  )
}

// --- routines (docs/build-plan-routines.md) ---------------------------------

const ROUTINE_LIMIT = 100

/** Readable by anyone who may view the agent; every write below is `requireManageAgent`. */
export function useRoutines(
  agentId: AgentId | undefined
): UseQueryResult<PageOf<Routine>, ApiError> {
  return useEffectQuery<PageOf<Routine>>(
    qk.routineList(agentId ?? 'all'),
    call((api) => api.routines.list({ urlParams: { limit: ROUTINE_LIMIT, agentId } }))
  )
}

/** A prefix, so every agent's list picks up a write no matter which tab made it. */
function useRoutineInvalidation(): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: qk.routines })
  }
}

export function useCreateRoutine() {
  const invalidate = useRoutineInvalidation()
  return useEffectMutation(
    (input: {
      agentId: AgentId
      name: string
      prompt: string
      /** Absent = the owner's DM with the agent, opened on the first fire. */
      channelId?: ChannelId
      /** A clock or a bus event (docs/build-plan-triggers.md D1). */
      trigger: Trigger
      /** A routine is live the moment it exists unless you say otherwise. */
      enabled?: boolean
    }) =>
      call((api) => api.routines.create({ payload: { ...input, enabled: input.enabled ?? true } })),
    { onSuccess: invalidate }
  )
}

/** `channelId: null` moves the routine back to the DM. */
export function useUpdateRoutine() {
  const invalidate = useRoutineInvalidation()
  return useEffectMutation(
    (input: {
      routineId: RoutineId
      name?: string
      prompt?: string
      channelId?: ChannelId | null
      /** Replaced whole, never merged: switching arms changes which filters exist at all. */
      trigger?: Trigger
      enabled?: boolean
    }) => {
      const { routineId, ...payload } = input
      return call((api) => api.routines.update({ path: { routineId }, payload }))
    },
    { onSuccess: invalidate }
  )
}

export function useDeleteRoutine() {
  const invalidate = useRoutineInvalidation()
  return useEffectMutation(
    (routineId: RoutineId) => call((api) => api.routines.delete({ path: { routineId } })),
    { onSuccess: invalidate }
  )
}

/** Fires once, now, ignoring the schedule; the task it returns is a normal agent run. */
export function useRunRoutine() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (routineId: RoutineId) => call((api) => api.routines.run({ path: { routineId } })),
    {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: qk.routines })
        void queryClient.invalidateQueries({ queryKey: qk.tasks })
      }
    }
  )
}

// --- signals (docs/build-plan-triggers.md Part II) ---------------------------

const SIGNAL_LIMIT = 100

/**
 * The pending wakes armed in one thread — the row under the thread composer, and the whole
 * human-facing surface signals get (D26).
 *
 * `ListSignalsQuery` filters on `agentId` and `status`, not on the thread, so one `pending`
 * query is shared by every open thread and narrowed here. That is cheaper than a query per
 * thread as well as being the only shape the contract offers.
 */
export function useSignals(threadId: MessageId | undefined): readonly Signal[] {
  const query = useEffectQuery<PageOf<Signal>>(
    qk.signalList(`pending:${threadId ?? 'none'}`),
    call((api) =>
      api.signals.list({ urlParams: { limit: SIGNAL_LIMIT, status: 'pending', threadId } })
    ),
    // A background affordance nobody asked for: a failure hides the row, it does not raise a toast.
    { enabled: threadId !== undefined, meta: { silent: true } }
  )
  return query.data?.items ?? EMPTY_SIGNALS
}

/** A stable empty array, so a thread with no reminders never re-renders its composer. */
const EMPTY_SIGNALS: readonly Signal[] = []

/** "Actually, never mind" — half of what a reminder is for (D26). Already-gone is a no-op. */
export function useCancelSignal() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (signalId: SignalId) => call((api) => api.signals.delete({ path: { signalId } })),
    { onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.signals }) }
  )
}

// --- handovers (the department boundary, docs/agent-model.md §9) -------------

/**
 * A head's queue of cross-department attempts their agents were refused. Only heads and
 * admins get rows back, so the sidebar entry can key off `data.length` without a role check.
 */
export function useHandovers(
  status: HandoverStatus = 'open'
): UseQueryResult<readonly Handover[], ApiError> {
  return useEffectQuery<readonly Handover[]>(
    qk.handoverList(status),
    call((api) => api.handovers.list({ urlParams: { status } }))
  )
}

/** DMs the other department's head as the current user, then closes the handover. */
export function useRaiseHandover() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (input: { readonly handoverId: HandoverId; readonly text?: string | undefined }) =>
      call((api) =>
        api.handovers.raise({
          path: { handoverId: input.handoverId },
          payload: { text: input.text }
        })
      ),
    {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: qk.handovers })
        void queryClient.invalidateQueries({ queryKey: qk.channels })
      }
    }
  )
}

export function useDismissHandover() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (handoverId: HandoverId) => call((api) => api.handovers.dismiss({ path: { handoverId } })),
    { onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.handovers }) }
  )
}

// --- calls (huddles, docs/build-plan-calls.md) -------------------------------

/**
 * The single gate (D3): every huddle affordance in the app hides when this is `false`, and
 * it only flips when the deployment is reconfigured, so it is fetched once and kept.
 */
export function useCallsConfig(): UseQueryResult<CallsConfig, ApiError> {
  return useEffectQuery<CallsConfig>(
    qk.callsConfig,
    call((api) => api.calls.config()),
    { staleTime: Infinity, retry: false, meta: { silent: true } }
  )
}

/**
 * Every open huddle the user can see. `call.started` / `call.updated` / `call.ended` patch
 * this list in place (`lib/realtime-cache.ts`), so it is only fetched on mount and after a
 * reconnect resync.
 */
export function useActiveCalls(enabled: boolean): UseQueryResult<readonly Call[], ApiError> {
  return useEffectQuery<readonly Call[]>(
    qk.activeCalls,
    enabled ? call((api) => api.calls.active()) : Effect.succeed<readonly Call[]>([]),
    { enabled, staleTime: 30_000 }
  )
}

/** Start-or-join, one endpoint (D1). Returns the room, its url and a token scoped to it. */
export function useJoinCall() {
  return useEffectMutation((channelId: ChannelId) =>
    call((api) => api.calls.join({ path: { channelId } }))
  )
}

/**
 * Leaving is only about *this* tab feeling instant — LiveKit's webhook is what actually
 * settles who is in the room (D2), so a failure here is not worth a toast.
 */
export function useLeaveCall() {
  return useEffectMutation((callId: CallId) => call((api) => api.calls.leave({ path: { callId } })))
}

export type { MessagePages }
