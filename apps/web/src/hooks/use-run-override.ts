import * as React from 'react'
import type { ChannelId, MessageId, RunOverride } from '@taut/contract'

/**
 * The composer's run settings, remembered per conversation
 * (docs/build-plan-run-overrides.md D2).
 *
 * Sticky is a client fact, not a server one. Every message states in full what
 * it asked for, so a thread stays readable without replaying anybody's
 * settings; what is remembered here is only the convenience of not re-picking
 * the same model for the next turn of the same conversation.
 *
 * `localStorage` because it should survive a reload of the same browser and
 * reach nothing else: a choice made on a laptop is not a choice made on a
 * phone. A browser that refuses storage (private mode, blocked site data) still
 * works — the setting simply lasts as long as the tab.
 */
const KEY_PREFIX = 'taut.run-override.'

const keyFor = (channelId: ChannelId | undefined, threadId: MessageId | undefined): string =>
  `${KEY_PREFIX}${channelId ?? 'none'}:${threadId ?? 'root'}`

/** An empty override and an absent one are the same thing: no override at all. */
export const isEmptyOverride = (override: RunOverride | undefined): boolean =>
  override === undefined ||
  (override.runtimeKind === undefined &&
    override.subscriptionId === undefined &&
    override.model === undefined &&
    override.reasoningEffort === undefined)

/** How many rows the popup is holding — what the button's dot counts. */
export const overrideCount = (override: RunOverride | undefined): number =>
  override === undefined
    ? 0
    : [
        override.runtimeKind,
        override.subscriptionId,
        override.model,
        override.reasoningEffort
      ].filter((field) => field !== undefined).length

const read = (key: string): RunOverride | undefined => {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as RunOverride) : undefined
  } catch {
    return undefined
  }
}

const write = (key: string, override: RunOverride | undefined): void => {
  try {
    if (isEmptyOverride(override)) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify(override))
  } catch {
    // Storage is a convenience here; a browser that refuses it loses the
    // stickiness and nothing else.
  }
}

export interface RunOverrideState {
  readonly override: RunOverride | undefined
  /** Sets one field; `undefined` clears it back to the agent's own setting. */
  readonly set: <K extends keyof RunOverride>(field: K, value: RunOverride[K]) => void
  readonly clear: () => void
}

export function useRunOverride(
  channelId: ChannelId | undefined,
  threadId: MessageId | undefined
): RunOverrideState {
  const key = keyFor(channelId, threadId)
  const [held, setHeld] = React.useState<{ key: string; value: RunOverride | undefined }>(() => ({
    key,
    value: read(key)
  }))

  // Moving between conversations swaps the whole setting, so the popup opens on
  // what *this* thread last asked for rather than on the last thread's answer.
  // Read during render rather than in an effect: the composer must never paint
  // one frame holding the previous conversation's model.
  if (held.key !== key) setHeld({ key, value: read(key) })
  const override = held.key === key ? held.value : read(key)

  const setOverride = React.useCallback(
    (next: (current: RunOverride | undefined) => RunOverride | undefined): void => {
      setHeld((current) => ({ key: current.key, value: next(current.value) }))
    },
    []
  )

  const set = React.useCallback(
    <K extends keyof RunOverride>(field: K, value: RunOverride[K]): void => {
      setOverride((current) => {
        const next = { ...current, [field]: value } as RunOverride
        const cleaned = isEmptyOverride(next) ? undefined : next
        write(key, cleaned)
        return cleaned
      })
    },
    [key, setOverride]
  )

  const clear = React.useCallback((): void => {
    write(key, undefined)
    setOverride(() => undefined)
  }, [key, setOverride])

  return { override, set, clear }
}
