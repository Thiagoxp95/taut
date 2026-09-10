import * as React from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  BuildingIcon,
  ChevronRightIcon,
  FolderGitIcon,
  SparklesIcon,
  TriangleAlertIcon
} from '@taut/ui/components/icons'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { EmojiPicker } from '@/components/emoji-picker'
import { PageBody, PageHeader, ReadOnlyNote } from '@/components/page'
import {
  InputAffix,
  SettingsCallout,
  SettingsCard,
  SettingsRow,
  SettingsSave,
  SettingsShell,
  affixInputClass
} from '@/components/settings'
import { WorkspaceSettingsNav } from '@/components/settings-nav'
import {
  useCanAdminister,
  useCompanies,
  useGithubConnection,
  useMe,
  useMyRole,
  useRepositories,
  useUpdateCompany
} from '@/lib/api'
import { formatRelative } from '@/lib/format'

/** One line under the link: where the company stands, and what to do about it. */
const githubSummary = (state: string | undefined, count: number): string => {
  if (state === 'connected') {
    return count === 0
      ? 'GitHub is connected. Attach the repositories this company works in.'
      : `GitHub is connected. ${count} ${count === 1 ? 'repository' : 'repositories'} attached.`
  }
  if (state === 'app-created') return 'The GitHub App is created but not installed yet.'
  return 'Connect GitHub to give agents repositories to read and open pull requests against.'
}

function CompanySettingsRoute() {
  const me = useMe().data
  const companies = useCompanies()
  const role = useMyRole()
  const canManage = useCanAdminister()
  const connection = useGithubConnection()
  const repositoryCount = useRepositories().data?.items.length ?? 0
  const updateCompany = useUpdateCompany()

  const company = companies.data?.items.find(
    (entry) => entry.company.id === me?.activeCompanyId
  )?.company

  // `null` is "unedited": the saved company is the source of truth until it is not.
  const [draft, setDraft] = React.useState<{ name: string; emoji: string } | null>(null)
  const [calloutDismissed, setCalloutDismissed] = React.useState(false)

  const savedEmoji = company?.avatar.kind === 'emoji' ? company.avatar.value : '🅰️'
  const form = draft ?? { name: company?.name ?? '', emoji: savedEmoji }
  const dirty = draft !== null && (form.name !== company?.name || form.emoji !== savedEmoji)

  const identityIncomplete = company !== undefined && company.avatar.kind !== 'emoji'

  const save = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!dirty || company === undefined) return
    updateCompany.mutate(
      {
        companyId: company.id,
        name: form.name.trim(),
        avatar: { kind: 'emoji', value: form.emoji }
      },
      { onSuccess: () => setDraft(null) }
    )
  }

  return (
    <>
      <PageHeader
        title="Organization"
        description="Identity, code and membership."
        icon={<BuildingIcon className="size-4" />}
      />
      <PageBody>
        <SettingsShell nav={<WorkspaceSettingsNav />}>
          {identityIncomplete && !calloutDismissed ? (
            <SettingsCallout
              icon={<SparklesIcon />}
              title="Give the organization a face."
              description="Pick an emoji so it is recognisable in the switcher and the sidebar."
              onDismiss={() => setCalloutDismissed(true)}
              action={
                <Button size="sm" onClick={() => setDraft({ ...form })}>
                  Update
                </Button>
              }
            />
          ) : null}

          <div className="grid gap-6">
            <SettingsCard
              title="Identity"
              description="How this organization appears everywhere in Taut."
              onSubmit={save}
              footer={
                canManage ? (
                  <SettingsSave
                    dirty={dirty}
                    pending={updateCompany.isPending}
                    onCancel={() => setDraft(null)}
                  />
                ) : (
                  <ReadOnlyNote />
                )
              }
            >
              <SettingsRow
                label="Avatar"
                description="Shown in the organization switcher and on every channel it owns."
                htmlFor="company-avatar"
              >
                <div className="flex items-center gap-3">
                  <EmojiPicker
                    id="company-avatar"
                    value={form.emoji}
                    onChange={(next) => setDraft({ ...form, emoji: next })}
                    className="size-12 text-2xl"
                  />
                  <span className="text-sm text-muted-foreground">
                    Click to pick another emoji.
                  </span>
                </div>
              </SettingsRow>

              <SettingsRow
                label="Name"
                description="Used across the workspace and in every invite."
                htmlFor="company-name"
              >
                <Input
                  id="company-name"
                  readOnly={!canManage}
                  value={form.name}
                  onChange={(event) => setDraft({ ...form, name: event.target.value })}
                />
              </SettingsRow>

              <SettingsRow
                label="Slug"
                badge={<Badge variant="outline">Fixed</Badge>}
                description="The on-disk folder at /data/companies. It is set at creation and never changes."
                htmlFor="company-slug"
              >
                <InputAffix prefix="/data/companies/">
                  <Input
                    id="company-slug"
                    readOnly
                    value={company?.slug ?? ''}
                    className={`${affixInputClass} font-mono text-xs`}
                  />
                </InputAffix>
              </SettingsRow>

              <SettingsRow label="Created" description="When this organization was opened.">
                <p className="text-sm text-muted-foreground">
                  {company === undefined ? '—' : formatRelative(company.createdAt)}
                </p>
              </SettingsRow>
            </SettingsCard>

            <SettingsCard
              title="Code"
              description="The GitHub repositories agents in this organization can work in."
            >
              <SettingsRow
                label="Repositories"
                description={githubSummary(connection.data?.state, repositoryCount)}
                stacked
              >
                <Button asChild variant="outline" className="w-fit">
                  <Link to="/settings/repositories">
                    <FolderGitIcon />
                    Manage repositories
                    <ChevronRightIcon />
                  </Link>
                </Button>
              </SettingsRow>
            </SettingsCard>

            <SettingsCard
              title="Your membership"
              description="Roles are managed on the Members page."
            >
              <SettingsRow
                label={me?.user.name ?? '—'}
                description={me?.user.email ?? '—'}
                badge={<Badge variant="secondary">{role ?? 'member'}</Badge>}
                stacked
              >
                <Button asChild variant="outline" className="w-fit">
                  <Link to="/members">
                    Open members
                    <ChevronRightIcon />
                  </Link>
                </Button>
              </SettingsRow>
            </SettingsCard>

            {canManage ? null : (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <TriangleAlertIcon className="size-3.5" />
                Only an owner or an admin can change the organization.
              </p>
            )}
          </div>
        </SettingsShell>
      </PageBody>
    </>
  )
}

export const Route = createFileRoute('/_app/settings/company')({
  component: CompanySettingsRoute
})
