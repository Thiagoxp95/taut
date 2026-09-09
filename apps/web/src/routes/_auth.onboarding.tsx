import * as React from 'react'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@taut/ui/components/card'
import { Field } from '@/components/page'
import { EmojiPicker } from '@/components/emoji-picker'
import { GithubConnectButton } from '@/components/github-connect'
import { meQueryOptions, useCreateCompany } from '@/lib/api'
import { slugify } from '@/lib/format'

function CreateCompanyStep({ onCreated }: { onCreated: () => void }) {
  const { queryClient } = Route.useRouteContext()
  const createCompany = useCreateCompany()
  const [name, setName] = React.useState('')
  const [slug, setSlug] = React.useState('')
  const [slugTouched, setSlugTouched] = React.useState(false)
  const [avatar, setAvatar] = React.useState('🅰️')

  const effectiveSlug = slugTouched ? slug : slugify(name)

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (name.trim() === '' || effectiveSlug === '') return
    createCompany.mutate(
      { name: name.trim(), slug: effectiveSlug, avatar: { kind: 'emoji', value: avatar } },
      {
        onSuccess: () => {
          queryClient.clear()
          onCreated()
        }
      }
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Create your first company</CardTitle>
        <CardDescription>
          Everything in Taut hangs off a company: its vault, its subscriptions, its agents and their
          files. Nothing crosses the boundary.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="flex gap-4">
            <Field label="Avatar" htmlFor="company-avatar">
              <EmojiPicker id="company-avatar" value={avatar} onChange={setAvatar} />
            </Field>
            <Field label="Company name" htmlFor="company-name" className="flex-1">
              <Input
                id="company-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Acme"
                autoComplete="organization"
              />
            </Field>
          </div>
          <Field
            label="Slug"
            htmlFor="company-slug"
            hint={`Files live at /data/companies/${effectiveSlug === '' ? '<slug>' : effectiveSlug}/`}
          >
            <Input
              id="company-slug"
              value={effectiveSlug}
              onChange={(event) => {
                setSlugTouched(true)
                setSlug(slugify(event.target.value))
              }}
              placeholder="acme"
              className="font-mono text-xs"
            />
          </Field>
          <Button
            type="submit"
            className="mt-1 w-full"
            disabled={name.trim() === '' || effectiveSlug === '' || createCompany.isPending}
          >
            {createCompany.isPending ? 'Creating…' : 'Create company'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

/**
 * The optional second step (docs/build-plan-repositories.md D11). The company
 * already exists and is fully usable by the time this shows, so skipping costs
 * nothing and GitHub is never touched.
 */
function ConnectGithubStep() {
  const navigate = useNavigate()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Connect GitHub</CardTitle>
        <CardDescription>
          Your company is ready. If your agents will work in code, connect GitHub now and pick the
          repositories that belong to this company. Each agent then gets them one at a time,
          read-only or read and write.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <GithubConnectButton block label="Connect GitHub" />
        <Button variant="ghost" className="w-full" onClick={() => void navigate({ to: '/' })}>
          Skip for now
        </Button>
        <p className="mt-1 text-center text-xs text-muted-foreground">
          You can do this later under Settings, Repositories. Nothing else waits on it.
        </p>
      </CardContent>
    </Card>
  )
}

function OnboardingRoute() {
  const [created, setCreated] = React.useState(false)
  return created ? <ConnectGithubStep /> : <CreateCompanyStep onCreated={() => setCreated(true)} />
}

export const Route = createFileRoute('/_auth/onboarding')({
  /** Creating a company needs a session; it does not need a company. */
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQueryOptions).catch(() => undefined)
    if (me === undefined) throw redirect({ to: '/login' })
  },
  component: OnboardingRoute
})
