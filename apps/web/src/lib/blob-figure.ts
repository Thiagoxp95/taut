/**
 * The agent's face, as the three things the drawing needs it to be: a bitmap of
 * the body, the eyes as paths that move on their own, and a cloud of coloured
 * particles to fly when the creature leaves.
 *
 * The body and the eyes are separate because the face is alive when nothing is
 * happening to it. `blobatar` ships its idle layer twice — as `motion.css` for
 * the web and as arithmetic (`blobatar/idle`) for React Native — and this draws
 * the arithmetic one, because the avatars are a canvas and there is no
 * stylesheet reaching into a canvas. Breathe and bob move the whole figure, so
 * they ride the body bitmap; the saccade and the blink move only the eyes, and
 * an eye baked into the bitmap cannot blink. The composition below is
 * `idleTransforms` written as canvas calls rather than as SVG group transforms
 * — same element tree, same order, same numbers.
 *
 * Both come from `_marks`, the drawing primitives `blobatar` hands its React
 * Native adapter — three paths and their fills, in the SVG's own 0–100 box. So
 * the particles carry the creature's real colours (body fill, eye fill) rather
 * than a sampled approximation of a rendered `<svg>`, and the face on the canvas
 * is the same figure `<Blobatar>` would have drawn, not a screenshot of it.
 *
 * Everything here is derived once and cached forever per agent: a member list
 * that draws the same agent forty times rasterises it once.
 */
import { idleAt, idleSeeds, type IdleSeeds } from 'blobatar/idle'
import { _layout, _marks, _posed } from 'blobatar/internal'
import { dpr } from '@/lib/orb-paint'

/** The blobatar viewBox. Every coordinate below is in these units. */
const BOX = 100

const TAU = Math.PI * 2

/** Where the particles land: the orb's sphere, as a fraction of the box. */
const SHELL = 0.36

function opts(shape: number | undefined) {
  return shape === undefined
    ? ({ background: false } as const)
    : ({ background: false, traits: { shape } } as const)
}

/** The blobatar's body colour — what `<Blobatar>` fills the head with. */
export function headColor(seed: string, shape: number | undefined): string {
  return _layout(seed, opts(shape)).palette.head ?? '#888888'
}

type Marks = ReturnType<typeof _marks>['marks']

function drawMarkList(ctx: CanvasRenderingContext2D, marks: Marks): void {
  for (const mark of marks) {
    ctx.fillStyle = mark.fill
    if (mark.kind === 'circle') {
      ctx.beginPath()
      ctx.arc(mark.cx, mark.cy, mark.r, 0, TAU)
      ctx.fill()
    } else {
      ctx.fill(new Path2D(mark.d))
    }
  }
}

function drawMarks(ctx: CanvasRenderingContext2D, seed: string, shape: number | undefined): void {
  drawMarkList(ctx, _marks(seed, opts(shape)).marks)
}

// --- the living face ----------------------------------------------------------

/** Degrees, which is what the layout's lean and the idle layer's rotations are. */
const RAD = Math.PI / 180

export interface Face {
  /** Everything but the eyes. */
  readonly marks: Marks
  /** Those marks, rasterised at the size the avatar is drawn at. */
  readonly body: HTMLCanvasElement
  readonly eyes: readonly Path2D[]
  /** Each eye's drawn centre and lean — what the blink and glance pivot about. */
  readonly frames: readonly { readonly cx: number; readonly cy: number; readonly rot: number }[]
  readonly eyeFill: string
  /** This agent's own timings, so a channel of blobatars is a crowd not a pulse. */
  readonly seeds: IdleSeeds
  scale: number
}

const faces = new Map<string, Face>()

/**
 * The face, ready to animate.
 *
 * The body is rasterised at the size it is drawn at rather than at one shared
 * size: there are four avatar sizes, the bitmap is a few kilobytes, and
 * downscaling a 64px face into a 20px slot softens it in a way the vector never
 * does. The eyes stay vector — they are two small paths, they are re-fetched
 * every frame under their own transforms, and a bitmap could not be squashed
 * shut without going soft at exactly the moment the eye is most looked at.
 */
export function blobFace(seed: string, shape: number | undefined, px: number): Face {
  const key = `${seed}|${shape ?? '-'}|${px}`
  const ratio = dpr()
  let face = faces.get(key)
  if (face === undefined) {
    if (faces.size > 128) faces.clear()
    const posed = _posed(seed, opts(shape))
    face = {
      marks: posed.marks,
      body: document.createElement('canvas'),
      eyes: posed.eyes.map((eye) => new Path2D(eye.d)),
      frames: posed.eyeFrames.map(({ cx, cy, rot }) => ({ cx, cy, rot })),
      eyeFill: posed.fill.eye,
      seeds: idleSeeds(seed, shape === undefined ? {} : { traits: { shape } }),
      scale: 0
    }
    faces.set(key, face)
  }
  if (face.scale !== ratio) {
    face.scale = ratio
    const { body } = face
    body.width = Math.round(px * ratio)
    body.height = Math.round(px * ratio)
    const ctx = body.getContext('2d')
    if (ctx !== null) {
      const s = (px * ratio) / BOX
      ctx.setTransform(s, 0, 0, s, 0, 0)
      ctx.clearRect(0, 0, BOX, BOX)
      // `_posed` already split the eyes off the tail of the list; they are
      // drawn per frame in `drawBlobFace` rather than baked in here.
      drawMarkList(ctx, face.marks)
    }
  }
  return face
}

/**
 * One frame of the idle layer, drawn into a context already scaled to CSS
 * pixels and positioned at the avatar's top-left.
 *
 * `t` is milliseconds off the page's shared clock — the idle layer is a pure
 * function of it, so an avatar that mounts mid-scroll joins loops already
 * running instead of starting its own. `amp` is 0 to 1 and scales the ambient
 * motion only: at 0 this draws exactly the still figure, which is what
 * `prefers-reduced-motion` gets and what the morph fades the face out at.
 *
 * The transform stack mirrors `motion.css`'s element tree, which is what
 * `idleTransforms` returns as strings: root (nothing here — the tremor is a
 * pose channel and idle wears no pose), breathe about the viewBox centre, bob,
 * the eye pair's glance, then each eye's own blink and foreshortening about its
 * drawn centre. Collapsing two of those levels is how the eye-scale bug in the
 * stylesheet's own history happened, so they are kept apart here too.
 */
export function drawBlobFace(
  ctx: CanvasRenderingContext2D,
  face: Face,
  px: number,
  t: number,
  amp: number
): void {
  const f = idleAt(face.seeds, t, amp)
  const s = px / BOX
  ctx.save()
  ctx.scale(s, s)
  ctx.translate(BOX / 2, BOX / 2)
  ctx.scale(f.breathe[0], f.breathe[1])
  ctx.translate(-BOX / 2, -BOX / 2)
  ctx.translate(0, f.bob)
  ctx.drawImage(face.body, 0, 0, BOX, BOX)
  ctx.translate(f.saccade[0], f.saccade[1])
  ctx.fillStyle = face.eyeFill
  for (let i = 0; i < face.eyes.length; i += 1) {
    const eye = face.frames[i] as { cx: number; cy: number; rot: number }
    const side = i ? 1 : -1
    ctx.save()
    ctx.translate(eye.cx, eye.cy)
    // The foreshortening is a screen-space effect, so it is not bracketed by
    // the lean; the blink closes the capsule across its own width, so it is.
    ctx.rotate(f.wrap.rot * side * RAD)
    ctx.scale(1 + f.wrap.mx + f.wrap.side * side, 1 + f.wrap.sy)
    ctx.rotate(eye.rot * RAD)
    ctx.scale(1, f.blink)
    ctx.rotate(-eye.rot * RAD)
    ctx.translate(-eye.cx, -eye.cy)
    ctx.fill(face.eyes[i] as Path2D)
    ctx.restore()
  }
  ctx.restore()
}

// --- the particles ------------------------------------------------------------

/**
 * The face as particles, sorted by colour so a whole run shares one fill.
 *
 * Parallel typed arrays rather than an array of objects: the draw loop touches
 * every field of every particle sixty times a second, and this is the layout
 * that keeps it out of the allocator.
 */
export interface BlobParticles {
  readonly n: number
  /** Where the particle sits on the face. */
  readonly x: Float32Array
  readonly y: Float32Array
  /** Where it lands on the orb's shell. */
  readonly tx: Float32Array
  readonly ty: Float32Array
  /** Perpendicular bow, so the flight is an arc rather than a ruled line. */
  readonly bx: Float32Array
  readonly by: Float32Array
  /** 0–1 head start. Edge particles leave first, so the face peels rather than pops. */
  readonly delay: Float32Array
  /** Radius on the face, in box units. Shrinks as the particle flies. */
  readonly r: number
  /** `[fill, index one past its last particle]`, in draw order. */
  readonly runs: readonly { readonly fill: string; readonly end: number }[]
}

/** Deterministic 0–1 from an integer. Same particle, same flight, every time. */
function noise(i: number): number {
  let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

/** Roughly how many particles each preset wants, and the grid that yields them. */
function gridFor(preset: number): number {
  // The figure fills a little over half the box, so a grid of n² cells lands
  // about 0.55n² samples on it.
  return preset <= 24 ? 9 : 16
}

const scratch = { canvas: undefined as HTMLCanvasElement | undefined }

function sampler(): CanvasRenderingContext2D | null {
  if (scratch.canvas === undefined) {
    scratch.canvas = document.createElement('canvas')
    scratch.canvas.width = BOX
    scratch.canvas.height = BOX
  }
  return scratch.canvas.getContext('2d', { willReadFrequently: true })
}

const particles = new Map<string, BlobParticles>()

export function blobParticles(
  seed: string,
  shape: number | undefined,
  preset: number
): BlobParticles {
  const key = `${seed}|${shape ?? '-'}|${preset}`
  const hit = particles.get(key)
  if (hit !== undefined) return hit
  if (particles.size > 96) particles.clear()
  const built = buildParticles(seed, shape, preset)
  particles.set(key, built)
  return built
}

function buildParticles(seed: string, shape: number | undefined, preset: number): BlobParticles {
  const fills = [...new Set(_marks(seed, opts(shape)).marks.map((mark) => mark.fill))]
  const ctx = sampler()
  const empty: BlobParticles = {
    n: 0,
    x: new Float32Array(0),
    y: new Float32Array(0),
    tx: new Float32Array(0),
    ty: new Float32Array(0),
    bx: new Float32Array(0),
    by: new Float32Array(0),
    delay: new Float32Array(0),
    r: 0,
    runs: []
  }
  if (ctx === null) return empty

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, BOX, BOX)
  drawMarks(ctx, seed, shape)
  const pixels = ctx.getImageData(0, 0, BOX, BOX).data

  const rgb = fills.map((fill) => {
    const n = Number.parseInt(fill.slice(1, 7), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const
  })

  const grid = gridFor(preset)
  const step = BOX / grid
  // Jittered grid: uniform coverage without the banding a strided scan gives.
  const picked: { x: number; y: number; c: number; rho: number }[] = []
  for (let row = 0; row < grid; row += 1) {
    for (let col = 0; col < grid; col += 1) {
      const i = row * grid + col
      const x = (col + 0.5 + (noise(i * 2) - 0.5) * 0.62) * step
      const y = (row + 0.5 + (noise(i * 2 + 1) - 0.5) * 0.62) * step
      const px = Math.min(BOX - 1, Math.max(0, Math.round(x)))
      const py = Math.min(BOX - 1, Math.max(0, Math.round(y)))
      const at = (py * BOX + px) * 4
      if ((pixels[at + 3] as number) < 140) continue
      const r = pixels[at] as number
      const g = pixels[at + 1] as number
      const b = pixels[at + 2] as number
      let best = 0
      let bestD = Number.POSITIVE_INFINITY
      for (let k = 0; k < rgb.length; k += 1) {
        const c = rgb[k] as readonly [number, number, number]
        const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2
        if (d < bestD) {
          bestD = d
          best = k
        }
      }
      const dx = x - BOX / 2
      const dy = y - BOX / 2
      picked.push({ x, y, c: best, rho: Math.min(1, Math.hypot(dx, dy) / (BOX / 2)) })
    }
  }
  if (picked.length === 0) return empty

  // Sorted by fill so the draw loop is one `beginPath` per colour, not per dot.
  picked.sort((a, b) => a.c - b.c)

  const n = picked.length
  const out = {
    n,
    x: new Float32Array(n),
    y: new Float32Array(n),
    tx: new Float32Array(n),
    ty: new Float32Array(n),
    bx: new Float32Array(n),
    by: new Float32Array(n),
    delay: new Float32Array(n),
    // Overlapping at rest, so the face granulating into particles is a texture
    // change rather than a shape change.
    r: step * 0.58,
    runs: [] as { fill: string; end: number }[]
  }
  for (let i = 0; i < n; i += 1) {
    const p = picked[i] as { x: number; y: number; c: number; rho: number }
    out.x[i] = p.x
    out.y[i] = p.y
    const dx = p.x - BOX / 2
    const dy = p.y - BOX / 2
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const reach = BOX * SHELL * (0.66 + 0.34 * noise(i * 7 + 3))
    out.tx[i] = BOX / 2 + ux * reach
    out.ty[i] = BOX / 2 + uy * reach
    const bow = BOX * SHELL * 0.3 * (noise(i * 11 + 5) * 2 - 1)
    out.bx[i] = -uy * bow
    out.by[i] = ux * bow
    out.delay[i] = 0.22 * (1 - p.rho)
    const fill = fills[p.c] as string
    const last = out.runs[out.runs.length - 1]
    if (last !== undefined && last.fill === fill) last.end = i + 1
    else out.runs.push({ fill, end: i + 1 })
  }
  return out
}
