import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProviderConnectDialog } from '../src/components/provider-connect-dialog'
import '../src/styles/globals.css'

function App() {
  const [open, setOpen] = React.useState(true)
  return open ? (
    <ProviderConnectDialog runtime="claude-code" onClose={() => setOpen(false)} />
  ) : (
    <p>Connected</p>
  )
}

createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <App />
  </QueryClientProvider>
)
