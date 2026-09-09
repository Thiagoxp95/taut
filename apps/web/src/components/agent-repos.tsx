import { Link } from '@tanstack/react-router'
import { FolderGitIcon, GitBranchIcon } from 'lucide-react'
import type { AgentId, AgentRepoGrant, FileGrantMode, Repository } from '@taut/contract'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Skeleton } from '@taut/ui/components/skeleton'
import { cn } from '@taut/ui/lib/utils'
import { EmptyState, ReadOnlyNote } from '@/components/page'
import { SettingsSection } from '@/components/settings'
import { useGrantRepo, useRepositories, useRevokeRepo } from '@/lib/api'

/** `none` is the absence of a grant, so it is a UI value and never leaves the browser. */
export type RepoAccess = 'none' | FileGrantMode

export const REPO_ACCESS_ORDER: readonly RepoAccess[] = ['none', 'ro', 'rw']

export const REPO_ACCESS_LABELS: Record<RepoAccess, string> = {
  none: 'No access',
  ro: 'Read-only',
  rw: 'Read & write'
}

/** One plain sentence per level, shown under the row that is on it. */
export function repoAccessNote(access: RepoAccess, defaultBranch: string): string | undefined {
  switch (access) {
    case 'none':
      return undefined
    case 'ro':
      return `Gets a checkout of ${defaultBranch} it can read but cannot push from.`
    case 'rw':
      return `Branches from ${defaultBranch}, and may push a branch and open a pull request, never to ${defaultBranch}.`
  }
}

/**
 * No access · Read-only · Read & write, as one control.
 *
 * A radiogroup rather than three buttons: the three levels are exclusive, and
 * the keyboard should move through them as one thing.
 */
export function RepoAccessControl({
  value,
  disabled,
  label,
  onChange
}: {
  value: RepoAccess
  disabled: boolean
  /** Names the group for a screen reader, e.g. `Access to octocat/hello-world`. */
  label: string
  onChange: (next: RepoAccess) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5"
    >
      {REPO_ACCESS_ORDER.map((access) => {
        const selected = value === access
        return (
          <Button
            key={access}
            type="button"
            role="radio"
            aria-checked={selected}
            size="sm"
            variant={selected ? 'default' : 'ghost'}
            disabled={disabled}
            className={cn('h-7 px-2.5 text-xs', selected ? undefined : 'text-muted-foreground')}
            onClick={() => {
              if (!selected) onChange(access)
            }}
          >
            {REPO_ACCESS_LABELS[access]}
          </Button>
        )
      })}
    </div>
  )
}

export function RepoAccessRow({
  repository,
  access,
  disabled,
  onChange
}: {
  repository: Repository
  access: RepoAccess
  disabled: boolean
  onChange: (next: RepoAccess) => void
}) {
  const note = repoAccessNote(access, repository.defaultBranch)

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-[12rem] flex-1">
        <p className="flex items-center gap-2 truncate text-sm font-medium">
          <span className="truncate font-mono">{repository.fullName}</span>
          {repository.private ? (
            <Badge variant="outline" className="font-normal">
              private
            </Badge>
          ) : null}
        </p>
        <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
          {note === undefined ? (
            <>
              <GitBranchIcon className="size-3 shrink-0" />
              <span className="truncate font-mono">{repository.defaultBranch}</span>
            </>
          ) : (
            <span className="truncate">{note}</span>
          )}
        </p>
      </div>
      <RepoAccessControl
        value={access}
        disabled={disabled}
        label={`Access to ${repository.fullName}`}
        onChange={onChange}
      />
    </li>
  )
}

/**
 * The Repositories tab (docs/build-plan-repositories.md, "The UI").
 *
 * The company attaches repositories once, under settings; this is where each
 * one is handed to this agent, and how. A repository the agent has no grant on
 * does not exist for it: not in its instructions, not in its checkouts (D14).
 */
export function AgentReposTab({
  agentId,
  repoGrants,
  canManage
}: {
  agentId: AgentId
  repoGrants: readonly AgentRepoGrant[]
  /** Company admin+ or the head of a department the agent is in. */
  canManage: boolean
}) {
  const repositories = useRepositories()
  const grantRepo = useGrantRepo()
  const revokeRepo = useRevokeRepo()

  const items = repositories.data?.items ?? []
  const pendingId = grantRepo.isPending
    ? grantRepo.variables?.repositoryId
    : revokeRepo.isPending
      ? revokeRepo.variables?.repositoryId
      : undefined

  const accessOf = (repository: Repository): RepoAccess =>
    repoGrants.find((grant) => grant.repositoryId === repository.id)?.mode ?? 'none'

  const change = (repository: Repository, next: RepoAccess): void => {
    if (next === 'none') {
      revokeRepo.mutate({ agentId, repositoryId: repository.id })
      return
    }
    grantRepo.mutate({ agentId, repositoryId: repository.id, mode: next })
  }

  return (
    <SettingsSection
      title="Repositories"
      description="Read-only gets the agent a checkout of the default branch it cannot push from. Read and write lets it push a branch and open a pull request, never to the default branch."
    >
      {repositories.isPending ? (
        <Skeleton className="h-32 rounded-lg" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<FolderGitIcon className="size-5" />}
          title="The company has no repositories yet"
          description="Connect GitHub and attach the repositories this company works in, then come back and hand them out one by one."
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/settings/repositories">Go to Repositories settings</Link>
            </Button>
          }
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {items.map((repository) => (
            <RepoAccessRow
              key={repository.id}
              repository={repository}
              access={accessOf(repository)}
              disabled={!canManage || pendingId === repository.id}
              onChange={(next) => change(repository, next)}
            />
          ))}
        </ul>
      )}

      {canManage || items.length === 0 ? null : (
        <div className="mt-4">
          <ReadOnlyNote />
        </div>
      )}
    </SettingsSection>
  )
}
