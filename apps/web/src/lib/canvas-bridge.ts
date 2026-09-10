export const CANVAS_ESCAPE_MESSAGE = 'taut.canvas.escape'

export function isCanvasEscapeMessage(
  event: { readonly source: unknown; readonly data: unknown },
  expectedSource: unknown
): boolean {
  return (
    expectedSource !== null &&
    expectedSource !== undefined &&
    event.source === expectedSource &&
    typeof event.data === 'object' &&
    event.data !== null &&
    'type' in event.data &&
    event.data.type === CANVAS_ESCAPE_MESSAGE
  )
}
