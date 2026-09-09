import { DateTime } from 'effect'

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit'
})

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric'
})

/** Contract dates are `DateTime.Utc`; every formatter here takes one. */
export function toMillis(value: DateTime.Utc): number {
  return DateTime.toEpochMillis(value)
}

export function toIso(value: DateTime.Utc): string {
  return DateTime.formatIso(value)
}

export function formatTime(value: DateTime.Utc): string {
  return timeFormatter.format(toMillis(value))
}

export function formatDay(value: DateTime.Utc): string {
  const millis = toMillis(value)
  const today = new Date()
  const day = new Date(millis)
  const sameDate = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()

  if (sameDate(day, today)) return 'Today'
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (sameDate(day, yesterday)) return 'Yesterday'
  return dayFormatter.format(millis)
}

/** Local calendar day, used to decide where a day separator goes. */
export function dayKey(value: DateTime.Utc): string {
  const day = new Date(toMillis(value))
  return `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`
}

/** Kept out of components so `Date.now()` never runs during render. */
export function isFuture(value: DateTime.Utc | undefined): boolean {
  return value !== undefined && toMillis(value) > Date.now()
}

/**
 * "1h 04m" / "4m 12s" / "9s" — how long until `value`, from `now`.
 * `now` is passed in so nothing reads the clock during render.
 */
export function formatCountdown(value: DateTime.Utc, now: number): string {
  const seconds = Math.max(0, Math.round((toMillis(value) - now) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, '0')}s`
  return `${rest}s`
}

/**
 * "4d 3h" / "1h 12m" / "8m" — the same countdown at quota scale.
 *
 * `formatCountdown` stops at hours, which reads as "98h 12m" for a weekly
 * window. This drops seconds and gains days, so one line covers a 5-hour
 * session and a 7-day cap alike.
 */
export function formatWindowReset(value: DateTime.Utc, now: number): string {
  const seconds = Math.max(0, Math.round((toMillis(value) - now) / 1000))
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m`
  return 'any moment'
}

/** Bytes as an operator reads them: "820 B", "12.4 KB", "3.1 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kilobytes = bytes / 1024
  if (kilobytes < 1024) return `${kilobytes.toFixed(kilobytes < 10 ? 1 : 0)} KB`
  const megabytes = kilobytes / 1024
  if (megabytes < 1024) return `${megabytes.toFixed(megabytes < 10 ? 1 : 0)} MB`
  return `${(megabytes / 1024).toFixed(1)} GB`
}

/** How long a task ran, from its two timestamps. */
export function formatDuration(fromMillis: number, toMillisValue: number): string {
  const seconds = Math.max(0, Math.round((toMillisValue - fromMillis) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function formatRelative(value: DateTime.Utc | undefined): string {
  if (value === undefined) return 'never'
  const diff = Date.now() - toMillis(value)
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * "in 3h" / "in 12m" / "any moment now" — `formatRelative` pointed the other way, for a
 * time that has not happened yet. `formatRelative` would say "just now" for all of them.
 */
export function formatUntil(value: DateTime.Utc | undefined): string {
  if (value === undefined) return 'never'
  const minutes = Math.round((toMillis(value) - Date.now()) / 60_000)
  if (minutes < 1) return 'any moment now'
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}

/** "Acme Inc" -> "acme-inc" */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** `@mentionable` handle derived from an email local part. */
export function handleFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email
  const cleaned = local.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  return cleaned === '' ? 'member' : cleaned
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((part) => part.charAt(0).toUpperCase()).join('') || '?'
}
