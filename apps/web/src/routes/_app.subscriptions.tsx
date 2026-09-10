import * as React from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import type { RuntimeKind, Subscription } from '@taut/contract'
import { ChevronRightIcon, CreditCardIcon, LockIcon, PlusIcon } from '@taut/ui/components/icons'
import { Button } from '@taut/ui/components/button'
import { Skeleton } from '@taut/ui/components/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageBody, PageHeader } from '@/components/page'
import { ProviderAccounts } from '@/components/provider-accounts'
import { ProviderConnectDialog } from '@/components/provider-connect-dialog'
import { SettingsShell } from '@/components/settings'
import { WorkspaceSettingsNav } from '@/components/settings-nav'
import { useTicker } from '@/hooks/use-ticker'
import { useCanAdminister, useRemoveSubscription, useSubscriptions, useVaultItems } from '@/lib/api'
import { ROTATION_RULE, RUNTIME_ORDER } from '@/lib/runtime-meta'

function SubscriptionsRoute() {
  const query = useSubscriptions()
  const vault = useVaultItems()
  const canAdminister = useCanAdminister()
  const remove = useRemoveSubscription()
  const [connecting, setConnecting] = React.useState<RuntimeKind | 'choose' | null>(null)
  const [removing, setRemoving] = React.useState<Subscription | null>(null)
  const accounts = query.data?.items ?? []
  const now = useTicker(
    1000,
    accounts.some((account) => account.cooldownUntil !== undefined || account.limits.length > 0)
  )
  return (
    <>
      <PageHeader
        title="Providers"
        description="Connect the accounts your agents use."
        icon={<CreditCardIcon className="size-4" />}
      />
      <PageBody>
        <SettingsShell nav={<WorkspaceSettingsNav />}>
          <div className="max-w-3xl">
            <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold">Your accounts</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Use your own subscriptions and API keys.
                </p>
              </div>
              {canAdminister ? (
                <Button size="sm" onClick={() => setConnecting('choose')}>
                  <PlusIcon />
                  Connect provider
                </Button>
              ) : null}
            </div>
            {query.isPending ? (
              <div className="space-y-5" aria-label="Loading providers">
                {[0, 1, 2, 3].map((n) => (
                  <Skeleton key={n} className="h-24 rounded-lg" />
                ))}
              </div>
            ) : query.isError ? (
              <div role="alert" className="rounded-lg border p-4">
                <p className="text-sm">Could not load your accounts.</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => void query.refetch()}
                >
                  Try again
                </Button>
              </div>
            ) : (
              <div className="divide-y">
                {RUNTIME_ORDER.map((runtime) => (
                  <ProviderAccounts
                    key={runtime}
                    runtime={runtime}
                    accounts={accounts.filter((account) => account.runtime === runtime)}
                    vaultItems={vault.data?.items ?? []}
                    canAdminister={canAdminister}
                    now={now}
                    onConnect={() => setConnecting(runtime)}
                    onRemove={setRemoving}
                  />
                ))}
              </div>
            )}
            <div className="mt-2 space-y-4 border-t pt-5">
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <LockIcon className="size-3.5 shrink-0" />
                <span>
                  Credentials are encrypted in your{' '}
                  <Link to="/vault" className="underline underline-offset-2">
                    workspace vault
                  </Link>
                  .
                </span>
              </p>
              <details className="group text-xs text-muted-foreground">
                <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                  <ChevronRightIcon className="size-3.5 group-open:rotate-90" />
                  How accounts are used
                </summary>
                <p className="mt-2 max-w-xl leading-relaxed">{ROTATION_RULE}</p>
              </details>
            </div>
          </div>
        </SettingsShell>
      </PageBody>
      {connecting === null ? null : (
        <ProviderConnectDialog runtime={connecting} onClose={() => setConnecting(null)} />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
        title={`Remove ${removing?.label ?? 'this account'}?`}
        confirmLabel="Remove account"
        pending={remove.isPending}
        description={
          <>
            <p>Agents will use another available account on their next task.</p>
            <p>The saved credential stays in your vault.</p>
          </>
        }
        onConfirm={() => {
          if (removing) remove.mutate(removing.id, { onSuccess: () => setRemoving(null) })
        }}
      />
    </>
  )
}
export const Route = createFileRoute('/_app/subscriptions')({ component: SubscriptionsRoute })
