/**
 * The paint layer under every agent avatar: one animation clock for the whole
 * page, and one tinted bitmap per distinct orb rather than one per avatar.
 *
 * The old drawing ran a `requestAnimationFrame` loop per avatar and, inside it,
 * set `fillStyle` and `globalAlpha` once per dot. A `working` orb at the 64
 * preset is 516 dots, so eight busy agents on screen cost eight geometry
 * solves and about eight thousand canvas state changes every frame — which is
 * what the jank was. Three things fix it and they all live here:
 *
 * - **One clock.** Every avatar reads the same `now`, so several orbs also spin
 *   in phase instead of each starting from its own mount time.
 * - **One geometry solve per (state, size) per frame**, memoised on `t`.
 * - **One paint per (state, size, colour, theme) per frame**, into an offscreen
 *   bitmap the avatars `drawImage` from. Two avatars of the same agent, or two
 *   agents of the same colour, share the paint; an avatar drawn smaller than
 *   the preset scales the bitmap instead of re-painting at its own size.
 *
 * Alpha is baked into the colour strings rather than set with `globalAlpha`, so
 * a dot costs at most one `fillStyle` write and usually not even that: dots
 * arrive z-sorted and their ink follows their depth, so neighbours quantise
 * alike and the assignment is skipped. Each dot still gets its own `fill` —
 * collapsing a run into one path would union the overlaps instead of stacking
 * them, and stacked translucent dots are exactly what gives the orb its density.
 */
import { MODE_FRAMES, resolvePreset, type OrbFrame, type OrbState } from 'thinking-orbs/engine'

export type { OrbState }

/**
 * The two designs `thinking-orbs` tunes — `64` for a chat avatar, `20` for
 * inline text. Separate dot counts and radii, not a scale factor.
 */
export type OrbPreset = 64 | 20

export function presetFor(px: number): OrbPreset {
  return px <= 24 ? 20 : 64
}

const TAU = Math.PI * 2

/** Capped: past 2 the extra pixels are invisible and the fill cost is real. */
export function dpr(): number {
  return Math.min(2, window.devicePixelRatio || 1)
}

// --- the shared clock ---------------------------------------------------------

type Tick = (now: number) => void

const ticks = new Set<Tick>()
let running = false
let listening = false

function loop(now: number): void {
  if (!running) return
  requestAnimationFrame(loop)
  // Copied: a tick may unsubscribe itself the moment it settles.
  for (const tick of [...ticks]) tick(now)
}

function sync(): void {
  const want = ticks.size > 0 && document.visibilityState !== 'hidden'
  if (want === running) return
  running = want
  if (want) requestAnimationFrame(loop)
}

/** Join the page's animation clock. Returns the unsubscribe. */
export function subscribe(tick: Tick): () => void {
  if (!listening) {
    listening = true
    document.addEventListener('visibilitychange', sync)
  }
  ticks.add(tick)
  sync()
  return () => {
    ticks.delete(tick)
    sync()
  }
}

// --- colour -------------------------------------------------------------------

/** Steps in the ink ramp, and in the alpha quantisation baked into it. */
const RAMP_STEPS = 24
const ALPHA_STEPS = 16

type Rgb = readonly [number, number, number]

function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1, 7), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

const BLACK: Rgb = [0, 0, 0]
const WHITE: Rgb = [255, 255, 255]

/**
 * `(ink, alpha) → rgba string`, flattened. The library's ink runs 0 (nearest,
 * darkest) to 1 (farthest, palest); here the near end is the agent's head
 * colour pushed toward the page's ink and the far end is it faded toward the
 * page, so depth still reads and the hue survives at both ends.
 */
function buildLut(head: string, dark: boolean): readonly string[] {
  const base = hexToRgb(head)
  const near = dark ? mix(base, WHITE, 0.45) : mix(base, BLACK, 0.3)
  const far = dark ? mix(base, BLACK, 0.5) : mix(base, WHITE, 0.62)
  const out = new Array<string>(RAMP_STEPS * ALPHA_STEPS)
  for (let i = 0; i < RAMP_STEPS; i += 1) {
    const [r, g, b] = mix(near, far, i / (RAMP_STEPS - 1))
    const head3 = `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},`
    for (let j = 0; j < ALPHA_STEPS; j += 1) {
      out[i * ALPHA_STEPS + j] = `${head3}${(j / (ALPHA_STEPS - 1)).toFixed(3)})`
    }
  }
  return out
}

const luts = new Map<string, readonly string[]>()

function lutFor(head: string, dark: boolean): readonly string[] {
  const key = `${head}|${dark ? 'd' : 'l'}`
  let lut = luts.get(key)
  if (lut === undefined) {
    if (luts.size > 64) luts.clear()
    lut = buildLut(head, dark)
    luts.set(key, lut)
  }
  return lut
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** `-1` for a mark that quantises to nothing, which is a mark not worth a path. */
function bucket(white: number, alpha: number): number {
  const a = Math.round(clamp01(alpha) * (ALPHA_STEPS - 1))
  if (a === 0) return -1
  return Math.round(clamp01(white) * (RAMP_STEPS - 1)) * ALPHA_STEPS + a
}

function paintTinted(ctx: CanvasRenderingContext2D, frame: OrbFrame, lut: readonly string[]): void {
  // Lines carry their own width, so they cannot share a path with each other;
  // no preset in use draws any, and the loop costs nothing when the list is
  // empty. Drawn first so nodes sit on top of their edges.
  for (const line of frame.lines) {
    const b = bucket(line.white, line.a ?? 1)
    if (b < 0) continue
    ctx.strokeStyle = lut[b] as string
    ctx.lineWidth = line.w
    ctx.beginPath()
    ctx.moveTo(line.x1, line.y1)
    ctx.lineTo(line.x2, line.y2)
    ctx.stroke()
  }

  let styled = -1
  for (const dot of frame.dots) {
    const b = bucket(dot.white, dot.a ?? 1)
    if (b < 0) continue
    if (b !== styled) {
      styled = b
      ctx.fillStyle = lut[b] as string
    }
    ctx.beginPath()
    ctx.arc(dot.x, dot.y, dot.r, 0, TAU)
    ctx.fill()
  }
}

// --- the shared orb bitmap ----------------------------------------------------

interface Presetted {
  readonly mode: keyof typeof MODE_FRAMES
  readonly speed: number
  readonly opts: Parameters<(typeof MODE_FRAMES)['globe']>[2]
}

const presets = new Map<string, Presetted>()

/** `resolvePreset` allocates a fresh opts object; the geometry cache keys off identity of nothing else. */
function presetted(state: OrbState, preset: OrbPreset): Presetted {
  const key = `${state}|${preset}`
  let value = presets.get(key)
  if (value === undefined) {
    value = resolvePreset(state, preset) as Presetted
    presets.set(key, value)
  }
  return value
}

/** Geometry solved this frame, keyed by (state, preset) and stamped with its `t`. */
const geometry = new Map<string, { t: number; frame: OrbFrame }>()

function frameAt(state: OrbState, preset: OrbPreset, t: number): OrbFrame {
  const key = `${state}|${preset}`
  const hit = geometry.get(key)
  if (hit !== undefined && hit.t === t) return hit.frame
  const { mode, opts } = presetted(state, preset)
  const frame = MODE_FRAMES[mode](preset, t, opts)
  geometry.set(key, { t, frame })
  return frame
}

interface Bitmap {
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D
  t: number
  scale: number
  used: number
}

const bitmaps = new Map<string, Bitmap>()
let generation = 0

/** The orb's clock: seconds since page load, at the state's tempo. */
export function orbTime(state: OrbState, preset: OrbPreset, now: number): number {
  return (now / 1000) * presetted(state, preset).speed
}

/**
 * The orb for one (state, size, colour, theme), painted at most once per value
 * of `t` — so every avatar sharing those four shares one paint, and an avatar
 * asking twice in a frame pays once.
 *
 * The bitmap is `preset` CSS pixels square at the current device ratio; callers
 * scale it to whatever size they draw at.
 */
export function orbBitmap(
  state: OrbState,
  preset: OrbPreset,
  head: string,
  dark: boolean,
  t: number
): HTMLCanvasElement {
  const key = `${state}|${preset}|${head}|${dark ? 'd' : 'l'}`
  const ratio = dpr()
  let bitmap = bitmaps.get(key)
  if (bitmap === undefined) {
    if (bitmaps.size > 24) prune()
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('2d canvas unavailable')
    bitmap = { canvas, ctx, t: Number.NaN, scale: 0, used: 0 }
    bitmaps.set(key, bitmap)
  }
  bitmap.used = generation += 1
  if (bitmap.scale !== ratio) {
    bitmap.scale = ratio
    bitmap.canvas.width = Math.round(preset * ratio)
    bitmap.canvas.height = Math.round(preset * ratio)
    bitmap.t = Number.NaN
  }
  if (bitmap.t !== t) {
    bitmap.t = t
    const { ctx } = bitmap
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, preset, preset)
    paintTinted(ctx, frameAt(state, preset, t), lutFor(head, dark))
  }
  return bitmap.canvas
}

/** Drops the half of the cache nobody has asked for recently. */
function prune(): void {
  const entries = [...bitmaps.entries()].sort((a, b) => a[1].used - b[1].used)
  for (let i = 0; i < entries.length >> 1; i += 1)
    bitmaps.delete((entries[i] as [string, Bitmap])[0])
}

// --- shared observers ---------------------------------------------------------

/** `.dark` on <html> is how `@/lib/theme` applies the theme; one observer serves every avatar. */
const darkListeners = new Set<() => void>()
let darkObserver: MutationObserver | undefined

export function isDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

export function subscribeDark(listener: () => void): () => void {
  darkListeners.add(listener)
  if (darkObserver === undefined) {
    darkObserver = new MutationObserver(() => {
      for (const notify of darkListeners) notify()
    })
    darkObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
  return () => {
    darkListeners.delete(listener)
    if (darkListeners.size === 0) {
      darkObserver?.disconnect()
      darkObserver = undefined
    }
  }
}

/** One `IntersectionObserver` for every avatar on the page, not one each. */
const seen = new Map<Element, (visible: boolean) => void>()
let viewport: IntersectionObserver | undefined

export function observeVisibility(el: Element, onChange: (visible: boolean) => void): () => void {
  if (viewport === undefined) {
    viewport = new IntersectionObserver((entries) => {
      for (const entry of entries) seen.get(entry.target)?.(entry.isIntersecting)
    })
  }
  seen.set(el, onChange)
  viewport.observe(el)
  return () => {
    seen.delete(el)
    viewport?.unobserve(el)
    if (seen.size === 0) {
      viewport?.disconnect()
      viewport = undefined
    }
  }
}
