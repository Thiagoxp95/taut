#!/usr/bin/env node
/**
 * Generates the PWA icon set into apps/web/public/icons/ (dependency-free: raw PNG
 * via zlib). Re-run after changing the mark:  node scripts/make-icons.mjs
 *
 * The mark is a "T" in the theme's near-black on white, drawn from rectangles so it
 * stays crisp at 192px and at 32px. Maskable variants keep the glyph inside the
 * 80% safe area Android crops to.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public', 'icons')

const INK = [0x18, 0x18, 0x1b] // zinc-900, matches --background in dark mode
const PAPER = [0xfa, 0xfa, 0xfa]

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, crc])
}

/** `pixel(x, y)` returns [r, g, b]; alpha is always opaque (push icons must not be transparent). */
const png = (size, pixel) => {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y)
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * `inset` is the fraction of the canvas the glyph+plate is pulled in by: 0 for a
 * full-bleed icon, 0.1 for a maskable one whose corners get cropped away.
 */
const mark = (size, { inset = 0, rounded = true } = {}) => {
  const pad = Math.round(size * inset)
  const plate = size - pad * 2
  const radius = rounded ? Math.round(plate * 0.22) : 0

  // "T": a bar across the top, a stem down the middle, both in the glyph box.
  const box = Math.round(plate * 0.52)
  const gx = pad + Math.round((plate - box) / 2)
  const gy = pad + Math.round((plate - box) / 2)
  const stroke = Math.max(2, Math.round(box * 0.19))
  const stemX0 = gx + Math.round((box - stroke) / 2)

  const inPlate = (x, y) => {
    if (x < pad || y < pad || x >= pad + plate || y >= pad + plate) return false
    if (radius === 0) return true
    const cx = Math.min(Math.max(x, pad + radius), pad + plate - 1 - radius)
    const cy = Math.min(Math.max(y, pad + radius), pad + plate - 1 - radius)
    const dx = x - cx
    const dy = y - cy
    return dx * dx + dy * dy <= radius * radius
  }
  const inGlyph = (x, y) =>
    (y >= gy && y < gy + stroke && x >= gx && x < gx + box) ||
    (y >= gy && y < gy + box && x >= stemX0 && x < stemX0 + stroke)

  return (x, y) => (inPlate(x, y) ? (inGlyph(x, y) ? PAPER : INK) : PAPER)
}

mkdirSync(OUT, { recursive: true })
const targets = [
  ['icon-192.png', 192, { inset: 0 }],
  ['icon-512.png', 512, { inset: 0 }],
  ['icon-maskable-192.png', 192, { inset: 0.1, rounded: false }],
  ['icon-maskable-512.png', 512, { inset: 0.1, rounded: false }],
  // iOS ignores the manifest icons for the home screen and uses this one.
  ['apple-touch-icon.png', 180, { inset: 0, rounded: false }],
  ['favicon-32.png', 32, { inset: 0 }]
]
for (const [name, size, options] of targets) {
  writeFileSync(join(OUT, name), png(size, mark(size, options)))
  console.log(`icons/${name}  ${size}x${size}`)
}
