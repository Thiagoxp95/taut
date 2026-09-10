import * as React from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { MailCheckIcon, PartyPopperIcon } from '@taut/ui/components/icons'
import { AcceptInviteResult } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@taut/ui/components/card'
import { Field } from '@/components/page'
import { useAcceptInvite, useInvitePreview, useMe } from '@/lib/api'

const MIN_PASSWORD = 8

function Shell({
  icon,
  title,
  description,
  children
}: {
  icon: React.ReactNode
  title: string
  description: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <div className="mb-1 flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {icon}
        </div>
        <CardTitle className="text-xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children === undefined ? null : <CardContent>{children}</CardContent>}
    </Card>
  )
}

/**
 * The preview (public: the token is the capability) says who the invite is for,
 * which is what decides the form. The session only skips the credentials when it
 * belongs to that same email — signed in as somebody else still has to
 * authenticate as the invitee, exactly as the server does.
 */
function InviteRoute() {
  const { token } = Route.useParams()
  const navigate = useNavigate()
  const me = useMe()
  const preview = useInvitePreview(token)
  const acceptInvite = useAcceptInvite()
  const [name, setName] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [accepted, setAccepted] = React.useState<typeof AcceptInviteResult.Type | null>(null)
  // Read once, on mount: an invite must not expire mid-render because the component
  // happened to re-render a millisecond past the deadline.
  const [openedAt] = React.useState(() => Date.now())

  const invite = preview.data
  const asInvitee = invite !== undefined && me.data?.user.email === invite.email
  const needsName = invite !== undefined && !invite.hasAccount
  const ready = asInvitee || (password.length >= MIN_PASSWORD && (!needsName || name.trim() !== ''))

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!ready) return
    acceptInvite.mutate(
      asInvitee ? { token } : { token, password, ...(needsName ? { name: name.trim() } : {}) },
      { onSuccess: (result) => setAccepted(result) }
    )
  }

  if (accepted !== null) {
    return (
      <Shell
        icon={<PartyPopperIcon className="size-4" />}
        title={`You are in, ${accepted.user.name}`}
        description={
          <>
            You joined <strong>{accepted.company.name}</strong> as {accepted.membership.role}.
          </>
        }
      >
        <Button className="w-full" onClick={() => void navigate({ to: '/' })}>
          Open {accepted.company.name}
        </Button>
      </Shell>
    )
  }

  if (preview.isPending) {
    return (
      <Shell
        icon={<MailCheckIcon className="size-4" />}
        title="Checking this invite"
        description="One moment."
      />
    )
  }

  if (invite === undefined) {
    return (
      <Shell
        icon={<MailCheckIcon className="size-4" />}
        title="This invite is not valid"
        description="The link is wrong or the invite was revoked. Ask whoever invited you for a new one."
      />
    )
  }

  if (invite.acceptedAt !== undefined) {
    return (
      <Shell
        icon={<MailCheckIcon className="size-4" />}
        title="This invite was already accepted"
        description={
          <>
            Sign in as {invite.email} to open <strong>{invite.company.name}</strong>.
          </>
        }
      >
        <Button className="w-full" onClick={() => void navigate({ to: '/login' })}>
          Go to sign in
        </Button>
      </Shell>
    )
  }

  if (invite.expiresAt.epochMillis <= openedAt) {
    return (
      <Shell
        icon={<MailCheckIcon className="size-4" />}
        title="This invite has expired"
        description={`Invites last seven days. Ask ${invite.inviterName} to send another one.`}
      />
    )
  }

  return (
    <Shell
      icon={<MailCheckIcon className="size-4" />}
      title={`Join ${invite.company.name}`}
      description={
        asInvitee ? (
          <>
            {invite.inviterName} invited you as {invite.role}. Accept as {invite.email}.
          </>
        ) : needsName ? (
          <>
            {invite.inviterName} invited {invite.email} as {invite.role}. Set a name and a password
            to create the account.
          </>
        ) : (
          <>
            {invite.inviterName} invited {invite.email} as {invite.role}. Enter that account&apos;s
            password to accept.
          </>
        )
      }
    >
      <form className="grid gap-4" onSubmit={submit}>
        {asInvitee ? null : (
          <>
            {needsName ? (
              <Field label="Name" htmlFor="name">
                <Input
                  id="name"
                  name="name"
                  autoComplete="name"
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Your name"
                />
              </Field>
            ) : null}
            <Field
              label="Password"
              htmlFor="password"
              {...(needsName ? { hint: `At least ${MIN_PASSWORD} characters.` } : {})}
            >
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={needsName ? 'new-password' : 'current-password'}
                autoFocus={!needsName}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          </>
        )}
        <Button type="submit" className="mt-1 w-full" disabled={!ready || acceptInvite.isPending}>
          {acceptInvite.isPending ? 'Accepting…' : 'Accept invite'}
        </Button>
      </form>
    </Shell>
  )
}

export const Route = createFileRoute('/_auth/invite/$token')({
  component: InviteRoute
})
