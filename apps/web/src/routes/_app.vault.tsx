import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { KeyRoundIcon, LockIcon, PlusIcon, ShieldAlertIcon, TrashIcon } from '@taut/ui/components/icons'
import type { VaultItemMeta } from '@taut/contract'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Skeleton } from '@taut/ui/components/skeleton'
import { Dialog, DialogContent } from '@taut/ui/components/dialog'
import { AddSecretForm } from '@/components/add-secret-form'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState, PageBody, PageHeader } from '@/components/page'
import { SettingsCallout, SettingsCard, SettingsShell } from '@/components/settings'
import { WorkspaceSettingsNav } from '@/components/settings-nav'
import {
  useAgents,
  useCanAdminister,
  useRevokeVaultItem,
  useSubscriptions,
  useVaultItems
} from '@/lib/api'
import { formatRelative, toIso } from '@/lib/format'
import { CREDENTIAL_LABELS, isSubscriptionSeat } from '@/lib/runtime-meta'

function AddSecretDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <AddSecretForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function VaultRoute() {
  const query = useVaultItems()
  const subscriptions = useSubscriptions().data?.items ?? []
  const agents = useAgents().data?.items ?? []
  const revokeItem = useRevokeVaultItem()
  const canAdminister = useCanAdminister()

  const [adding, setAdding] = React.useState(false)
  const [revoking, setRevoking] = React.useState<VaultItemMeta | null>(null)

  const items = query.data?.items ?? []
  const agentName = (id: string | undefined): string | undefined =>
    agents.find((agent) => agent.id === id)?.handle

  const seatsUsing = (item: VaultItemMeta): readonly string[] =>
    subscriptions.filter((entry) => entry.credentialId === item.id).map((entry) => entry.label)

  const addButton = canAdminister ? (
    <Button size="sm" onClick={() => setAdding(true)}>
      <PlusIcon />
      Add secret
    </Button>
  ) : undefined

  return (
    <>
      <PageHeader
        title="Vault"
        description="Company credentials. Every agent can use them, encrypted at rest, decrypted only at spawn time."
        icon={<KeyRoundIcon className="size-4" />}
        actions={addButton}
      />
      <PageBody>
        <SettingsShell nav={<WorkspaceSettingsNav />}>
          <SettingsCallout
            icon={<ShieldAlertIcon />}
            title="Secrets never come back to the browser."
            description="Runtime output is redacted before it reaches a channel or the database. Subscription seats — a Claude or OpenAI token rather than an API key — are shared logins: check your provider's terms."
          />

          <SettingsCard
            title="Company secrets"
            description="Every agent can use these. A secret only one agent should hold belongs on that agent's page, under Agent vault."
            action={addButton}
          >
            {query.isPending ? (
              <Skeleton className="m-6 h-48 rounded-lg" />
            ) : items.length === 0 ? (
              <div className="px-6 py-5">
                <EmptyState
                  icon={<KeyRoundIcon className="size-5" />}
                  title="The vault is empty"
                  description={
                    canAdminister
                      ? 'Add a credential before connecting a runtime — every seat in the pool points at one.'
                      : 'Only owners and admins can add or revoke company credentials.'
                  }
                  action={
                    canAdminister ? (
                      <Button size="sm" onClick={() => setAdding(true)}>
                        Add your first secret
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-6 py-2.5 text-left font-medium">Label</th>
                      <th className="px-4 py-2.5 text-left font-medium">Kind</th>
                      <th className="px-4 py-2.5 text-left font-medium">Hint</th>
                      <th className="px-4 py-2.5 text-left font-medium">Created</th>
                      <th className="px-4 py-2.5 text-left font-medium">Last used</th>
                      {canAdminister ? <th className="w-10 px-4 py-2.5" /> : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {items.map((item) => {
                      const usedBy = agentName(item.lastUsedBy)
                      return (
                        <tr key={item.id} className="transition-colors hover:bg-muted/40">
                          <td className="px-6 py-3">
                            <span className="font-medium">{item.label}</span>
                            {isSubscriptionSeat(item.kind) ? (
                              <span className="ml-2 text-[11px] text-muted-foreground">
                                subscription seat
                              </span>
                            ) : null}
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="outline">{CREDENTIAL_LABELS[item.kind]}</Badge>
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                            ••••{item.hint}
                          </td>
                          <td
                            className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground"
                            title={toIso(item.createdAt)}
                          >
                            {formatRelative(item.createdAt)}
                          </td>
                          <td className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground">
                            {item.lastUsedAt === undefined ? (
                              'never'
                            ) : (
                              <>
                                {formatRelative(item.lastUsedAt)}
                                {usedBy === undefined ? null : (
                                  <span className="ml-1 font-mono">@{usedBy}</span>
                                )}
                              </>
                            )}
                          </td>
                          {canAdminister ? (
                            <td className="px-4 py-3">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Revoke ${item.label}`}
                                onClick={() => setRevoking(item)}
                              >
                                <TrashIcon />
                              </Button>
                            </td>
                          ) : null}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </SettingsCard>

          {canAdminister ? null : (
            <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
              <LockIcon className="size-3.5" />
              You can see what the company holds; adding and revoking is owner and admin only.
            </p>
          )}
        </SettingsShell>
      </PageBody>

      <AddSecretDialog open={adding} onOpenChange={setAdding} />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(next) => {
          if (!next) setRevoking(null)
        }}
        title={`Revoke ${revoking?.label ?? 'this secret'}?`}
        confirmLabel="Revoke"
        pending={revokeItem.isPending}
        description={
          <>
            <p>
              The ciphertext is deleted and any task currently resolving it is cancelled. This
              cannot be undone — you would have to paste the secret again.
            </p>
            {revoking !== null && seatsUsing(revoking).length > 0 ? (
              <p className="text-destructive">
                {seatsUsing(revoking).length === 1 ? 'This seat' : 'These seats'} run on it and will
                be removed with it: {seatsUsing(revoking).join(', ')}.
              </p>
            ) : null}
          </>
        }
        onConfirm={() => {
          if (revoking === null) return
          revokeItem.mutate(revoking.id, { onSuccess: () => setRevoking(null) })
        }}
      />
    </>
  )
}

export const Route = createFileRoute('/_app/vault')({
  component: VaultRoute
})
