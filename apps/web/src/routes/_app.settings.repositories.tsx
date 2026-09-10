import * as React from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  CheckIcon,
  ExternalLinkIcon,
  FolderGitIcon,
  GitBranchIcon,
  InfoIcon,
  LockIcon,
  SearchIcon,
  TrashIcon,
  TriangleAlertIcon,
  UnplugIcon
} from '@taut/ui/components/icons'
import type { AvailableRepository, Repository } from '@taut/contract'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { Skeleton } from '@taut/ui/components/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { GithubConnectButton } from '@/components/github-connect'
import { EmptyState, PageBody, PageHeader } from '@/components/page'
import { SettingsCallout, SettingsCard, SettingsRow, SettingsShell } from '@/components/settings'
import { WorkspaceSettingsNav } from '@/components/settings-nav'
import {
  useAttachRepositories,
  useAvailableRepositories,
  useCanAdminister,
  useDetachRepository,
  useDisconnectGithub,
  useGithubConnection,
  useGithubInstallUrl,
  useRepositories
} from '@/lib/api'
import { formatRelative } from '@/lib/format'

/** GitHub sends the owner back here after each leg of the flow. */
export interface RepositoriesSearch {
  readonly github?: string
  /** Why it failed, sent alongside `github=error`. */
  readonly reason?: string
}

/** What the server appends to the redirect at the end of each leg. */
const RETURN_NOTE: Record<string, string> = {
  'app-created': 'The GitHub App is created. Install it next, on the account that owns the code.',
  connected: 'GitHub is connected. Attach the repositories this company should work in.'
}

function ReturnNote({
  value,
  reason,
  onDismiss
}: {
  value: string
  reason: string | undefined
  onDismiss: () => void
}) {
  const known = RETURN_NOTE[value]
  const problem =
    value === 'error'
      ? (reason ?? 'GitHub sent you back without saying what went wrong.')
      : `GitHub sent you back with "${value}", which Taut does not recognise. Start the connection again.`
  return (
    <SettingsCallout
      variant={known === undefined ? 'attention' : 'success'}
      icon={known === undefined ? <TriangleAlertIcon /> : <CheckIcon />}
      title={known === undefined ? 'GitHub sent you back' : 'GitHub is connected'}
      description={known ?? problem}
      onDismiss={onDismiss}
    />
  )
}

// --- rows -----------------------------------------------------------------

function RepoName({
  fullName,
  isPrivate,
  defaultBranch
}: {
  fullName: string
  isPrivate: boolean
  defaultBranch: string
}) {
  return (
    <div className="min-w-0 flex-1">
      <p className="flex items-center gap-2 truncate text-sm font-medium">
        <span className="truncate font-mono">{fullName}</span>
        {isPrivate ? (
          <Badge variant="outline" className="font-normal">
            private
          </Badge>
        ) : null}
      </p>
      <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
        <GitBranchIcon className="size-3" />
        <span className="font-mono">{defaultBranch}</span>
      </p>
    </div>
  )
}

function AttachedRow({
  repository,
  canAdminister,
  onDetach
}: {
  repository: Repository
  canAdminister: boolean
  onDetach: () => void
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <RepoName
        fullName={repository.fullName}
        isPrivate={repository.private}
        defaultBranch={repository.defaultBranch}
      />
      <span className="hidden text-xs whitespace-nowrap text-muted-foreground sm:block">
        attached {formatRelative(repository.attachedAt)}
      </span>
      {canAdminister ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Detach ${repository.fullName}`}
          onClick={onDetach}
        >
          <TrashIcon />
        </Button>
      ) : null}
    </li>
  )
}

function AvailableRow({
  repository,
  pending,
  onAttach
}: {
  repository: AvailableRepository
  pending: boolean
  onAttach: () => void
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <RepoName
        fullName={repository.fullName}
        isPrivate={repository.private}
        defaultBranch={repository.defaultBranch}
      />
      <Button size="sm" variant="outline" disabled={pending} onClick={onAttach}>
        Attach
      </Button>
    </li>
  )
}

// --- states ---------------------------------------------------------------

function ConnectCard({ canAdminister }: { canAdminister: boolean }) {
  return (
    <section className="rounded-xl border bg-card p-6">
      <h2 className="text-sm font-semibold">Connect GitHub</h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Taut talks to GitHub through a GitHub App you create from here. GitHub asks you to name it
        and press Create, then asks which repositories it may see. Nothing is stored until you have
        done both.
      </p>
      <ul className="mt-4 grid max-w-prose gap-1.5 text-xs text-muted-foreground">
        <li>1. Create the App on GitHub. Taut fills in the settings for you.</li>
        <li>2. Install it on the account that owns the code, and tick the repositories.</li>
        <li>3. Attach the ones this company works in, then grant them per agent.</li>
      </ul>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <GithubConnectButton disabled={!canAdminister} />
        {canAdminister ? null : (
          <p className="text-xs text-muted-foreground">
            Connecting GitHub is owner and admin only. Ask one of them to start this.
          </p>
        )}
      </div>
    </section>
  )
}

function InstallCard({ canAdminister }: { canAdminister: boolean }) {
  const installUrl = useGithubInstallUrl({ enabled: canAdminister })

  return (
    <section className="rounded-xl border bg-card p-6">
      <h2 className="text-sm font-semibold">Now install it on your GitHub account</h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        The App exists but is installed nowhere yet. The repositories you tick on GitHub are the
        ones Taut will be able to see, and you can change that list on GitHub at any time. GitHub
        sends you back here as soon as it is installed.
      </p>
      <div className="mt-5 flex items-center gap-3">
        {installUrl.data === undefined ? (
          <Button size="sm" disabled>
            <ExternalLinkIcon />
            Install on GitHub
          </Button>
        ) : (
          <Button asChild size="sm">
            <a href={installUrl.data.url} target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              Install on GitHub
            </a>
          </Button>
        )}
        {canAdminister ? null : (
          <p className="text-xs text-muted-foreground">
            Installing it is owner and admin only. Ask one of them to finish this.
          </p>
        )}
      </div>
    </section>
  )
}

function ConnectedView({
  accountLogin,
  canAdminister,
  onDisconnect
}: {
  accountLogin: string | undefined
  canAdminister: boolean
  onDisconnect: () => void
}) {
  const attached = useRepositories()
  const available = useAvailableRepositories({ enabled: canAdminister })
  const installUrl = useGithubInstallUrl({ enabled: canAdminister })
  const attach = useAttachRepositories()
  const detach = useDetachRepository()

  const [filter, setFilter] = React.useState('')
  const [detaching, setDetaching] = React.useState<Repository | null>(null)

  const repositories = attached.data?.items ?? []
  const needle = filter.trim().toLowerCase()
  const candidates = (available.data?.items ?? [])
    .filter((entry) => !entry.attached)
    .filter((entry) => needle === '' || entry.fullName.toLowerCase().includes(needle))

  return (
    <>
      <SettingsCard title="GitHub" description="The installation this company's code comes from.">
        <SettingsRow
          label={accountLogin === undefined ? 'Connected to GitHub' : `@${accountLogin}`}
          description={
            repositories.length === 0
              ? 'No repositories attached yet.'
              : `${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'} attached.`
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            {canAdminister && installUrl.data !== undefined ? (
              <Button asChild variant="ghost" size="sm">
                <a href={installUrl.data.url} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon />
                  Repositories on GitHub
                </a>
              </Button>
            ) : null}
            <Button variant="outline" size="sm" disabled={!canAdminister} onClick={onDisconnect}>
              <UnplugIcon />
              Disconnect
            </Button>
          </div>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="Attached"
        description="What this company works in. An agent can only be granted a repository from this list."
      >
        {attached.isPending ? (
          <Skeleton className="m-6 h-32 rounded-lg" />
        ) : repositories.length === 0 ? (
          <div className="px-6 py-5">
            <EmptyState
              icon={<FolderGitIcon className="size-5" />}
              title="Nothing attached yet"
              description={
                canAdminister
                  ? 'Pick one below. Attaching it makes it grantable; it does not give any agent access on its own.'
                  : 'An owner or an admin attaches repositories. Until then agents have no code to work in.'
              }
            />
          </div>
        ) : (
          <ul className="divide-y">
            {repositories.map((repository) => (
              <AttachedRow
                key={repository.id}
                repository={repository}
                canAdminister={canAdminister}
                onDetach={() => setDetaching(repository)}
              />
            ))}
          </ul>
        )}
      </SettingsCard>

      {canAdminister ? (
        <SettingsCard
          title="Available on GitHub"
          description="Everything the installation can see. Tick more on GitHub if what you want is missing."
          action={
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter"
                aria-label="Filter available repositories"
                className="h-8 w-48 pl-8 text-xs"
              />
            </div>
          }
        >
          {available.isPending ? (
            <Skeleton className="m-6 h-32 rounded-lg" />
          ) : candidates.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">
              {needle === ''
                ? 'Everything the installation can see is already attached.'
                : `Nothing matches "${filter.trim()}".`}
            </p>
          ) : (
            <ul className="divide-y">
              {candidates.map((repository) => (
                <AvailableRow
                  key={repository.githubId}
                  repository={repository}
                  pending={attach.isPending}
                  onAttach={() => attach.mutate([repository.githubId])}
                />
              ))}
            </ul>
          )}
        </SettingsCard>
      ) : null}

      <ConfirmDialog
        open={detaching !== null}
        onOpenChange={(next) => {
          if (!next) setDetaching(null)
        }}
        title={`Detach ${detaching?.fullName ?? 'this repository'}?`}
        confirmLabel="Detach"
        pending={detach.isPending}
        description={
          <>
            <p className="text-destructive">
              This revokes every agent&apos;s access to it. Any agent that held it read-only or read
              and write loses it on its next task, and stops seeing it entirely.
            </p>
            <p>
              Nothing changes on GitHub, and you can attach it again later. Work an agent already
              pushed stays where it is.
            </p>
          </>
        }
        onConfirm={() => {
          if (detaching === null) return
          detach.mutate(detaching.id, { onSuccess: () => setDetaching(null) })
        }}
      />
    </>
  )
}

// --- page -----------------------------------------------------------------

function RepositoriesSettingsRoute() {
  const navigate = useNavigate()
  const { github, reason } = Route.useSearch()
  const connection = useGithubConnection()
  const canAdminister = useCanAdminister()
  const disconnect = useDisconnectGithub()

  const [disconnecting, setDisconnecting] = React.useState(false)

  const state = connection.data?.state

  return (
    <>
      <PageHeader
        title="Repositories"
        description="The GitHub repositories this company works in."
        icon={<FolderGitIcon className="size-4" />}
      />
      <PageBody>
        <SettingsShell nav={<WorkspaceSettingsNav />}>
          {github === undefined ? null : (
            <ReturnNote
              value={github}
              reason={reason}
              onDismiss={() =>
                void navigate({ to: '/settings/repositories', search: {}, replace: true })
              }
            />
          )}

          <SettingsCallout
            variant="default"
            icon={<InfoIcon />}
            title="Attaching is not granting."
            description="Attaching a repository here does not give any agent access to it. You grant it agent by agent, read-only or read and write, on the agent's Repositories tab."
          />

          <div className="grid gap-6">
            {connection.isPending ? (
              <Skeleton className="h-48 rounded-xl" />
            ) : state === 'connected' ? (
              <ConnectedView
                accountLogin={connection.data?.accountLogin}
                canAdminister={canAdminister}
                onDisconnect={() => setDisconnecting(true)}
              />
            ) : state === 'app-created' ? (
              <InstallCard canAdminister={canAdminister} />
            ) : (
              <ConnectCard canAdminister={canAdminister} />
            )}
          </div>

          {canAdminister ? (
            <p className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
              <FolderGitIcon className="size-3.5" />
              Per-agent access lives on each agent, under{' '}
              <Link to="/agents" className="underline underline-offset-2">
                Agents
              </Link>
              .
            </p>
          ) : (
            <p className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
              <LockIcon className="size-3.5" />
              You can see what the company works in; connecting GitHub and attaching repositories is
              owner and admin only.
            </p>
          )}
        </SettingsShell>
      </PageBody>

      <ConfirmDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title="Disconnect GitHub?"
        confirmLabel="Disconnect"
        pending={disconnect.isPending}
        description={
          <>
            <p className="text-destructive">
              Every attached repository goes with it, and so does every grant an agent holds on
              them.
            </p>
            <p>
              The App itself stays on your GitHub account until you delete it there. Connecting
              again means creating a new one.
            </p>
          </>
        }
        onConfirm={() => disconnect.mutate(undefined, { onSuccess: () => setDisconnecting(false) })}
      />
    </>
  )
}

export const Route = createFileRoute('/_app/settings/repositories')({
  /** `?github=app-created` and `?github=connected` are how the server hands the browser back. */
  validateSearch: (search: Record<string, unknown>): RepositoriesSearch => ({
    github: typeof search.github === 'string' ? search.github : undefined,
    reason: typeof search.reason === 'string' ? search.reason : undefined
  }),
  component: RepositoriesSettingsRoute
})
