import * as React from 'react'
import { Link, createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@taut/ui/components/card'
import { Field } from '@/components/page'
import { meQueryOptions, useSignup } from '@/lib/api'

const MIN_PASSWORD = 8

function SignupRoute() {
  const navigate = useNavigate()
  const signup = useSignup()
  const { queryClient } = Route.useRouteContext()
  const [name, setName] = React.useState('')
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')

  const ready = name.trim() !== '' && email.trim() !== '' && password.length >= MIN_PASSWORD

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!ready) return
    signup.mutate(
      { name: name.trim(), email: email.trim(), password },
      {
        onSuccess: () => {
          queryClient.clear()
          void navigate({ to: '/onboarding' })
        }
      }
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Create your account</CardTitle>
        <CardDescription>
          On a fresh instance the first account becomes the owner of the first company.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
          <Field label="Name" htmlFor="name">
            <Input
              id="name"
              name="name"
              autoComplete="name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ada Osei"
            />
          </Field>
          <Field label="Email" htmlFor="email">
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@acme.test"
            />
          </Field>
          <Field
            label="Password"
            htmlFor="password"
            hint={`At least ${MIN_PASSWORD} characters. Hashed with scrypt, never stored in the clear.`}
          >
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Button type="submit" className="mt-1 w-full" disabled={!ready || signup.isPending}>
            {signup.isPending ? 'Creating…' : 'Create account'}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Already have one?{' '}
          <Link
            to="/login"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Log in
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}

export const Route = createFileRoute('/_auth/signup')({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQueryOptions).catch(() => undefined)
    if (me !== undefined) throw redirect({ to: '/' })
  },
  component: SignupRoute
})
