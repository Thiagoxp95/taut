/**
 * How a mirrored Linear project is shown (docs/build-plan-projects.md).
 *
 * The mirror stores Linear's own words; these turn them into something a Taut
 * reader can scan. Kept out of the components because the sidebar dot, the list
 * badge and the detail header all have to agree on what "started" looks like.
 */
import type { Project, ProjectHealth, ProjectPriority, ProjectState } from '@taut/contract'

/** Human label for each state Linear reports. */
export const PROJECT_STATE_LABEL: Record<ProjectState, string> = {
  backlog: 'Backlog',
  planned: 'Planned',
  started: 'In progress',
  paused: 'Paused',
  completed: 'Completed',
  canceled: 'Canceled',
  unknown: 'Unknown'
}

/**
 * Tailwind text colour per state, used for the dot and the badge. Deliberately
 * only a colour: the label carries the meaning, so this stays readable to anyone
 * who cannot tell green from amber.
 */
export const PROJECT_STATE_COLOR: Record<ProjectState, string> = {
  backlog: 'text-muted-foreground',
  planned: 'text-sky-500',
  started: 'text-amber-500',
  paused: 'text-muted-foreground',
  completed: 'text-emerald-500',
  canceled: 'text-muted-foreground',
  unknown: 'text-muted-foreground'
}

/** `0.42` → `42%`. Linear reports progress as a fraction. */
export const projectProgress = (project: Project): number =>
  Math.max(0, Math.min(100, Math.round(project.progress * 100)))

/**
 * `YYYY-MM-DD` as a short local date. Linear's `TimelessDate` is a calendar day,
 * so it is split by hand rather than parsed: `new Date('2026-03-01')` is UTC
 * midnight, which is the last day of February in half the world.
 */
const parseTimelessDate = (value: string | undefined): Date | undefined => {
  if (value === undefined) return undefined
  const parts = value.split('-')
  if (parts.length < 3) return undefined
  const [year, month, day] = parts
  const date = new Date(Number(year), Number(month) - 1, Number(day))
  return Number.isNaN(date.getTime()) ? undefined : date
}

export const formatTimelessDate = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const date = parseTimelessDate(value)
  return date === undefined
    ? value
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Linear's five priority levels, by the number Linear stores (D14). `0` is the
 * absence of a priority, which is why it sorts *after* the four real ones: a
 * board ordered by priority puts urgent first and unprioritised last.
 */
export const PROJECT_PRIORITY_LABEL: Record<ProjectPriority, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low'
}

/** Ascending: urgent first, no-priority last. */
export const priorityRank = (priority: ProjectPriority): number => (priority === 0 ? 5 : priority)

/** Linear's own words for a health flag. */
export const PROJECT_HEALTH_LABEL: Record<ProjectHealth, string> = {
  onTrack: 'On track',
  atRisk: 'At risk',
  offTrack: 'Off track'
}

export const PROJECT_HEALTH_COLOR: Record<ProjectHealth, string> = {
  onTrack: 'text-emerald-500',
  atRisk: 'text-amber-500',
  offTrack: 'text-red-500'
}

/**
 * `YYYY-MM-DD` the way a Linear card writes it: `Apr 30th`, and `Apr 30, 2025`
 * once the year stops being this one. Split by hand for the same reason as
 * `formatTimelessDate` — a calendar day is not a timestamp.
 */
const ordinal = (day: number): string => {
  const rest = day % 100
  if (rest >= 11 && rest <= 13) return `${day}th`
  const last = day % 10
  return `${day}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`
}

export const formatBoardDate = (value: string | undefined): string | undefined => {
  const date = parseTimelessDate(value)
  if (date === undefined) return value
  const month = date.toLocaleDateString(undefined, { month: 'short' })
  return date.getFullYear() === new Date().getFullYear()
    ? `${month} ${ordinal(date.getDate())}`
    : `${month} ${date.getDate()}, ${date.getFullYear()}`
}

/** A target date Linear would draw in red: today or earlier. */
export const isOverdue = (value: string | undefined): boolean => {
  const date = parseTimelessDate(value)
  if (date === undefined) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return date.getTime() < today.getTime()
}
