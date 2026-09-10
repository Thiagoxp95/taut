import { Outlet, createFileRoute, useLocation } from '@tanstack/react-router'
import { Button } from '@taut/ui/components/button'

/** Centred card layout for login, signup, invites and onboarding. */
function AuthLayout() {
  const pathname = useLocation({ select: (location) => location.pathname })
  const desktop = window.taut
  return (
    <div className="taut-shell flex min-h-dvh flex-col items-center justify-center bg-muted/40 px-4 py-10">
      <div className="mb-6 flex items-center gap-2">
        <span aria-hidden className="text-2xl">
          🧵
        </span>
        <span className="text-lg font-bold tracking-tight">Taut</span>
      </div>
      <div className="w-full max-w-[26rem]">
        <Outlet />
        {desktop && pathname === '/login' && (
          <div className="mt-4 flex flex-col items-center gap-1 text-center">
            <p className="max-w-full break-all text-xs text-muted-foreground">
              Server: {window.location.origin}
            </p>
            {desktop.changeServer ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => desktop.changeServer?.()}
              >
                Change server
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                To change servers, choose {desktop.platform === 'darwin' ? 'Taut' : 'File'} → Switch
                instance… from the app menu.
              </p>
            )}
          </div>
        )}
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
