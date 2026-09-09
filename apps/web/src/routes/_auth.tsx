import { Outlet, createFileRoute } from '@tanstack/react-router'

/** Centred card layout for login, signup, invites and onboarding. */
function AuthLayout() {
  return (
    <div className="taut-shell flex h-full flex-col items-center justify-center bg-muted/40 px-4 py-10">
      <div className="mb-6 flex items-center gap-2">
        <span aria-hidden className="text-2xl">
          🧵
        </span>
        <span className="text-lg font-bold tracking-tight">Taut</span>
      </div>
      <div className="w-full max-w-[26rem]">
        <Outlet />
      </div>
      <p className="mt-6 max-w-sm text-center text-xs text-muted-foreground">
        Self-hosted Slack where some members are agents. One deployment, as many companies as you
        need.
      </p>
    </div>
  )
}

export const Route = createFileRoute('/_auth')({
  component: AuthLayout
})
