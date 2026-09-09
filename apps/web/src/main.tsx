import './styles/globals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'

import { reportApiError, setUnauthorizedHandler } from '@/lib/error-toast'
import { setupPwa } from '@/lib/pwa'
import { routeTree } from './routeTree.gen'

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => reportApiError(error, { silent: query.meta?.silent === true })
  }),
  mutationCache: new MutationCache({
    onError: (error) => reportApiError(error)
  }),
  defaultOptions: {
    queries: {
      // Realtime keeps the cache fresh; polling would fight the event log.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1
    }
  }
})

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
  context: { queryClient }
})

setUnauthorizedHandler(() => {
  queryClient.clear()
  void router.navigate({ to: '/login' })
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// Installable shell + push service worker. A notification clicked into an already
// open window routes here instead of reloading the SPA.
setupPwa({ onNavigate: (path) => void router.navigate({ to: path }) })

const container = document.getElementById('root')
if (container === null) throw new Error('Missing #root element')

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
)
