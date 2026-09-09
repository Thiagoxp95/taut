/**
 * Agents have no profile picture. Their face is a blobatar derived from who the
 * agent *is*, so the same agent renders identically everywhere without any
 * asset to store, upload or serve.
 *
 * Two independent inputs draw it, and keeping them apart is the point:
 *
 * - the **seed** is the agent — handle, name, role — and gives it its colour,
 *   its eyes and its decoration;
 * - the **shape** is the agent's department, pinned rather than hashed, so a
 *   silhouette reads as "Engineering" across every screen.
 *
 * Both are built here rather than at the call sites because a blobatar is only
 * useful while every surface agrees on them: two views that seed differently
 * draw two different agents, and two views that shape differently move an agent
 * between departments on screen.
 */
import { DateTime } from 'effect'
import type { Agent, Department, DepartmentShape } from '@taut/contract'

/**
 * The identity fields the face is drawn from. Structural rather than `Agent` so
 * a partial row (a directory entry, a task assignee) can seed one too — but
 * everything listed is present on every payload that carries an agent, which is
 * what keeps the drawing stable across list and detail views.
 */
export interface AgentAvatarIdentity {
  readonly handle: string
  readonly name: string
  readonly role: string
  /**
   * Skill names. Off the wire today — `agents.list` returns `Agent`, and skills
   * only come back from `agents.get` — so passing them from the detail route
   * alone would give that one screen a different face. Wired here so it becomes
   * a one-line change once the list carries them.
   */
  readonly skills?: readonly string[]
}

/** Sorted, so membership order off the wire cannot change the face. */
function set(values: readonly string[] | undefined): string {
  return values === undefined ? '' : [...values].sort().join('+')
}

/**
 * The string a blobatar is drawn from. Stable for a given agent identity, and
 * deliberately sensitive to role: renaming an agent or retitling it does redraw
 * its face.
 *
 * Department is *not* in here, and that is the change that made silhouettes
 * departmental. It is expressed as the shape instead, so moving an agent
 * between departments restyles the creature it already is rather than replacing
 * it with a stranger — and counting the department twice would do exactly that.
 */
export function agentAvatarSeed(agent: AgentAvatarIdentity): string {
  return [agent.handle, agent.name, agent.role, set(agent.skills)].join('|')
}

/** The seed for a full `Agent` row. */
export function seedOfAgent(agent: Agent): string {
  return agentAvatarSeed({ handle: agent.handle, name: agent.name, role: agent.role })
}

/**
 * The ten silhouettes blobatar 2 can draw, each as the 0–1 trait position that
 * selects it — the midpoint of its band in the generator's private table, so a
 * value here is as far from the neighbouring silhouettes as the band allows.
 *
 * Order is the generator's own, which runs everyday-first: the earliest
 * departments get the shapes a crowd reads as ordinary and the louder ones
 * arrive as a company grows into them.
 *
 * Frozen for as long as `blobatar` stays on major 2 — the bands partition
 * [0, 1) and a new silhouette has to take its share from the existing ones, so
 * these numbers move on a major and only on a major. Re-read them off
 * `blobatar/src/styles/blob.ts` when that upgrade happens; every agent's
 * silhouette changes with them, which is what the major is the opt-in for.
 */
export const SHAPE_TRAITS = [
  0.11, // round
  0.35, // organic
  0.54, // boxy
  0.65, // capsule
  0.745, // nub
  0.825, // cloud
  0.8875, // droplet
  0.9325, // hexagon
  0.965, // sun
  0.99 // triangle
] as const

/**
 * Silhouette names, parallel to `SHAPE_TRAITS`. This is the order the picker
 * lists them in, and the order auto departments are handed one.
 *
 * The same ten literals as `DepartmentShape` in the contract, which is what a
 * department stores. Kept as a local array rather than imported from the schema
 * because the index into it *is* the index into `SHAPE_TRAITS` — the pairing is
 * positional, so the two lists have to be written next to each other.
 */
export const SHAPE_NAMES = [
  'round',
  'organic',
  'boxy',
  'capsule',
  'nub',
  'cloud',
  'droplet',
  'hexagon',
  'sun',
  'triangle'
] as const

export type ShapeName = (typeof SHAPE_NAMES)[number]

/** The trait position that draws a named silhouette. */
export function traitOfShape(shape: DepartmentShape): number {
  const index = SHAPE_NAMES.indexOf(shape)
  return SHAPE_TRAITS[index === -1 ? 0 : index] as number
}

/**
 * `departmentId → silhouette`.
 *
 * A department that picked a shape gets the one it picked. The rest are handed
 * a shape by age — oldest first — out of the silhouettes nobody picked, so a
 * deliberate choice can never be shadowed by an accidental one and two
 * departments still never share a silhouette while there are shapes to go
 * round.
 *
 * Deterministic and distinct rather than hashed. Hashing the id needs no list
 * and never shifts, but with only ten silhouettes it collides at around a 70%
 * chance by the fifth department — and two departments sharing a silhouette
 * costs the whole feature its meaning.
 *
 * The costs of deriving the leftovers instead of storing them, stated plainly:
 * the eleventh department wraps onto an already-used shape, and deleting a
 * department — or pinning a shape an auto department happened to be wearing —
 * re-shapes the auto departments after it. Picking a shape is the escape hatch
 * from both, which is what the picker in department settings is for.
 *
 * `id` breaks a tie so two departments created in the same millisecond cannot
 * swap shapes between two renders.
 *
 * Keyed by plain `string`, not `DepartmentId`: half the callers hold an id off a
 * form value or a route param, and a branded key would cost each of them a
 * parse to do a map lookup.
 */
export function departmentShapes(departments: readonly Department[]): ReadonlyMap<string, number> {
  const byAge = [...departments].sort((a, b) => {
    const delta = DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt)
    return delta !== 0 ? delta : a.id.localeCompare(b.id)
  })
  const taken = new Set(
    byAge.flatMap((department) =>
      department.shape === undefined ? [] : [SHAPE_NAMES.indexOf(department.shape)]
    )
  )
  // Every shape pinned leaves nothing to hand out, so the auto departments go
  // back to the full list rather than to no list at all.
  const free = SHAPE_TRAITS.map((_, index) => index).filter((index) => !taken.has(index))
  const pool = free.length === 0 ? SHAPE_TRAITS.map((_, index) => index) : free
  let next = 0
  return new Map(
    byAge.map((department) => [
      department.id,
      department.shape === undefined
        ? (SHAPE_TRAITS[pool[next++ % pool.length] as number] as number)
        : traitOfShape(department.shape)
    ])
  )
}

/**
 * Everything `EntityAvatar` needs to draw one agent. Seed and shape travel as
 * one value because they are one face: a surface that passes the seed and
 * forgets the shape draws the right agent in the wrong department.
 */
export interface AgentFace {
  readonly seed: string
  /**
   * The department's silhouette. `undefined` while the departments are still
   * loading, or for an agent in none — the seed picks a shape then, which is
   * the pre-departmental behaviour and the only sane fallback.
   */
  readonly shape?: number
}

/**
 * The face for an agent, given the company's shape assignment.
 *
 * `departmentIds` is oldest-first, so an agent in several departments wears the
 * one it was added to first. There is no primary-department field to consult,
 * and picking the oldest is the only choice that does not change under the
 * user's feet.
 */
export function agentFace(agent: Agent, shapes: ReadonlyMap<string, number>): AgentFace {
  return { seed: seedOfAgent(agent), shape: shapeOfAgent(agent, shapes) }
}

/** An agent's silhouette alone, for a surface that draws its own seed. */
export function shapeOfAgent(
  agent: Agent,
  shapes: ReadonlyMap<string, number>
): number | undefined {
  const home = agent.departmentIds[0]
  return home === undefined ? undefined : shapes.get(home)
}
