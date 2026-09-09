import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { CompanyId } from '@taut/contract'

import { useSwitchCompany } from '@/lib/api'
import { live } from '@/lib/live'
import { realtime } from '@/lib/ws'

/**
 * Switching company is a hard boundary: the session's active company changes,
 * every cached list belongs to the old one, and the event sequence restarts.
 * So: switch → drop the cache → reopen the socket at `since=0` → land on `/`.
 */
export function useCompanySwitcher(): (companyId: CompanyId) => Promise<void> {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const switchCompany = useSwitchCompany()
  const switchAsync = switchCompany.mutateAsync

  return React.useCallback(
    async (companyId: CompanyId) => {
      await switchAsync(companyId)
      live.reset()
      queryClient.clear()
      realtime.reset(companyId)
      await navigate({ to: '/' })
    },
    [switchAsync, queryClient, navigate]
  )
}
