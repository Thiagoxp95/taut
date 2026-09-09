/**
 * An agent, drawn: its face when it is idle, its thinking orb when it is busy,
 * and a real morph between the two.
 *
 * The morph used to be a crossfade — the `<svg>` face and the orb canvas
 * stacked, each running a CSS `opacity`/`scale`/`blur(3px)` keyframe. Blur is a
 * per-frame full-layer filter, the two layers repainted independently, and the
 * orb's own animation loop started at the moment the layer mounted, so the
 * handover stuttered and read as "the face was replaced by a spinner".
 *
 * This draws all three stages on one canvas instead, and the middle stage is
 * the point: the face granulates into particles cut from its own fills, they
 * bow outward onto the orb's shell as the orb condenses out of them, and on the
 * way back they carry the same colours home and settle into the face again. The
 * agent's colour is continuous through the whole travel because every stage is
 * drawn from the same blobatar — the particles from its marks, the orb from a
 * ramp built on its head colour.
 *
 * An idle agent is not a still picture either. It breathes, bobs, glances and
 * blinks on its own seeded timings — `blobatar`'s idle layer, drawn as canvas
 * transforms over a body bitmap and two live eye paths (`@/lib/blob-figure`).
 * That is what makes a member list read as a room full of creatures rather than
 * a sheet of stickers, and it costs one `drawImage` and two path fills per
 * avatar per frame.
 *
 * The expensive halves are shared page-wide (`@/lib/orb-paint`): one clock, one
 * geometry solve and one orb bitmap per distinct orb per frame, so a channel
 * full of busy agents costs about what one does. An avatar scrolled out of view
 * or on a hidden tab stops drawing entirely, and under
 * `prefers-reduced-motion` nothing loops at all: the face holds still at
 * amplitude zero, which is the same figure the still renderer draws.
 */
import * as React from 'react'
import { cn } from '@taut/ui/lib/utils'
import { blobFace, blobParticles, drawBlobFace, headColor } from '@/lib/blob-figure'
import {
  dpr,
  isDark,
  observeVisibility,
  orbBitmap,
  orbTime,
  presetFor,
  subscribe,
  subscribeDark,
  type OrbPreset,
  type OrbState
} from '@/lib/orb-paint'

export type { OrbState }

/** The blobatar viewBox; particle coordinates are in these units. */
const BOX = 100

const TAU = Math.PI * 2

/** How long the whole travel takes, at a full 0 → 1. */
const MORPH_MS = 460

/** The frame the orb freezes on under `prefers-reduced-motion`. */
const STILL_FRAME = 0.6

/** Where the last particle finishes its flight, as a position in the morph. */
const ARRIVED = 0.86

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

interface Figure {
  seed: string
  shape: number | undefined
  orb: OrbState
  px: number
  preset: OrbPreset
  head: string
  dark: boolean
  still: boolean
  working: boolean
}

/**
 * The imperative half. Lives outside React because it owns a canvas and a
 * position on a shared clock, and because a re-render must be able to change
 * what is drawn without tearing down either.
 */
function createEngine(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')
  let figure: Figure | undefined
  /** 0 = the face, 1 = the orb. */
  let u = 0
  let from = 0
  let to = 0
  let startedAt = 0
  let duration = 0
  let visible = true
  let unsubscribe: (() => void) | undefined
  let sized = 0

  function draw(now: number): boolean {
    if (ctx === null || figure === undefined) return false
    const { px, preset, seed, shape, head, dark, orb, still } = figure

    const ratio = dpr()
    const side = Math.round(px * ratio)
    if (sized !== side) {
      sized = side
      canvas.width = side
      canvas.height = side
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, px, px)

    let travelling = false
    if (duration > 0) {
      const k = clamp01((now - startedAt) / duration)
      u = from + (to - from) * k
      if (k >= 1) {
        u = to
        duration = 0
      } else travelling = true
    }

    const t = still ? STILL_FRAME : orbTime(orb, preset, now)

    // Amplitude is the face's own presence: it is fully alive at rest and has
    // stopped breathing by the time it has become particles, so the idle layer
    // does not fight the morph for the same pixels.
    const faceAlpha = u <= 0.001 ? 1 : 1 - smoothstep(0.06, 0.4, u)

    if (u <= 0.001) {
      drawBlobFace(ctx, blobFace(seed, shape, px), px, still ? 0 : now, still ? 0 : 1)
      return travelling || !still
    }
    if (u >= 0.999) {
      ctx.drawImage(orbBitmap(orb, preset, head, dark, t), 0, 0, px, px)
      return travelling || !still
    }

    const scale = px / BOX

    if (faceAlpha > 0.004) {
      ctx.globalAlpha = faceAlpha
      drawBlobFace(ctx, blobFace(seed, shape, px), px, still ? 0 : now, still ? 0 : faceAlpha)
    }

    const dustAlpha = smoothstep(0, 0.14, u) * (1 - smoothstep(0.78, 1, u))
    if (dustAlpha > 0.004) {
      const dust = blobParticles(seed, shape, preset)
      ctx.globalAlpha = dustAlpha
      let i = 0
      for (const run of dust.runs) {
        ctx.fillStyle = run.fill
        ctx.beginPath()
        for (; i < run.end; i += 1) {
          const delay = dust.delay[i]!
          // Landed by ARRIVED rather than by 1, so the last particle settles
          // while the orb is still gaining and the picture never goes thin.
          const k = easeInOut(clamp01((u - delay) / (ARRIVED - delay)))
          const bow = Math.sin(Math.PI * k)
          const ox = dust.x[i]!
          const oy = dust.y[i]!
          const x = (ox + (dust.tx[i]! - ox) * k + dust.bx[i]! * bow) * scale
          const y = (oy + (dust.ty[i]! - oy) * k + dust.by[i]! * bow) * scale
          // Down to about an orb dot, so the cloud reads as the orb forming.
          const r = dust.r * (1 - 0.74 * k) * scale
          ctx.moveTo(x + r, y)
          ctx.arc(x, y, r, 0, TAU)
        }
        ctx.fill()
      }
    }

    const orbAlpha = smoothstep(0.3, 0.86, u)
    if (orbAlpha > 0.004) {
      // Condenses out of the particle cloud rather than fading in over it.
      const grown = px * (0.78 + 0.22 * smoothstep(0.28, 1, u))
      const inset = (px - grown) / 2
      ctx.globalAlpha = orbAlpha
      ctx.drawImage(orbBitmap(orb, preset, head, dark, t), inset, inset, grown, grown)
    }

    ctx.globalAlpha = 1
    return travelling
  }

  function stop(): void {
    unsubscribe?.()
    unsubscribe = undefined
  }

  function tick(now: number): void {
    if (!draw(now)) stop()
  }

  function wake(): void {
    if (unsubscribe === undefined && visible) unsubscribe = subscribe(tick)
  }

  const unobserve = observeVisibility(canvas, (next) => {
    visible = next
    if (next) wake()
    else stop()
  })

  return {
    update(next: Figure): void {
      const was = figure
      figure = next
      if (next.still) {
        u = next.working ? 1 : 0
        to = u
        duration = 0
      } else if (was === undefined || was.working === next.working) {
        // Nothing morphs on mount: an avatar that is born busy is born an orb.
        if (was === undefined) {
          u = next.working ? 1 : 0
          to = u
        }
      } else {
        from = u
        to = next.working ? 1 : 0
        startedAt = performance.now()
        // An interrupted morph turns around from where it is, over the part of
        // the travel it still has left, so a flicker of presence cannot stall.
        duration = MORPH_MS * Math.max(0.4, Math.abs(to - from))
      }
      // Drawn now rather than on the next frame, so a mount or a prop change
      // lands immediately; the loop starts only if there is more to draw, which
      // under `prefers-reduced-motion` is nothing at either end.
      if (draw(performance.now())) wake()
    },
    dispose(): void {
      stop()
      unobserve()
    }
  }
}

/**
 * Always pass the same `seed`/`shape` the agent's `<Blobatar>` would get: the
 * orb's colour is resolved from them, so a mismatch morphs one agent into
 * another agent's colour.
 */
export function AgentFigure({
  seed,
  shape,
  state = 'working',
  working,
  px,
  className
}: {
  seed: string
  shape?: number
  /** Which of the library's animations to become. */
  state?: OrbState
  /** `true` while the agent is busy. Flipping it runs the morph. */
  working: boolean
  /** Rendered size in CSS pixels. */
  px: number
  className?: string
}) {
  const ref = React.useRef<HTMLCanvasElement>(null)
  const engine = React.useRef<ReturnType<typeof createEngine>>(null)
  const dark = useDark()
  const still = useReducedMotion()
  const head = React.useMemo(() => headColor(seed, shape), [seed, shape])

  React.useEffect(() => {
    const canvas = ref.current
    if (canvas === null) return
    const created = createEngine(canvas)
    engine.current = created
    return () => {
      created.dispose()
      engine.current = null
    }
  }, [])

  React.useEffect(() => {
    engine.current?.update({
      seed,
      shape,
      orb: state,
      px,
      preset: presetFor(px),
      head,
      dark,
      still,
      working
    })
  }, [seed, shape, state, px, head, dark, still, working])

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={cn('block', className)}
      style={{ width: px, height: px }}
    />
  )
}

function useDark(): boolean {
  return React.useSyncExternalStore(subscribeDark, isDark, () => false)
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function subscribeReducedMotion(listener: () => void): () => void {
  const media = window.matchMedia(REDUCED_MOTION)
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

function useReducedMotion(): boolean {
  return React.useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false
  )
}
