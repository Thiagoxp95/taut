/**
 * Pure text transforms behind the markdown editor's toolbar and keymap.
 *
 * Every command takes the current value plus the caret/selection and returns
 * the single range to replace — never a whole new document. The editor applies
 * it through `document.execCommand('insertText')` so the browser's own undo
 * stack keeps working, which a wholesale `setState(next)` would throw away.
 */

export interface Selection {
  readonly start: number
  readonly end: number
}

/** Replace `[start, end)` with `text`, then leave the caret at `selection`. */
export interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
  readonly selectionStart: number
  readonly selectionEnd: number
}

export type BlockKind = 'bullet' | 'ordered' | 'task' | 'quote'

const BULLET = /^[-*+] (?!\[[ xX]\] )/
const TASK = /^[-*+] \[[ xX]\] /
const ORDERED = /^\d+[.)] /
const QUOTE = /^> ?/
const HEADING = /^#{1,6} +/
/** Any of the above, so switching a line from one block to another is clean. */
const ANY_MARKER = /^(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> ?|#{1,6} +)/

const INDENT = '  '
const WORD = /[\p{L}\p{N}_'-]/u

function lineStartOf(value: string, index: number): number {
  return value.lastIndexOf('\n', index - 1) + 1
}

function lineEndOf(value: string, index: number): number {
  const next = value.indexOf('\n', index)
  return next === -1 ? value.length : next
}

function leadingSpace(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? ''
}

/** The word under a collapsed caret, so ⌘B with no selection still bolds something. */
function wordAt(value: string, index: number): Selection {
  let start = index
  let end = index
  while (start > 0 && WORD.test(value[start - 1] ?? '')) start -= 1
  while (end < value.length && WORD.test(value[end] ?? '')) end += 1
  return { start, end }
}

/**
 * Toggle a paired inline marker (`**`, `_`, `` ` ``, `~~`).
 *
 * Unwraps whether the markers sit inside the selection (`**bold**` selected) or
 * just outside it (`bold` selected between existing asterisks), which is what a
 * second ⌘B press usually means.
 */
export function toggleWrap(
  value: string,
  selection: Selection,
  open: string,
  close: string = open
): Edit {
  let { start, end } = selection
  if (start === end) {
    const word = wordAt(value, start)
    start = word.start
    end = word.end
  }
  const selected = value.slice(start, end)

  if (
    selected.length >= open.length + close.length &&
    selected.startsWith(open) &&
    selected.endsWith(close)
  ) {
    const inner = selected.slice(open.length, selected.length - close.length)
    return { start, end, text: inner, selectionStart: start, selectionEnd: start + inner.length }
  }

  if (
    value.slice(start - open.length, start) === open &&
    value.slice(end, end + close.length) === close
  ) {
    const from = start - open.length
    return {
      start: from,
      end: end + close.length,
      text: selected,
      selectionStart: from,
      selectionEnd: from + selected.length
    }
  }

  return {
    start,
    end,
    text: `${open}${selected}${close}`,
    selectionStart: start + open.length,
    selectionEnd: start + open.length + selected.length
  }
}

interface Block {
  readonly start: number
  readonly end: number
  readonly lines: readonly string[]
}

function blockOf(value: string, selection: Selection): Block {
  const start = lineStartOf(value, selection.start)
  const end = lineEndOf(value, selection.end)
  return { start, end, lines: value.slice(start, end).split('\n') }
}

function replaceBlock(block: Block, lines: readonly string[]): Edit {
  const text = lines.join('\n')
  return {
    start: block.start,
    end: block.end,
    text,
    selectionStart: block.start,
    selectionEnd: block.start + text.length
  }
}

const MARKERS: Record<
  BlockKind,
  { readonly test: RegExp; readonly make: (index: number) => string }
> = {
  bullet: { test: BULLET, make: () => '- ' },
  task: { test: TASK, make: () => '- [ ] ' },
  ordered: { test: ORDERED, make: (index) => `${index + 1}. ` },
  quote: { test: QUOTE, make: () => '> ' }
}

/**
 * Turn every selected line into a list/quote — or, if they all already are,
 * strip the marker. Ordered lists are renumbered from 1 on the way in.
 */
export function toggleBlock(value: string, selection: Selection, kind: BlockKind): Edit {
  const block = blockOf(value, selection)
  const marker = MARKERS[kind]
  const filled = block.lines.filter((line) => line.trim() !== '')
  const active = filled.length > 0 && filled.every((line) => marker.test.test(line.trimStart()))

  let n = 0
  const lines = block.lines.map((line) => {
    const indent = leadingSpace(line)
    const body = line.slice(indent.length).replace(ANY_MARKER, '')
    if (active) return body === '' ? '' : `${indent}${body}`
    if (line.trim() === '') return line
    const prefix = marker.make(n)
    n += 1
    return `${indent}${prefix}${body}`
  })
  return replaceBlock(block, lines)
}

/** `#` … `######`; applying the level a line already has clears it. */
export function toggleHeading(value: string, selection: Selection, level: number): Edit {
  const block = blockOf(value, selection)
  const hashes = '#'.repeat(level)
  const already = block.lines.every((line) => line.trimStart().startsWith(`${hashes} `))
  const lines = block.lines.map((line) => {
    const indent = leadingSpace(line)
    const body = line.slice(indent.length).replace(HEADING, '')
    return already ? `${indent}${body}` : `${indent}${hashes} ${body}`
  })
  return replaceBlock(block, lines)
}

const URLISH = /^(?:https?:\/\/|mailto:|\/|#)\S*$/i

/**
 * `[text](url)`. Whichever half the selection did not supply is what ends up
 * selected, so the next keystroke fills it in.
 */
export function insertLink(value: string, selection: Selection): Edit {
  const selected = value.slice(selection.start, selection.end)
  const { start, end } = selection

  if (selected === '') {
    const text = '[](url)'
    return { start, end, text, selectionStart: start + 1, selectionEnd: start + 1 }
  }
  if (URLISH.test(selected.trim())) {
    const text = `[](${selected.trim()})`
    return { start, end, text, selectionStart: start + 1, selectionEnd: start + 1 }
  }
  const text = `[${selected}](url)`
  const urlAt = start + selected.length + 3
  return { start, end, text, selectionStart: urlAt, selectionEnd: urlAt + 3 }
}

/** A fenced block on its own lines, with the language slot selected when empty. */
export function insertCodeBlock(value: string, selection: Selection): Edit {
  const selected = value.slice(selection.start, selection.end)
  const before = selection.start === 0 || value[selection.start - 1] === '\n' ? '' : '\n'
  const after = selection.end === value.length || value[selection.end] === '\n' ? '' : '\n'
  const text = `${before}\`\`\`\n${selected}\n\`\`\`${after}`
  const fenceAt = selection.start + before.length + 3
  return {
    start: selection.start,
    end: selection.end,
    text,
    selectionStart: fenceAt,
    selectionEnd: fenceAt
  }
}

export function insertRule(value: string, selection: Selection): Edit {
  const before = selection.start === 0 || value[selection.start - 1] === '\n' ? '' : '\n'
  const text = `${before}\n---\n\n`
  const at = selection.start + text.length
  return { start: selection.start, end: selection.end, text, selectionStart: at, selectionEnd: at }
}

/** Indent or outdent every selected line by two spaces (⇥ / ⇧⇥). */
export function shiftIndent(value: string, selection: Selection, outdent: boolean): Edit {
  const block = blockOf(value, selection)
  const collapsed = selection.start === selection.end
  if (collapsed && !outdent && !ANY_MARKER.test((block.lines[0] ?? '').trimStart())) {
    return {
      start: selection.start,
      end: selection.end,
      text: INDENT,
      selectionStart: selection.start + INDENT.length,
      selectionEnd: selection.start + INDENT.length
    }
  }
  const lines = block.lines.map((line) =>
    outdent ? line.replace(/^ {1,2}|^\t/, '') : line === '' ? line : `${INDENT}${line}`
  )
  return replaceBlock(block, lines)
}

const LIST_LINE = /^(\s*)(?:([-*+])|(\d+)([.)]))\s+(\[[ xX]\]\s+)?(.*)$/
const QUOTE_LINE = /^(\s*)>\s?(.*)$/

/**
 * Enter inside a list or quote continues it; Enter on an item that is still
 * empty ends the list instead of stacking blank bullets. Returns `null` when
 * the caret is in plain prose, where the browser's own newline is correct.
 */
export function continueBlock(value: string, selection: Selection): Edit | null {
  if (selection.start !== selection.end) return null
  const caret = selection.start
  const start = lineStartOf(value, caret)
  const line = value.slice(start, caret)

  const list = LIST_LINE.exec(line)
  if (list !== null) {
    const [, indent = '', bullet, digits, delimiter, task, body = ''] = list
    if (body.trim() === '') {
      return { start, end: caret, text: '', selectionStart: start, selectionEnd: start }
    }
    const marker = bullet !== undefined ? `${bullet} ` : `${Number(digits) + 1}${delimiter ?? '.'} `
    const checkbox = task === undefined ? '' : '[ ] '
    const text = `\n${indent}${marker}${checkbox}`
    return keepAfter(caret, text)
  }

  const quote = QUOTE_LINE.exec(line)
  if (quote !== null) {
    const [, indent = '', body = ''] = quote
    if (body.trim() === '') {
      return { start, end: caret, text: '', selectionStart: start, selectionEnd: start }
    }
    return keepAfter(caret, `\n${indent}> `)
  }

  return null
}

function keepAfter(caret: number, text: string): Edit {
  return {
    start: caret,
    end: caret,
    text,
    selectionStart: caret + text.length,
    selectionEnd: caret + text.length
  }
}
