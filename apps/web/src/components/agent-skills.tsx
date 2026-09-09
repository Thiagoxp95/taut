import * as React from 'react'
import {
  CloudDownloadIcon,
  EyeIcon,
  LockIcon,
  PencilIcon,
  PenLineIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  TrashIcon
} from 'lucide-react'
import type { AgentId, AgentSkill, SkillCandidate, SkillUpdatePolicy } from '@taut/contract'
import { SKILL_SOURCE_HELP } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@taut/ui/components/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@taut/ui/components/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { Skeleton } from '@taut/ui/components/skeleton'
import { Textarea } from '@taut/ui/components/textarea'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { MarkdownEditor } from '@/components/markdown-editor'
import { EmptyState, Field } from '@/components/page'
import { SettingsSection } from '@/components/settings'
import {
  useApproveSkill,
  useCheckSkill,
  useDeleteSkill,
  useInstallSkill,
  usePreviewSkill,
  usePutSkill,
  useSetSkillPolicy,
  useSkill,
  useUpdateSkill
} from '@/lib/api'
import { slugify } from '@/lib/format'

const SKILL_TEMPLATE = `---
name: <name>
description: <one line, this is what the agent reads when choosing a skill>
---

## When to use

…

## Steps

1. …
`

/**
 * The form behind "Add skill" and "Edit".
 *
 * When editing, `SkillDialog` first loads the current `SKILL.md` body through
 * `agents.getSkill` and passes it as `initialBody`, so a save edits the file
 * instead of replacing it with a template.
 */
function SkillForm({
  agentId,
  editing,
  initialBody,
  readOnly,
  onDone
}: {
  agentId: AgentId
  editing: AgentSkill | null
  /** The body on disk (frontmatter stripped); `undefined` for a new skill. */
  initialBody?: string
  /** Built-in, or the viewer cannot manage this agent: show the body, refuse the save. */
  readOnly: boolean
  onDone: () => void
}) {
  const putSkill = usePutSkill()
  const formRef = React.useRef<HTMLFormElement>(null)
  const [name, setName] = React.useState(editing?.name ?? '')
  const [description, setDescription] = React.useState(editing?.description ?? '')
  const [body, setBody] = React.useState(
    () => initialBody ?? SKILL_TEMPLATE.replace('<name>', editing?.name ?? '<name>')
  )

  const handle = editing?.name ?? slugify(name).slice(0, 32)
  const ready = handle.length >= 2 && description.trim() !== ''

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (readOnly || !ready || putSkill.isPending) return
    putSkill.mutate(
      { agentId, name: handle, description: description.trim(), body },
      { onSuccess: onDone }
    )
  }

  return (
    <form ref={formRef} onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <DialogHeader className="shrink-0">
        <DialogTitle>
          {editing === null ? 'Add a skill' : `${readOnly ? '' : 'Edit '}${editing.name}`}
        </DialogTitle>
        <DialogDescription>
          {readOnly ? (
            <>
              This skill ships with Taut. Every agent has it, and it cannot be edited or deleted —
              this is the same text the runtime loads from{' '}
              <code className="font-mono">skills/{editing?.name}/SKILL.md</code>.
            </>
          ) : (
            <>
              A skill is a folder with a{' '}
              <code className="font-mono">skills/&lt;name&gt;/SKILL.md</code> in the agent&apos;s
              home. The YAML frontmatter at the top (<code className="font-mono">name</code>,{' '}
              <code className="font-mono">description</code>) is what the runtime reads when it
              decides which skill applies; everything below it is the procedure.
            </>
          )}
        </DialogDescription>
      </DialogHeader>

      <div className="taut-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-4">
        <div className="grid shrink-0 gap-4 sm:grid-cols-2">
          <Field
            label="Name"
            htmlFor="skill-name"
            hint={
              readOnly
                ? `Folder: skills/${handle}/`
                : editing === null
                  ? handle === ''
                    ? 'Becomes the folder name.'
                    : `Folder: skills/${handle}/`
                  : 'The folder name is fixed once the skill exists.'
            }
          >
            <Input
              id="skill-name"
              autoFocus={editing === null}
              readOnly={editing !== null}
              className="font-mono"
              value={editing?.name ?? name}
              onChange={(event) => setName(event.target.value)}
              placeholder="review-pr"
            />
          </Field>
          <Field
            label="Description"
            htmlFor="skill-description"
            hint={readOnly ? 'What the runtime routes on.' : 'One line.'}
          >
            <Input
              id="skill-description"
              readOnly={readOnly}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Reads a diff and reports risk, missing tests, and naming."
            />
          </Field>
        </div>

        <MarkdownEditor
          id="skill-body"
          label="Body"
          value={body}
          onChange={setBody}
          readOnly={readOnly}
          onSubmit={() => formRef.current?.requestSubmit()}
          className="min-h-[22rem] flex-1"
          hint={
            readOnly ? (
              <>
                Baked into Taut. Restored from source on every restart, so an edit to{' '}
                <code className="font-mono">skills/{editing?.name}/SKILL.md</code> on disk does not
                survive.
              </>
            ) : editing === null ? (
              <>
                Written to{' '}
                <code className="font-mono">
                  skills/{handle === '' ? '<name>' : handle}/SKILL.md
                </code>{' '}
                under the frontmatter above.
              </>
            ) : (
              <>
                Saving rewrites <code className="font-mono">skills/{editing.name}/SKILL.md</code>;
                the frontmatter is regenerated from the fields above.
              </>
            )
          }
        />
      </div>

      <DialogFooter className="shrink-0">
        {readOnly ? (
          <Button type="button" onClick={onDone}>
            Close
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || putSkill.isPending}>
              {editing === null ? 'Add skill' : 'Save skill'}
            </Button>
          </>
        )}
      </DialogFooter>
    </form>
  )
}

/**
 * Loads the current body first so the editor never starts from a blank template —
 * and, for a built-in, so the viewer shows the real shipped text rather than a stub.
 */
function EditSkillForm({
  agentId,
  editing,
  readOnly,
  onDone
}: {
  agentId: AgentId
  editing: AgentSkill
  readOnly: boolean
  onDone: () => void
}) {
  const skill = useSkill(agentId, editing.name)
  if (skill.isPending) {
    return (
      <div className="grid gap-4 py-4" aria-busy="true" aria-label="Loading skill">
        <DialogHeader>
          <DialogTitle>{readOnly ? editing.name : `Edit ${editing.name}`}</DialogTitle>
          <DialogDescription>
            Loading <code className="font-mono">skills/{editing.name}/SKILL.md</code>…
          </DialogDescription>
        </DialogHeader>
        <Skeleton className="h-9 rounded-md" />
        <Skeleton className="h-[22rem] rounded-md" />
      </div>
    )
  }
  if (skill.isError) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{readOnly ? editing.name : `Edit ${editing.name}`}</DialogTitle>
          <DialogDescription>Could not load the skill: {skill.error.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onDone}>
            Close
          </Button>
        </DialogFooter>
      </>
    )
  }
  return (
    <SkillForm
      key={`${editing.name}:${skill.dataUpdatedAt}`}
      agentId={agentId}
      editing={{ ...editing, description: skill.data.description }}
      initialBody={skill.data.body}
      readOnly={readOnly}
      onDone={onDone}
    />
  )
}

/**
 * Install from a source (docs/build-plan-skills.md D2/D3). One field, because a skill arrives in
 * whatever shape the person had it in: a link they were reading, the `npx skills` line off that
 * page, a bare `owner/repo`, or the markdown itself. `preview` runs first so a repo with
 * thirty-seven skills asks which one instead of guessing.
 */
function InstallSkillForm({ agentId, onDone }: { agentId: AgentId; onDone: () => void }) {
  const preview = usePreviewSkill()
  const install = useInstallSkill()
  const [source, setSource] = React.useState('')
  const [candidates, setCandidates] = React.useState<readonly SkillCandidate[] | null>(null)
  const [chosen, setChosen] = React.useState<string | null>(null)
  const [policy, setPolicy] = React.useState<SkillUpdatePolicy>('notify')

  const trimmed = source.trim()
  const busy = preview.isPending || install.isPending
  const error = preview.error ?? install.error

  const look = (event: React.FormEvent): void => {
    event.preventDefault()
    if (trimmed === '' || busy) return
    preview.mutate(
      { agentId, source: trimmed },
      {
        onSuccess: (found) => {
          setCandidates(found)
          setChosen(found.length === 1 ? (found[0]?.name ?? null) : null)
        }
      }
    )
  }

  const add = (): void => {
    if (chosen === null || busy) return
    install.mutate(
      { agentId, source: trimmed, name: chosen, updatePolicy: policy },
      { onSuccess: onDone }
    )
  }

  return (
    <form onSubmit={look} className="flex min-h-0 flex-1 flex-col">
      <DialogHeader className="shrink-0">
        <DialogTitle>Install a skill</DialogTitle>
        <DialogDescription>{SKILL_SOURCE_HELP}</DialogDescription>
      </DialogHeader>

      <div className="taut-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-4">
        <Field
          label="Source"
          htmlFor="skill-source"
          hint="Taut reads it over HTTPS. A command is parsed, never run."
        >
          <Textarea
            id="skill-source"
            autoFocus
            rows={3}
            className="font-mono text-xs"
            value={source}
            onChange={(event) => {
              setSource(event.target.value)
              setCandidates(null)
              setChosen(null)
            }}
            placeholder={
              'mattpocock/skills\nnpx skills@latest add mattpocock/skills --skill=grill-with-docs\nhttps://www.aihero.dev/skills-grill-with-docs'
            }
          />
        </Field>

        {error !== null ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error.message}
          </p>
        ) : null}

        {candidates !== null ? (
          candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing installable was found there.</p>
          ) : (
            <div className="grid gap-2">
              <p className="text-xs text-muted-foreground">
                {candidates.length === 1
                  ? 'Found one skill.'
                  : `Found ${candidates.length} skills. Pick the one to install.`}
              </p>
              <ul className="taut-scroll max-h-64 divide-y overflow-y-auto rounded-lg border">
                {candidates.map((candidate) => (
                  <li key={candidate.name}>
                    <button
                      type="button"
                      onClick={() => setChosen(candidate.name)}
                      aria-pressed={chosen === candidate.name}
                      className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-accent ${
                        chosen === candidate.name ? 'bg-accent' : ''
                      }`}
                    >
                      <span className="font-mono text-sm">{candidate.name}</span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {candidate.description === '' ? candidate.path : candidate.description}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <Field
                label="When it changes upstream"
                htmlFor="skill-policy"
                hint="Notify is the default: nothing changes until someone says so."
              >
                <Select
                  value={policy}
                  onValueChange={(next) => setPolicy(next as SkillUpdatePolicy)}
                >
                  <SelectTrigger id="skill-policy">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="notify">Tell me, and wait</SelectItem>
                    <SelectItem value="auto">Update it for me</SelectItem>
                    <SelectItem value="manual">Never check</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )
        ) : null}
      </div>

      <DialogFooter className="shrink-0">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        {candidates === null ? (
          <Button type="submit" disabled={trimmed === '' || busy}>
            {preview.isPending ? 'Reading…' : 'Look'}
          </Button>
        ) : (
          <Button type="button" onClick={add} disabled={chosen === null || busy}>
            {install.isPending ? 'Installing…' : 'Install skill'}
          </Button>
        )}
      </DialogFooter>
    </form>
  )
}

/**
 * What upstream says now, against what the agent is using (D9). The body on disk is untouched
 * until Update is pressed, which is the whole point of the `notify` default.
 */
function SkillUpdateDialog({
  agentId,
  skill,
  onDone
}: {
  agentId: AgentId
  skill: AgentSkill
  onDone: () => void
}) {
  const detail = useSkill(agentId, skill.name)
  const update = useUpdateSkill()

  return (
    <>
      <DialogHeader>
        <DialogTitle>{skill.name} changed upstream</DialogTitle>
        <DialogDescription>
          {skill.source === undefined ? null : (
            <>
              From <code className="font-mono">{skill.source}</code>.{' '}
            </>
          )}
          The agent is still using the copy on the left. Nothing changes until you say so.
        </DialogDescription>
      </DialogHeader>

      <div className="taut-scroll grid min-h-0 flex-1 gap-4 overflow-y-auto py-4 sm:grid-cols-2">
        {detail.isPending ? (
          <>
            <Skeleton className="h-64 rounded-md" />
            <Skeleton className="h-64 rounded-md" />
          </>
        ) : detail.isError ? (
          <p className="text-sm text-muted-foreground">
            Could not load the skill: {detail.error.message}
          </p>
        ) : (
          <>
            <section className="grid min-h-0 gap-1">
              <h3 className="text-xs font-medium text-muted-foreground">In use now</h3>
              <pre className="taut-scroll max-h-80 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
                {detail.data.body}
              </pre>
            </section>
            <section className="grid min-h-0 gap-1">
              <h3 className="text-xs font-medium text-muted-foreground">Upstream</h3>
              <pre className="taut-scroll max-h-80 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
                {detail.data.upstreamBody ??
                  'Upstream has changed, but I have not fetched the new text yet. Updating pulls it.'}
              </pre>
            </section>
          </>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Keep what it has
        </Button>
        <Button
          type="button"
          disabled={update.isPending}
          onClick={() => update.mutate({ agentId, name: skill.name }, { onSuccess: onDone })}
        >
          {update.isPending ? 'Updating…' : 'Update the skill'}
        </Button>
      </DialogFooter>
    </>
  )
}

/** The small outlined label next to a skill name. */
function Chip({
  children,
  className = '',
  title
}: {
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-sans text-[10px] leading-none font-normal text-muted-foreground ${className}`}
    >
      {children}
    </span>
  )
}

/** `github:mattpocock/skills#grill-with-docs` reads as `mattpocock/skills` in a row this narrow. */
function sourceLabel(source: string | undefined): string {
  if (source === undefined) return 'Installed'
  if (source === 'inline') return 'Pasted'
  const withoutScheme = source.replace(/^\w+:/, '')
  const repo = withoutScheme.split('#')[0]?.split('@')[0] ?? withoutScheme
  return repo.length > 34 ? `${repo.slice(0, 33)}…` : repo
}

function SkillDialog({
  agentId,
  editing,
  canManage,
  open,
  onOpenChange
}: {
  agentId: AgentId
  editing: AgentSkill | null
  canManage: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const close = (): void => onOpenChange(false)
  const readOnly = editing !== null && (editing.builtin || !canManage)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-3xl lg:max-w-5xl">
        {editing === null ? (
          <SkillForm agentId={agentId} editing={null} readOnly={false} onDone={close} />
        ) : (
          <EditSkillForm agentId={agentId} editing={editing} readOnly={readOnly} onDone={close} />
        )}
      </DialogContent>
    </Dialog>
  )
}

export function AgentSkillsTab({
  agentId,
  skills,
  canManage
}: {
  agentId: AgentId
  skills: readonly AgentSkill[]
  /** Company admin+ or the head of a department the agent is in. */
  canManage: boolean
}) {
  const deleteSkill = useDeleteSkill()
  const approveSkill = useApproveSkill()
  const checkSkill = useCheckSkill()
  const setPolicy = useSetSkillPolicy()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<AgentSkill | null>(null)
  const [deleting, setDeleting] = React.useState<AgentSkill | null>(null)
  const [installOpen, setInstallOpen] = React.useState(false)
  const [reviewing, setReviewing] = React.useState<AgentSkill | null>(null)

  const openNew = (): void => {
    setEditing(null)
    setDialogOpen(true)
  }

  return (
    <>
      <SettingsSection
        title="Skills"
        description="Named, repeatable procedures the agent can pick from. Descriptions are what the runtime routes on. Built-in skills ship with Taut and are read-only."
        action={
          canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  <PlusIcon />
                  Add skill
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem onSelect={openNew}>
                  <PenLineIcon />
                  <span className="flex flex-col items-start">
                    Write one
                    <span className="text-xs text-muted-foreground">
                      A SKILL.md you author here.
                    </span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setInstallOpen(true)}>
                  <CloudDownloadIcon />
                  <span className="flex flex-col items-start">
                    Install from a source
                    <span className="text-xs text-muted-foreground">
                      A link, a repo, or an npx command.
                    </span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      >
        {skills.length === 0 ? (
          <EmptyState
            icon={<SparklesIcon className="size-5" />}
            title="No skills yet"
            description="Without skills the agent works from its mandate alone. Add one for anything it does more than once."
            action={
              canManage ? (
                <div className="flex gap-2">
                  <Button onClick={openNew}>Write the first skill</Button>
                  <Button variant="outline" onClick={() => setInstallOpen(true)}>
                    Install one
                  </Button>
                </div>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y rounded-lg border">
            {skills.map((skill) => {
              const pending = skill.state === 'pending'
              const installed = skill.origin === 'installed'
              return (
                <li key={skill.name} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-mono text-sm font-medium">
                      {skill.name}
                      {skill.builtin ? (
                        <Chip title="Ships with Taut. Every agent has it; it cannot be edited or deleted.">
                          <LockIcon className="size-2.5" />
                          Built-in
                        </Chip>
                      ) : null}
                      {pending ? (
                        <Chip
                          className="border-amber-500/40 text-amber-700 dark:text-amber-400"
                          title="The agent installed this for itself. It is on disk but not in use until you approve it."
                        >
                          Waiting for you
                        </Chip>
                      ) : null}
                      {installed && !pending ? (
                        <Chip title={skill.source ?? 'Installed from a source'}>
                          <CloudDownloadIcon className="size-2.5" />
                          {sourceLabel(skill.source)}
                        </Chip>
                      ) : null}
                      {skill.updateAvailable ? (
                        <Chip className="border-sky-500/40 text-sky-700 dark:text-sky-400">
                          <RefreshCwIcon className="size-2.5" />
                          Changed upstream
                        </Chip>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{skill.description}</p>
                  </div>

                  {canManage && pending ? (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={approveSkill.isPending}
                        onClick={() => approveSkill.mutate({ agentId, name: skill.name })}
                      >
                        Approve
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(skill)}>
                        Reject
                      </Button>
                    </div>
                  ) : null}

                  {canManage && skill.updateAvailable && !pending ? (
                    <Button size="sm" variant="outline" onClick={() => setReviewing(skill)}>
                      Review change
                    </Button>
                  ) : null}

                  {canManage && installed ? (
                    <Select
                      value={skill.updatePolicy}
                      onValueChange={(next) =>
                        setPolicy.mutate({
                          agentId,
                          name: skill.name,
                          updatePolicy: next as SkillUpdatePolicy
                        })
                      }
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label={`Update policy for ${skill.name}`}
                        className="w-[9.5rem]"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="notify">Tell me</SelectItem>
                        <SelectItem value="auto">Auto-update</SelectItem>
                        <SelectItem value="manual">Never check</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : null}

                  {canManage && installed && !pending ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Check ${skill.name} for updates`}
                      title="Look upstream now"
                      disabled={checkSkill.isPending}
                      onClick={() => checkSkill.mutate({ agentId, name: skill.name })}
                    >
                      <RefreshCwIcon />
                    </Button>
                  ) : null}

                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${skill.builtin || !canManage ? 'View' : 'Edit'} ${skill.name}`}
                    onClick={() => {
                      setEditing(skill)
                      setDialogOpen(true)
                    }}
                  >
                    {skill.builtin || !canManage ? <EyeIcon /> : <PencilIcon />}
                  </Button>
                  {canManage && !skill.builtin && !pending ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${skill.name}`}
                      onClick={() => setDeleting(skill)}
                    >
                      <TrashIcon />
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </SettingsSection>

      <SkillDialog
        agentId={agentId}
        editing={editing}
        canManage={canManage}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />

      <Dialog open={installOpen} onOpenChange={setInstallOpen}>
        <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-2xl">
          <InstallSkillForm agentId={agentId} onDone={() => setInstallOpen(false)} />
        </DialogContent>
      </Dialog>

      <Dialog
        open={reviewing !== null}
        onOpenChange={(next) => {
          if (!next) setReviewing(null)
        }}
      >
        <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-4xl">
          {reviewing === null ? null : (
            <SkillUpdateDialog
              agentId={agentId}
              skill={reviewing}
              onDone={() => setReviewing(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
        title={
          deleting?.state === 'pending'
            ? `Reject the ${deleting.name} skill?`
            : `Delete the ${deleting?.name ?? ''} skill?`
        }
        confirmLabel={deleting?.state === 'pending' ? 'Reject skill' : 'Delete skill'}
        pending={deleteSkill.isPending}
        description={
          <p>
            The folder <code className="font-mono">skills/{deleting?.name}/</code> is removed from
            the agent&apos;s home. Its other skills and its memory are untouched.
          </p>
        }
        onConfirm={() => {
          if (deleting === null) return
          deleteSkill.mutate(
            { agentId, name: deleting.name },
            { onSuccess: () => setDeleting(null) }
          )
        }}
      />
    </>
  )
}
