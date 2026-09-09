import * as React from 'react'
import type { AgentId } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@taut/ui/components/dialog'
import {
  SecretFields,
  emptySecret,
  isSecretReady,
  secretToStore,
  type NewSecret
} from '@/components/secret-fields'
import { useAddVaultItem } from '@/lib/api'

/**
 * The one "add a secret" form, for both vault scopes.
 *
 * Mount it *inside* a `DialogContent` and never outside one: Radix unmounts the
 * subtree on close, so the plaintext secret exists in exactly one place, for
 * exactly as long as the dialog is on screen.
 *
 * `agentId` decides the scope — absent = a company item every agent may use,
 * present = an item only that agent can resolve.
 */
export function AddSecretForm({ agentId, onDone }: { agentId?: AgentId; onDone: () => void }) {
  const [value, setValue] = React.useState<NewSecret>(emptySecret)
  const addItem = useAddVaultItem()
  const scoped = agentId !== undefined

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!isSecretReady(value)) return
    addItem.mutate(
      { kind: value.kind, label: value.label.trim(), secret: secretToStore(value), agentId },
      { onSuccess: onDone }
    )
  }

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{scoped ? 'Add a secret for this agent' : 'Add a secret'}</DialogTitle>
        <DialogDescription>
          {scoped ? 'Only this agent can resolve it. ' : 'Every agent in the company can use it. '}
          Encrypted with AES-256-GCM under this company&apos;s own key. Taut never returns the
          plaintext — after you save this, only the last four characters are ever shown.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-4">
        <SecretFields
          idPrefix={scoped ? 'agent-vault' : 'vault'}
          value={value}
          onChange={setValue}
          autoFocus
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!isSecretReady(value) || addItem.isPending}>
          {addItem.isPending ? 'Encrypting…' : 'Encrypt and store'}
        </Button>
      </DialogFooter>
    </form>
  )
}
