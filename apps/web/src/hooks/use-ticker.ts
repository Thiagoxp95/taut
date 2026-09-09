import * as React from 'react'

/**
 * `Date.now()` as state, refreshed on an interval, so countdowns and running
 * durations tick without any component reading the clock during render.
 *
 * Pass `active: false` when nothing on screen is counting — the interval is
 * then never installed.
 */
export function useTicker(intervalMs = 1000, active = true): number {
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, active])

  return now
}
