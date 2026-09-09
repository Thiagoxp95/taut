import * as React from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  HashIcon,
  LayersIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  TrashIcon,
  UsersIcon
} from 'lucide-react'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import type { DepartmentShape } from '@taut/contract'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CreateChannelDialog } from '@/components/create-channel-dialog'
import { DepartmentShapePicker, autoTrait } from '@/components/department-shape-picker'
import { EmptyState, PageBody, PageHeader } from '@/components/page'
import { EntityAvatar } from '@/components/entity-avatar'
import { MemberPicker, MemberSelect } from '@/components/member-picker'
import {
  DangerZone,
  InputAffix,
  SettingsCard,
  SettingsPanel,
  SettingsRow,
  SettingsSave,
  SettingsTab,
  SettingsTabs,
  affixInputClass
} from '@/components/settings'
import { useChannelGroups, useLookupMember } from '@/hooks/use-directory'
import {
  useAddDepartmentMember,
  useDeleteChannel,
  useDeleteDepartment,
  useDepartment,
  useDepartments,
  useRemoveDepartmentMember,
  useSetDepartmentHead,
  useUpdateDepartment
} from '@/lib/api'
import { slugify } from '@/lib/format'
import { parseDepartmentId } from '@/lib/ids'

function DepartmentSettingsRoute() {
  const { departmentId: raw } = Route.useParams()
  const navigate = useNavigate()
  const departmentId = parseDepartmentId(raw)
  const detail = useDepartment(departmentId)
  const departments = useDepartments()
  const { byDepartment } = useChannelGroups()
  const lookup = useLookupMember()

  const updateDepartment = useUpdateDepartment()
  const deleteDepartment = useDeleteDepartment()
  const setHead = useSetDepartmentHead()
  const addMember = useAddDepartmentMember()
  const removeMember = useRemoveDepartmentMember()
  const deleteChannel = useDeleteChannel()

  const [tab, setTab] = React.useState('general')
  const [creatingChannel, setCreatingChannel] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [name, setName] = React.useState<string | null>(null)
  const [slug, setSlug] = React.useState<string | null>(null)
  // `null` is a pending "back to auto", which is a different edit from "unedited".
  const [shape, setShape] = React.useState<DepartmentShape | null | undefined>(undefined)

  const department = detail.data?.department
  const members = detail.data?.members ?? []
  const channels = departmentId === undefined ? [] : (byDepartment.get(departmentId) ?? [])

  if (departmentId === undefined || (detail.isFetched && department === undefined)) {
    return (
      <>
        <PageHeader title="Department" description={raw} />
        <PageBody>
          <EmptyState
            icon={<LayersIcon className="size-5" />}
            title="Department not found"
            description="It may have been removed, or you do not have access to it."
          />
        </PageBody>
      </>
    )
  }

  if (department === undefined) {
    return (
      <>
        <PageHeader title="Department" description="Loading…" />
        <PageBody />
      </>
    )
  }

  const effectiveName = name ?? department.name
  const effectiveSlug = slug ?? department.slug
  const effectiveShape = shape === undefined ? department.shape : (shape ?? undefined)
  const dirty =
    effectiveName !== department.name ||
    effectiveSlug !== department.slug ||
    effectiveShape !== department.shape
  const present = new Set(members.map((member) => member.memberId))

  const resetDetails = (): void => {
    setName(null)
    setSlug(null)
    setShape(undefined)
  }

  const saveDetails = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!dirty) return
    updateDepartment.mutate(
      {
        departmentId: department.id,
        name: effectiveName,
        slug: effectiveSlug,
        shape: effectiveShape ?? null
      },
      { onSuccess: resetDetails }
    )
  }

  return (
    <>
      <PageHeader
        title={`${department.name} settings`}
        description="The department head manages members, channels and agents."
        icon={<LayersIcon className="size-4" />}
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
              <SettingsTab value="channels" icon={<HashIcon />}>
                Channels
              </SettingsTab>
              <SettingsTab value="members" icon={<UsersIcon />}>
                Members
              </SettingsTab>
              <SettingsTab value="danger" icon={<TrashIcon />}>
                Delete
              </SettingsTab>
            </>
          }
        >
          <SettingsPanel value="general">
            <SettingsCard
              title="Details"
              description="What this department is called and who runs it."
              onSubmit={saveDetails}
              footer={
                <SettingsSave
                  dirty={dirty}
                  pending={updateDepartment.isPending}
                  onCancel={resetDetails}
                />
              }
            >
              <SettingsRow
                label="Name"
                description="Shown in the sidebar and on every channel this department owns."
                htmlFor="dept-name"
              >
                <Input
                  id="dept-name"
                  value={effectiveName}
                  onChange={(event) => setName(event.target.value)}
                />
              </SettingsRow>

              <SettingsRow
                label="Slug"
                description="Used in URLs and as the folder name on disk."
                htmlFor="dept-slug"
              >
                <InputAffix prefix="/">
                  <Input
                    id="dept-slug"
                    value={effectiveSlug}
                    onChange={(event) => setSlug(slugify(event.target.value))}
                    className={`${affixInputClass} font-mono text-xs`}
                  />
                </InputAffix>
              </SettingsRow>

              <SettingsRow
                label="Head"
                description="Heads are humans. They manage this department's members and channels."
                htmlFor="dept-head"
              >
                <MemberSelect
                  value={department.headUserId}
                  only="user"
                  placeholder="Pick a head"
                  onSelect={(member) => {
                    if (member.memberKind === 'user') {
                      setHead.mutate({
                        departmentId: department.id,
                        headUserId: member.memberId
                      })
                    }
                  }}
                />
              </SettingsRow>

              <SettingsRow
                label="Agent shape"
                description="The silhouette every agent in this department wears. Auto takes whichever is still free."
                stacked
              >
                <DepartmentShapePicker
                  value={effectiveShape}
                  seed={effectiveSlug}
                  auto={autoTrait(departments.data?.items ?? [], department.id)}
                  onChange={(next) => setShape(next ?? null)}
                />
              </SettingsRow>
            </SettingsCard>
          </SettingsPanel>

          <SettingsPanel value="channels">
            <SettingsCard
              title="Channels"
              description="Channels that belong to this department."
              action={
                <Button size="sm" variant="outline" onClick={() => setCreatingChannel(true)}>
                  <PlusIcon />
                  Add channel
                </Button>
              }
            >
              {channels.length === 0 ? (
                <div className="px-6 py-5">
                  <EmptyState
                    icon={<HashIcon className="size-5" />}
                    title="No channels"
                    description="Create the first channel so this department has somewhere to talk."
                    action={
                      <Button onClick={() => setCreatingChannel(true)}>Create a channel</Button>
                    }
                  />
                </div>
              ) : (
                channels.map((channel) => (
                  <div key={channel.id} className="flex items-center gap-3 px-6 py-3">
                    <HashIcon className="size-4 shrink-0 text-muted-foreground" />
                    <Link
                      to="/c/$channelId"
                      params={{ channelId: channel.id }}
                      className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
                    >
                      {channel.name}
                    </Link>
                    <Button asChild size="sm" variant="ghost">
                      <Link to="/channels/$channelId/settings" params={{ channelId: channel.id }}>
                        Configure
                      </Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete #${channel.name}`}
                      onClick={() => deleteChannel.mutate(channel.id)}
                    >
                      <TrashIcon />
                    </Button>
                  </div>
                ))
              )}
            </SettingsCard>
          </SettingsPanel>

          <SettingsPanel value="members">
            <SettingsCard
              title="Members"
              description={`${members.length} humans and agents.`}
              action={
                <MemberPicker
                  exclude={present}
                  onSelect={(member) =>
                    addMember.mutate({ departmentId: department.id, ...member })
                  }
                />
              }
            >
              {members.length === 0 ? (
                <div className="px-6 py-5">
                  <EmptyState
                    icon={<UsersIcon className="size-5" />}
                    title="No members"
                    description="Add the people and agents who belong to this department."
                  />
                </div>
              ) : (
                members.map((member) => {
                  const entry = lookup(member.memberId)
                  return (
                    <div
                      key={`${member.memberKind}:${member.memberId}`}
                      className="flex items-center gap-3 px-6 py-3"
                    >
                      <EntityAvatar
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
                        {member.memberId === department.headUserId
                          ? 'Head'
                          : (entry?.subtitle ?? member.memberKind)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${entry?.name ?? 'member'}`}
                        onClick={() =>
                          removeMember.mutate({
                            departmentId: department.id,
                            memberKind: member.memberKind,
                            memberId: member.memberId
                          })
                        }
                      >
                        <TrashIcon />
                      </Button>
                    </div>
                  )
                })
              )}
            </SettingsCard>
          </SettingsPanel>

          <SettingsPanel value="danger">
            <DangerZone>
              <SettingsRow
                label={`Delete ${department.name}`}
                description="Its channels and the membership of everyone in it go with it. Messages already written stay readable in the channels that survive."
              >
                <Button variant="destructive" onClick={() => setDeleting(true)}>
                  <TrashIcon />
                  Delete department
                </Button>
              </SettingsRow>
            </DangerZone>
          </SettingsPanel>
        </SettingsTabs>
      </PageBody>

      <CreateChannelDialog
        open={creatingChannel}
        onOpenChange={setCreatingChannel}
        departmentId={department.id}
        departmentName={department.name}
      />

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${department.name}?`}
        confirmLabel="Delete this department"
        pending={deleteDepartment.isPending}
        description={
          <p>
            Its channels are removed and every agent in it loses the silhouette it wore. This cannot
            be undone.
          </p>
        }
        onConfirm={() =>
          deleteDepartment.mutate(department.id, {
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

export const Route = createFileRoute('/_app/departments/$departmentId/settings')({
  component: DepartmentSettingsRoute
})
