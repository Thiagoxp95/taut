import * as React from 'react'
import { Link, createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@taut/ui/components/card'
import { Field } from '@/components/page'
import { meQueryOptions, useLogin } from '@/lib/api'
import { qk } from '@/lib/query-keys'

function LoginRoute() {
  const navigate = useNavigate()
  const login = useLogin()
  const { queryClient } = Route.useRouteContext()
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    login.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => {
          queryClient.clear()
          void queryClient.invalidateQueries({ queryKey: qk.me })
          void navigate({ to: '/' })
        }
      }
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Log in</CardTitle>
        <CardDescription>Email and password. No third-party sign-in.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
          <Field label="Email" htmlFor="email">
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@acme.test"
            />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            className="mt-1 w-full"
            disabled={email.trim() === '' || password === '' || login.isPending}
          >
            {login.isPending ? 'Logging in…' : 'Log in'}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          No account yet?{' '}
          <Link
            to="/signup"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Create one
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}

export const Route = createFileRoute('/_auth/login')({
  beforeLoad: async ({ context }) => {
    // Already signed in: the shell decides where to land.
    const me = await context.queryClient.ensureQueryData(meQueryOptions).catch(() => undefined)
    if (me !== undefined) throw redirect({ to: '/' })
  },
  component: LoginRoute
})
