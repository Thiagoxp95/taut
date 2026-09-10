/**
 * The schedule editor behind every routine (docs/build-plan-routines.md).
 *
 * Controlled on a `Schedule` and its time zone, so the dialog owns the value and this owns
 * nothing but the chips. Every sentence and every preview row comes from `@taut/contract` —
 * the same `nextRuns` the server fires on, so what a human approves here is what happens.
 */
import * as React from 'react'
import { PlusIcon, TriangleAlertIcon, XIcon } from '@taut/ui/components/icons'
import {
  describeSchedule,
  nextRuns,
  TimeOfDay,
  validateSchedule,
  type MonthDay,
  type Schedule
} from '@taut/contract'
import { DateTime, Option, Schema } from 'effect'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@taut/ui/components/tabs'
import { cn } from '@taut/ui/lib/utils'
import { Field } from '@/components/page'
import { useTicker } from '@/hooks/use-ticker'

// --- values ---------------------------------------------------------------

type Mode = Schedule['_tag']

const MODES: readonly { readonly mode: Mode; readonly label: string }[] = [
  { mode: 'interval', label: 'Interval' },
  { mode: 'daily', label: 'Daily' },
  { mode: 'weekly', label: 'Weekly' },
  { mode: 'monthly', label: 'Monthly' },
  { mode: 'cron', label: 'Advanced' }
]

const decodeTime = Schema.decodeUnknownOption(TimeOfDay)
const DEFAULT_TIME = TimeOfDay.make('09:00')

/** `<input type="time">` hands back `''` while it is half-typed; only real clock times land. */
const toTimeOfDay = (value: string): TimeOfDay | undefined =>
  Option.getOrUndefined(decodeTime(value))

/**
 * A selection may go empty for a moment — clearing the month grid, removing the last time —
 * and `validateSchedule` is what refuses to save it. `Schema.NonEmptyArray` cannot say that,
 * so the widening lives here once instead of at every call site.
 */
const maybeEmpty = <A,>(values: readonly A[]): readonly [A, ...A[]] =>
  values as readonly [A, ...A[]]

const sortTimes = (times: readonly TimeOfDay[]): readonly TimeOfDay[] =>
  Array.from(new Set(times)).sort()

const timesOf = (schedule: Schedule): readonly TimeOfDay[] =>
  schedule._tag === 'daily' || schedule._tag === 'weekly' || schedule._tag === 'monthly'
    ? schedule.times
    : [DEFAULT_TIME]

/** Today as a calendar day in `timezone` — `en-CA` is the locale that formats as YYYY-MM-DD. */
function todayIn(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

/** What a brand-new routine starts as: every day at 9:00, the shape most people want. */
export const defaultSchedule = (timezone: string): Schedule => ({
  _tag: 'daily',
  everyNDays: 1,
  anchorDate: todayIn(timezone),
  times: [DEFAULT_TIME]
})

/** Switching modes keeps the times, so a 9:00 weekly becomes a 9:00 monthly. */
function blankSchedule(mode: Mode, from: Schedule, timezone: string): Schedule {
  const times = maybeEmpty(timesOf(from))
  switch (mode) {
    case 'interval':
      return { _tag: 'interval', everyMinutes: 60 }
    case 'daily':
      return { _tag: 'daily', everyNDays: 1, anchorDate: todayIn(timezone), times }
    case 'weekly':
      return { _tag: 'weekly', weekdays: [1, 2, 3, 4, 5], times }
    case 'monthly':
      return { _tag: 'monthly', days: [1], times }
    case 'cron':
      return { _tag: 'cron', expression: '0 9 * * 1-5' }
  }
}

/** The routine's own zone, not the reader's: a 9:00 standup reads as 9:00 here too. */
function useRunFormatter(timezone: string): Intl.DateTimeFormat {
  return React.useMemo(() => {
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }
    try {
      return new Intl.DateTimeFormat(undefined, { ...options, timeZone: timezone })
    } catch {
      return new Intl.DateTimeFormat(undefined, options)
    }
  }, [timezone])
}

/** ~400 zones from the runtime's database; the browser's own zone is always first. */
function useTimezones(current: string): readonly string[] {
  return React.useMemo(() => {
    let all: readonly string[] = []
    try {
      all = Intl.supportedValuesOf('timeZone')
    } catch {
      all = []
    }
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone
    const rest = all.filter((zone) => zone !== local && zone !== current)
    return [...new Set([local, current, ...rest].filter((zone) => zone !== ''))]
  }, [current])
}

// --- chips ----------------------------------------------------------------

const CHIP_BASE =
  'flex size-9 items-center justify-center text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50'

function Chip({
  selected,
  round,
  className,
  ...props
}: React.ComponentProps<'button'> & { selected: boolean; round?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        CHIP_BASE,
        round === true ? 'rounded-full' : 'rounded-md',
        selected
          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
          : 'bg-muted text-foreground hover:bg-accent',
        className
      )}
      {...props}
    />
  )
}

/**
 * Roving focus over a chip grid: one tab stop, arrows walk it, Home/End jump to the ends.
 * `columns` is what up/down step by, so the weekday row (7 across, one row) and the month
 * grid (7 across, five rows) share it.
 */
function useChipGrid(count: number, columns: number) {
  const [active, setActive] = React.useState(0)
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])

  const focus = (index: number): void => {
    const clamped = Math.max(0, Math.min(count - 1, index))
    setActive(clamped)
    refs.current[clamped]?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent, index: number): void => {
    const step =
      event.key === 'ArrowLeft'
        ? -1
        : event.key === 'ArrowRight'
          ? 1
          : event.key === 'ArrowUp'
            ? -columns
            : event.key === 'ArrowDown'
              ? columns
              : undefined
    if (step !== undefined) {
      event.preventDefault()
      focus(index + step)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      focus(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focus(count - 1)
    }
  }

  const props = (index: number) => ({
    ref: (node: HTMLButtonElement | null) => {
      refs.current[index] = node
    },
    tabIndex: index === Math.min(active, count - 1) ? 0 : -1,
    onKeyDown: (event: React.KeyboardEvent) => onKeyDown(event, index),
    onFocus: () => setActive(index)
  })

  return props
}

// --- mode bodies ----------------------------------------------------------

const INTERVAL_UNITS = { minutes: 1, hours: 60 } as const
type IntervalUnit = keyof typeof INTERVAL_UNITS

function IntervalBody({
  everyMinutes,
  onChange,
  id
}: {
  everyMinutes: number
  onChange: (everyMinutes: number) => void
  id: string
}) {
  // 90 minutes has no whole-hour reading, so the unit follows the value rather than state.
  const unit: IntervalUnit = everyMinutes % 60 === 0 && everyMinutes >= 60 ? 'hours' : 'minutes'
  const amount = everyMinutes / INTERVAL_UNITS[unit]
  const max = unit === 'hours' ? 24 : 1440

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <span className="text-sm">Every</span>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={unit === 'hours' ? 1 : 5}
          max={max}
          value={amount}
          aria-label="Interval length"
          className="w-20"
          onChange={(event) => {
            const next = Number(event.target.value)
            if (!Number.isFinite(next)) return
            onChange(Math.round(next) * INTERVAL_UNITS[unit])
          }}
        />
        <Select
          value={unit}
          onValueChange={(next) => {
            if (next !== 'minutes' && next !== 'hours') return
            onChange(Math.round(amount) * INTERVAL_UNITS[next])
          }}
        >
          <SelectTrigger className="w-32" aria-label="Interval unit">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="minutes">minutes</SelectItem>
            <SelectItem value="hours">hours</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        Counted from the moment the routine is created, so the gap stays even across restarts.
        Between 5 minutes and 24 hours.
      </p>
    </div>
  )
}

function DailyBody({
  everyNDays,
  anchorDate,
  onChange,
  id
}: {
  everyNDays: number
  anchorDate: string
  onChange: (everyNDays: number) => void
  id: string
}) {
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <span className="text-sm">Every</span>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          max={30}
          value={everyNDays}
          aria-label="Days between runs"
          className="w-20"
          onChange={(event) => {
            const next = Number(event.target.value)
            if (!Number.isFinite(next)) return
            onChange(Math.round(next))
          }}
        />
        <span className="text-sm">{everyNDays === 1 ? 'day' : 'days'}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {everyNDays === 1
          ? 'Runs every day. Add a second time below to run it more than once a day.'
          : `Counted from ${anchorDate}, so it lands on that day and every ${everyNDays}th after it.`}
      </p>
    </div>
  )
}

const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const

const WEEKDAY_PRESETS: readonly { readonly label: string; readonly days: readonly number[] }[] = [
  { label: 'Every day', days: [0, 1, 2, 3, 4, 5, 6] },
  { label: 'Weekdays', days: [1, 2, 3, 4, 5] },
  { label: 'Weekends', days: [0, 6] }
]

const sameDays = (a: readonly number[], b: readonly number[]): boolean => {
  if (a.length !== b.length) return false
  const other = new Set(b)
  return a.every((day) => other.has(day))
}

function WeeklyBody({
  weekdays,
  onChange
}: {
  weekdays: readonly number[]
  onChange: (weekdays: readonly number[]) => void
}) {
  const chip = useChipGrid(7, 7)
  const selected = new Set(weekdays)

  return (
    <div className="grid gap-2">
      <div
        className="grid w-full max-w-72 grid-cols-7 gap-1 [&>button]:min-w-0 [&>button]:w-full"
        role="group"
        aria-label="Days of the week"
      >
        {WEEKDAY_LETTERS.map((letter, day) => (
          <Chip
            key={day}
            round
            selected={selected.has(day)}
            aria-label={WEEKDAY_NAMES[day]}
            onClick={() =>
              onChange(
                selected.has(day)
                  ? weekdays.filter((current) => current !== day)
                  : [...weekdays, day].sort((a, b) => a - b)
              )
            }
            {...chip(day)}
          >
            {letter}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {WEEKDAY_PRESETS.map((preset) => (
          <Button
            key={preset.label}
            type="button"
            size="xs"
            variant={sameDays(weekdays, preset.days) ? 'default' : 'outline'}
            onClick={() => onChange(preset.days)}
          >
            {preset.label}
          </Button>
        ))}
      </div>
    </div>
  )
}

const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1)

function MonthlyBody({
  days,
  onChange
}: {
  days: readonly MonthDay[]
  onChange: (days: readonly MonthDay[]) => void
}) {
  // 31 numbered chips plus "Last day", which fills the four cells the fifth row leaves free.
  const chip = useChipGrid(32, 7)
  const selected = new Set<MonthDay>(days)

  const toggle = (day: MonthDay): void =>
    onChange(
      selected.has(day)
        ? days.filter((current) => current !== day)
        : [...days, day].sort((a, b) => (a === 'last' ? 1 : b === 'last' ? -1 : a - b))
    )

  const keep = (predicate: (day: number) => boolean): void =>
    onChange([...MONTH_DAYS.filter(predicate), ...(selected.has('last') ? ['last' as const] : [])])

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-1">
        <Button type="button" size="xs" variant="ghost" onClick={() => keep(() => true)}>
          All
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => keep((d) => d % 2 === 1)}>
          Odd
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => keep((d) => d % 2 === 0)}>
          Even
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => onChange([])}>
          Clear
        </Button>
      </div>
      <div
        className="grid w-full max-w-72 grid-cols-7 gap-1 [&>button]:min-w-0 [&>button]:w-full"
        role="group"
        aria-label="Days of the month"
      >
        {MONTH_DAYS.map((day) => (
          <Chip
            key={day}
            selected={selected.has(day)}
            aria-label={`Day ${day}`}
            onClick={() => toggle(day)}
            {...chip(day - 1)}
          >
            {day}
          </Chip>
        ))}
        <Chip
          selected={selected.has('last')}
          className="col-span-4 w-full"
          aria-label="Last day of the month"
          onClick={() => toggle('last')}
          {...chip(31)}
        >
          Last day
        </Chip>
      </div>
      <p className="text-xs text-muted-foreground">
        A month without the day you picked is skipped — the 31st never fires in April.
      </p>
    </div>
  )
}

function CronBody({
  expression,
  issue,
  onChange,
  id
}: {
  expression: string
  issue: string | undefined
  onChange: (expression: string) => void
  id: string
}) {
  return (
    <div className="grid gap-2">
      <Input
        id={id}
        value={expression}
        spellCheck={false}
        autoComplete="off"
        aria-label="Cron expression"
        aria-invalid={issue !== undefined}
        className="font-mono"
        placeholder="0 9 * * 1-5"
        onChange={(event) => onChange(event.target.value)}
      />
      {issue === undefined ? (
        <p className="text-xs text-muted-foreground">
          Five fields — minute, hour, day of month, month, day of week. The times below do not
          apply; the expression carries its own.
        </p>
      ) : (
        <p className="text-xs text-destructive">{issue}</p>
      )}
    </div>
  )
}

// --- times ----------------------------------------------------------------

function TimesRow({
  times,
  onChange
}: {
  times: readonly TimeOfDay[]
  onChange: (times: readonly TimeOfDay[]) => void
}) {
  /** An hour after the last one, so adding twice gives 9:00, 10:00, 11:00 without typing. */
  const add = (): void => {
    const last = times[times.length - 1]
    const minutes =
      last === undefined
        ? 9 * 60
        : (Number(last.slice(0, 2)) * 60 + Number(last.slice(3)) + 60) % 1440
    const next = toTimeOfDay(
      `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
    )
    if (next !== undefined) onChange(sortTimes([...times, next]))
  }

  return (
    <div className="grid gap-2">
      <span className="text-sm leading-none font-medium select-none">Times</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {times.map((time, index) => (
          <span
            key={index}
            className="inline-flex h-9 items-center gap-1 rounded-full bg-muted pr-1 pl-3 text-sm focus-within:ring-[3px] focus-within:ring-ring/50"
          >
            <input
              type="time"
              value={time}
              aria-label={`Time ${index + 1}`}
              className="w-[5.25rem] bg-transparent tabular-nums outline-none"
              onChange={(event) => {
                const next = toTimeOfDay(event.target.value)
                if (next === undefined) return
                onChange(sortTimes(times.map((current, i) => (i === index ? next : current))))
              }}
            />
            <button
              type="button"
              aria-label={`Remove ${time}`}
              onClick={() => onChange(times.filter((_, i) => i !== index))}
              className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-background hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <XIcon className="size-3.5" />
            </button>
          </span>
        ))}
        <Button type="button" size="sm" variant="outline" onClick={add}>
          <PlusIcon />
          Add time
        </Button>
      </div>
    </div>
  )
}

// --- the picker -----------------------------------------------------------

export function SchedulePicker({
  value,
  onChange,
  timezone,
  onTimezoneChange
}: {
  value: Schedule
  onChange: (schedule: Schedule) => void
  /** IANA zone the times are wall clock in; defaults to the browser's in the dialog. */
  timezone: string
  onTimezoneChange: (timezone: string) => void
}) {
  const id = React.useId()
  // Reading the clock in an effect-driven tick keeps `nextRuns` out of render's way, and
  // makes an interval preview move on its own while the dialog is open.
  const now = useTicker(30_000)
  const zones = useTimezones(timezone)
  const formatter = useRunFormatter(timezone)

  // Switching away and back should not lose what was already picked.
  const drafts = React.useRef<Partial<Record<Mode, Schedule>>>({})
  React.useEffect(() => {
    drafts.current[value._tag] = value
  }, [value])

  const issues = validateSchedule(value)
  const runs = nextRuns(value, timezone, DateTime.unsafeMake(now), 3)
  const cronIssue =
    value._tag === 'cron'
      ? issues.find((issue) => issue.path[0] === 'expression')?.message
      : undefined

  const setTimes = (times: readonly TimeOfDay[]): void => {
    if (value._tag !== 'daily' && value._tag !== 'weekly' && value._tag !== 'monthly') return
    onChange({ ...value, times: maybeEmpty(times) })
  }

  return (
    <div className="grid gap-4">
      <Tabs
        value={value._tag}
        onValueChange={(next) =>
          onChange(drafts.current[next as Mode] ?? blankSchedule(next as Mode, value, timezone))
        }
      >
        <TabsList className="grid h-auto w-full grid-cols-3 gap-1 sm:grid-cols-5">
          {MODES.map((entry) => (
            <TabsTrigger key={entry.mode} value={entry.mode} className="h-8 text-xs">
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* A floor under every mode body, so the four short ones do not move the preview. */}
        <div className="min-h-20 pt-1">
          <TabsContent value="interval">
            {value._tag === 'interval' ? (
              <IntervalBody
                id={`${id}-interval`}
                everyMinutes={value.everyMinutes}
                onChange={(everyMinutes) => onChange({ ...value, everyMinutes })}
              />
            ) : null}
          </TabsContent>

          <TabsContent value="daily">
            {value._tag === 'daily' ? (
              <DailyBody
                id={`${id}-daily`}
                everyNDays={value.everyNDays}
                anchorDate={value.anchorDate}
                onChange={(everyNDays) => onChange({ ...value, everyNDays })}
              />
            ) : null}
          </TabsContent>

          <TabsContent value="weekly">
            {value._tag === 'weekly' ? (
              <WeeklyBody
                weekdays={value.weekdays}
                onChange={(weekdays) => onChange({ ...value, weekdays: maybeEmpty(weekdays) })}
              />
            ) : null}
          </TabsContent>

          <TabsContent value="monthly">
            {value._tag === 'monthly' ? (
              <MonthlyBody
                days={value.days}
                onChange={(days) => onChange({ ...value, days: maybeEmpty(days) })}
              />
            ) : null}
          </TabsContent>

          <TabsContent value="cron">
            {value._tag === 'cron' ? (
              <CronBody
                id={`${id}-cron`}
                expression={value.expression}
                issue={cronIssue}
                onChange={(expression) => onChange({ ...value, expression })}
              />
            ) : null}
          </TabsContent>
        </div>
      </Tabs>

      {value._tag === 'daily' || value._tag === 'weekly' || value._tag === 'monthly' ? (
        <TimesRow times={value.times} onChange={setTimes} />
      ) : null}

      <Field
        label="Time zone"
        htmlFor={`${id}-timezone`}
        hint="Times are wall clock here, so a 9:00 run stays at 9:00 through a daylight-saving change."
      >
        <Select value={timezone} onValueChange={onTimezoneChange}>
          <SelectTrigger id={`${id}-timezone`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {zones.map((zone) => (
              <SelectItem key={zone} value={zone}>
                {zone.replace(/_/g, ' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <SchedulePreview
        schedule={value}
        timezone={timezone}
        issue={issues[0]?.message}
        runs={runs}
        formatter={formatter}
      />
    </div>
  )
}

function SchedulePreview({
  schedule,
  timezone,
  issue,
  runs,
  formatter
}: {
  schedule: Schedule
  timezone: string
  issue: string | undefined
  runs: readonly DateTime.Utc[]
  formatter: Intl.DateTimeFormat
}) {
  if (issue !== undefined) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2.5">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{issue}</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-muted/40 px-3 py-2.5">
      <p className="text-sm font-medium">{describeSchedule(schedule, timezone)}</p>
      {runs.length === 0 ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <TriangleAlertIcon className="size-3.5" />
          Nothing matches this in the next 400 days, so it would never run.
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          Next: {runs.map((at) => formatter.format(DateTime.toEpochMillis(at))).join(' · ')}
        </p>
      )}
    </div>
  )
}
