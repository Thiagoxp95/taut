import { describe, expect, it } from 'vitest'
import { isCanvasEscapeMessage } from '../../web/src/lib/canvas-bridge'

describe('canvas Escape bridge', () => {
  it('accepts only the Escape message from the displayed frame', () => {
    const frame = {}
    expect(
      isCanvasEscapeMessage({ source: frame, data: { type: 'taut.canvas.escape' } }, frame)
    ).toBe(true)
    expect(isCanvasEscapeMessage({ source: {}, data: { type: 'taut.canvas.escape' } }, frame)).toBe(
      false
    )
    expect(
      isCanvasEscapeMessage({ source: frame, data: { type: 'taut.canvas.open' } }, frame)
    ).toBe(false)
    expect(isCanvasEscapeMessage({ source: frame, data: null }, frame)).toBe(false)
    expect(isCanvasEscapeMessage({ source: frame, data: 'taut.canvas.escape' }, frame)).toBe(false)
  })

  it('rejects messages while no preview frame is mounted', () => {
    expect(
      isCanvasEscapeMessage({ source: null, data: { type: 'taut.canvas.escape' } }, null)
    ).toBe(false)
    expect(
      isCanvasEscapeMessage({ source: undefined, data: { type: 'taut.canvas.escape' } }, undefined)
    ).toBe(false)
  })
})
