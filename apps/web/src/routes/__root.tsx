import type { QueryClient } from '@tanstack/react-query'
import { Link, Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import { CompassIcon } from '@taut/ui/components/icons'
import { Button } from '@taut/ui/components/button'
import { Toaster } from '@taut/ui/components/sonner'
import { TooltipProvider } from '@taut/ui/components/tooltip'

export interface RouterContext {
  readonly queryClient: QueryClient
}

function RootLayout() {
  return (
    <TooltipProvider>
      <div className="h-full font-sans antialiased">
        <Outlet />
      </div>
      <Toaster />
    </TooltipProvider>
  )
}

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <CompassIcon className="size-6" />
      </div>
      <div>
        <h1 className="text-lg font-semibold">This page does not exist</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The link may be stale, or the channel was archived.
        </p>
      </div>
      <Button asChild size="sm">
        <Link to="/">Back to Taut</Link>
      </Button>
    </div>
  )
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound
})
