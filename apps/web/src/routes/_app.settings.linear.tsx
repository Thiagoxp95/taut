import { MemberProfileTrigger } from '@/components/profile-card'
import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import {
  ExternalLinkIcon,
  InfoIcon,
  RefreshCwIcon,
  SquareKanbanIcon,
  TriangleAlertIcon,
  UnplugIcon
} from '@taut/ui/components/icons'
import type { LinearUser, User, UserId } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { Skeleton } from '@taut/ui/components/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EntityAvatar } from '@/components/entity-avatar'
import { PageBody, PageHeader, Field } from '@/components/page'
import { SettingsCallout, SettingsCard, SettingsRow, SettingsShell } from '@/components/settings'
import { WorkspaceSettingsNav } from '@/components/settings-nav'
import {
  useCanAdminister,
  useConnectLinear,
  useDisconnectLinear,
  useLinearConnection,
  useLinearUsers,
  useLinkLinearUser,
  useMembers,
  useProjects,
  useSyncProjects
} from '@/lib/api'
import { formatRelative } from '@/lib/format'

/** Where an admin makes a key. Linear has no App flow to send them through (D2). */
const KEY_SETTINGS_URL = 'https://linear.app/settings/account/security'

function ConnectCard({ canAdminister }: { canAdminister: boolean }) {
  const connect = useConnectLinear()
  const [apiKey, setApiKey] = React.useState('')

  return (
    <SettingsCard
      title="Connect Linear"
      description="Taut reads your Linear workspace with a personal API key and mirrors its projects. It never writes back."
      onSubmit={(event) => {
        event.preventDefault()
        if (apiKey.trim() === '') return
        connect.mutate(apiKey, { onSuccess: () => setApiKey('') })
      }}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <Button asChild variant="ghost" size="sm">
            <a href={KEY_SETTINGS_URL} target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              Make a key in Linear
            </a>
          </Button>
          <Button type="submit" size="sm" disabled={!canAdminister || connect.isPending}>
            {connect.isPending ? 'Checking with Linear…' : 'Connect'}
          </Button>
        </div>
      }
    >
      <div className="px-6 py-5">
        <Field
          label="Linear API key"
          htmlFor="linear-api-key"
          hint="Linear · Settings · Security & access · Personal API keys. The key is encrypted before it is stored and is never shown again."
        >
          <Input
            id="linear-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="lin_api_…"
            value={apiKey}
            disabled={!canAdminister}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>
        {connect.isError ? (
          <p className="mt-3 text-xs text-destructive">{connect.error.message}</p>
        ) : null}
        {canAdminister ? null : (
          <p className="mt-3 text-xs text-muted-foreground">
            Connecting Linear is owner and admin only. Ask one of them to paste a key.
          </p>
        )}
      </div>
    </SettingsCard>
  )
}

function ConnectedCard({
  canAdminister,
  onDisconnect
}: {
  canAdminister: boolean
  onDisconnect: () => void
}) {
  const connection = useLinearConnection()
  const projects = useProjects().data?.items ?? []
  const sync = useSyncProjects()

  const workspace = connection.data?.workspaceName ?? 'Linear'
  const urlKey = connection.data?.workspaceUrlKey
  const lastSyncedAt = connection.data?.lastSyncedAt
  const lastError = connection.data?.lastSyncError

  return (
    <>
      {lastError === undefined ? null : (
        <SettingsCallout
          variant="attention"
          icon={<TriangleAlertIcon />}
          title="The last sync failed"
          description={`${lastError} The projects below are what Taut saw the last time it succeeded.`}
        />
      )}

      <SettingsCard title="Linear" description="The workspace these projects are mirrored from.">
        <SettingsRow
          label={workspace}
          description={
            lastSyncedAt === undefined
              ? 'Never synced.'
              : `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}, synced ${formatRelative(lastSyncedAt)}.`
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            {urlKey === undefined ? null : (
              <Button asChild variant="ghost" size="sm">
                <a href={`https://linear.app/${urlKey}`} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon />
                  Open in Linear
                </a>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!canAdminister || sync.isPending}
              onClick={() => sync.mutate()}
            >
              <RefreshCwIcon className={sync.isPending ? 'animate-spin' : undefined} />
              {sync.isPending ? 'Syncing…' : 'Sync now'}
            </Button>
            <Button variant="outline" size="sm" disabled={!canAdminister} onClick={onDisconnect}>
              <UnplugIcon />
              Disconnect
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow
          label="API key"
          description="Stored encrypted. Only the last four characters are ever shown."
        >
          <span className="font-mono text-sm text-muted-foreground">
            ••••{connection.data?.keyHint ?? '····'}
          </span>
        </SettingsRow>
      </SettingsCard>
    </>
  )
}

/**
 * "Nobody" as a `Select` value. Radix treats the empty string as "no selection",
 * so the None choice needs a token of its own or it cannot be picked back.
 */
const NOBODY = '__nobody__'

/** Linear's own avatar, or the initial in the same round frame Linear uses. */
function LinearFace({ user }: { user: LinearUser }) {
  const [broken, setBroken] = React.useState(false)
  const initial = user.name.charAt(0).toUpperCase() || '·'

  return user.avatarUrl === undefined || broken ? (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-muted-foreground">
      {initial}
    </span>
  ) : (
    <img
      src={user.avatarUrl}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className="size-8 shrink-0 rounded-full object-cover"
    />
  )
}

/**
 * One Linear person and the Taut human they stand for
 * (docs/build-plan-projects.md D15, D16).
 *
 * The row reads left to right the way the mapping does: this is who Linear says
 * it is, and this is who that is here. The dropdown defaults to None because an
 * unmapped person is the honest state — a guess based on matching emails would be
 * a mapping nobody chose, and agents will assign real work through this.
 *
 * A human already standing for somebody else is refused by the server; the reason
 * lands under the row rather than in a toast, because the row is where the reader
 * is looking.
 */
function PersonRow({
  user,
  members,
  canAdminister
}: {
  user: LinearUser
  members: ReadonlyArray<User>
  canAdminister: boolean
}) {
  const link = useLinkLinearUser()
  const [error, setError] = React.useState<string | undefined>(undefined)

  const handle = user.displayName ?? user.email
  const subtitle = user.active
    ? handle
    : `${handle === undefined ? '' : `${handle} · `}Deactivated in Linear`

  return (
    <SettingsRow
      label={
        <span className="flex min-w-0 items-center gap-3">
          <MemberProfileTrigger memberId={user.member}>
            <LinearFace user={user} />
          </MemberProfileTrigger>
          <span className="min-w-0 truncate">{user.name}</span>
        </span>
      }
      description={subtitle}
      className={user.active ? undefined : 'opacity-60'}
    >
      <div className="grid gap-2">
        <Select
          value={user.member ?? NOBODY}
          disabled={!canAdminister || link.isPending}
          onValueChange={(next) => {
            setError(undefined)
            link.mutate(
              { linearUserId: user.linearId, member: next === NOBODY ? null : (next as UserId) },
              { onError: (failure) => setError(failure.message) }
            )
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="None" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NOBODY}>
              <span className="text-muted-foreground">None</span>
            </SelectItem>
            {members.map((member) => (
              <SelectItem key={member.id} value={member.id}>
                <span className="flex items-center gap-2">
                  <EntityAvatar
                    memberId={member.id}
                    kind="user"
                    size="sm"
                    name={member.name}
                    avatar={member.avatar}
                  />
                  <span className="truncate">{member.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {error === undefined ? null : <p className="text-xs text-destructive">{error}</p>}
      </div>
    </SettingsRow>
  )
}

/**
 * The mapping table (D15). It is the workspace's people, not Taut's, so the list
 * is whatever the last sync brought across — including people who have left,
 * greyed out, because they still wrote half the tickets.
 */
function PeopleCard({ canAdminister }: { canAdminister: boolean }) {
  const users = useLinearUsers()
  const members = useMembers()

  const people = users.data?.items ?? []
  const humans = React.useMemo(
    () =>
      (members.data?.items ?? [])
        .map((member) => member.user)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [members.data]
  )

  return (
    <SettingsCard
      title="People"
      description="Who each person in Linear is here. Agents working in Linear on your behalf resolve names through this table, so a ticket assigned to a Taut member lands on the right Linear account."
    >
      {users.isPending ? (
        <div className="px-6 py-5">
          <Skeleton className="h-10 rounded-lg" />
        </div>
      ) : people.length === 0 ? (
        <div className="px-6 py-5 text-sm text-muted-foreground">
          Nobody yet. Sync brings the workspace&rsquo;s people across; if the list stays empty, the
          API key cannot read the member directory.
        </div>
      ) : (
        people.map((user) => (
          <PersonRow
            key={user.linearId}
            user={user}
            members={humans}
            canAdminister={canAdminister}
          />
        ))
      )}
      {canAdminister || users.isPending ? null : (
        <div className="px-6 py-4 text-xs text-muted-foreground">
          Mapping people is owner and admin only.
        </div>
      )}
    </SettingsCard>
  )
}

function LinearSettingsRoute() {
  const connection = useLinearConnection()
  const canAdminister = useCanAdminister()
  const disconnect = useDisconnectLinear()

  const [disconnecting, setDisconnecting] = React.useState(false)
  const connected = connection.data?.state === 'connected'

  return (
    <>
      <PageHeader
        title="Linear"
        description="Where this company's projects come from."
        icon={<SquareKanbanIcon className="size-4" />}
      />
      <PageBody>
        <SettingsShell nav={<WorkspaceSettingsNav />}>
          <SettingsCallout
            variant="default"
            icon={<InfoIcon />}
            title="Projects are a mirror, not a copy you can edit."
            description="Taut reads Linear and shows what it finds. Renaming, closing or creating a project happens in Linear; the next sync brings it across."
          />

          <div className="grid gap-6">
            {connection.isPending ? (
              <Skeleton className="h-48 rounded-xl" />
            ) : connected ? (
              <>
                <ConnectedCard
                  canAdminister={canAdminister}
                  onDisconnect={() => setDisconnecting(true)}
                />
                <PeopleCard canAdminister={canAdminister} />
              </>
            ) : (
              <ConnectCard canAdminister={canAdminister} />
            )}
          </div>

          <ConfirmDialog
            open={disconnecting}
            onOpenChange={setDisconnecting}
            title="Disconnect Linear?"
            confirmLabel="Disconnect"
            pending={disconnect.isPending}
            description={
              <>
                <p className="text-destructive">
                  Every mirrored project disappears from Taut, and the sidebar group goes with it.
                </p>
                <p>
                  Nothing changes in Linear. Paste a key again later and the projects come straight
                  back.
                </p>
              </>
            }
            onConfirm={() =>
              disconnect.mutate(undefined, { onSuccess: () => setDisconnecting(false) })
            }
          />
        </SettingsShell>
      </PageBody>
    </>
  )
}

export const Route = createFileRoute('/_app/settings/linear')({
  component: LinearSettingsRoute
})
