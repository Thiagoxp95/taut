import { describe, expect, it } from '@effect/vitest'
import { Cron, DateTime, Either, Option, Schema } from 'effect'

import {
  Schedule,
  Timezone,
  describeSchedule,
  nextRuns,
  validateSchedule,
  type Schedule as ScheduleT,
  type TimeOfDay
} from '../src/domain/schedule.js'

const toronto = 'America/Toronto'
const zone = Option.getOrThrow(DateTime.zoneMakeNamed(toronto))
const utc = (iso: string) => DateTime.unsafeMake(iso)
const iso = (runs: ReadonlyArray<DateTime.Utc>) => runs.map(DateTime.formatIso)
const t = (...times: ReadonlyArray<string>) =>
  times as unknown as readonly [TimeOfDay, ...TimeOfDay[]]
/** Wall-clock "YYYY-MM-DD HH:MM" in Toronto, to read DST assertions without converting in your head. */
const local = (runs: ReadonlyArray<DateTime.Utc>) =>
  runs.map((run) => {
    const p = DateTime.toParts(DateTime.setZone(run, zone))
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hours)}:${pad(p.minutes)}`
  })
const decode = Schema.decodeUnknownEither(Schedule)

const weekdays9: ScheduleT = { _tag: 'weekly', weekdays: [1, 2, 3, 4, 5], times: t('09:00') }

describe('nextRuns', () => {
  it('interval steps from the anchor, first run one step after it', () => {
    const anchor = utc('2026-09-08T12:00:00.000Z')
    const runs = nextRuns({ _tag: 'interval', everyMinutes: 90 }, toronto, anchor, 5, anchor)
    expect(iso(runs)).toEqual([
      '2026-09-08T13:30:00.000Z',
      '2026-09-08T15:00:00.000Z',
      '2026-09-08T16:30:00.000Z',
      '2026-09-08T18:00:00.000Z',
      '2026-09-08T19:30:00.000Z'
    ])
  })

  it('interval keeps the anchor grid after a restart instead of drifting from now', () => {
    const anchor = utc('2026-09-08T12:00:00.000Z')
    const later = utc('2026-09-08T14:10:00.000Z')
    expect(
      iso(nextRuns({ _tag: 'interval', everyMinutes: 90 }, toronto, later, 2, anchor))
    ).toEqual(['2026-09-08T15:00:00.000Z', '2026-09-08T16:30:00.000Z'])
    // exactly on a grid point is not "after" it
    const onGrid = utc('2026-09-08T15:00:00.000Z')
    expect(
      iso(nextRuns({ _tag: 'interval', everyMinutes: 90 }, toronto, onGrid, 1, anchor))
    ).toEqual(['2026-09-08T16:30:00.000Z'])
    // anchor ahead of `after` (clock skew): still one step after the anchor
    const early = utc('2026-09-08T11:00:00.000Z')
    expect(
      iso(nextRuns({ _tag: 'interval', everyMinutes: 90 }, toronto, early, 1, anchor))
    ).toEqual(['2026-09-08T13:30:00.000Z'])
  })

  it('daily: next 5 at 09:00 Toronto', () => {
    const s: ScheduleT = {
      _tag: 'daily',
      everyNDays: 1,
      anchorDate: '2026-01-01',
      times: t('09:00')
    }
    expect(iso(nextRuns(s, toronto, utc('2026-09-08T12:00:00.000Z'), 5))).toEqual([
      '2026-09-08T13:00:00.000Z',
      '2026-09-09T13:00:00.000Z',
      '2026-09-10T13:00:00.000Z',
      '2026-09-11T13:00:00.000Z',
      '2026-09-12T13:00:00.000Z'
    ])
  })

  it('weekly: next 5 weekdays from a Friday after 9', () => {
    expect(local(nextRuns(weekdays9, toronto, utc('2026-09-11T14:00:00.000Z'), 5))).toEqual([
      '2026-09-14 09:00',
      '2026-09-15 09:00',
      '2026-09-16 09:00',
      '2026-09-17 09:00',
      '2026-09-18 09:00'
    ])
  })

  it('monthly: next 5 on the 1st and 15th, crossing the fall-back into EST', () => {
    const s: ScheduleT = { _tag: 'monthly', days: [1, 15], times: t('09:00') }
    expect(iso(nextRuns(s, toronto, utc('2026-09-08T12:00:00.000Z'), 5))).toEqual([
      '2026-09-15T13:00:00.000Z',
      '2026-10-01T13:00:00.000Z',
      '2026-10-15T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
      '2026-11-15T14:00:00.000Z'
    ])
  })

  it('cron: next 5 and parity with Cron.next', () => {
    const s: ScheduleT = { _tag: 'cron', expression: '0 9 * * 1-5' }
    const after = utc('2026-09-11T14:00:00.000Z')
    const runs = nextRuns(s, toronto, after, 5)
    expect(local(runs)).toEqual(local(nextRuns(weekdays9, toronto, after, 5)))
    const cron = Either.getOrThrow(Cron.parse('0 9 * * 1-5', zone))
    const expected: Array<string> = []
    let cursor = DateTime.toDateUtc(after)
    for (let i = 0; i < 5; i++) {
      cursor = Cron.next(cron, cursor)
      expected.push(cursor.toISOString())
    }
    expect(iso(runs)).toEqual(expected)
  })

  it('multiple times per day come out sorted even when given unsorted', () => {
    const s: ScheduleT = {
      _tag: 'daily',
      everyNDays: 1,
      anchorDate: '2026-01-01',
      times: t('18:00', '08:00', '08:00')
    }
    expect(iso(nextRuns(s, toronto, utc('2026-09-08T12:00:00.000Z'), 4))).toEqual([
      '2026-09-08T22:00:00.000Z',
      '2026-09-09T12:00:00.000Z',
      '2026-09-09T22:00:00.000Z',
      '2026-09-10T12:00:00.000Z'
    ])
  })

  it('everyNDays alternates across a month boundary, counted from the anchor in both directions', () => {
    const s: ScheduleT = {
      _tag: 'daily',
      everyNDays: 2,
      anchorDate: '2026-01-30',
      times: t('08:00')
    }
    expect(local(nextRuns(s, toronto, utc('2026-01-29T00:00:00.000Z'), 5))).toEqual([
      '2026-01-30 08:00',
      '2026-02-01 08:00',
      '2026-02-03 08:00',
      '2026-02-05 08:00',
      '2026-02-07 08:00'
    ])
    const ahead: ScheduleT = { ...s, anchorDate: '2026-02-03' }
    expect(local(nextRuns(ahead, toronto, utc('2026-01-29T00:00:00.000Z'), 3))).toEqual([
      '2026-01-30 08:00',
      '2026-02-01 08:00',
      '2026-02-03 08:00'
    ])
  })

  it('monthly day 31 skips months without one', () => {
    const s: ScheduleT = { _tag: 'monthly', days: [31], times: t('09:00') }
    expect(local(nextRuns(s, toronto, utc('2026-01-31T15:00:00.000Z'), 5))).toEqual([
      '2026-03-31 09:00',
      '2026-05-31 09:00',
      '2026-07-31 09:00',
      '2026-08-31 09:00',
      '2026-10-31 09:00'
    ])
  })

  it("'last' resolves per month, including a leap February", () => {
    const s: ScheduleT = { _tag: 'monthly', days: ['last'], times: t('09:00') }
    expect(local(nextRuns(s, toronto, utc('2028-01-31T15:00:00.000Z'), 3))).toEqual([
      '2028-02-29 09:00',
      '2028-03-31 09:00',
      '2028-04-30 09:00'
    ])
    const with15: ScheduleT = { _tag: 'monthly', days: ['last', 15], times: t('09:00') }
    expect(local(nextRuns(with15, toronto, utc('2026-02-01T00:00:00.000Z'), 3))).toEqual([
      '2026-02-15 09:00',
      '2026-02-28 09:00',
      '2026-03-15 09:00'
    ])
  })

  it('spring forward (2026-03-08): a 02:30 daily time fires once, 24 h after the previous run', () => {
    const s: ScheduleT = {
      _tag: 'daily',
      everyNDays: 1,
      anchorDate: '2026-01-01',
      times: t('02:30')
    }
    const runs = nextRuns(s, toronto, utc('2026-03-07T00:00:00.000Z'), 3)
    expect(iso(runs)).toEqual([
      '2026-03-07T07:30:00.000Z',
      '2026-03-08T07:30:00.000Z',
      '2026-03-09T06:30:00.000Z'
    ])
    // 02:30 does not exist that morning; it lands on 03:30 EDT, the same instant as 02:30 EST would have
    expect(local(runs)[1]).toBe('2026-03-08 03:30')
    // an explicit 03:30 on the same day collapses with the shifted 02:30 instead of duplicating
    const both: ScheduleT = { ...s, times: t('02:30', '03:30') }
    expect(iso(nextRuns(both, toronto, utc('2026-03-08T00:00:00.000Z'), 2))).toEqual([
      '2026-03-08T07:30:00.000Z',
      '2026-03-09T06:30:00.000Z'
    ])
  })

  it('fall back (2026-11-01): a 01:30 daily time fires once, at the first occurrence', () => {
    const s: ScheduleT = {
      _tag: 'daily',
      everyNDays: 1,
      anchorDate: '2026-01-01',
      times: t('01:30')
    }
    const runs = nextRuns(s, toronto, utc('2026-10-31T12:00:00.000Z'), 3)
    expect(iso(runs)).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
      '2026-11-03T06:30:00.000Z'
    ])
    expect(local(runs)[0]).toBe('2026-11-01 01:30')
  })

  it('is total: unknown zone, impossible cron, bad anchor and count ≤ 0 all give []', () => {
    const daily: ScheduleT = {
      _tag: 'daily',
      everyNDays: 1,
      anchorDate: '2026-01-01',
      times: t('09:00')
    }
    const after = utc('2026-09-08T12:00:00.000Z')
    expect(nextRuns(daily, 'Mars/Olympus', after, 3)).toEqual([])
    expect(nextRuns({ _tag: 'cron', expression: '0 0 30 2 *' }, toronto, after, 3)).toEqual([])
    expect(nextRuns({ _tag: 'cron', expression: 'not cron' }, toronto, after, 3)).toEqual([])
    expect(nextRuns({ ...daily, anchorDate: '2026-02-31' }, toronto, after, 3)).toEqual([])
    expect(nextRuns(daily, toronto, after, 0)).toEqual([])
    expect(nextRuns(daily, toronto, after, Number.NaN)).toEqual([])
  })

  it('returns fewer than count when the 400-day horizon runs out', () => {
    // only Feb 29: one in 2028, none until 2032
    const s: ScheduleT = { _tag: 'cron', expression: '0 9 29 2 *' }
    expect(local(nextRuns(s, toronto, utc('2027-06-01T00:00:00.000Z'), 5))).toEqual([
      '2028-02-29 09:00'
    ])
  })
})

describe('describeSchedule', () => {
  it('reads like the plan', () => {
    expect(describeSchedule(weekdays9, toronto)).toBe('Every weekday at 9:00 AM')
    expect(
      describeSchedule(
        { _tag: 'daily', everyNDays: 2, anchorDate: '2026-01-01', times: t('08:00', '18:00') },
        toronto
      )
    ).toBe('Every 2 days at 8:00 AM and 6:00 PM')
    expect(
      describeSchedule(
        { _tag: 'daily', everyNDays: 1, anchorDate: '2026-01-01', times: t('00:00', '12:00') },
        toronto
      )
    ).toBe('Every day at 12:00 AM and 12:00 PM')
    expect(describeSchedule({ _tag: 'monthly', days: [1, 15], times: t('09:00') }, toronto)).toBe(
      'On the 1st and 15th at 9:00 AM'
    )
    expect(
      describeSchedule({ _tag: 'monthly', days: [2, 3, 'last'], times: t('09:00') }, toronto)
    ).toBe('On the 2nd, 3rd and last day of the month at 9:00 AM')
    expect(
      describeSchedule(
        { _tag: 'monthly', days: [11, 12, 13, 21, 22, 23], times: t('09:30') },
        toronto
      )
    ).toBe('On the 11th, 12th, 13th, 21st, 22nd and 23rd at 9:30 AM')
    expect(describeSchedule({ _tag: 'interval', everyMinutes: 30 }, toronto)).toBe(
      'Every 30 minutes'
    )
    expect(describeSchedule({ _tag: 'interval', everyMinutes: 60 }, toronto)).toBe('Every hour')
    expect(describeSchedule({ _tag: 'interval', everyMinutes: 120 }, toronto)).toBe('Every 2 hours')
    expect(describeSchedule({ _tag: 'cron', expression: '0 9 * * 1-5' }, toronto)).toBe(
      'Cron `0 9 * * 1-5`'
    )
  })

  it('names weekday sets', () => {
    const weekly = (weekdays: ReadonlyArray<number>): ScheduleT => ({
      _tag: 'weekly',
      weekdays: weekdays as unknown as readonly [number, ...number[]],
      times: t('09:00')
    })
    expect(describeSchedule(weekly([0, 1, 2, 3, 4, 5, 6]), toronto)).toBe('Every day at 9:00 AM')
    expect(describeSchedule(weekly([6, 0]), toronto)).toBe('Every weekend at 9:00 AM')
    expect(describeSchedule(weekly([1]), toronto)).toBe('Every Monday at 9:00 AM')
    expect(describeSchedule(weekly([5, 1, 3]), toronto)).toBe(
      'Every Monday, Wednesday and Friday at 9:00 AM'
    )
  })
})

describe('validateSchedule', () => {
  it('rejects a bad cron and accepts a good one', () => {
    expect(validateSchedule({ _tag: 'cron', expression: '0 9 * * 1-5' })).toEqual([])
    const bad = validateSchedule({ _tag: 'cron', expression: 'every day at nine' })
    expect(bad).toHaveLength(1)
    expect(bad[0]?.path).toEqual(['expression'])
    // effect would accept six fields (seconds first); the editor promises five
    expect(validateSchedule({ _tag: 'cron', expression: '0 0 9 * * *' })[0]?.path).toEqual([
      'expression'
    ])
  })

  it('wants times sorted and unique, arrays non-empty, a real anchor day', () => {
    expect(validateSchedule(weekdays9)).toEqual([])
    expect(
      validateSchedule({ _tag: 'weekly', weekdays: [1], times: t('18:00', '09:00') }).map(
        (i) => i.path
      )
    ).toEqual([['times']])
    expect(
      validateSchedule({ _tag: 'weekly', weekdays: [1], times: t('09:00', '09:00') }).map(
        (i) => i.path
      )
    ).toEqual([['times']])
    expect(
      validateSchedule({ _tag: 'weekly', weekdays: [1, 1], times: t('09:00') }).map((i) => i.path)
    ).toEqual([['weekdays']])
    expect(
      validateSchedule({
        _tag: 'weekly',
        weekdays: [] as unknown as readonly [number, ...number[]],
        times: [] as unknown as readonly [TimeOfDay, ...TimeOfDay[]]
      }).map((i) => i.path)
    ).toEqual([['weekdays'], ['times']])
    expect(
      validateSchedule({
        _tag: 'daily',
        everyNDays: 2,
        anchorDate: '2026-02-31',
        times: t('09:00')
      }).map((i) => i.path)
    ).toEqual([['anchorDate']])
    expect(validateSchedule({ _tag: 'interval', everyMinutes: 3 }).map((i) => i.path)).toEqual([
      ['everyMinutes']
    ])
    expect(
      validateSchedule({
        _tag: 'daily',
        everyNDays: 1,
        anchorDate: '2026-01-01',
        times: t('9:00')
      }).map((i) => i.path)
    ).toEqual([['times', 0]])
  })
})

describe('Schedule schema', () => {
  it('validates cron and time zones on decode', () => {
    expect(Either.isRight(decode({ _tag: 'cron', expression: '*/15 * * * *' }))).toBe(true)
    expect(Either.isLeft(decode({ _tag: 'cron', expression: 'nope' }))).toBe(true)
    expect(
      Either.isLeft(
        decode({ _tag: 'daily', everyNDays: 1, anchorDate: '2026-01-01', times: ['9:00'] })
      )
    ).toBe(true)
    expect(Either.isLeft(decode({ _tag: 'weekly', weekdays: [], times: ['09:00'] }))).toBe(true)
    const tz = Schema.decodeUnknownEither(Timezone)
    expect(Either.isRight(tz('America/Toronto'))).toBe(true)
    expect(Either.isRight(tz('UTC'))).toBe(true)
    expect(Either.isLeft(tz('Mars/Olympus'))).toBe(true)
  })
})
