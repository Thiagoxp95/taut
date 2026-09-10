import * as React from 'react'
import type { CredentialKind, RuntimeKind, VaultItemId } from '@taut/contract'
import { RuntimeCredentialKinds } from '@taut/contract'
import type { ClaudeDesktopLogin } from '@taut/contract/desktop'
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  CreditCardIcon,
  KeyRoundIcon,
  LockIcon
} from '@taut/ui/components/icons'
import { Button } from '@taut/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@taut/ui/components/dialog'
import { RuntimeIcon } from '@/components/runtime-icon'
import { SecretFields, emptySecret, isSecretReady, secretToStore } from '@/components/secret-fields'
import { useAddSubscription, useAddVaultItem, useCheckSubscription } from '@/lib/api'
import { connectClaude } from '@/lib/claude-connect'
import {
  CREDENTIAL_LABELS,
  RUNTIME_LABELS,
  RUNTIME_ORDER,
  isSubscriptionSeat
} from '@/lib/runtime-meta'

export const PROVIDER_DESCRIPTION: Record<RuntimeKind, string> = {
  'claude-code': 'Use your Claude subscription or an Anthropic API key.',
  codex: 'Use your ChatGPT subscription or an OpenAI API key.',
  cursor: 'Connect with a Cursor API key.',
  opencode: 'Connect with an Anthropic or OpenAI API key.'
}

/** The dialog owns plaintext and unmounts it on close or provider changes. */
export function ProviderConnectDialog({
  runtime,
  onClose
}: {
  runtime: RuntimeKind | 'choose'
  onClose: () => void
}) {
  const [selected, setSelected] = React.useState(runtime)
  const [busy, setBusy] = React.useState(false)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        className="sm:max-w-[480px]"
        showCloseButton={!busy}
        onInteractOutside={(event) => event.preventDefault()}
      >
        {selected === 'choose' ? (
          <>
            <DialogHeader>
              <DialogTitle>Connect a provider</DialogTitle>
              <DialogDescription>Bring your subscription or API key to Taut.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 py-2">
              {RUNTIME_ORDER.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  onClick={() => setSelected(provider)}
                  className="flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <RuntimeIcon runtime={provider} className="size-6" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{RUNTIME_LABELS[provider]}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {PROVIDER_DESCRIPTION[provider]}
                    </span>
                  </span>
                  <ChevronRightIcon className="size-4 text-muted-foreground" />
                </button>
              ))}
            </div>
          </>
        ) : (
          <ProviderConnectForm
            key={selected}
            runtime={selected}
            onDone={onClose}
            onBusyChange={setBusy}
            onBack={runtime === 'choose' ? () => setSelected('choose') : undefined}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ProviderConnectForm({
  runtime,
  onDone,
  onBack,
  onBusyChange
}: {
  runtime: RuntimeKind
  onDone: () => void
  onBack?: () => void
  onBusyChange: (busy: boolean) => void
}) {
  const accepted = RuntimeCredentialKinds[runtime].filter((kind) => kind !== 'claude.login')
  const initialKind =
    runtime === 'claude-code' ? 'claude.oauth' : (accepted[0] ?? 'anthropic.api_key')
  const addVault = useAddVaultItem()
  const addAccount = useAddSubscription()
  const check = useCheckSubscription()
  const [method, setMethod] = React.useState<CredentialKind>(initialKind)
  const [secret, setSecret] = React.useState(() => ({
    ...emptySecret(initialKind),
    label: `${RUNTIME_LABELS[runtime]} account`
  }))
  const [pending, setPending] = React.useState(false)
  const [authorizing, setAuthorizing] = React.useState(false)
  const authorization = React.useRef<AbortController | undefined>(undefined)
  const capturedLogin = React.useRef<ClaudeDesktopLogin | undefined>(undefined)
  React.useEffect(() => () => authorization.current?.abort(), [])
  const [error, setError] = React.useState<string>()
  // If account creation fails after saving a credential, retry with the saved ID.
  const saved = React.useRef<{ fingerprint: string; id: VaultItemId } | undefined>(undefined)
  const chooseMethod = (next: CredentialKind) => {
    setMethod(next)
    setError(undefined)
    capturedLogin.current = undefined
    setSecret((current) => ({ ...current, kind: next, secret: '' }))
  }
  const browserSubscription = runtime === 'claude-code' && method === 'claude.oauth'
  const ready = browserSubscription || isSecretReady(secret)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!ready || pending) return
    setPending(true)
    onBusyChange(true)
    setError(undefined)
    const controller = new AbortController()
    authorization.current = controller
    try {
      let connectedSecret = secret
      if (browserSubscription) {
        setAuthorizing(true)
        try {
          const login = capturedLogin.current ?? (await connectClaude(controller.signal))
          if (controller.signal.aborted) return
          capturedLogin.current = login
          connectedSecret = { ...secret, ...login }
        } finally {
          setAuthorizing(false)
        }
      }
      const normalized = secretToStore(connectedSecret)
      const fingerprint = JSON.stringify([connectedSecret.kind, secret.label.trim(), normalized])
      let id = saved.current?.fingerprint === fingerprint ? saved.current.id : undefined
      if (!id) {
        const item = await addVault.mutateAsync({
          kind: connectedSecret.kind,
          label: secret.label.trim(),
          secret: normalized
        })
        id = item.id
        saved.current = { fingerprint, id }
      }
      const account = await addAccount.mutateAsync({
        runtime,
        label: secret.label.trim(),
        credentialId: id
      })
      check.mutate(account.id)
      onDone()
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(
          error instanceof Error ? error.message : 'Could not connect this account. Try again.'
        )
      }
    } finally {
      authorization.current = undefined
      setPending(false)
      onBusyChange(false)
    }
  }
  const subscriptionKind = accepted.find(isSubscriptionSeat)
  const apiKinds = accepted.filter((kind) => !isSubscriptionSeat(kind))
  return (
    <form onSubmit={(event) => void submit(event)} className="min-w-0">
      <DialogHeader className="text-left">
        {onBack ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mb-2 w-fit -ml-2"
            onClick={onBack}
            disabled={pending}
          >
            <ArrowLeftIcon />
            Providers
          </Button>
        ) : null}
        <RuntimeIcon runtime={runtime} className="mb-3 size-8" />
        <DialogTitle>Connect {RUNTIME_LABELS[runtime]}</DialogTitle>
        <DialogDescription>{PROVIDER_DESCRIPTION[runtime]}</DialogDescription>
      </DialogHeader>
      <fieldset
        disabled={pending}
        className="mt-6 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 [&>*]:min-w-0"
      >
        <div className="grid gap-2">
          <span className="text-xs font-medium text-muted-foreground">Connection method</span>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Connection method">
            {subscriptionKind ? (
              <Button
                type="button"
                size="sm"
                variant={isSubscriptionSeat(method) ? 'secondary' : 'outline'}
                aria-pressed={isSubscriptionSeat(method)}
                onClick={() => chooseMethod(subscriptionKind)}
              >
                <CreditCardIcon />
                Subscription
              </Button>
            ) : null}
            {apiKinds.map((kind) => (
              <Button
                type="button"
                key={kind}
                size="sm"
                variant={method === kind ? 'secondary' : 'outline'}
                aria-pressed={method === kind}
                onClick={() => chooseMethod(kind)}
              >
                <KeyRoundIcon />
                {apiKinds.length > 1 ? CREDENTIAL_LABELS[kind].replace(' API key', '') : 'API key'}
              </Button>
            ))}
          </div>
        </div>
        {browserSubscription ? (
          <div className="grid gap-2 text-sm text-muted-foreground" role="status">
            <p>
              {authorizing
                ? 'Complete Claude sign-in in your browser. Taut will connect automatically.'
                : 'Connect opens Claude in your browser. Sign in to link your subscription.'}
            </p>
            {!window.taut ? (
              <p className="text-xs">
                Taut desktop must be installed on this computer and connected to this workspace.
              </p>
            ) : null}
          </div>
        ) : (
          <SecretFields
            key={method}
            idPrefix="provider"
            compact
            value={secret}
            onChange={setSecret}
            kinds={[secret.kind]}
          />
        )}
      </fieldset>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-5 border-t pt-4">
        <p className="mb-4 flex items-center gap-1.5 text-xs text-muted-foreground">
          <LockIcon className="size-3" />
          Stored encrypted in your workspace vault.
        </p>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              authorization.current?.abort()
              onDone()
            }}
            disabled={pending && !authorizing}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!ready || pending}>
            {authorizing ? 'Waiting for sign-in…' : pending ? 'Connecting…' : 'Connect'}
          </Button>
        </DialogFooter>
      </div>
    </form>
  )
}
