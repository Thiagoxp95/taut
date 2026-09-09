/**
 * The company directory as the UI wants it.
 *
 * The contract keeps humans (`CompanyMember`) and agents (`Agent`) apart and
 * has no notion of a handle for a human; the shell needs one list of
 * `@mentionable` members with presence. That translation lives here — the
 * hooks in `@/lib/api` stay a faithful mirror of the HTTP API.
 */
import * as React from 'react'
import { useQueries } from '@tanstack/react-query'
import type {
  Agent,
  AgentId,
  Avatar,
  Channel,
  ChannelId,
  ChannelMember,
  Department,
  MemberKind,
  MembershipRole,
  User,
  UserId
} from '@taut/contract'

import {
  useAgents,
  useChannelMembers,
  useChannels,
  useDepartments,
  useMe,
  useMembers,
  type PageOf
} from '@/lib/api'
import { agentFace, departmentShapes, type AgentFace } from '@/lib/agent-avatar'
import { call } from '@/lib/api-client'
import { handleFromEmail } from '@/lib/format'
import type { Presence } from '@/lib/live'
import { qk } from '@/lib/query-keys'
import { runEffect } from '@/lib/runtime'

export interface DirectoryUser {
  readonly kind: 'user'
  readonly id: UserId
  readonly handle: string
  readonly name: string
  readonly email: string
  readonly avatar: Avatar
  readonly role: MembershipRole
  readonly subtitle: string
  readonly defaultPresence: Presence
  /** Humans render `avatar`; the field exists so the union can be read blindly. */
  readonly face?: undefined
}

export interface DirectoryAgent {
  readonly kind: 'agent'
  readonly id: AgentId
  readonly handle: string
  readonly name: string
  readonly avatar: Avatar
  /** Agents have no picture: their face is drawn from this. */
  readonly face: AgentFace
  readonly subtitle: string
  readonly defaultPresence: Presence
  /** Archived agents stay in the directory so their old messages keep a name and a face. */
  readonly archived: boolean
  readonly agent: Agent
}

export type Mentionable = DirectoryUser | DirectoryAgent

const ROLE_LABEL: Record<MembershipRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member'
}

const FALLBACK_AVATAR: Avatar = { kind: 'emoji', value: '👤' }

function toDirectoryUser(user: User, role: MembershipRole): DirectoryUser {
  return {
    kind: 'user',
    id: user.id,
    handle: handleFromEmail(user.email),
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    role,
    subtitle: ROLE_LABEL[role],
    defaultPresence: 'offline'
  }
}

function toDirectoryAgent(agent: Agent, shapes: ReadonlyMap<string, number>): DirectoryAgent {
  return {
    kind: 'agent',
    id: agent.id,
    handle: agent.handle,
    name: agent.name,
    avatar: agent.avatar,
    face: agentFace(agent, shapes),
    subtitle: agent.role,
    defaultPresence: 'idle',
    archived: agent.archivedAt !== undefined,
    agent
  }
}

/**
 * `departmentId → silhouette` for the active company.
 *
 * One place, because the assignment is a property of the whole department list
 * (see `departmentShapes`) and two callers computing it off different slices of
 * that list would draw the same agent as two shapes. Empty while the
 * departments load, which renders every agent per seed for one frame.
 */
export function useDepartmentShapes(): ReadonlyMap<string, number> {
  const query = useDepartments()
  return React.useMemo(() => departmentShapes(query.data?.items ?? []), [query.data])
}

/** The signed-in user, with the handle the composer inserts. */
export function useCurrentUser(): DirectoryUser | undefined {
  const me = useMe().data
  return React.useMemo(() => {
    if (me === undefined) return undefined
    const role =
      me.memberships.find((entry) => entry.company.id === me.activeCompanyId)?.role ?? 'member'
    return toDirectoryUser(me.user, role)
  }, [me])
}

export function useDirectoryUsers(): {
  users: readonly DirectoryUser[]
  isPending: boolean
} {
  const query = useMembers()
  const users = React.useMemo(
    () => (query.data?.items ?? []).map((entry) => toDirectoryUser(entry.user, entry.role)),
    [query.data]
  )
  return { users, isPending: query.isPending }
}

export function useDirectoryAgents(): {
  agents: readonly DirectoryAgent[]
  isPending: boolean
} {
  const query = useAgents()
  const shapes = useDepartmentShapes()
  const agents = React.useMemo(
    () => (query.data?.items ?? []).map((agent) => toDirectoryAgent(agent, shapes)),
    [query.data, shapes]
  )
  return { agents, isPending: query.isPending }
}

/**
 * Everyone who can be `@mentioned` or DM'd in the active company.
 *
 * Archived agents are left out: the scheduler will not wake one, so offering the handle would
 * promise a reply that never comes. `useDirectoryIndex` keeps them, so the messages they wrote
 * before they were archived still render with their name and face.
 */
export function useMentionables(): readonly Mentionable[] {
  const { users } = useDirectoryUsers()
  const { agents } = useDirectoryAgents()
  return React.useMemo<readonly Mentionable[]>(
    () => [...users, ...agents.filter((agent) => !agent.archived)],
    [users, agents]
  )
}

/**
 * Everyone `@mentionable` *in one channel*: the company directory narrowed to
 * the channel's own membership. Empty while the membership loads, which offers
 * nothing for a frame rather than the whole company.
 */
export function useChannelMentionables(channelId: ChannelId | undefined): readonly Mentionable[] {
  return useMentionGroups(channelId).here
}

/**
 * The `@` picker's two lists.
 *
 * `here` is the channel's own membership — the only people a mention actually
 * reaches, since the scheduler refuses to wake an agent that is not a member.
 * `elsewhere` is the rest of the company, offered under its own heading so a
 * name can still be *written*: telling an agent in a DM to go talk to
 * `@bruno` in `#engineering` is naming him, not pinging him, and a picker
 * limited to the DM's two members made that impossible to type.
 */
export function useMentionGroups(channelId: ChannelId | undefined): {
  here: readonly Mentionable[]
  elsewhere: readonly Mentionable[]
} {
  const mentionables = useMentionables()
  const members = useChannelMembers(channelId)
  return React.useMemo(() => {
    if (channelId === undefined) return { here: [], elsewhere: [] }
    const ids = new Set((members.data?.items ?? []).map((member) => member.memberId as string))
    const here: Mentionable[] = []
    const elsewhere: Mentionable[] = []
    for (const candidate of mentionables) {
      if (ids.has(candidate.id)) here.push(candidate)
      else elsewhere.push(candidate)
    }
    return { here, elsewhere }
  }, [channelId, mentionables, members.data])
}

/**
 * `id → member`, for turning an author id into a name and an avatar. Archived agents included:
 * an author with no entry renders as "Unknown member", which is what archiving exists to avoid.
 */
export function useDirectoryIndex(): ReadonlyMap<string, Mentionable> {
  const { users } = useDirectoryUsers()
  const { agents } = useDirectoryAgents()
  return React.useMemo(() => {
    const index = new Map<string, Mentionable>()
    for (const entry of [...users, ...agents]) index.set(entry.id, entry)
    return index
  }, [users, agents])
}

export function useLookupMember(): (id: string) => Mentionable | undefined {
  const index = useDirectoryIndex()
  return React.useCallback((id: string) => index.get(id), [index])
}

/** `handle → member`, for turning an `@mention` chip into a profile. */
export function useHandleIndex(): ReadonlyMap<string, Mentionable> {
  const mentionables = useMentionables()
  return React.useMemo(() => {
    const index = new Map<string, Mentionable>()
    for (const entry of mentionables) index.set(entry.handle.toLowerCase(), entry)
    return index
  }, [mentionables])
}

export function useLookupHandle(): (handle: string) => Mentionable | undefined {
  const index = useHandleIndex()
  return React.useCallback((handle: string) => index.get(handle.toLowerCase()), [index])
}

// --- channels -------------------------------------------------------------

export interface ChannelGroups {
  readonly all: readonly Channel[]
  /** Company-wide channels: no department. */
  readonly company: readonly Channel[]
  readonly dms: readonly Channel[]
  readonly byDepartment: ReadonlyMap<string, readonly Channel[]>
  readonly isPending: boolean
}

export function useChannelGroups(): ChannelGroups {
  const query = useChannels()
  return React.useMemo(() => {
    const all = query.data?.items ?? []
    const company: Channel[] = []
    const dms: Channel[] = []
    const byDepartment = new Map<string, Channel[]>()

    for (const channel of all) {
      if (channel.kind === 'dm') {
        dms.push(channel)
      } else if (channel.departmentId === undefined) {
        company.push(channel)
      } else {
        const bucket = byDepartment.get(channel.departmentId)
        if (bucket === undefined) byDepartment.set(channel.departmentId, [channel])
        else bucket.push(channel)
      }
    }

    const byName = (a: Channel, b: Channel): number => a.name.localeCompare(b.name)
    company.sort(byName)
    for (const bucket of byDepartment.values()) bucket.sort(byName)

    return { all, company, dms, byDepartment, isPending: query.isPending }
  }, [query.data, query.isPending])
}

export function useChannel(channelId: string | undefined): Channel | undefined {
  const { all } = useChannelGroups()
  return all.find((channel) => channel.id === channelId)
}

export function useDepartmentList(): { departments: readonly Department[]; isPending: boolean } {
  const query = useDepartments()
  const departments = React.useMemo(
    () => [...(query.data?.items ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [query.data]
  )
  return { departments, isPending: query.isPending }
}

/** The departments an agent belongs to (`Agent.departmentIds`), in name order. */
export function useAgentDepartments(agent: Agent | undefined): readonly Department[] {
  const { departments } = useDepartmentList()
  return React.useMemo(() => {
    if (agent === undefined) return []
    const ids = new Set<string>(agent.departmentIds)
    return departments.filter((department) => ids.has(department.id))
  }, [departments, agent])
}

// --- direct messages ------------------------------------------------------

export interface DmPartner {
  readonly memberKind: MemberKind
  readonly memberId: string
}

/**
 * A DM's title is "the other member", which only the membership list knows.
 * One small query per open DM, kept fresh by `channel.updated` events.
 */
export function useDmPartners(): ReadonlyMap<string, DmPartner> {
  const { dms } = useChannelGroups()
  const me = useMe().data

  const results = useQueries({
    queries: dms.map((channel) => ({
      queryKey: qk.channelMembers(channel.id),
      queryFn: () =>
        runEffect(
          call((api) =>
            api.channels.members({ path: { channelId: channel.id }, urlParams: { limit: 10 } })
          )
        ),
      staleTime: 5 * 60_000
    }))
  })

  const entries: [string, DmPartner][] = []
  dms.forEach((channel, index) => {
    const page: PageOf<ChannelMember> | undefined = results[index]?.data
    const other = page?.items.find(
      (member) => !(member.memberKind === 'user' && member.memberId === me?.user.id)
    )
    if (other !== undefined) {
      entries.push([channel.id, { memberKind: other.memberKind, memberId: other.memberId }])
    }
  })
  const signature = entries.map(([id, partner]) => `${id}>${partner.memberId}`).join(',')

  // `entries` is rebuilt every render; `signature` is what actually changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useMemo(() => new Map(entries), [signature])
}

export interface DmView {
  readonly channel: Channel
  readonly partner: Mentionable | undefined
  readonly label: string
  /** The channel itself is archived — the agent on the other side was archived. */
  readonly archived: boolean
}

export function useDmViews(): readonly DmView[] {
  const { dms } = useChannelGroups()
  const partners = useDmPartners()
  const index = useDirectoryIndex()

  return React.useMemo(
    () =>
      dms.map((channel) => {
        const partner = partners.get(channel.id)
        const member = partner === undefined ? undefined : index.get(partner.memberId)
        return {
          channel,
          partner: member,
          label: member?.handle ?? channel.name,
          archived: channel.archivedAt !== undefined
        }
      }),
    [dms, partners, index]
  )
}

export function useDmView(channelId: ChannelId | string | undefined): DmView | undefined {
  const views = useDmViews()
  return views.find((view) => view.channel.id === channelId)
}

export { FALLBACK_AVATAR }
