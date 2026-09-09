import * as React from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  ChevronLeftIcon,
  CircleSlashIcon,
  FolderGitIcon,
  FolderIcon,
  GlobeIcon,
  KeyRoundIcon,
  MessageSquareIcon,
  PlusIcon,
  ScrollTextIcon,
  ServerIcon,
  SparklesIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  TerminalIcon,
  TrashIcon,
  TimerIcon,
  UserIcon,
  XIcon
} from 'lucide-react'
import type {
  AgentId,
  Department,
  PermissionMode,
  RuntimeKind,
  SubscriptionId,
  VaultItemMeta
} from '@taut/contract'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { Switch } from '@taut/ui/components/switch'
import { Textarea } from '@taut/ui/components/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { Dialog, DialogContent } from '@taut/ui/components/dialog'
import { AddSecretForm } from '@/components/add-secret-form'
import { AgentFilesTab } from '@/components/agent-files'
import { AgentReposTab } from '@/components/agent-repos'
import { AgentRoutinesTab } from '@/components/agent-routines'
import { AgentWorkspaceTab } from '@/components/agent-workspace'
import { AgentSkillsTab } from '@/components/agent-skills'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EntityAvatar } from '@/components/entity-avatar'
import { Markdown } from '@/components/markdown'
import { ModelSelect } from '@/components/model-select'
import { EmptyState, PageBody, PageHeader, ReadOnlyNote } from '@/components/page'
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
import { PresenceDot, presenceLabel } from '@/components/presence-dot'
import { TaskStatusBadge, isLiveTask } from '@/components/task-status'
import { useAgentDepartments, useDepartmentList, useDepartmentShapes } from '@/hooks/use-directory'
import { agentAvatarSeed, shapeOfAgent, type AgentFace } from '@/lib/agent-avatar'
import {
  useAddDepartmentMember,
  useAgent,
  useCanAdminister,
  useCancelTask,
  useDeleteAgent,
  useMe,
  useOpenDm,
  useRemoveDepartmentMember,
  useRevokeVaultItem,
  useSubscriptions,
  useTasks,
  useUpdateAgent,
  useVaultItems
} from '@/lib/api'
import { formatRelative, toIso } from '@/lib/format'
import { parseAgentId, parseDepartmentId, parseSubscriptionId } from '@/lib/ids'
import { usePresence } from '@/lib/live'
import { CREDENTIAL_LABELS, isRuntimeKind, RUNTIME_LABELS } from '@/lib/runtime-meta'

// --- profile --------------------------------------------------------------

function DepartmentMembership({
  agentId,
  memberOf,
  canManage
}: {
  agentId: string
  memberOf: readonly Department[]
  canManage: boolean
}) {
  const { departments } = useDepartmentList()
  const addMember = useAddDepartmentMember()
  const removeMember = useRemoveDepartmentMember()
  const [picked, setPicked] = React.useState('none')

  const joined = new Set(memberOf.map((department) => department.id))
  const available = departments.filter((department) => !joined.has(department.id))
  const parsedAgentId = parseAgentId(agentId)

  return (
    <SettingsRow
      label="Departments"
      description="Joining a department adds the agent to its channels; its head is the human it reports to."
    >
      {memberOf.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Not in any department yet — nobody can @mention it in a department channel.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {memberOf.map((department) => (
            <span
              key={department.id}
              className="flex items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-2.5 text-xs"
            >
              {department.name}
              <button
                type="button"
                aria-label={`Remove from ${department.name}`}
                hidden={!canManage}
                disabled={removeMember.isPending || parsedAgentId === undefined}
                onClick={() => {
                  if (parsedAgentId === undefined) return
                  removeMember.mutate({
                    departmentId: department.id,
                    memberKind: 'agent',
                    memberId: parsedAgentId
                  })
                }}
                className="flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-background hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {available.length === 0 || !canManage ? null : (
        <div className="flex gap-2">
          <Select value={picked} onValueChange={setPicked}>
            <SelectTrigger size="sm" className="flex-1" aria-label="Department to join">
              <SelectValue placeholder="Add to a department" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Add to a department…</SelectItem>
              {available.map((department) => (
                <SelectItem key={department.id} value={department.id}>
                  {department.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={picked === 'none' || addMember.isPending || parsedAgentId === undefined}
            onClick={() => {
              const departmentId = parseDepartmentId(picked)
              if (departmentId === undefined || parsedAgentId === undefined) return
              addMember.mutate(
                { departmentId, memberKind: 'agent', memberId: parsedAgentId },
                { onSuccess: () => setPicked('none') }
              )
            }}
          >
            <PlusIcon />
            Add
          </Button>
        </div>
      )}
    </SettingsRow>
  )
}

// --- agent vault -----------------------------------------------------------

/** The agent's own vault: items nobody else in the company can resolve. */
function AgentVaultTab({ agentId }: { agentId: AgentId }) {
  const query = useVaultItems(agentId)
  const revokeItem = useRevokeVaultItem()
  const [adding, setAdding] = React.useState(false)
  const [revoking, setRevoking] = React.useState<VaultItemMeta | null>(null)

  const items = query.data?.items ?? []

  return (
    <SettingsCard
      title="Agent vault"
      description="Secrets only this agent may resolve. Every resolve is appended to its audit log."
      action={
        <Button size="sm" onClick={() => setAdding(true)}>
          <PlusIcon />
          Add secret
        </Button>
      }
    >
      <p className="px-6 py-4 text-sm text-muted-foreground">
        These secrets are private to this agent; secrets every agent may use live in the{' '}
        <Link to="/vault" className="underline underline-offset-2">
          company vault
        </Link>
        .
      </p>

      {query.isPending ? null : items.length === 0 ? (
        <div className="px-6 py-5">
          <EmptyState
            icon={<KeyRoundIcon className="size-5" />}
            title="No secrets of its own"
            description="It can already use every company secret. Add one here only if it should be the only agent holding it."
            action={
              <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                Add a secret
              </Button>
            }
          />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Label</th>
                <th className="px-4 py-2.5 text-left font-medium">Kind</th>
                <th className="px-4 py-2.5 text-left font-medium">Hint</th>
                <th className="px-4 py-2.5 text-left font-medium">Created</th>
                <th className="px-4 py-2.5 text-left font-medium">Last used</th>
                <th className="w-10 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((item) => (
                <tr key={item.id} className="transition-colors hover:bg-muted/40">
                  <td className="px-4 py-3 font-medium">{item.label}</td>
                  <td className="px-4 py-3">
                    <Badge variant="outline">{CREDENTIAL_LABELS[item.kind]}</Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    ••••{item.hint}
                  </td>
                  <td
                    className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground"
                    title={toIso(item.createdAt)}
                  >
                    {formatRelative(item.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground">
                    {item.lastUsedAt === undefined ? 'never' : formatRelative(item.lastUsedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Revoke ${item.label}`}
                      onClick={() => setRevoking(item)}
                    >
                      <TrashIcon />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <AddSecretForm agentId={agentId} onDone={() => setAdding(false)} />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(next) => {
          if (!next) setRevoking(null)
        }}
        title={`Revoke ${revoking?.label ?? 'this secret'}?`}
        confirmLabel="Revoke"
        pending={revokeItem.isPending}
        description={
          <p>
            The ciphertext is deleted and any task currently resolving it is cancelled. This cannot
            be undone — you would have to paste the secret again.
          </p>
        }
        onConfirm={() => {
          if (revoking === null) return
          revokeItem.mutate(revoking.id, { onSuccess: () => setRevoking(null) })
        }}
      />
    </SettingsCard>
  )
}

// --- route ----------------------------------------------------------------

function AgentRoute() {
  const { agentId: raw } = Route.useParams()
  const agentId = parseAgentId(raw)
  const navigate = useNavigate()

  const detail = useAgent(agentId)
  const subscriptions = useSubscriptions().data?.items ?? []
  const tasks = useTasks(agentId === undefined ? {} : { agentId })
  const memberOf = useAgentDepartments(detail.data?.agent)
  const departmentShapes = useDepartmentShapes()

  /**
   * Who may manage this agent, matching the server: company admin+, or the
   * human head of a department the agent belongs to. Everyone else reads it,
   * DMs it, and drops files in its inbox.
   */
  const myUserId = useMe().data?.user.id
  const canManage =
    useCanAdminister() || memberOf.some((department) => department.headUserId === myUserId)

  const updateAgent = useUpdateAgent()
  const deleteAgent = useDeleteAgent()
  const cancelTask = useCancelTask()
  const openDm = useOpenDm()

  const [profile, setProfile] = React.useState<{
    name: string
    role: string
  } | null>(null)
  const [mandate, setMandate] = React.useState<string | null>(null)
  const [mandatePreview, setMandatePreview] = React.useState(false)
  const [runtime, setRuntime] = React.useState<{
    runtimeKind: RuntimeKind
    pinned: string
    model: string
    permissionMode: PermissionMode
    browserAccess: boolean
  } | null>(null)
  const [deleting, setDeleting] = React.useState(false)
  // Controlled so the Workspace tab can send the viewer to Files (workspace D1).
  const [tab, setTab] = React.useState('profile')

  const agent = detail.data?.agent
  const archived = agent?.archivedAt !== undefined
  const presence = usePresence(agentId, 'idle')

  if (agentId === undefined || (detail.isFetched && agent === undefined)) {
    return (
      <>
        <PageHeader title="Agent" description={raw} />
        <PageBody>
          <EmptyState
            icon={<SparklesIcon className="size-5" />}
            title="Agent not found"
            description="It may have been deleted, or it belongs to another company."
            action={
              <Button asChild size="sm" variant="outline">
                <Link to="/agents">Back to agents</Link>
              </Button>
            }
          />
        </PageBody>
      </>
    )
  }

  if (agent === undefined) {
    return (
      <>
        <PageHeader title="Agent" description="Loading…" />
        <PageBody />
      </>
    )
  }

  const skills = detail.data?.skills ?? []
  const fileGrants = detail.data?.fileGrants ?? []
  const repoGrants = detail.data?.repoGrants ?? []

  const profileForm = profile ?? { name: agent.name, role: agent.role }
  // Redrawn as the form changes, because name and role are part of the seed.
  // The silhouette is the agent's first department and does not follow the form
  // — membership is edited below, not here.
  const avatarFace: AgentFace = {
    seed: agentAvatarSeed({
      handle: agent.handle,
      name: profileForm.name.trim(),
      role: profileForm.role.trim()
    }),
    shape: shapeOfAgent(agent, departmentShapes)
  }
  const mandateValue = mandate ?? agent.mandate
  const runtimeForm = runtime ?? {
    runtimeKind: agent.runtimeKind,
    pinned: agent.pinnedSubscriptionId ?? 'none',
    model: agent.model ?? '',
    permissionMode: agent.permissionMode,
    browserAccess: agent.browserAccess
  }
  const pinnable = subscriptions.filter((entry) => entry.runtime === runtimeForm.runtimeKind)
  const recentTasks = tasks.data?.items ?? []
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {agent.name}
            <span className="font-normal text-muted-foreground">@{agent.handle}</span>
            {agent.status === 'paused' ? <Badge variant="outline">paused</Badge> : null}
            <Badge variant="secondary" className="font-normal">
              {RUNTIME_LABELS[agent.runtimeKind]}
            </Badge>
            {agent.browserAccess ? (
              <Badge variant="secondary" className="gap-1 font-normal" title="Browser access is on">
                <GlobeIcon className="size-3" />
                Browser
              </Badge>
            ) : null}
          </span>
        }
        description={`${agent.role || 'No role set'} · ${presenceLabel(presence)}`}
        icon={<EntityAvatar kind="agent" face={avatarFace} name={agent.name} size="md" />}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link to="/agents">
                <ChevronLeftIcon />
                All agents
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                openDm.mutate(
                  { memberKind: 'agent', memberId: agent.id },
                  {
                    onSuccess: (channel) =>
                      void navigate({ to: '/dm/$channelId', params: { channelId: channel.id } })
                  }
                )
              }
            >
              <MessageSquareIcon />
              Message
            </Button>
            {canManage ? (
              <Button
                size="sm"
                variant={agent.status === 'active' ? 'outline' : 'default'}
                disabled={updateAgent.isPending}
                onClick={() =>
                  updateAgent.mutate({
                    agentId: agent.id,
                    status: agent.status === 'active' ? 'paused' : 'active'
                  })
                }
              >
                {agent.status === 'active' ? 'Pause' : 'Resume'}
              </Button>
            ) : null}
          </>
        }
      />

      <PageBody>
        <SettingsTabs
          value={tab}
          onValueChange={setTab}
          nav={
            <>
              <SettingsTab value="profile" icon={<UserIcon />}>
                Profile
              </SettingsTab>
              <SettingsTab value="mandate" icon={<ScrollTextIcon />}>
                Mandate
              </SettingsTab>
              <SettingsTab value="skills" icon={<SparklesIcon />}>
                Skills
              </SettingsTab>
              <SettingsTab value="repositories" icon={<FolderGitIcon />}>
                Repositories
              </SettingsTab>
              <SettingsTab value="routines" icon={<TimerIcon />}>
                Routines
              </SettingsTab>
              <SettingsTab value="files" icon={<FolderIcon />}>
                Files
              </SettingsTab>
              {canManage ? (
                <SettingsTab value="workspace" icon={<TerminalIcon />}>
                  Workspace
                </SettingsTab>
              ) : null}
              {canManage ? (
                <SettingsTab value="vault" icon={<KeyRoundIcon />}>
                  Agent vault
                </SettingsTab>
              ) : null}
              <SettingsTab value="runtime" icon={<ServerIcon />}>
                Runtime
              </SettingsTab>
              {canManage ? (
                <SettingsTab value="danger" icon={<ArchiveIcon />}>
                  Archive
                </SettingsTab>
              ) : null}
            </>
          }
        >
          {/* --- profile --- */}
          <SettingsPanel value="profile">
            {archived ? (
              <SettingsCallout
                icon={<ArchiveIcon />}
                title={`@${agent.handle} is archived.`}
                description="It answers nothing until you bring it back."
                action={
                  canManage ? (
                    <Button
                      size="sm"
                      disabled={updateAgent.isPending}
                      onClick={() => updateAgent.mutate({ agentId: agent.id, archived: false })}
                    >
                      <ArchiveRestoreIcon />
                      Unarchive
                    </Button>
                  ) : undefined
                }
              />
            ) : null}

            <SettingsCard
              title="Agent profile"
              description="Who this agent is to everyone in the workspace."
              onSubmit={(event) => {
                event.preventDefault()
                updateAgent.mutate(
                  {
                    agentId: agent.id,
                    name: profileForm.name.trim(),
                    role: profileForm.role.trim()
                  },
                  { onSuccess: () => setProfile(null) }
                )
              }}
              footer={
                canManage ? (
                  <SettingsSave
                    dirty={profile !== null}
                    pending={updateAgent.isPending}
                    onCancel={() => setProfile(null)}
                  />
                ) : (
                  <ReadOnlyNote />
                )
              }
            >
              <SettingsRow
                label="Face"
                description="Drawn from the handle, name and role, and shaped by the agent's first department."
              >
                <EntityAvatar kind="agent" face={avatarFace} name={profileForm.name} size="xl" />
              </SettingsRow>

              <SettingsRow
                label="Handle"
                badge={<Badge variant="outline">Fixed</Badge>}
                description="Unique within the company and set at creation. It is what people type to @mention it."
                htmlFor="handle"
              >
                <InputAffix prefix="@">
                  <Input
                    id="handle"
                    readOnly
                    value={agent.handle}
                    className={`${affixInputClass} font-mono`}
                  />
                </InputAffix>
              </SettingsRow>

              <SettingsRow
                label="Name"
                description="Shown on every message it writes."
                htmlFor="name"
              >
                <Input
                  id="name"
                  readOnly={!canManage}
                  value={profileForm.name}
                  onChange={(event) => setProfile({ ...profileForm, name: event.target.value })}
                />
              </SettingsRow>

              <SettingsRow
                label="Role"
                description="The job title shown in the member list."
                htmlFor="role"
              >
                <Input
                  id="role"
                  readOnly={!canManage}
                  value={profileForm.role}
                  onChange={(event) => setProfile({ ...profileForm, role: event.target.value })}
                  placeholder="Backend engineer"
                />
              </SettingsRow>

              <SettingsRow
                label="Status"
                badge={
                  <Badge variant={agent.status === 'active' ? 'secondary' : 'outline'}>
                    {agent.status === 'active' ? 'Active' : 'Paused'}
                  </Badge>
                }
                description={
                  agent.status === 'active'
                    ? 'Answers @mentions. Presence is derived: idle with no task, working while one runs.'
                    : 'Ignores @mentions until you resume it. Nothing on disk is touched.'
                }
              >
                <div className="flex items-center gap-3">
                  <Switch
                    checked={agent.status === 'active'}
                    disabled={!canManage}
                    aria-label={agent.status === 'active' ? 'Pause the agent' : 'Resume the agent'}
                    onCheckedChange={(next) =>
                      updateAgent.mutate({
                        agentId: agent.id,
                        status: next ? 'active' : 'paused'
                      })
                    }
                  />
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    <PresenceDot presence={presence} />
                    Created {formatRelative(agent.createdAt)}
                  </span>
                </div>
              </SettingsRow>

              <DepartmentMembership agentId={agent.id} memberOf={memberOf} canManage={canManage} />
            </SettingsCard>
          </SettingsPanel>

          {/* --- mandate --- */}
          <SettingsPanel value="mandate">
            <SettingsCard
              title="Mandate"
              description="Rendered to AGENT.md in the home folder and used as the system prompt. The role is a label; this is the contract."
              action={
                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="xs"
                    variant={mandatePreview ? 'ghost' : 'secondary'}
                    onClick={() => setMandatePreview(false)}
                  >
                    Write
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant={mandatePreview ? 'secondary' : 'ghost'}
                    onClick={() => setMandatePreview(true)}
                  >
                    Preview
                  </Button>
                </div>
              }
              onSubmit={(event) => {
                event.preventDefault()
                updateAgent.mutate(
                  { agentId: agent.id, mandate: mandateValue },
                  { onSuccess: () => setMandate(null) }
                )
              }}
              footer={
                canManage ? (
                  <SettingsSave
                    dirty={mandate !== null}
                    pending={updateAgent.isPending}
                    onCancel={() => setMandate(null)}
                    cancelLabel="Discard changes"
                    label="Save mandate"
                  />
                ) : (
                  <ReadOnlyNote />
                )
              }
            >
              <div className="px-6 py-5">
                {mandatePreview ? (
                  <div className="min-h-[24rem] rounded-md border p-4">
                    <Markdown source={mandateValue} />
                  </div>
                ) : (
                  <Textarea
                    id="mandate"
                    aria-label="Mandate"
                    readOnly={!canManage}
                    rows={18}
                    value={mandateValue}
                    onChange={(event) => setMandate(event.target.value)}
                    className="font-mono text-xs"
                  />
                )}
              </div>
            </SettingsCard>
          </SettingsPanel>

          {/* --- skills --- */}
          <SettingsPanel value="skills">
            <AgentSkillsTab agentId={agent.id} skills={skills} canManage={canManage} />
          </SettingsPanel>

          {/* --- repositories (docs/build-plan-repositories.md) --- */}
          <SettingsPanel value="repositories">
            <AgentReposTab agentId={agent.id} repoGrants={repoGrants} canManage={canManage} />
          </SettingsPanel>

          {/* --- routines --- */}
          <SettingsPanel value="routines">
            <AgentRoutinesTab agentId={agent.id} agentHandle={agent.handle} canManage={canManage} />
          </SettingsPanel>

          {/* --- files --- */}
          <SettingsPanel value="files">
            <AgentFilesTab agentId={agent.id} fileGrants={fileGrants} canManage={canManage} />
          </SettingsPanel>

          {/* --- workspace (docs/build-plan-workspace.md; managers only, D3) --- */}
          {canManage ? (
            <SettingsPanel value="workspace">
              <AgentWorkspaceTab
                agent={agent}
                canManage={canManage}
                onFiles={() => setTab('files')}
              />
            </SettingsPanel>
          ) : null}

          {/* --- agent vault --- */}
          {canManage ? (
            <SettingsPanel value="vault">
              <AgentVaultTab agentId={agent.id} />
            </SettingsPanel>
          ) : null}

          {/* --- runtime --- */}
          <SettingsPanel value="runtime">
            <SettingsCard
              title="Runtime"
              description="Which engine runs this agent, on whose seat, and how much it is allowed to touch."
              onSubmit={(event) => {
                event.preventDefault()
                updateAgent.mutate(
                  {
                    agentId: agent.id,
                    runtimeKind: runtimeForm.runtimeKind,
                    permissionMode: runtimeForm.permissionMode,
                    pinnedSubscriptionId:
                      runtimeForm.pinned === 'none'
                        ? null
                        : (parseSubscriptionId(runtimeForm.pinned) ?? null),
                    model: runtimeForm.model.trim() === '' ? null : runtimeForm.model.trim(),
                    browserAccess: runtimeForm.browserAccess
                  },
                  { onSuccess: () => setRuntime(null) }
                )
              }}
              footer={
                canManage ? (
                  <SettingsSave
                    dirty={runtime !== null}
                    pending={updateAgent.isPending}
                    onCancel={() => setRuntime(null)}
                    label="Save runtime"
                  />
                ) : (
                  <ReadOnlyNote />
                )
              }
            >
              <SettingsRow
                label="Runtime kind"
                description="The engine the agent's tasks run on."
                htmlFor="runtime-kind"
              >
                <Select
                  value={runtimeForm.runtimeKind}
                  onValueChange={(next) => {
                    if (isRuntimeKind(next)) {
                      // A pinned seat belongs to the old runtime; drop it.
                      setRuntime({ ...runtimeForm, runtimeKind: next, pinned: 'none' })
                    }
                  }}
                >
                  <SelectTrigger id="runtime-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(RUNTIME_LABELS) as RuntimeKind[]).map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {RUNTIME_LABELS[kind]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsRow>

              <SettingsRow
                label="Pinned subscription"
                description={
                  pinnable.length === 0
                    ? `No ${RUNTIME_LABELS[runtimeForm.runtimeKind]} seats in the pool yet.`
                    : 'Pinned agents skip pool rotation and always run on this seat.'
                }
                htmlFor="runtime-subscription"
              >
                <Select
                  value={runtimeForm.pinned}
                  onValueChange={(next) => setRuntime({ ...runtimeForm, pinned: next })}
                >
                  <SelectTrigger id="runtime-subscription" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Rotate across the pool</SelectItem>
                    {pinnable.map((subscription) => (
                      <SelectItem key={subscription.id} value={subscription.id}>
                        {subscription.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsRow>

              <SettingsRow
                label="Model override"
                description="Wins over the subscription's default model."
                htmlFor="runtime-model"
              >
                <ModelSelect
                  id="runtime-model"
                  runtime={runtimeForm.runtimeKind}
                  {...(runtimeForm.pinned === 'none'
                    ? {}
                    : { subscriptionId: runtimeForm.pinned as SubscriptionId })}
                  value={runtimeForm.model === '' ? undefined : runtimeForm.model}
                  onValueChange={(next) => setRuntime({ ...runtimeForm, model: next ?? '' })}
                  emptyLabel="Subscription default"
                />
              </SettingsRow>

              <SettingsRow
                label="Permission mode"
                description="How much of its own machine the agent may change without asking."
                htmlFor="runtime-permission"
              >
                <Select
                  value={runtimeForm.permissionMode}
                  onValueChange={(next) => {
                    if (next === 'plan' || next === 'auto-edit') {
                      setRuntime({ ...runtimeForm, permissionMode: next })
                    }
                  }}
                >
                  <SelectTrigger id="runtime-permission" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="plan">Plan — proposes, never writes</SelectItem>
                    <SelectItem value="auto-edit">Auto-edit — writes inside its home</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsRow>

              <SettingsRow
                label="Browser access"
                description="Gives the agent a headless Chromium (Playwright MCP) inside its machine. Logins persist between tasks."
                htmlFor="runtime-browser"
              >
                <div className="flex items-center gap-3">
                  <Switch
                    id="runtime-browser"
                    checked={runtimeForm.browserAccess}
                    disabled={!canManage}
                    aria-label="Browser access"
                    onCheckedChange={(next) => setRuntime({ ...runtimeForm, browserAccess: next })}
                  />
                  <span className="text-sm text-muted-foreground">
                    {runtimeForm.browserAccess ? 'On' : 'Off'}
                  </span>
                </div>
              </SettingsRow>

              <SettingsRow
                label="Machine"
                badge={<Badge variant="outline">dev</Badge>}
                description="One long-lived box per agent, home folder as the working directory. The docker provider — one hardened container per agent — is chosen by the server, not here."
              >
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <ServerIcon className="size-4" />
                  local
                </p>
              </SettingsRow>
            </SettingsCard>

            <SettingsCard
              title="Recent tasks"
              description="Every run this agent has done, newest first."
              action={
                <Button asChild size="sm" variant="ghost">
                  <Link to="/tasks">All tasks</Link>
                </Button>
              }
            >
              {tasks.isPending ? (
                <div className="px-6 py-5" />
              ) : recentTasks.length === 0 ? (
                <div className="px-6 py-5">
                  <EmptyState
                    icon={<SparklesIcon className="size-5" />}
                    title="It has not run yet"
                    description="@mention it in a channel or send it a direct message to give it its first task."
                  />
                </div>
              ) : (
                <ul className="divide-y">
                  {recentTasks.slice(0, 10).map((task) => (
                    <li key={task.id} className="flex items-center gap-3 px-6 py-3">
                      <TaskStatusBadge status={task.status} />
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        started {formatRelative(task.startedAt)}
                        {task.error === undefined ? '' : ` · ${task.error}`}
                      </span>
                      <Button asChild size="xs" variant="ghost">
                        <Link
                          to={task.channelKind === 'dm' ? '/dm/$channelId' : '/c/$channelId'}
                          params={{ channelId: task.channelId }}
                          search={{ thread: task.threadId }}
                        >
                          Open thread
                        </Link>
                      </Button>
                      {isLiveTask(task.status) ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={cancelTask.isPending}
                          onClick={() => cancelTask.mutate(task.id)}
                        >
                          <CircleSlashIcon />
                          Cancel
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </SettingsCard>
          </SettingsPanel>

          {/* --- danger --- */}
          {canManage ? (
            <SettingsPanel value="danger">
              <DangerZone>
                <SettingsRow
                  label={archived ? `@${agent.handle} is archived` : `Archive @${agent.handle}`}
                  description={
                    archived
                      ? 'It answers nothing and its DMs are filed away. Its home folder and every message it wrote are untouched.'
                      : 'It stops answering and its direct messages are filed away. Its home folder, its messages and the threads it replied to all stay, marked archived. Pause it instead if you only want it quiet for a while.'
                  }
                >
                  {archived ? (
                    <Button
                      variant="outline"
                      disabled={updateAgent.isPending}
                      onClick={() => updateAgent.mutate({ agentId: agent.id, archived: false })}
                    >
                      <ArchiveRestoreIcon />
                      Unarchive
                    </Button>
                  ) : (
                    <Button variant="destructive" onClick={() => setDeleting(true)}>
                      <ArchiveIcon />
                      Archive agent
                    </Button>
                  )}
                </SettingsRow>
              </DangerZone>
            </SettingsPanel>
          ) : null}
        </SettingsTabs>
      </PageBody>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Archive ${agent.name}?`}
        confirmLabel="Archive this agent"
        pending={deleteAgent.isPending}
        description={
          <>
            <p>
              It stops being woken by mentions, its running tasks are cancelled, and your direct
              messages with it move to the archived list.
            </p>
            <p>
              Everything it wrote stays where it is, under its own name and face. You can unarchive
              it here at any time.
            </p>
          </>
        }
        onConfirm={() =>
          deleteAgent.mutate(agent.id, {
            onSuccess: () => {
              setDeleting(false)
              void navigate({ to: '/agents' })
            }
          })
        }
      />
    </>
  )
}

export const Route = createFileRoute('/_app/agents/$agentId')({
  component: AgentRoute
})
