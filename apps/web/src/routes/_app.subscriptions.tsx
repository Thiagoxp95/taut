import * as React from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  CreditCardIcon,
  InfoIcon,
  KeyRoundIcon,
  LockIcon,
  MinusIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  TerminalIcon,
  TrashIcon,
  UndoIcon
} from 'lucide-react'
import type {
  LimitWindow,
  RuntimeKind,
  Subscription,
  VaultItemId,
  VaultItemMeta
} from '@taut/contract'
import { EXHAUSTED_PCT, RuntimeCredentialKinds, RuntimeUsageCredentialKinds } from '@taut/contract'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { Separator } from '@taut/ui/components/separator'
import { Skeleton } from '@taut/ui/components/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@taut/ui/components/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ModelSelect } from '@/components/model-select'
import { EmptyState, Field, PageBody, PageHeader } from '@/components/page'
import { SettingsCallout, SettingsShell } from '@/components/settings'
import { WorkspaceSettingsNav } from '@/components/settings-nav'
import {
  SecretFields,
  emptySecret,
  isSecretReady,
  secretToStore,
  type NewSecret
} from '@/components/secret-fields'
import { useTicker } from '@/hooks/use-ticker'
import {
  useAddSubscription,
  useAddVaultItem,
  useCanAdminister,
  useCheckSubscription,
  useClearSubscriptionCooldown,
  useRemoveSubscription,
  useSetSubscriptionUsageCredential,
  useSetSubscriptionWeight,
  useSubscriptions,
  useVaultItems
} from '@/lib/api'
import { formatRelative, formatWindowReset, toMillis } from '@/lib/format'
import { parseVaultItemId } from '@/lib/ids'
import {
  CREDENTIAL_LABELS,
  ROTATION_RULE,
  RUNTIME_BINARY,
  RUNTIME_BLURB,
  RUNTIME_INSTALL_HINT,
  RUNTIME_LABELS,
  RUNTIME_ORDER,
  SUBSCRIPTION_STATUS_LABELS
} from '@/lib/runtime-meta'

const MAX_WEIGHT = 10

const STATUS_CLASS: Record<Subscription['status'], string> = {
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  'auth-failed': 'border-destructive/40 bg-destructive/10 text-destructive',
  'binary-missing': 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-500',
  unchecked: 'border-border bg-muted text-muted-foreground'
}

function StatusPill({ status }: { status: Subscription['status'] }) {
  return (
    <Badge variant="outline" className={STATUS_CLASS[status]}>
      {SUBSCRIPTION_STATUS_LABELS[status]}
    </Badge>
  )
}

// --- connect dialog -------------------------------------------------------

function ConnectForm({ runtime, onDone }: { runtime: RuntimeKind; onDone: () => void }) {
  const accepted = RuntimeCredentialKinds[runtime]
  const vaultItems = useVaultItems().data?.items ?? []
  const candidates = vaultItems.filter((item) => accepted.includes(item.kind))

  const addVaultItem = useAddVaultItem()
  const addSubscription = useAddSubscription()
  const check = useCheckSubscription()

  // Mounted only while the dialog is open, so every open starts clean and the
  // plaintext secret never outlives the dialog.
  const [mode, setMode] = React.useState<'existing' | 'new'>(
    candidates.length > 0 ? 'existing' : 'new'
  )
  const [credentialId, setCredentialId] = React.useState<VaultItemId | undefined>(undefined)
  // The vault label is prefilled: the whole point of this dialog is copy the
  // command, paste the line, press Connect — a field the operator has to invent
  // a value for is one more thing between them and a working seat.
  const [secret, setSecret] = React.useState<NewSecret>(() => ({
    ...emptySecret(accepted[0]),
    label: `${RUNTIME_LABELS[runtime]} login`
  }))
  const [label, setLabel] = React.useState(`${RUNTIME_LABELS[runtime]} seat`)
  const [model, setModel] = React.useState('')

  const pending = addVaultItem.isPending || addSubscription.isPending
  const ready =
    label.trim() !== '' &&
    (mode === 'existing' ? credentialId !== undefined : isSecretReady(secret))

  const connect = (id: VaultItemId): void => {
    addSubscription.mutate(
      {
        runtime,
        label: label.trim(),
        credentialId: id,
        defaultModel: model.trim() === '' ? undefined : model.trim()
      },
      {
        onSuccess: (created: Subscription) => {
          // `add` only detects the binary. Reading the seat is a provider call,
          // which is the page's job to ask for, not a POST's to hide — but the
          // operator connected a seat to see it work, so the page asks now
          // rather than leaving them a row with an empty strip and a button.
          check.mutate(created.id)
          onDone()
        }
      }
    )
  }

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!ready || pending) return
    if (mode === 'existing') {
      if (credentialId !== undefined) connect(credentialId)
      return
    }
    // Store the secret first, then point the new seat at it.
    addVaultItem.mutate(
      { kind: secret.kind, label: secret.label.trim(), secret: secretToStore(secret) },
      { onSuccess: (item: VaultItemMeta) => connect(item.id) }
    )
  }

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Connect {RUNTIME_LABELS[runtime]}</DialogTitle>
        <DialogDescription>
          A seat pairs the <code className="font-mono">{RUNTIME_BINARY[runtime]}</code> binary with
          a vault credential. Taut checks it as soon as you add it, then rotates it with the rest of
          the pool.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 py-4">
        <Field label="Seat label" htmlFor="connect-label">
          <Input
            id="connect-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={`${RUNTIME_LABELS[runtime]} — Max seat`}
          />
        </Field>

        <Separator />

        <div className="flex items-center gap-1 rounded-md bg-muted p-0.5">
          <Button
            type="button"
            size="sm"
            variant={mode === 'existing' ? 'default' : 'ghost'}
            className="flex-1"
            disabled={candidates.length === 0}
            onClick={() => setMode('existing')}
          >
            Use a vault secret
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === 'new' ? 'default' : 'ghost'}
            className="flex-1"
            onClick={() => setMode('new')}
          >
            Add a new one
          </Button>
        </div>

        {mode === 'existing' ? (
          candidates.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
              The vault holds nothing {RUNTIME_LABELS[runtime]} accepts. Add one here, or in the{' '}
              <Link to="/vault" className="underline underline-offset-2">
                vault
              </Link>
              .
            </p>
          ) : (
            <Field
              label="Credential"
              htmlFor="connect-credential"
              hint={`${RUNTIME_LABELS[runtime]} accepts ${accepted
                .map((kind) => CREDENTIAL_LABELS[kind])
                .join(' or ')}.`}
            >
              <Select
                value={credentialId}
                onValueChange={(next) => setCredentialId(parseVaultItemId(next))}
              >
                <SelectTrigger id="connect-credential" className="w-full">
                  <SelectValue placeholder="Pick a vault secret" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label} · ••••{item.hint}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )
        ) : (
          <SecretFields idPrefix="connect" value={secret} onChange={setSecret} kinds={accepted} />
        )}

        <Separator />

        <Field
          label="Default model"
          htmlFor="connect-model"
          hint="Optional. An agent's own model override wins over this."
        >
          <ModelSelect
            id="connect-model"
            runtime={runtime}
            value={model === '' ? undefined : model}
            onValueChange={(next) => setModel(next ?? '')}
            emptyLabel="Runtime default"
          />
        </Field>
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready || pending}>
          {pending ? 'Checking the seat…' : 'Connect'}
        </Button>
      </DialogFooter>
    </form>
  )
}

function ConnectDialog({
  runtime,
  open,
  onOpenChange
}: {
  runtime: RuntimeKind
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <ConnectForm runtime={runtime} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

// --- pool rows ------------------------------------------------------------

function WeightStepper({
  subscription,
  disabled
}: {
  subscription: Subscription
  disabled: boolean
}) {
  const setWeight = useSetSubscriptionWeight()
  const draining = subscription.weight === 0

  const step = (delta: number): void => {
    const next = Math.min(MAX_WEIGHT, Math.max(0, subscription.weight + delta))
    if (next !== subscription.weight) {
      setWeight.mutate({ subscriptionId: subscription.id, weight: next })
    }
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Lower the weight of ${subscription.label}`}
        disabled={disabled || subscription.weight === 0 || setWeight.isPending}
        onClick={() => step(-1)}
      >
        <MinusIcon />
      </Button>
      <span
        className={
          draining
            ? 'w-16 text-center text-xs font-medium text-amber-600 dark:text-amber-500'
            : 'w-16 text-center text-xs tabular-nums'
        }
        title={draining ? 'Weight 0 — takes no new tasks' : 'Rotation weight'}
      >
        {draining ? 'Draining' : `weight ${subscription.weight}`}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Raise the weight of ${subscription.label}`}
        disabled={disabled || subscription.weight >= MAX_WEIGHT || setWeight.isPending}
        onClick={() => step(1)}
      >
        <PlusIcon />
      </Button>
    </div>
  )
}

/**
 * What the provider says is left on this seat.
 *
 * The bars matter more than the cooling badge: a badge only appears once a seat
 * is already parked, while this shows the weekly and model-scoped caps draining
 * long before anything trips. Each row is one window the provider reported, so
 * an Anthropic seat shows its session, weekly and per-model (Opus, Fable) caps
 * side by side, and a plan without one of them simply has no row for it.
 */
function LimitStrip({
  limits,
  error,
  now
}: {
  limits: readonly LimitWindow[]
  error: string | undefined
  now: number
}) {
  if (limits.length === 0) {
    // Silence when the probe has simply not run yet; a reason is worth a line.
    return error === undefined ? null : (
      <p className="basis-full text-xs text-muted-foreground">{error}</p>
    )
  }

  return (
    <ul className="basis-full space-y-1 pt-1">
      {limits.map((limit) => {
        const used = Math.min(100, Math.max(0, limit.percentUsed))
        const spent = limit.percentUsed >= EXHAUSTED_PCT
        return (
          <li
            key={`${limit.kind}-${limit.label}`}
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <span className="w-16 shrink-0 truncate" title={limit.label}>
              {limit.label}
            </span>
            <span
              className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-muted"
              role="presentation"
            >
              <span
                className={`block h-full rounded-full ${
                  spent ? 'bg-amber-500' : used >= 75 ? 'bg-amber-500/60' : 'bg-emerald-500/70'
                }`}
                style={{ width: `${used}%` }}
              />
            </span>
            <span className="w-10 shrink-0 text-right tabular-nums">{Math.round(used)}%</span>
            {limit.resetsAt === undefined ? null : (
              <span className="tabular-nums">resets {formatWindowReset(limit.resetsAt, now)}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Paste a usage login for a seat that cannot read its own quota.
 *
 * Only a seat still running on a `claude setup-token` needs this, and sending
 * that operator to the vault to create an item, then back here to attach it, is
 * three screens for one paste. So the same command-copy-paste block the connect
 * dialog uses appears right on the row, and the attach and the read happen
 * without another click.
 */
function AttachUsageLoginDialog({
  subscription,
  open,
  onOpenChange
}: {
  subscription: Subscription
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const kinds = RuntimeUsageCredentialKinds[subscription.runtime]
  const addVaultItem = useAddVaultItem()
  const setUsageCredential = useSetSubscriptionUsageCredential()
  const check = useCheckSubscription()
  const [secret, setSecret] = React.useState<NewSecret>(() => ({
    ...emptySecret(kinds[0]),
    label: `${subscription.label} usage`
  }))

  const pending = addVaultItem.isPending || setUsageCredential.isPending || check.isPending

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!isSecretReady(secret) || pending) return
    addVaultItem.mutate(
      { kind: secret.kind, label: secret.label.trim(), secret: secretToStore(secret) },
      {
        onSuccess: (item: VaultItemMeta) =>
          setUsageCredential.mutate(
            { subscriptionId: subscription.id, usageCredentialId: item.id },
            {
              onSuccess: () => {
                check.mutate(subscription.id)
                onOpenChange(false)
              }
            }
          )
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Read limits for {subscription.label}</DialogTitle>
            <DialogDescription>
              This seat runs on a setup token, which Anthropic scopes to inference only. Paste the
              full login and the seat starts reporting its windows; the login is never given to an
              agent.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <SecretFields idPrefix="usage" value={secret} onChange={setSecret} kinds={kinds} />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!isSecretReady(secret) || pending}>
              {pending ? 'Reading the seat…' : 'Attach and read'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The credential a seat probes with, when it is not the seat's own.
 *
 * Only a Claude seat pasted as a `claude setup-token` needs one, and the reason
 * is worth saying on the page rather than in a doc: that token is inference-only
 * and gets a 401 from the usage endpoint. A seat pasted as a full Claude login,
 * like a Codex seat, reads its own quota — so this stays out of the way there.
 */
function UsageCredentialField({
  subscription,
  vaultItems,
  canAdminister
}: {
  subscription: Subscription
  vaultItems: readonly VaultItemMeta[]
  canAdminister: boolean
}) {
  const setUsageCredential = useSetSubscriptionUsageCredential()
  const check = useCheckSubscription()
  const [pasting, setPasting] = React.useState(false)
  const kinds = RuntimeUsageCredentialKinds[subscription.runtime]
  const own = vaultItems.find((item) => item.id === subscription.credentialId)
  const attached = vaultItems.find((item) => item.id === subscription.usageCredentialId)
  const candidates = vaultItems.filter(
    (item) => item.agentId === undefined && kinds.includes(item.kind)
  )
  const ownReadsUsage = own !== undefined && kinds.includes(own.kind)

  // Nothing to say when the runtime has no usage endpoint, when the seat's own
  // credential already reads it (Codex), or when a non-admin has none attached.
  if (kinds.length === 0 || ownReadsUsage) return null
  if (!canAdminister && attached === undefined) return null

  return (
    <div className="basis-full pt-1 text-xs text-muted-foreground">
      {attached === undefined ? (
        candidates.length === 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>
              No limits on this seat &mdash; a setup token cannot read them.
              {canAdminister ? '' : ' Ask an admin to attach a Claude login.'}
            </span>
            {canAdminister ? (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2"
                onClick={() => setPasting(true)}
              >
                Paste a {CREDENTIAL_LABELS['claude.login']}
              </Button>
            ) : null}
            {/* Mounted only while open, so the pasted login never outlives the dialog. */}
            {pasting ? (
              <AttachUsageLoginDialog subscription={subscription} open onOpenChange={setPasting} />
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span>Read limits with</span>
            <Select
              disabled={setUsageCredential.isPending || check.isPending}
              onValueChange={(value) => {
                const usageCredentialId = parseVaultItemId(value)
                if (usageCredentialId === undefined) return
                // Attaching without reading is a half-answer: the operator
                // pasted a login to see a number, so go and get the number.
                setUsageCredential.mutate(
                  { subscriptionId: subscription.id, usageCredentialId },
                  { onSuccess: () => check.mutate(subscription.id) }
                )
              }}
            >
              <SelectTrigger size="sm" className="h-7 w-56">
                <SelectValue placeholder="pick a usage login" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label} · ••••{item.hint}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span>
            Limits read with {attached.label} ·{' '}
            <span className="font-mono">••••{attached.hint}</span>
          </span>
          {canAdminister ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2"
              disabled={setUsageCredential.isPending}
              onClick={() =>
                setUsageCredential.mutate({
                  subscriptionId: subscription.id,
                  usageCredentialId: undefined
                })
              }
            >
              Detach
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}

function SubscriptionRow({
  subscription,
  credential,
  vaultItems,
  canAdminister,
  now,
  onRemove
}: {
  subscription: Subscription
  credential: VaultItemMeta | undefined
  vaultItems: readonly VaultItemMeta[]
  canAdminister: boolean
  now: number
  onRemove: () => void
}) {
  const check = useCheckSubscription()
  const clearCooldown = useClearSubscriptionCooldown()
  const cooldownUntil = subscription.cooldownUntil
  const cooling = cooldownUntil !== undefined && toMillis(cooldownUntil) > now
  // The badge and the strip must never disagree, so both read the same numbers.
  const spent = subscription.limits.filter((limit) => limit.percentUsed >= EXHAUSTED_PCT)

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-[10rem] flex-1">
        <p className="truncate text-sm font-medium">{subscription.label}</p>
        <p className="truncate text-xs text-muted-foreground">
          {credential === undefined ? (
            <span className="text-destructive">credential missing</span>
          ) : (
            <>
              {credential.label} · <span className="font-mono">••••{credential.hint}</span>
            </>
          )}
          {subscription.defaultModel === undefined ? null : <> · {subscription.defaultModel}</>}
        </p>
      </div>

      <StatusPill status={subscription.status} />

      {cooling && cooldownUntil !== undefined ? (
        <span className="flex items-center gap-1">
          <Badge
            variant="outline"
            className="border-amber-500/40 text-amber-600 tabular-nums dark:text-amber-500"
            title={
              spent.length > 0
                ? `${spent.map((limit) => limit.label).join(', ')} spent; back in the rotation when the window resets`
                : 'Rate-limited; back in the rotation when this reaches zero'
            }
          >
            cooling {formatWindowReset(cooldownUntil, now)}
          </Badge>
          {/*
           * A limit is per-model but a cooldown parks the whole seat, so one
           * exhausted model benches models that still have room. Check only
           * releases a seat the provider agrees is free; this is the operator
           * overruling it.
           */}
          {canAdminister ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Clear cooldown on ${subscription.label}`}
              title="Put this seat back in the rotation now"
              disabled={clearCooldown.isPending}
              onClick={() => clearCooldown.mutate(subscription.id)}
            >
              <UndoIcon />
            </Button>
          ) : null}
        </span>
      ) : null}

      <WeightStepper subscription={subscription} disabled={!canAdminister} />

      <span
        className="w-24 text-right text-xs text-muted-foreground tabular-nums"
        title="Tasks run on this seat since company-local midnight"
      >
        {subscription.tasksToday} today
      </span>

      <span className="w-24 text-right text-xs text-muted-foreground" title="Last detection run">
        {formatRelative(subscription.lastCheckedAt)}
      </span>

      <Button
        variant="ghost"
        size="sm"
        disabled={check.isPending}
        onClick={() => check.mutate(subscription.id)}
      >
        <RefreshCwIcon className={check.isPending ? 'animate-spin' : undefined} />
        Check
      </Button>

      {canAdminister ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${subscription.label}`}
          onClick={onRemove}
        >
          <TrashIcon />
        </Button>
      ) : null}

      <LimitStrip limits={subscription.limits} error={subscription.limitsError} now={now} />

      <UsageCredentialField
        subscription={subscription}
        vaultItems={vaultItems}
        canAdminister={canAdminister}
      />
    </li>
  )
}

function RuntimeCard({
  runtime,
  pool,
  vaultItems,
  canAdminister,
  now,
  onConnect,
  onRemove
}: {
  runtime: RuntimeKind
  pool: readonly Subscription[]
  vaultItems: readonly VaultItemMeta[]
  canAdminister: boolean
  now: number
  onConnect: () => void
  onRemove: (subscription: Subscription) => void
}) {
  const binaryMissing = pool.length > 0 && pool.every((seat) => seat.status === 'binary-missing')
  const authFailed = pool.some((seat) => seat.status === 'auth-failed')

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex flex-wrap items-center gap-3 border-b px-6 py-5">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            {RUNTIME_LABELS[runtime]}
            <span className="rounded bg-muted px-1.5 py-px font-mono text-[11px] font-normal text-muted-foreground">
              {RUNTIME_BINARY[runtime]}
            </span>
            {pool.length > 0 ? (
              <span className="text-xs font-normal text-muted-foreground">
                {pool.length} {pool.length === 1 ? 'seat' : 'seats'}
              </span>
            ) : null}
          </h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{RUNTIME_BLURB[runtime]}</p>
        </div>
        {canAdminister ? (
          <Button size="sm" variant={pool.length === 0 ? 'outline' : 'ghost'} onClick={onConnect}>
            <PlugIcon />
            Connect
          </Button>
        ) : null}
      </header>

      {binaryMissing ? (
        <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-xs">
          <TerminalIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
          <p className="text-muted-foreground">
            The server cannot find <code className="font-mono">{RUNTIME_BINARY[runtime]}</code> on
            the machine. Install it, then press Check:{' '}
            <code className="font-mono">{RUNTIME_INSTALL_HINT[runtime]}</code>
          </p>
        </div>
      ) : null}

      {authFailed ? (
        <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs">
          <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <p className="text-muted-foreground">
            {RUNTIME_LABELS[runtime]} rejected the credential — usually a login that was pasted
            half-copied or has since been signed out. Connect the seat again; the dialog gives you
            the command that copies a fresh one.
          </p>
        </div>
      ) : null}

      {pool.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">No {RUNTIME_LABELS[runtime]} seats yet.</p>
          {canAdminister ? (
            <Button size="sm" variant="outline" className="mt-3" onClick={onConnect}>
              Connect {RUNTIME_LABELS[runtime]}
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="divide-y">
          {pool.map((subscription) => (
            <SubscriptionRow
              key={subscription.id}
              subscription={subscription}
              credential={vaultItems.find((item) => item.id === subscription.credentialId)}
              vaultItems={vaultItems}
              canAdminister={canAdminister}
              now={now}
              onRemove={() => onRemove(subscription)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

// --- page -----------------------------------------------------------------

function SubscriptionsRoute() {
  const query = useSubscriptions()
  const vaultItems = useVaultItems().data?.items ?? []
  const canAdminister = useCanAdminister()
  const removeSubscription = useRemoveSubscription()

  const [connecting, setConnecting] = React.useState<RuntimeKind | null>(null)
  const [removing, setRemoving] = React.useState<Subscription | null>(null)

  const subscriptions = query.data?.items ?? []

  const anyCooling = subscriptions.some((seat) => seat.cooldownUntil !== undefined)
  const now = useTicker(1000, anyCooling)

  const byRuntime = new Map<RuntimeKind, Subscription[]>()
  for (const runtime of RUNTIME_ORDER) byRuntime.set(runtime, [])
  for (const subscription of subscriptions) {
    byRuntime.get(subscription.runtime)?.push(subscription)
  }

  const total = subscriptions.length

  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="Runtime seats the company owns. Agents rotate across the pool."
        icon={<CreditCardIcon className="size-4" />}
        actions={
          canAdminister && total > 0 ? (
            <Button size="sm" onClick={() => setConnecting('claude-code')}>
              <PlusIcon />
              Connect a runtime
            </Button>
          ) : undefined
        }
      />
      <PageBody>
        <SettingsShell nav={<WorkspaceSettingsNav />}>
          <SettingsCallout
            variant="default"
            icon={<InfoIcon />}
            title="How the pool rotates"
            description={ROTATION_RULE}
          />

          <div className="grid gap-6">
            {query.isPending ? (
              <div className="space-y-4">
                {[0, 1].map((row) => (
                  <Skeleton key={row} className="h-40 rounded-xl" />
                ))}
              </div>
            ) : total === 0 ? (
              <EmptyState
                icon={<CreditCardIcon className="size-5" />}
                title="No subscriptions yet — connect Claude Code"
                description={
                  canAdminister
                    ? 'A seat pairs a runtime with a vault credential. Agents cannot run a single task until the pool has one.'
                    : 'Ask an owner or admin to connect a runtime — agents cannot run until the pool has a seat.'
                }
                action={
                  canAdminister ? (
                    <Button size="sm" onClick={() => setConnecting('claude-code')}>
                      <PlugIcon />
                      Connect Claude Code
                    </Button>
                  ) : (
                    <Button asChild size="sm" variant="outline">
                      <Link to="/agents">Back to agents</Link>
                    </Button>
                  )
                }
              />
            ) : (
              RUNTIME_ORDER.map((runtime) => (
                <RuntimeCard
                  key={runtime}
                  runtime={runtime}
                  pool={byRuntime.get(runtime) ?? []}
                  vaultItems={vaultItems}
                  canAdminister={canAdminister}
                  now={now}
                  onConnect={() => setConnecting(runtime)}
                  onRemove={setRemoving}
                />
              ))
            )}
          </div>

          {canAdminister ? (
            <p className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
              <KeyRoundIcon className="size-3.5" />
              Credentials live in the{' '}
              <Link to="/vault" className="underline underline-offset-2">
                vault
              </Link>
              ; a seat only ever references one.
            </p>
          ) : (
            <p className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
              <LockIcon className="size-3.5" />
              Connecting and removing seats is owner and admin only.
            </p>
          )}
        </SettingsShell>
      </PageBody>

      {connecting === null ? null : (
        <ConnectDialog
          runtime={connecting}
          open
          onOpenChange={(next) => {
            if (!next) setConnecting(null)
          }}
        />
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null)
        }}
        title={`Remove ${removing?.label ?? 'this seat'}?`}
        confirmLabel="Remove seat"
        pending={removeSubscription.isPending}
        description={
          <>
            <p>
              The seat leaves the pool immediately. Agents pinned to it fall back to rotation on
              their next task.
            </p>
            <p>Its vault credential is untouched — revoke that separately if you meant to.</p>
          </>
        }
        onConfirm={() => {
          if (removing === null) return
          removeSubscription.mutate(removing.id, { onSuccess: () => setRemoving(null) })
        }}
      />
    </>
  )
}

export const Route = createFileRoute('/_app/subscriptions')({
  component: SubscriptionsRoute
})
