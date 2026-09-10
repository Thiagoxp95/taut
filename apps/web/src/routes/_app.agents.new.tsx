import * as React from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { BotIcon, CheckIcon, ChevronLeftIcon, GlobeIcon } from '@taut/ui/components/icons'
import type {
  Avatar,
  ConnectorInput,
  FileGrantMode,
  PermissionMode,
  RepositoryId,
  RuntimeKind
} from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { Switch } from '@taut/ui/components/switch'
import { Textarea } from '@taut/ui/components/textarea'
import { cn } from '@taut/ui/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@taut/ui/components/card'
import { NewAgentConnectors } from '@/components/agent-connectors'
import { RepoAccessRow, type RepoAccess } from '@/components/agent-repos'
import { EntityAvatar } from '@/components/entity-avatar'
import { ModelSelect } from '@/components/model-select'
import { Field, PageBody, PageHeader } from '@/components/page'
import { useDepartmentList, useDepartmentShapes } from '@/hooks/use-directory'
import { agentAvatarSeed, type AgentFace } from '@/lib/agent-avatar'
import { useCreateAgent, useRepositories, useSubscriptions } from '@/lib/api'
import { slugify } from '@/lib/format'
import { parseDepartmentId, parseSubscriptionId } from '@/lib/ids'
import { RUNTIME_BLURB, RUNTIME_LABELS, RUNTIME_ORDER } from '@/lib/runtime-meta'

/** Stored because `CreateAgentPayload` requires an avatar; never rendered. */
const AGENT_PLACEHOLDER_AVATAR: Avatar = { kind: 'emoji', value: '🤖' }

/** `Handle` in the contract: 2–32 chars of a-z, 0-9, `_` and `-`. */
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/

const MANDATE_TEMPLATE = `You are …

## You must
- …

## You must never
- …

## Report format
- …
`

function handleError(handle: string): string | undefined {
  if (handle === '') return undefined
  if (handle.length < 2) return 'At least 2 characters.'
  if (handle.length > 32) return 'At most 32 characters.'
  if (!HANDLE_PATTERN.test(handle)) {
    return 'Lowercase letters, digits, - and _ only, starting with a letter or digit.'
  }
  return undefined
}

function RuntimeCards({
  value,
  onChange,
  poolSize
}: {
  value: RuntimeKind
  onChange: (next: RuntimeKind) => void
  poolSize: (runtime: RuntimeKind) => number
}) {
  const cardClass = (selected: boolean, disabled: boolean): string =>
    cn(
      'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors outline-none',
      disabled
        ? 'bg-muted/30 opacity-80'
        : cn(
            'focus-visible:ring-[3px] focus-visible:ring-ring/50',
            selected ? 'border-ring bg-accent/50' : 'hover:border-ring/50 hover:bg-accent/30'
          )
    )

  return (
    <div role="radiogroup" aria-label="Runtime" className="grid gap-2 sm:grid-cols-2">
      {RUNTIME_ORDER.map((runtime) => {
        const seats = poolSize(runtime)
        const disabled = seats === 0
        const selected = value === runtime

        const title = (
          <span className="flex w-full items-center gap-2 text-sm font-medium">
            {RUNTIME_LABELS[runtime]}
            {selected && !disabled ? <CheckIcon className="size-3.5" /> : null}
            <span className="ml-auto text-[11px] font-normal text-muted-foreground">
              {disabled ? 'no seats' : `${seats} ${seats === 1 ? 'seat' : 'seats'}`}
            </span>
          </span>
        )

        // A disabled card is not a control: it is a signpost to /subscriptions,
        // so it renders as a div with a real link rather than a dead button.
        return disabled ? (
          <div key={runtime} className={cardClass(false, true)}>
            {title}
            <span className="text-xs leading-relaxed text-muted-foreground">
              Nothing in the pool yet —{' '}
              <Link to="/subscriptions" className="underline underline-offset-2">
                connect {RUNTIME_LABELS[runtime]}
              </Link>
              .
            </span>
          </div>
        ) : (
          <button
            key={runtime}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(runtime)}
            className={cardClass(selected, false)}
          >
            {title}
            <span className="text-xs leading-relaxed text-muted-foreground">
              {RUNTIME_BLURB[runtime]}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function NewAgentRoute() {
  const navigate = useNavigate()
  const createAgent = useCreateAgent()
  const subscriptions = useSubscriptions().data?.items ?? []
  const repositories = useRepositories().data?.items ?? []
  const { departments } = useDepartmentList()

  const [connectors, setConnectors] = React.useState<readonly ConnectorInput[]>([])
  const [name, setName] = React.useState('')
  const [handle, setHandle] = React.useState('')
  const [handleTouched, setHandleTouched] = React.useState(false)
  const [role, setRole] = React.useState('')
  const [mandate, setMandate] = React.useState(MANDATE_TEMPLATE)
  const [departmentId, setDepartmentId] = React.useState('none')
  const departmentShapes = useDepartmentShapes()
  const [runtimeChoice, setRuntimeChoice] = React.useState<RuntimeKind | null>(null)
  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>('plan')
  const [pinned, setPinned] = React.useState('none')
  const [model, setModel] = React.useState('')
  const [browserAccess, setBrowserAccess] = React.useState(false)
  // Keyed by repository id; anything not in here is `none`, which sends no grant.
  const [repoAccess, setRepoAccess] = React.useState<Record<string, RepoAccess>>({})

  const poolSize = (runtime: RuntimeKind): number =>
    subscriptions.filter((entry) => entry.runtime === runtime).length

  // Until the operator picks one, default to the first runtime that has seats —
  // derived rather than written back, so the pool loading cannot fight a choice.
  const runtimeKind =
    runtimeChoice ?? RUNTIME_ORDER.find((runtime) => poolSize(runtime) > 0) ?? 'claude-code'

  const pinnable = subscriptions.filter((entry) => entry.runtime === runtimeKind)
  // The face follows the form: it is drawn from the identity being typed and
  // shaped by the department picked above, so it is already the avatar this
  // agent will have once it exists.
  const previewFace: AgentFace = {
    seed: agentAvatarSeed({ handle, name: name.trim(), role: role.trim() }),
    shape: departmentId === 'none' ? undefined : departmentShapes.get(departmentId)
  }
  const repoGrants: { repositoryId: RepositoryId; mode: FileGrantMode }[] = repositories.flatMap(
    (repository) => {
      const access = repoAccess[repository.id] ?? 'none'
      return access === 'none' ? [] : [{ repositoryId: repository.id, mode: access }]
    }
  )

  const handleProblem = handleTouched ? handleError(handle) : undefined
  const ready = name.trim() !== '' && HANDLE_PATTERN.test(handle)

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!ready || createAgent.isPending) return
    const department = departmentId === 'none' ? undefined : parseDepartmentId(departmentId)
    createAgent.mutate(
      {
        handle,
        name: name.trim(),
        // Agents have no picture: the shell draws a blobatar from their identity
        // (`@/lib/agent-avatar`). The contract still requires a value, so this
        // placeholder is stored and never rendered.
        avatar: AGENT_PLACEHOLDER_AVATAR,
        role: role.trim(),
        mandate,
        runtimeKind,
        permissionMode,
        browserAccess,
        connectors,
        departmentId: department,
        pinnedSubscriptionId: pinned === 'none' ? undefined : parseSubscriptionId(pinned),
        model: model.trim() === '' ? undefined : model.trim(),
        // The server checks each repository is attached to the company; a
        // repository with no grant does not exist for the agent at all.
        repoGrants: repoGrants.length === 0 ? undefined : repoGrants
      },
      // `create` takes `departmentId` and joins the agent to it server-side
      // (contract: `CreateAgentPayload.departmentId`), so nothing to do here.
      {
        onSuccess: (agent) =>
          void navigate({ to: '/agents/$agentId', params: { agentId: agent.id } })
      }
    )
  }

  return (
    <>
      <PageHeader
        title="New agent"
        description="Identity, mandate, and the runtime seat it spends."
        icon={<BotIcon className="size-4" />}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link to="/agents">
              <ChevronLeftIcon />
              All agents
            </Link>
          </Button>
        }
      />
      <PageBody>
        <form className="mx-auto grid max-w-2xl gap-4" onSubmit={submit}>
          <Card>
            <CardHeader>
              <CardTitle>Identity</CardTitle>
              <CardDescription>
                The handle is what people type after <code className="font-mono">@</code>. It is
                unique within the company and cannot be changed later.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="flex gap-4">
                <div className="grid gap-2">
                  <span className="text-sm leading-none font-medium text-foreground select-none">
                    Avatar
                  </span>
                  <EntityAvatar kind="agent" face={previewFace} name={name} size="xl" />
                </div>
                <Field label="Name" htmlFor="agent-name" className="flex-1">
                  <Input
                    id="agent-name"
                    name="name"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value)
                      // The handle follows the name until it is edited by hand.
                      if (!handleTouched) setHandle(slugify(event.target.value).slice(0, 32))
                    }}
                    placeholder="Bruno"
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label="Handle"
                  htmlFor="agent-handle"
                  className="flex-1"
                  hint={handleProblem}
                >
                  <Input
                    id="agent-handle"
                    name="handle"
                    value={handle}
                    aria-invalid={handleProblem !== undefined}
                    onChange={(event) => {
                      setHandleTouched(true)
                      setHandle(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
                    }}
                    placeholder="bruno"
                    autoComplete="off"
                    className="font-mono"
                  />
                </Field>
              </div>
              <Field
                label="Role"
                htmlFor="agent-role"
                hint="One line. The job title shown in the member list — not the instructions."
              >
                <Input
                  id="agent-role"
                  name="role"
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                  placeholder="Backend engineer"
                />
              </Field>
              <Field
                label="Department"
                htmlFor="agent-department"
                hint="It joins that department and its channels; its head is the human it reports to."
              >
                <Select value={departmentId} onValueChange={setDepartmentId}>
                  <SelectTrigger id="agent-department" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No department yet</SelectItem>
                    {departments.map((department) => (
                      <SelectItem key={department.id} value={department.id}>
                        {department.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Mandate</CardTitle>
              <CardDescription>
                Markdown. Standing instructions and boundaries — this becomes the agent&apos;s
                <code className="mx-1 font-mono">AGENT.md</code> and its system prompt. The role is
                a label; this is the contract.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Field label="Mandate" htmlFor="agent-mandate">
                <Textarea
                  id="agent-mandate"
                  name="mandate"
                  rows={12}
                  value={mandate}
                  onChange={(event) => setMandate(event.target.value)}
                  className="font-mono text-xs"
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Runtime</CardTitle>
              <CardDescription>
                Agents bind to a runtime kind and rotate across the company pool unless you pin a
                seat.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <RuntimeCards value={runtimeKind} onChange={setRuntimeChoice} poolSize={poolSize} />

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Permission mode" htmlFor="agent-permission">
                  <Select
                    value={permissionMode}
                    onValueChange={(next) => {
                      if (next === 'plan' || next === 'auto-edit') setPermissionMode(next)
                    }}
                  >
                    <SelectTrigger id="agent-permission" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="plan">Plan — proposes, never writes</SelectItem>
                      <SelectItem value="auto-edit">Auto-edit — writes inside its home</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field
                  label="Pinned subscription"
                  htmlFor="agent-subscription"
                  hint="Optional. Pinning skips pool rotation."
                >
                  <Select value={pinned} onValueChange={setPinned}>
                    <SelectTrigger id="agent-subscription" className="w-full">
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
                </Field>
                <Field
                  label="Model override"
                  htmlFor="agent-model"
                  hint="Leave empty to use the subscription's default."
                  className="sm:col-span-2"
                >
                  <ModelSelect
                    id="agent-model"
                    runtime={runtimeKind}
                    {...(pinned === 'none' ? {} : { subscriptionId: parseSubscriptionId(pinned) })}
                    value={model === '' ? undefined : model}
                    onValueChange={(next) => setModel(next ?? '')}
                    emptyLabel="Subscription default"
                  />
                </Field>
              </div>

              <div className="flex items-start gap-3 rounded-lg border p-3">
                <GlobeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Browser access</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Gives the agent a headless Chromium (Playwright MCP) inside its machine. Logins
                    persist between tasks.
                  </p>
                </div>
                <Switch
                  id="agent-browser"
                  checked={browserAccess}
                  aria-label="Browser access"
                  onCheckedChange={setBrowserAccess}
                />
              </div>
            </CardContent>
          </Card>

          <NewAgentConnectors
            value={connectors}
            onChange={setConnectors}
            disabled={createAgent.isPending}
          />

          {repositories.length === 0 ? null : (
            <Card>
              <CardHeader>
                <CardTitle>Repositories</CardTitle>
                <CardDescription>
                  Optional. Read-only gets the agent a checkout of the default branch it cannot push
                  from. Read and write lets it push a branch and open a pull request, never to the
                  default branch. You can change any of this later.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y rounded-lg border">
                  {repositories.map((repository) => (
                    <RepoAccessRow
                      key={repository.id}
                      repository={repository}
                      access={repoAccess[repository.id] ?? 'none'}
                      disabled={false}
                      onChange={(next) =>
                        setRepoAccess((current) => ({ ...current, [repository.id]: next }))
                      }
                    />
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <div className="flex items-center justify-end gap-2 pb-6">
            <Button asChild variant="ghost" type="button">
              <Link to="/agents">Cancel</Link>
            </Button>
            <Button type="submit" disabled={!ready || createAgent.isPending}>
              {createAgent.isPending ? 'Creating…' : 'Create agent'}
            </Button>
          </div>
        </form>
      </PageBody>
    </>
  )
}

export const Route = createFileRoute('/_app/agents/new')({
  component: NewAgentRoute
})
