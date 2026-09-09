import * as React from 'react'
import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  HomeIcon,
  PlusIcon,
  TrashIcon,
  UploadIcon
} from 'lucide-react'
import type { AgentFileGrant, AgentId, FileGrantMode } from '@taut/contract'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { Skeleton } from '@taut/ui/components/skeleton'
import { toast } from '@taut/ui/components/sonner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/page'
import { SettingsSection } from '@/components/settings'
import { useAgentFiles, useGrantFile, useRevokeFileGrant, useUploadAgentFile } from '@/lib/api'
import { formatBytes, formatRelative } from '@/lib/format'

/** `path` in `files.list` is relative to home; '' is the home folder itself. */
const parentOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

const baseName = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
}

function Breadcrumb({ path, onNavigate }: { path: string; onNavigate: (next: string) => void }) {
  const segments = path === '' ? [] : path.split('/')

  return (
    <nav aria-label="Folder" className="flex flex-wrap items-center gap-1 text-xs">
      <button
        type="button"
        onClick={() => onNavigate('')}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <HomeIcon className="size-3.5" />
        home
      </button>
      {segments.map((segment, index) => {
        const target = segments.slice(0, index + 1).join('/')
        const last = index === segments.length - 1
        return (
          <React.Fragment key={target}>
            <ChevronRightIcon className="size-3 text-muted-foreground/60" />
            <button
              type="button"
              disabled={last}
              onClick={() => onNavigate(target)}
              className={
                last
                  ? 'rounded px-1.5 py-0.5 font-medium'
                  : 'rounded px-1.5 py-0.5 text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50'
              }
            >
              {segment}
            </button>
          </React.Fragment>
        )
      })}
    </nav>
  )
}

function HomeBrowser({ agentId }: { agentId: AgentId }) {
  const [path, setPath] = React.useState('')
  const files = useAgentFiles(agentId, path === '' ? undefined : path)
  const upload = useUploadAgentFile()
  const inputRef = React.useRef<HTMLInputElement>(null)

  const entries = [...(files.data?.items ?? [])].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.path.localeCompare(b.path)
  })

  const onPick = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    upload.mutate(
      { agentId, path: 'inbox', file },
      {
        onSuccess: () => {
          toast.success(`${file.name} is in the agent's inbox`)
          setPath('inbox')
        }
      }
    )
  }

  return (
    <SettingsSection
      title="Home folder"
      description="Everything the agent may write without an extra grant. Uploads land in inbox/."
      action={
        <>
          <input
            ref={inputRef}
            type="file"
            className="sr-only"
            aria-label="Upload a file to the agent's inbox"
            onChange={onPick}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={upload.isPending}
            onClick={() => inputRef.current?.click()}
          >
            <UploadIcon />
            {upload.isPending ? 'Uploading…' : 'Upload to inbox'}
          </Button>
        </>
      }
    >
      <div className="mb-2 flex items-center gap-2">
        <Breadcrumb path={path} onNavigate={setPath} />
        {path === '' ? null : (
          <Button size="xs" variant="ghost" onClick={() => setPath(parentOf(path))}>
            Up
          </Button>
        )}
      </div>

      {files.isPending ? (
        <Skeleton className="h-32 rounded-lg" />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<FolderIcon className="size-5" />}
          title={path === '' ? 'Nothing on disk yet' : 'This folder is empty'}
          description={
            path === ''
              ? 'The home folder — AGENT.md, skills/, memory/, inbox/, work/ — is created the first time the agent runs.'
              : 'Nothing here. Upload something, or let the agent write into it.'
          }
        />
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {entries.map((entry) => {
            const isDir = entry.kind === 'dir'
            return (
              <li key={entry.path}>
                <div
                  className={
                    isDir
                      ? 'flex w-full items-center gap-2 px-4 py-2.5'
                      : 'flex items-center gap-2 px-4 py-2.5'
                  }
                >
                  {isDir ? (
                    <button
                      type="button"
                      onClick={() => setPath(entry.path)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded text-left transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {baseName(entry.path)}/
                      </span>
                    </button>
                  ) : (
                    <>
                      <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {baseName(entry.path)}
                      </span>
                    </>
                  )}
                  <span className="w-20 text-right text-xs text-muted-foreground tabular-nums">
                    {isDir ? '' : formatBytes(entry.size)}
                  </span>
                  <span className="w-24 text-right text-xs text-muted-foreground">
                    {formatRelative(entry.modifiedAt)}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </SettingsSection>
  )
}

function GrantForm({ agentId }: { agentId: AgentId }) {
  const grantFile = useGrantFile()
  const [path, setPath] = React.useState('')
  const [mode, setMode] = React.useState<FileGrantMode>('ro')

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (path.trim() === '') return
        grantFile.mutate({ agentId, path: path.trim(), mode }, { onSuccess: () => setPath('') })
      }}
    >
      <div className="min-w-[14rem] flex-1">
        <label htmlFor="grant-path" className="sr-only">
          Absolute path
        </label>
        <Input
          id="grant-path"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/srv/repos/acme-api"
          className="font-mono text-xs"
        />
      </div>
      <Select
        value={mode}
        onValueChange={(next) => {
          if (next === 'ro' || next === 'rw') setMode(next)
        }}
      >
        <SelectTrigger className="w-40" aria-label="Grant mode">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ro">Read only</SelectItem>
          <SelectItem value="rw">Read and write</SelectItem>
        </SelectContent>
      </Select>
      <Button type="submit" variant="outline" disabled={path.trim() === '' || grantFile.isPending}>
        <PlusIcon />
        Grant
      </Button>
    </form>
  )
}

export function AgentFilesTab({
  agentId,
  fileGrants,
  canManage
}: {
  agentId: AgentId
  fileGrants: readonly AgentFileGrant[]
  /** Grants are admin+/head only; uploading into `inbox/` is open to any member. */
  canManage: boolean
}) {
  const revokeGrant = useRevokeFileGrant()
  const [revoking, setRevoking] = React.useState<AgentFileGrant | null>(null)

  return (
    <>
      <HomeBrowser agentId={agentId} />

      <SettingsSection
        title="Grants outside its home"
        description="Paths the agent may read or write. Everything else on the machine is off limits."
      >
        <div className="rounded-lg border">
          {canManage ? (
            <div className="border-b p-4">
              <GrantForm agentId={agentId} />
            </div>
          ) : null}
          {fileGrants.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No extra paths — the agent can only touch its own home folder.
            </p>
          ) : (
            <ul className="divide-y">
              {fileGrants.map((grant) => (
                <li
                  key={`${grant.path}:${grant.mode}`}
                  className="flex items-center gap-3 px-4 py-2.5"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{grant.path}</span>
                  <Badge variant={grant.mode === 'rw' ? 'default' : 'outline'}>
                    {grant.mode === 'rw' ? 'read/write' : 'read only'}
                  </Badge>
                  {canManage ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Revoke access to ${grant.path}`}
                      onClick={() => setRevoking(grant)}
                    >
                      <TrashIcon />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsSection>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(next) => {
          if (!next) setRevoking(null)
        }}
        title="Revoke this path?"
        confirmLabel="Revoke"
        pending={revokeGrant.isPending}
        description={
          <p>
            The agent loses access to <code className="font-mono">{revoking?.path}</code> on its
            next task. Files already copied into its home stay there.
          </p>
        }
        onConfirm={() => {
          if (revoking === null) return
          revokeGrant.mutate(
            { agentId, path: revoking.path },
            { onSuccess: () => setRevoking(null) }
          )
        }}
      />
    </>
  )
}
