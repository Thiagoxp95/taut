import * as React from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  HashIcon,
  LayersIcon,
  MessagesSquareIcon,
  SlidersHorizontalIcon,
  TrashIcon,
  UsersIcon
} from '@taut/ui/components/icons'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState, PageBody, PageHeader, ReadOnlyNote } from '@/components/page'
import { EntityAvatar } from '@/components/entity-avatar'
import { MemberPicker } from '@/components/member-picker'
import {
  DangerZone,
  InputAffix,
  SettingsCallout,
  SettingsCard,
  SettingsPanel,
  SettingsRow,
  SettingsSave,
  SettingsTab,
  SettingsTabs,
  affixInputClass
} from '@/components/settings'
import { useChannel, useDepartmentList, useLookupMember } from '@/hooks/use-directory'
import {
  useAddChannelMember,
  useCanAdminister,
  useChannelMembers,
  useDeleteChannel,
  useRemoveChannelMember,
  useUpdateChannel
} from '@/lib/api'
import { formatRelative } from '@/lib/format'

/**
 * Channel configuration. A channel carries less than an agent or a department
 * does — a name, who is in it, and whether it still takes messages — so the rail
 * is short, but it is the same rail, the same cards and the same footer.
 */
function ChannelSettingsRoute() {
  const { channelId } = Route.useParams()
  const navigate = useNavigate()
  const channel = useChannel(channelId)
  const { departments } = useDepartmentList()
  const members = useChannelMembers(channel?.id)
  const lookup = useLookupMember()
  const canManage = useCanAdminister()

  const updateChannel = useUpdateChannel()
  const deleteChannel = useDeleteChannel()
  const addMember = useAddChannelMember()
  const removeMember = useRemoveChannelMember()

  const [tab, setTab] = React.useState('general')
  const [name, setName] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState(false)

  const items = members.data?.items ?? []
  const present = new Set(items.map((member) => member.memberId))

  if (channel === undefined) {
    return (
      <>
        <PageHeader title="Channel" description={channelId} />
        <PageBody>
          <EmptyState
            icon={<HashIcon className="size-5" />}
            title="Channel not found"
            description="It may have been deleted, or you are not a member of it."
            action={
              <Button asChild size="sm" variant="outline">
                <Link to="/">Back to Taut</Link>
              </Button>
            }
          />
        </PageBody>
      </>
    )
  }

  const department = departments.find((entry) => entry.id === channel.departmentId)
  const archived = channel.archivedAt !== undefined
  const effectiveName = name ?? channel.name
  const dirty = name !== null && effectiveName.trim() !== channel.name

  const save = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!dirty) return
    updateChannel.mutate(
      { channelId: channel.id, name: effectiveName.trim() },
      { onSuccess: () => setName(null) }
    )
  }

  return (
    <>
      <PageHeader
        title={`#${channel.name} settings`}
        description={
          department === undefined
            ? 'Channel'
            : `In ${department.name}. Members see everything in it.`
        }
        icon={<HashIcon className="size-4" />}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/c/$channelId" params={{ channelId: channel.id }}>
              <MessagesSquareIcon />
              Open channel
            </Link>
          </Button>
        }
      />
      <PageBody>
        <SettingsTabs
          value={tab}
          onValueChange={setTab}
          nav={
            <>
              <SettingsTab value="general" icon={<SlidersHorizontalIcon />}>
                General
              </SettingsTab>
              <SettingsTab value="members" icon={<UsersIcon />}>
                Members
              </SettingsTab>
              {canManage ? (
                <SettingsTab value="danger" icon={<TrashIcon />}>
                  Delete
                </SettingsTab>
              ) : null}
            </>
          }
        >
          <SettingsPanel value="general">
            {archived ? (
              <SettingsCallout
                icon={<HashIcon />}
                title={`#${channel.name} is archived.`}
                description="Its history stays readable. Nothing new can be posted in it."
              />
            ) : null}

            <SettingsCard
              title="Channel"
              description="What this channel is called and where it lives."
              onSubmit={save}
              footer={
                canManage ? (
                  <SettingsSave
                    dirty={dirty}
                    pending={updateChannel.isPending}
                    onCancel={() => setName(null)}
                  />
                ) : (
                  <ReadOnlyNote />
                )
              }
            >
              <SettingsRow
                label="Name"
                description="Shown in the sidebar and in every mention of this channel."
                htmlFor="channel-name"
              >
                <InputAffix prefix="#">
                  <Input
                    id="channel-name"
                    readOnly={!canManage}
                    value={effectiveName}
                    onChange={(event) => setName(event.target.value)}
                    className={affixInputClass}
                  />
                </InputAffix>
              </SettingsRow>

              <SettingsRow
                label="Department"
                badge={<Badge variant="outline">Fixed</Badge>}
                description="A channel belongs to the department that created it. Create a new channel to move the conversation."
              >
                {department === undefined ? (
                  <p className="text-sm text-muted-foreground">
                    {channel.kind === 'dm' ? 'A direct message.' : 'No department.'}
                  </p>
                ) : (
                  <Button asChild variant="outline" className="w-fit">
                    <Link
                      to="/departments/$departmentId/settings"
                      params={{ departmentId: department.id }}
                    >
                      <LayersIcon />
                      {department.name}
                    </Link>
                  </Button>
                )}
              </SettingsRow>

              <SettingsRow
                label="Kind"
                description="Channels are open to their members; a direct message has exactly two sides."
              >
                <Badge variant="secondary" className="w-fit">
                  {channel.kind}
                </Badge>
              </SettingsRow>

              <SettingsRow label="Created" description="When this channel was opened.">
                <p className="text-sm text-muted-foreground">{formatRelative(channel.createdAt)}</p>
              </SettingsRow>
            </SettingsCard>
          </SettingsPanel>

          <SettingsPanel value="members">
            <SettingsCard
              title="Members"
              description={`${items.length} ${items.length === 1 ? 'member' : 'members'}. Agents only see channels they belong to.`}
              action={
                canManage ? (
                  <MemberPicker
                    exclude={present}
                    onSelect={(member) => addMember.mutate({ channelId: channel.id, ...member })}
                  />
                ) : undefined
              }
            >
              {items.length === 0 ? (
                <div className="px-6 py-5">
                  <EmptyState
                    icon={<UsersIcon className="size-5" />}
                    title="No members yet"
                    description="Add the people and agents who should see this channel."
                  />
                </div>
              ) : (
                items.map((member) => {
                  const entry = lookup(member.memberId)
                  return (
                    <div key={member.memberId} className="flex items-center gap-3 px-6 py-3">
                      <EntityAvatar
                        memberId={member.memberId}
                        avatar={entry?.avatar ?? { kind: 'emoji', value: '👤' }}
                        kind={member.memberKind}
                        face={entry?.face}
                        name={entry?.name ?? member.memberId}
                        size="md"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {entry?.name ?? member.memberId}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {entry?.subtitle ?? member.memberKind}
                      </span>
                      {canManage ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${entry?.name ?? 'member'}`}
                          onClick={() =>
                            removeMember.mutate({
                              channelId: channel.id,
                              memberKind: member.memberKind,
                              memberId: member.memberId
                            })
                          }
                        >
                          <TrashIcon />
                        </Button>
                      ) : null}
                    </div>
                  )
                })
              )}
            </SettingsCard>
          </SettingsPanel>

          {canManage ? (
            <SettingsPanel value="danger">
              <DangerZone>
                <SettingsRow
                  label={`Delete #${channel.name}`}
                  description="Every message in it goes with it, for everyone. Nothing here can bring them back."
                >
                  <Button variant="destructive" onClick={() => setDeleting(true)}>
                    <TrashIcon />
                    Delete channel
                  </Button>
                </SettingsRow>
              </DangerZone>
            </SettingsPanel>
          ) : null}
        </SettingsTabs>
      </PageBody>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete #${channel.name}?`}
        confirmLabel="Delete this channel"
        pending={deleteChannel.isPending}
        description={
          <p>
            The channel and every message written in it are removed for everyone. This cannot be
            undone.
          </p>
        }
        onConfirm={() =>
          deleteChannel.mutate(channel.id, {
            onSuccess: () => {
              setDeleting(false)
              void navigate({ to: '/' })
            }
          })
        }
      />
    </>
  )
}

export const Route = createFileRoute('/_app/channels/$channelId/settings')({
  component: ChannelSettingsRoute
})
