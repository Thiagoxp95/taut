/**
 * When a routine fires (docs/build-plan-routines.md D2–D4). `nextRuns` is the only place that
 * does calendar math: the server fires on it and the web previews on it, so a disagreement
 * would be a user-visible bug. Both import this instead of reimplementing it.
 */
import { Cron, DateTime, Either, Option, Schema } from 'effect'

import type { ValidationIssue } from '../errors.js'

// --- primitives -----------------------------------------------------------

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/

/** "09:00" — wall clock in the routine's timezone, 24 h. */
export const TimeOfDay = Schema.String.pipe(
  Schema.pattern(TIME_OF_DAY, { identifier: 'TimeOfDay', message: () => 'expected HH:MM (24 h)' }),
  Schema.brand('TimeOfDay')
)
export type TimeOfDay = typeof TimeOfDay.Type

/** 0 = Sunday … 6 = Saturday (matches `Date.getDay`). */
export const Weekday = Schema.Int.pipe(Schema.between(0, 6))
export type Weekday = typeof Weekday.Type

/** 1–31, or 'last' for the last day of the month. */
export const MonthDay = Schema.Union(Schema.Int.pipe(Schema.between(1, 31)), Schema.Literal('last'))
export type MonthDay = typeof MonthDay.Type

/** IANA zone id, e.g. "America/Toronto". Checked against the runtime's zone database on decode. */
export const Timezone = Schema.String.pipe(
  Schema.filter((zone) => Option.isSome(DateTime.zoneMakeNamed(zone)), {
    identifier: 'Timezone',
    message: () => 'unknown IANA time zone'
  })
)
export type Timezone = typeof Timezone.Type

/** Five fields only: effect also accepts six (leading seconds), which the editor never offers. */
const parseCron = (
  expression: string,
  zone?: DateTime.TimeZone
): Either.Either<Cron.Cron, string> => {
  if (expression.trim().split(/\s+/).length !== 5) {
    return Either.left('expected five fields: minute hour day month weekday')
  }
  return Cron.parse(expression, zone).pipe(Either.mapLeft((e) => e.message))
}

export const CronExpression = Schema.NonEmptyString.pipe(
  Schema.filter(
    (expression) =>
      Either.match(parseCron(expression), {
        onLeft: (message) => message,
        onRight: () => true
      }),
    { identifier: 'CronExpression' }
  )
)
export type CronExpression = typeof CronExpression.Type

// --- the union ------------------------------------------------------------

export const IntervalSchedule = Schema.TaggedStruct('interval', {
  /** 5 … 1440. Anchored on `Routine.createdAt` so "every 90 min" is stable across restarts. */
  everyMinutes: Schema.Int.pipe(Schema.between(5, 1440))
})
export type IntervalSchedule = typeof IntervalSchedule.Type

export const DailySchedule = Schema.TaggedStruct('daily', {
  /** 1 = every day, 2 = every other day … 30. Counted from `anchorDate`. */
  everyNDays: Schema.Int.pipe(Schema.between(1, 30)),
  /** Calendar day (YYYY-MM-DD, routine timezone) the count starts from. */
  anchorDate: Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/)),
  times: Schema.NonEmptyArray(TimeOfDay)
})
export type DailySchedule = typeof DailySchedule.Type

export const WeeklySchedule = Schema.TaggedStruct('weekly', {
  weekdays: Schema.NonEmptyArray(Weekday),
  times: Schema.NonEmptyArray(TimeOfDay)
})
export type WeeklySchedule = typeof WeeklySchedule.Type

export const MonthlySchedule = Schema.TaggedStruct('monthly', {
  days: Schema.NonEmptyArray(MonthDay),
  times: Schema.NonEmptyArray(TimeOfDay)
})
export type MonthlySchedule = typeof MonthlySchedule.Type

/** Five-field cron, parsed with `effect/Cron`. Validated on decode. */
export const CronSchedule = Schema.TaggedStruct('cron', { expression: CronExpression })
export type CronSchedule = typeof CronSchedule.Type

export const Schedule = Schema.Union(
  IntervalSchedule,
  DailySchedule,
  WeeklySchedule,
  MonthlySchedule,
  CronSchedule
)
export type Schedule = typeof Schedule.Type

type CalendarSchedule = DailySchedule | WeeklySchedule | MonthlySchedule

// --- next runs ------------------------------------------------------------

/** Missed runs are never replayed (D5), so looking this far ahead and giving up is safe. */
const HORIZON_DAYS = 400
const DAY_MS = 86_400_000

const parseTime = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number)
  return { hours: hours ?? 0, minutes: minutes ?? 0 }
}

/** "HH:MM" sorts lexicographically in clock order, so no parsing is needed to order times. */
const sortedTimes = (times: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.from(new Set(times)).sort()

type CalendarDay = { readonly year: number; readonly month: number; readonly day: number }

/** Midnight UTC of a YYYY-MM-DD, or none when the string names a day that does not exist. */
const calendarDate = (date: string): Option.Option<DateTime.Utc> => {
  const [year, month, day] = date.split('-').map(Number)
  if (year === undefined || month === undefined || day === undefined) return Option.none()
  return DateTime.make({ year, month, day, hours: 0, minutes: 0, seconds: 0, millis: 0 }).pipe(
    // `Date.UTC` rolls "2026-02-31" over to March; reject anything that did not round-trip
    Option.filter((dt) => {
      const parts = DateTime.toPartsUtc(dt)
      return parts.year === year && parts.month === month && parts.day === day
    })
  )
}

/**
 * A wall-clock time on a calendar day, in `zone`. DST rule (`disambiguation: 'compatible'`):
 * a time that does not exist on a spring-forward day fires once, shifted forward by the size of
 * the gap (02:30 → 03:30 in Toronto), which is the same instant as the previous day's run plus
 * 24 h; a time that occurs twice on a fall-back day fires once, at its first occurrence.
 */
const atWallClock = (
  zone: DateTime.TimeZone,
  day: CalendarDay,
  time: string
): Option.Option<DateTime.Utc> => {
  const { hours, minutes } = parseTime(time)
  return DateTime.makeZoned(
    { year: day.year, month: day.month, day: day.day, hours, minutes, seconds: 0, millis: 0 },
    { timeZone: zone, adjustForTimeZone: true, disambiguation: 'compatible' }
  ).pipe(Option.map(DateTime.toUtc))
}

/**
 * Calendar days in `zone`, starting on the day `after` falls in. The cursor sits at noon:
 * midnight is skipped by zones that shift at 00:00, noon exists everywhere.
 */
function* calendarDays(
  zone: DateTime.TimeZone,
  after: DateTime.Utc
): Generator<{
  readonly parts: DateTime.DateTime.PartsWithWeekday
  readonly cursor: DateTime.Zoned
}> {
  const start = DateTime.toParts(DateTime.setZone(after, zone))
  const noon = DateTime.makeZoned(
    {
      year: start.year,
      month: start.month,
      day: start.day,
      hours: 12,
      minutes: 0,
      seconds: 0,
      millis: 0
    },
    { timeZone: zone, adjustForTimeZone: true }
  )
  if (Option.isNone(noon)) return
  for (let offset = 0; offset <= HORIZON_DAYS; offset++) {
    const cursor = DateTime.add(noon.value, { days: offset })
    yield { parts: DateTime.toParts(cursor), cursor }
  }
}

type DayMatcher = (parts: DateTime.DateTime.PartsWithWeekday, cursor: DateTime.Zoned) => boolean

const dayMatcher = (schedule: CalendarSchedule): Option.Option<DayMatcher> => {
  switch (schedule._tag) {
    case 'daily':
      return calendarDate(schedule.anchorDate).pipe(
        Option.map((anchor): DayMatcher => (parts) => {
          const day = DateTime.make({
            year: parts.year,
            month: parts.month,
            day: parts.day,
            hours: 0,
            minutes: 0,
            seconds: 0,
            millis: 0
          })
          if (Option.isNone(day)) return false
          const diff = Math.round(DateTime.distance(anchor, day.value) / DAY_MS)
          // negative when the anchor is ahead of the cursor; both directions must land on the grid
          return ((diff % schedule.everyNDays) + schedule.everyNDays) % schedule.everyNDays === 0
        })
      )
    case 'weekly': {
      const weekdays = new Set<number>(schedule.weekdays)
      return Option.some((parts) => weekdays.has(parts.weekDay))
    }
    case 'monthly': {
      const days = new Set<number>(schedule.days.filter((d): d is number => d !== 'last'))
      const last = schedule.days.includes('last')
      return Option.some(
        (parts, cursor) =>
          days.has(parts.day) ||
          (last && parts.day === DateTime.toParts(DateTime.endOf(cursor, 'month')).day)
      )
    }
  }
}

const calendarRuns = (
  schedule: CalendarSchedule,
  zone: DateTime.TimeZone,
  after: DateTime.Utc,
  count: number
): ReadonlyArray<DateTime.Utc> => {
  const matches = dayMatcher(schedule)
  if (Option.isNone(matches)) return []
  const times = sortedTimes(schedule.times)
  const afterMs = DateTime.toEpochMillis(after)
  const out: Array<DateTime.Utc> = []
  let lastMs = afterMs
  for (const { parts, cursor } of calendarDays(zone, after)) {
    if (!matches.value(parts, cursor)) continue
    // DST shifts can reorder or collide instants within a day (02:30→03:30 vs an explicit 03:30)
    const instants = times
      .flatMap((time) => Option.toArray(atWallClock(zone, parts, time)))
      .sort((a, b) => DateTime.toEpochMillis(a) - DateTime.toEpochMillis(b))
    for (const at of instants) {
      const ms = DateTime.toEpochMillis(at)
      if (ms <= lastMs) continue
      out.push(at)
      lastMs = ms
      if (out.length >= count) return out
    }
  }
  return out
}

const intervalRuns = (
  schedule: IntervalSchedule,
  after: DateTime.Utc,
  anchor: DateTime.Utc,
  count: number,
  horizonMs: number
): ReadonlyArray<DateTime.Utc> => {
  const step = schedule.everyMinutes * 60_000
  const anchorMs = DateTime.toEpochMillis(anchor)
  const afterMs = DateTime.toEpochMillis(after)
  // the anchor itself is not a run: the first fire is one step after creation
  const first = Math.max(1, Math.floor((afterMs - anchorMs) / step) + 1)
  const out: Array<DateTime.Utc> = []
  for (let k = first; out.length < count; k++) {
    const at = anchorMs + k * step
    if (at > horizonMs) break
    out.push(DateTime.unsafeMake(at))
  }
  return out
}

const cronRuns = (
  schedule: CronSchedule,
  zone: DateTime.TimeZone,
  after: DateTime.Utc,
  count: number,
  horizonMs: number
): ReadonlyArray<DateTime.Utc> => {
  const cron = parseCron(schedule.expression, zone)
  if (Either.isLeft(cron)) return []
  const out: Array<DateTime.Utc> = []
  let cursor = DateTime.toDateUtc(after)
  while (out.length < count) {
    let next: Date
    try {
      // steps one second past `cursor` before matching, so the result is strictly after it
      next = Cron.next(cron.right, cursor)
    } catch {
      // `Cron.next` throws when nothing matches within 10 000 steps (e.g. `0 0 30 2 *`)
      break
    }
    if (next.getTime() <= cursor.getTime() || next.getTime() > horizonMs) break
    out.push(DateTime.unsafeFromDate(next))
    cursor = next
  }
  return out
}

/**
 * The next `count` instants a schedule fires strictly after `after`, ascending, or fewer when
 * it fires less often than that within `HORIZON_DAYS`. Never throws: an unknown `timezone`, a
 * cron that can never match, or a bad `anchorDate` all yield `[]`.
 *
 * `anchor` only matters for `interval` (`Routine.createdAt` on the server); it defaults to
 * `after`, which is what a preview wants before the routine exists.
 */
export const nextRuns = (
  schedule: Schedule,
  timezone: string,
  after: DateTime.Utc,
  count: number,
  anchor: DateTime.Utc = after
): ReadonlyArray<DateTime.Utc> => {
  const wanted = Number.isFinite(count) ? Math.floor(count) : 0
  if (wanted <= 0) return []
  const zone = DateTime.zoneMakeNamed(timezone)
  if (Option.isNone(zone)) return []
  const horizonMs = DateTime.toEpochMillis(DateTime.add(after, { days: HORIZON_DAYS }))
  switch (schedule._tag) {
    case 'interval':
      return intervalRuns(schedule, after, anchor, wanted, horizonMs)
    case 'cron':
      return cronRuns(schedule, zone.value, after, wanted, horizonMs)
    default:
      return calendarRuns(schedule, zone.value, after, wanted)
  }
}

// --- describe -------------------------------------------------------------

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const

const formatTime = (time: string): string => {
  const { hours, minutes } = parseTime(time)
  const hour12 = hours % 12 === 0 ? 12 : hours % 12
  return `${hour12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`
}

/** "a", "a and b", "a, b and c". */
const list = (items: ReadonlyArray<string>): string =>
  items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

const ordinal = (n: number): string => {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

const describeTimes = (times: ReadonlyArray<string>): string =>
  `at ${list(sortedTimes(times).map(formatTime))}`

const describeWeekdays = (weekdays: ReadonlyArray<number>): string => {
  const days = Array.from(new Set(weekdays)).sort((a, b) => a - b)
  const key = days.join(',')
  if (key === '0,1,2,3,4,5,6') return 'Every day'
  if (key === '1,2,3,4,5') return 'Every weekday'
  if (key === '0,6') return 'Every weekend'
  return `Every ${list(days.map((d) => WEEKDAY_NAMES[d] ?? String(d)))}`
}

const describeMonthDays = (days: ReadonlyArray<MonthDay>): string => {
  const numbered = Array.from(new Set(days.filter((d): d is number => d !== 'last'))).sort(
    (a, b) => a - b
  )
  const parts = numbered.map(ordinal)
  if (days.includes('last')) parts.push('last day of the month')
  return `On the ${list(parts)}`
}

/**
 * The human sentence for a schedule, identical in list rows and the editor preview. Times are
 * already wall clock in the routine's zone, so `_timezone` is unused; it is accepted so callers
 * pass the same arguments they pass `nextRuns`.
 */
export const describeSchedule = (schedule: Schedule, _timezone: string): string => {
  switch (schedule._tag) {
    case 'interval': {
      const minutes = schedule.everyMinutes
      if (minutes % 60 === 0) return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`
      return `Every ${minutes} minutes`
    }
    case 'daily': {
      const every = schedule.everyNDays === 1 ? 'Every day' : `Every ${schedule.everyNDays} days`
      return `${every} ${describeTimes(schedule.times)}`
    }
    case 'weekly':
      return `${describeWeekdays(schedule.weekdays)} ${describeTimes(schedule.times)}`
    case 'monthly':
      return `${describeMonthDays(schedule.days)} ${describeTimes(schedule.times)}`
    case 'cron':
      return `Cron \`${schedule.expression}\``
  }
}

// --- validate -------------------------------------------------------------

/**
 * Everything the editor can get wrong before the payload is decoded. Same shape as
 * `Validation.issues`, so the server can throw the result as-is. `[]` means valid.
 */
export const validateSchedule = (schedule: Schedule): ReadonlyArray<ValidationIssue> => {
  const issues: Array<ValidationIssue> = []
  const checkTimes = (times: ReadonlyArray<string>) => {
    if (times.length === 0) issues.push({ path: ['times'], message: 'add at least one time' })
    times.forEach((time, i) => {
      if (!TIME_OF_DAY.test(time))
        issues.push({ path: ['times', i], message: 'expected HH:MM (24 h)' })
    })
    for (let i = 1; i < times.length; i++) {
      const previous = times[i - 1]
      const current = times[i]
      if (previous !== undefined && current !== undefined && !(previous < current)) {
        issues.push({ path: ['times'], message: 'times must be sorted and unique' })
        break
      }
    }
  }
  const checkUnique = (path: string, values: ReadonlyArray<unknown>) => {
    if (values.length === 0)
      issues.push({ path: [path], message: `add at least one ${path.slice(0, -1)}` })
    if (new Set(values).size !== values.length)
      issues.push({ path: [path], message: `${path} must be unique` })
  }
  const checkRange = (path: string, value: number, min: number, max: number) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      issues.push({ path: [path], message: `must be a whole number between ${min} and ${max}` })
    }
  }
  switch (schedule._tag) {
    case 'interval':
      checkRange('everyMinutes', schedule.everyMinutes, 5, 1440)
      break
    case 'daily':
      checkRange('everyNDays', schedule.everyNDays, 1, 30)
      if (Option.isNone(calendarDate(schedule.anchorDate))) {
        issues.push({ path: ['anchorDate'], message: 'expected a real calendar day (YYYY-MM-DD)' })
      }
      checkTimes(schedule.times)
      break
    case 'weekly':
      checkUnique('weekdays', schedule.weekdays)
      schedule.weekdays.forEach((d, i) => {
        if (!Number.isInteger(d) || d < 0 || d > 6)
          issues.push({ path: ['weekdays', i], message: 'expected 0 (Sunday) to 6 (Saturday)' })
      })
      checkTimes(schedule.times)
      break
    case 'monthly':
      checkUnique('days', schedule.days)
      schedule.days.forEach((d, i) => {
        if (d !== 'last' && (!Number.isInteger(d) || d < 1 || d > 31))
          issues.push({ path: ['days', i], message: "expected 1 to 31 or 'last'" })
      })
      checkTimes(schedule.times)
      break
    case 'cron': {
      const parsed = parseCron(schedule.expression)
      if (Either.isLeft(parsed)) issues.push({ path: ['expression'], message: parsed.left })
      break
    }
  }
  return issues
}
