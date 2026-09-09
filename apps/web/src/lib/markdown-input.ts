/**
 * Selection-aware markdown editing for the composer.
 *
 * Every helper is pure: it takes the textarea's value and selection and gives
 * back the next value plus where the caret should land, so the caller only has
 * to `setValue` and `setSelectionRange`.
 */

export type MarkdownFormat =
  'bold' | 'italic' | 'strike' | 'code' | 'codeBlock' | 'link' | 'bullet' | 'ordered' | 'quote'

export interface Selection {
  readonly value: string
  readonly start: number
  readonly end: number
}

/** `start`/`end` are where the selection should sit afterwards. */
export interface Edit {
  readonly value: string
  readonly start: number
  readonly end: number
}

const WRAP: Partial<Record<MarkdownFormat, string>> = {
  bold: '**',
  italic: '_',
  strike: '~~',
  code: '`'
}

interface LinePrefix {
  /** The marker for the nth line of the selection (ordered lists count up). */
  readonly make: (index: number) => string
  /** Recognises this family's marker, so a second click removes it. */
  readonly test: RegExp
}

const PREFIX: Partial<Record<MarkdownFormat, LinePrefix>> = {
  bullet: { make: () => '- ', test: /^[-*+] / },
  ordered: { make: (index) => `${index + 1}. `, test: /^\d+[.)] / },
  quote: { make: () => '> ', test: /^> / }
}

const splice = (value: string, start: number, end: number, insert: string): string =>
  value.slice(0, start) + insert + value.slice(end)

/** Toggles `**text**` style markers around the selection (or at the caret). */
function wrap(selection: Selection, marker: string): Edit {
  const { value, start, end } = selection
  const width = marker.length

  const alreadyInside =
    value.slice(start - width, start) === marker && value.slice(end, end + width) === marker
  if (alreadyInside) {
    return {
      value: splice(value, start - width, end + width, value.slice(start, end)),
      start: start - width,
      end: end - width
    }
  }

  const inner = value.slice(start, end)
  if (inner.startsWith(marker) && inner.endsWith(marker) && inner.length >= width * 2) {
    const stripped = inner.slice(width, -width)
    return { value: splice(value, start, end, stripped), start, end: start + stripped.length }
  }

  return {
    value: splice(value, start, end, `${marker}${inner}${marker}`),
    start: start + width,
    end: end + width
  }
}

/** Adds or removes a per-line prefix across every line the selection touches. */
function prefixLines(selection: Selection, prefix: LinePrefix): Edit {
  const { value, start, end } = selection
  const from = value.lastIndexOf('\n', start - 1) + 1
  const toIndex = value.indexOf('\n', end)
  const to = toIndex === -1 ? value.length : toIndex

  const lines = value.slice(from, to).split('\n')
  // Any list or quote marker is stripped, so bullets convert straight to numbers.
  const anyMarker = /^(?:[-*+] |\d+[.)] |> )/
  const filled = lines.filter((line) => line.trim() !== '')
  // A second click on a list that is already this kind turns it back off.
  const remove = filled.length > 0 && filled.every((line) => prefix.test.test(line))

  const next = lines
    .map((line, index) => {
      if (line.trim() === '') return line
      const bare = line.replace(anyMarker, '')
      return remove ? bare : `${prefix.make(index)}${bare}`
    })
    .join('\n')

  const delta = next.length - (to - from)
  return { value: splice(value, from, to, next), start: from, end: end + delta }
}

function codeBlock(selection: Selection): Edit {
  const { value, start, end } = selection
  const inner = value.slice(start, end)
  const before = start > 0 && value[start - 1] !== '\n' ? '\n' : ''
  const after = end < value.length && value[end] !== '\n' ? '\n' : ''
  const block = `${before}\`\`\`\n${inner}\n\`\`\`${after}`
  const caret = start + before.length + 4
  return { value: splice(value, start, end, block), start: caret, end: caret + inner.length }
}

function link(selection: Selection): Edit {
  const { value, start, end } = selection
  const inner = value.slice(start, end)
  const text = inner === '' ? 'text' : inner
  const next = `[${text}](url)`
  const urlAt = start + text.length + 3
  return { value: splice(value, start, end, next), start: urlAt, end: urlAt + 3 }
}

export function applyFormat(selection: Selection, format: MarkdownFormat): Edit {
  const marker = WRAP[format]
  if (marker !== undefined) return wrap(selection, marker)
  const prefix = PREFIX[format]
  if (prefix !== undefined) return prefixLines(selection, prefix)
  return format === 'link' ? link(selection) : codeBlock(selection)
}

/** ⌘/Ctrl shortcuts Slack users already have in their fingers. */
export function shortcutFor(event: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}): MarkdownFormat | undefined {
  if (!event.metaKey && !event.ctrlKey) return undefined
  const key = event.key.toLowerCase()
  if (key === 'b' && !event.shiftKey) return 'bold'
  if (key === 'i' && !event.shiftKey) return 'italic'
  if (key === 'x' && event.shiftKey) return 'strike'
  if (key === 'c' && event.shiftKey) return 'code'
  if (key === 'k' && !event.shiftKey) return 'link'
  // Slack's list shortcuts are ⌘⇧7/8/9, but `key` for those depends on the
  // keyboard layout, so lists stay on the toolbar buttons.
  return undefined
}
