import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { BotIcon, MailIcon, UserPlusIcon, UsersIcon, XIcon } from 'lucide-react'
import type { MembershipRole } from '@taut/contract'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Skeleton } from '@taut/ui/components/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { EmptyState, PageBody, PageHeader } from '@/components/page'
import { SettingsCard, SettingsShell } from '@/components/settings'
import { WorkspaceSettingsNav } from '@/components/settings-nav'
import { EntityAvatar } from '@/components/entity-avatar'
import { PresenceDot, presenceLabel } from '@/components/presence-dot'
import { CopyInviteLink, InviteDialog } from '@/components/invite-dialog'
import { useDirectoryAgents, useDirectoryUsers, type DirectoryUser } from '@/hooks/use-directory'
import type { AgentFace } from '@/lib/agent-avatar'
import { useCanAdminister, useInvites, useMe, useRevokeInvite, useSetRole } from '@/lib/api'
import { formatRelative } from '@/lib/format'
import { usePresence } from '@/lib/live'

const ROLE_VARIANT: Record<MembershipRole, 'default' | 'secondary' | 'outline'> = {
  owner: 'default',
  admin: 'secondary',
  member: 'outline'
}

function MemberRow({ member, canAdminister }: { member: DirectoryUser; canAdminister: boolean }) {
  const presence = usePresence(member.id, member.defaultPresence)
  const setRole = useSetRole()

  return (
    <li className="flex items-center gap-3 px-6 py-3">
      <EntityAvatar avatar={member.avatar} name={member.name} presence={presence} size="lg" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {member.name} <span className="font-normal text-muted-foreground">@{member.handle}</span>
        </p>
        <p className="truncate text-xs text-muted-foreground">{member.email}</p>
      </div>
      <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
        <PresenceDot presence={presence} />
        {presenceLabel(presence)}
      </span>
      {canAdminister ? (
        <Select
          value={member.role}
          disabled={setRole.isPending}
          onValueChange={(next) => {
            if (next === 'owner' || next === 'admin' || next === 'member') {
              setRole.mutate({ userId: member.id, role: next })
            }
          }}
        >
          <SelectTrigger size="sm" className="w-32" aria-label={`Role for ${member.name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="owner">Owner</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="member">Member</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <Badge variant={ROLE_VARIANT[member.role]}>{member.role}</Badge>
      )}
    </li>
  )
}

function AgentRow({
  agentId,
  name,
  handle,
  role,
  avatar,
  face,
  runtimeKind
}: {
  agentId: string
  name: string
  handle: string
  role: string
  avatar: Parameters<typeof EntityAvatar>[0]['avatar']
  face: AgentFace
  runtimeKind: string
}) {
  const presence = usePresence(agentId, 'idle')
  return (
    <li className="flex items-center gap-3 px-6 py-3">
      <EntityAvatar avatar={avatar} kind="agent" face={face} name={name} size="lg" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {name} <span className="font-normal text-muted-foreground">@{handle}</span>
        </p>
        <p className="truncate text-xs text-muted-foreground">{role}</p>
      </div>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <PresenceDot presence={presence} />
        {presenceLabel(presence)}
      </span>
      <Badge variant="outline">{runtimeKind}</Badge>
    </li>
  )
}

function MembersRoute() {
  const { users, isPending } = useDirectoryUsers()
  const { agents } = useDirectoryAgents()
  const canAdminister = useCanAdminister()
  const invites = useInvites()
  const revokeInvite = useRevokeInvite()
  const me = useMe().data
  const [inviting, setInviting] = React.useState(false)

  const pending = (invites.data?.items ?? []).filter((invite) => invite.acceptedAt === undefined)

  return (
    <>
      <PageHeader
        title="Members"
        description="Humans and agents in this company."
        icon={<UsersIcon className="size-4" />}
        actions={
          canAdminister ? (
            <Button size="sm" onClick={() => setInviting(true)}>
              <UserPlusIcon />
              Invite people
            </Button>
          ) : null
        }
      />
      <PageBody>
        <SettingsShell nav={<WorkspaceSettingsNav />}>
          <div className="grid gap-6">
            <SettingsCard title="People" description={`${users.length} humans`}>
              {isPending ? (
                <Skeleton className="m-6 h-40 rounded-lg" />
              ) : users.length === 0 ? (
                <div className="px-6 py-5">
                  <EmptyState
                    icon={<UsersIcon className="size-5" />}
                    title="Nobody here yet"
                    description="Invite the people who should share this company's channels and agents."
                    action={
                      canAdminister ? (
                        <Button onClick={() => setInviting(true)}>Invite people</Button>
                      ) : undefined
                    }
                  />
                </div>
              ) : (
                <ul className="divide-y">
                  {users.map((member) => (
                    <MemberRow
                      key={member.id}
                      member={member}
                      canAdminister={canAdminister && member.id !== me?.user.id}
                    />
                  ))}
                </ul>
              )}
            </SettingsCard>

            {canAdminister ? (
              <SettingsCard
                title="Pending invites"
                description={`${pending.length} waiting to be accepted`}
              >
                {pending.length === 0 ? (
                  <div className="px-6 py-5">
                    <EmptyState
                      icon={<MailIcon className="size-5" />}
                      title="No pending invites"
                      description="Create one and share the link — Taut sends no email."
                      action={<Button onClick={() => setInviting(true)}>Create an invite</Button>}
                    />
                  </div>
                ) : (
                  <ul className="divide-y">
                    {pending.map((invite) => (
                      <li key={invite.id} className="flex items-center gap-3 px-6 py-3">
                        <MailIcon className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{invite.email}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {invite.role} · expires {formatRelative(invite.expiresAt)}
                          </p>
                        </div>
                        <CopyInviteLink token={invite.token} />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Revoke the invite for ${invite.email}`}
                          onClick={() => revokeInvite.mutate(invite.id)}
                        >
                          <XIcon />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </SettingsCard>
            ) : null}

            <SettingsCard title="Agents" description={`${agents.length} agents`}>
              {agents.length === 0 ? (
                <div className="px-6 py-5">
                  <EmptyState
                    icon={<BotIcon className="size-5" />}
                    title="No agents yet"
                    description="Agents are members that run on the company's subscription pool."
                  />
                </div>
              ) : (
                <ul className="divide-y">
                  {agents.map((entry) => (
                    <AgentRow
                      key={entry.id}
                      agentId={entry.id}
                      name={entry.name}
                      handle={entry.handle}
                      role={entry.subtitle}
                      avatar={entry.avatar}
                      face={entry.face}
                      runtimeKind={entry.agent.runtimeKind}
                    />
                  ))}
                </ul>
              )}
            </SettingsCard>
          </div>
        </SettingsShell>
      </PageBody>

      <InviteDialog open={inviting} onOpenChange={setInviting} />
    </>
  )
}

export const Route = createFileRoute('/_app/members')({
  component: MembersRoute
})
