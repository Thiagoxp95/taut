import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { GithubConnectButton } from '../src/components/github-connect'

createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={new QueryClient()}>
    <GithubConnectButton />
  </QueryClientProvider>
)
