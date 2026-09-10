import * as React from 'react'
import {
  ChevronRightIcon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
  TrashIcon,
  UndoIcon
} from '@taut/ui/components/icons'
import type { LimitWindow, RuntimeKind, Subscription, VaultItemMeta } from '@taut/contract'
import { EXHAUSTED_PCT, RuntimeUsageCredentialKinds } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { RuntimeIcon } from '@/components/runtime-icon'
import { PROVIDER_DESCRIPTION } from '@/components/provider-connect-dialog'
import {
  useCheckSubscription,
  useClearSubscriptionCooldown,
  useSetSubscriptionWeight
} from '@/lib/api'
import { formatRelative, formatWindowReset, toMillis } from '@/lib/format'
import {
  isSubscriptionSeat,
  RUNTIME_BINARY,
  RUNTIME_INSTALL_HINT,
  RUNTIME_LABELS,
  ROTATION_RULE
} from '@/lib/runtime-meta'
const MAX_WEIGHT = 10
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
    <ul className="grid gap-2">
      {limits.map((limit) => {
        const used = Math.min(100, Math.max(0, limit.percentUsed))
        const spent = limit.percentUsed >= EXHAUSTED_PCT
        return (
          <li
            key={`${limit.kind}-${limit.label}`}
            className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          >
            <span className="w-16 shrink-0 truncate" title={limit.label}>
              {limit.label}
            </span>
            <span
              className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={`${limit.label} usage`}
              aria-valuenow={used}
              aria-valuemin={0}
              aria-valuemax={100}
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

function AccountRow({
  subscription,
  vaultItems,
  canAdminister,
  now,
  onRemove
}: {
  subscription: Subscription
  vaultItems: readonly VaultItemMeta[]
  canAdminister: boolean
  now: number
  onRemove: () => void
}) {
  const [expanded, setExpanded] = React.useState(false)
  const check = useCheckSubscription()
  const clearCooldown = useClearSubscriptionCooldown()
  const credential = vaultItems.find((item) => item.id === subscription.credentialId)
  const cooling =
    subscription.cooldownUntil !== undefined && toMillis(subscription.cooldownUntil) > now
  const problem = subscription.status === 'auth-failed' || subscription.status === 'binary-missing'
  const state =
    subscription.status === 'auth-failed'
      ? 'Needs attention'
      : subscription.status === 'binary-missing'
        ? 'Setup needed'
        : subscription.status === 'unchecked'
          ? 'Not checked'
          : subscription.weight === 0
            ? 'Paused'
            : cooling
              ? 'Rate limited'
              : 'Connected'
  const id = `account-${subscription.id}`
  return (
    <li className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronRightIcon
            className={`size-3.5 shrink-0 text-muted-foreground ${expanded ? 'rotate-90' : ''}`}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{subscription.label}</span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {credential
                ? isSubscriptionSeat(credential.kind)
                  ? 'Subscription'
                  : 'API key'
                : 'Credential unavailable'}
              {subscription.defaultModel ? ` · ${subscription.defaultModel}` : ''}
            </span>
          </span>
          <span
            className={`hidden shrink-0 items-center gap-1.5 text-xs sm:flex ${problem ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            <span
              className={`size-1.5 rounded-full ${problem ? 'bg-destructive' : state === 'Connected' ? 'bg-emerald-500' : 'bg-amber-500'}`}
            />
            {state}
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Refresh status"
          aria-label={`Refresh ${subscription.label}`}
          disabled={!canAdminister || check.isPending}
          onClick={() => check.mutate(subscription.id)}
        >
          <RefreshCwIcon className={check.isPending ? 'motion-safe:animate-spin' : undefined} />
        </Button>
        {canAdminister ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            aria-label={`Remove ${subscription.label}`}
            onClick={onRemove}
          >
            <TrashIcon />
          </Button>
        ) : null}
      </div>
      <p
        className={`px-8 pb-2 text-xs sm:hidden ${problem ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {state}
      </p>
      {subscription.status === 'auth-failed' ? (
        <p className="border-t px-3 py-2 text-xs text-destructive">
          This login was rejected. Add a fresh connection, then remove this account.
        </p>
      ) : null}
      {expanded ? (
        <div id={id} className="grid gap-4 border-t px-4 py-4 sm:pl-9">
          {subscription.status === 'binary-missing' ? (
            <p className="text-xs text-muted-foreground">
              Install <code>{RUNTIME_BINARY[subscription.runtime]}</code> on the Taut server, then
              refresh:{' '}
              <code className="break-all">{RUNTIME_INSTALL_HINT[subscription.runtime]}</code>
            </p>
          ) : null}
          <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
            <span>{subscription.tasksToday} tasks today</span>
            <span>Checked {formatRelative(subscription.lastCheckedAt)}</span>
          </div>
          {subscription.usageCredentialId !== undefined ||
          (credential !== undefined &&
            RuntimeUsageCredentialKinds[subscription.runtime].includes(credential.kind)) ? (
            <LimitStrip limits={subscription.limits} error={subscription.limitsError} now={now} />
          ) : null}
          {cooling && subscription.cooldownUntil ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>Available in {formatWindowReset(subscription.cooldownUntil, now)}</span>
              {canAdminister ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={clearCooldown.isPending}
                  onClick={() => clearCooldown.mutate(subscription.id)}
                >
                  <UndoIcon />
                  Clear cooldown
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <span className="text-xs text-muted-foreground" title={ROTATION_RULE}>
              Task routing priority
            </span>
            <WeightStepper subscription={subscription} disabled={!canAdminister} />
          </div>
        </div>
      ) : null}
    </li>
  )
}

export function ProviderAccounts({
  runtime,
  accounts,
  vaultItems,
  canAdminister,
  now,
  onConnect,
  onRemove
}: {
  runtime: RuntimeKind
  accounts: readonly Subscription[]
  vaultItems: readonly VaultItemMeta[]
  canAdminister: boolean
  now: number
  onConnect: () => void
  onRemove: (account: Subscription) => void
}) {
  return (
    <section aria-labelledby={`provider-${runtime}`} className="py-6 first:pt-0">
      <header className="mb-3 flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card">
          <RuntimeIcon runtime={runtime} className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id={`provider-${runtime}`} className="flex items-center gap-2 text-sm font-semibold">
            {RUNTIME_LABELS[runtime]}
            {accounts.length ? (
              <span className="text-xs font-normal text-muted-foreground">
                {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}
              </span>
            ) : null}
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {PROVIDER_DESCRIPTION[runtime]}
          </p>
        </div>
        {canAdminister ? (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={onConnect}
            aria-label={`Add ${RUNTIME_LABELS[runtime]} account`}
          >
            <PlusIcon />
            <span className="hidden sm:inline">Add account</span>
            <span className="sm:hidden">Add</span>
          </Button>
        ) : null}
      </header>
      {accounts.length ? (
        <ul className="space-y-2">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              subscription={account}
              vaultItems={vaultItems}
              canAdminister={canAdminister}
              now={now}
              onRemove={() => onRemove(account)}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
          No accounts connected.{canAdminister ? '' : ' Ask an admin to add an account.'}
        </p>
      )}
    </section>
  )
}
