import * as React from 'react'
import {
  BoldIcon,
  Columns2Icon,
  EyeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  MinusIcon,
  PencilIcon,
  SquareCodeIcon,
  StrikethroughIcon,
  TextQuoteIcon,
  CodeIcon
} from 'lucide-react'
import { Button } from '@taut/ui/components/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@taut/ui/components/tooltip'
import { cn } from '@taut/ui/lib/utils'

import { Markdown } from '@/components/markdown'
import {
  continueBlock,
  insertCodeBlock,
  insertLink,
  insertRule,
  shiftIndent,
  toggleBlock,
  toggleHeading,
  toggleWrap,
  type Edit,
  type Selection
} from '@/lib/markdown-commands'

/** ⌘ on Apple platforms, Ctrl everywhere else — only used for the hint text. */
const APPLE =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const MOD = APPLE ? '⌘' : 'Ctrl+'

type Mode = 'write' | 'split' | 'preview'

/** Selecting text and typing one of these wraps the selection. */
const WRAPPERS: Record<string, { open: string; close: string }> = {
  '*': { open: '*', close: '*' },
  _: { open: '_', close: '_' },
  '`': { open: '`', close: '`' },
  '~': { open: '~', close: '~' },
  '(': { open: '(', close: ')' },
  '[': { open: '[', close: ']' },
  '"': { open: '"', close: '"' }
}

/**
 * Apply an edit to a live textarea.
 *
 * `execCommand('insertText')` is deprecated but it is still the only way to
 * write into a textarea and keep the browser's native undo stack: setting
 * `value` from React drops every previous ⌘Z step. The `setRangeText` path is
 * the fallback for engines that refuse the command.
 */
function applyEdit(area: HTMLTextAreaElement, edit: Edit): void {
  area.focus()
  area.setSelectionRange(edit.start, edit.end)
  let ok = false
  try {
    ok = document.execCommand('insertText', false, edit.text)
  } catch {
    ok = false
  }
  if (!ok) {
    area.setRangeText(edit.text, edit.start, edit.end, 'end')
    area.dispatchEvent(new Event('input', { bubbles: true }))
  }
  area.setSelectionRange(edit.selectionStart, edit.selectionEnd)
}

interface Command {
  readonly key: string
  readonly label: string
  readonly shortcut?: string
  readonly icon: React.ReactNode
  readonly run: (value: string, selection: Selection) => Edit | null
}

const COMMANDS: readonly (Command | 'separator')[] = [
  {
    key: 'bold',
    label: 'Bold',
    shortcut: `${MOD}B`,
    icon: <BoldIcon />,
    run: (value, selection) => toggleWrap(value, selection, '**')
  },
  {
    key: 'italic',
    label: 'Italic',
    shortcut: `${MOD}I`,
    icon: <ItalicIcon />,
    run: (value, selection) => toggleWrap(value, selection, '_')
  },
  {
    key: 'strike',
    label: 'Strikethrough',
    icon: <StrikethroughIcon />,
    run: (value, selection) => toggleWrap(value, selection, '~~')
  },
  {
    key: 'code',
    label: 'Inline code',
    shortcut: `${MOD}E`,
    icon: <CodeIcon />,
    run: (value, selection) => toggleWrap(value, selection, '`')
  },
  {
    key: 'link',
    label: 'Link',
    shortcut: `${MOD}K`,
    icon: <LinkIcon />,
    run: insertLink
  },
  'separator',
  {
    key: 'h1',
    label: 'Heading 1',
    shortcut: `${MOD}1`,
    icon: <Heading1Icon />,
    run: (value, selection) => toggleHeading(value, selection, 1)
  },
  {
    key: 'h2',
    label: 'Heading 2',
    shortcut: `${MOD}2`,
    icon: <Heading2Icon />,
    run: (value, selection) => toggleHeading(value, selection, 2)
  },
  {
    key: 'h3',
    label: 'Heading 3',
    shortcut: `${MOD}3`,
    icon: <Heading3Icon />,
    run: (value, selection) => toggleHeading(value, selection, 3)
  },
  'separator',
  {
    key: 'bullet',
    label: 'Bulleted list',
    shortcut: `${MOD}⇧8`,
    icon: <ListIcon />,
    run: (value, selection) => toggleBlock(value, selection, 'bullet')
  },
  {
    key: 'ordered',
    label: 'Numbered list',
    shortcut: `${MOD}⇧7`,
    icon: <ListOrderedIcon />,
    run: (value, selection) => toggleBlock(value, selection, 'ordered')
  },
  {
    key: 'task',
    label: 'Task list',
    icon: <ListTodoIcon />,
    run: (value, selection) => toggleBlock(value, selection, 'task')
  },
  {
    key: 'quote',
    label: 'Quote',
    shortcut: `${MOD}⇧.`,
    icon: <TextQuoteIcon />,
    run: (value, selection) => toggleBlock(value, selection, 'quote')
  },
  'separator',
  {
    key: 'block',
    label: 'Code block',
    shortcut: `${MOD}⇧E`,
    icon: <SquareCodeIcon />,
    run: insertCodeBlock
  },
  {
    key: 'rule',
    label: 'Divider',
    icon: <MinusIcon />,
    run: insertRule
  }
]

/** Keyboard bindings, keyed by `event.key` lowercased, split by shift. */
const KEYMAP: Record<string, string> = {
  b: 'bold',
  i: 'italic',
  e: 'code',
  k: 'link',
  '1': 'h1',
  '2': 'h2',
  '3': 'h3'
}
const SHIFT_KEYMAP: Record<string, string> = {
  '8': 'bullet',
  '*': 'bullet',
  '7': 'ordered',
  '&': 'ordered',
  '.': 'quote',
  '>': 'quote',
  e: 'block',
  x: 'task'
}

function commandByKey(key: string): Command | undefined {
  return COMMANDS.find((entry): entry is Command => entry !== 'separator' && entry.key === key)
}

function ToolbarButton({
  command,
  onRun
}: {
  command: Command
  onRun: (command: Command) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={command.label}
          // Keep the caret where it is: the toolbar must not steal focus.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onRun(command)}
        >
          {command.icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {command.label}
        {command.shortcut === undefined ? null : (
          <span className="ml-1.5 text-primary-foreground/60">{command.shortcut}</span>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

function ModeButton({
  active,
  onClick,
  icon,
  children,
  className
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant={active ? 'secondary' : 'ghost'}
      aria-pressed={active}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn('gap-1.5', active ? 'shadow-xs' : 'text-muted-foreground', className)}
    >
      {icon}
      {children}
    </Button>
  )
}

export interface MarkdownEditorProps {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Rendered above the toolbar, opposite the Write/Split/Preview switch. */
  label?: React.ReactNode
  /** Small print under the editor — where the text ends up, for instance. */
  hint?: React.ReactNode
  className?: string
  autoFocus?: boolean
  /** ⌘⏎ inside the editor. */
  onSubmit?: () => void
  /**
   * View the source without being able to change it: no toolbar, no shortcuts,
   * a read-only textarea. Preview opens first, since reading is the point.
   * Used for built-in skills, which ship with Taut and cannot be edited.
   */
  readOnly?: boolean
}

/**
 * A markdown editor: toolbar, the usual editing shortcuts, and a preview that
 * runs the same renderer the channel does.
 *
 * The textarea stays a plain textarea — the value is markdown source, never a
 * rich-text model — so what an agent reads out of `SKILL.md` is exactly what
 * was typed. Everything the toolbar does is a text edit the keyboard could
 * have made.
 */
export function MarkdownEditor({
  id,
  value,
  onChange,
  placeholder,
  label,
  hint,
  className,
  autoFocus = false,
  onSubmit,
  readOnly = false
}: MarkdownEditorProps) {
  const areaRef = React.useRef<HTMLTextAreaElement>(null)
  const [mode, setMode] = React.useState<Mode>(readOnly ? 'preview' : 'write')

  const run = React.useCallback((command: Command): void => {
    const area = areaRef.current
    if (area === null) return
    const edit = command.run(area.value, { start: area.selectionStart, end: area.selectionEnd })
    if (edit !== null) applyEdit(area, edit)
  }, [])

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (readOnly) return
    const area = event.currentTarget
    const selection: Selection = { start: area.selectionStart, end: area.selectionEnd }
    const mod = event.metaKey || event.ctrlKey

    if (mod && event.key === 'Enter') {
      event.preventDefault()
      onSubmit?.()
      return
    }

    if (mod && !event.altKey) {
      const key = event.key.toLowerCase()
      const name = event.shiftKey ? SHIFT_KEYMAP[key] : KEYMAP[key]
      const command = name === undefined ? undefined : commandByKey(name)
      if (command !== undefined) {
        event.preventDefault()
        run(command)
        return
      }
    }

    if (event.key === 'Tab' && !mod) {
      event.preventDefault()
      applyEdit(area, shiftIndent(area.value, selection, event.shiftKey))
      return
    }

    if (event.key === 'Enter' && !event.shiftKey && !mod) {
      const edit = continueBlock(area.value, selection)
      if (edit !== null) {
        event.preventDefault()
        applyEdit(area, edit)
      }
      return
    }

    // Typing a paired marker with text selected wraps it instead of replacing it.
    const pair = WRAPPERS[event.key]
    if (pair !== undefined && !mod && selection.start !== selection.end) {
      event.preventDefault()
      applyEdit(area, toggleWrap(area.value, selection, pair.open, pair.close))
    }
  }

  const words = value.trim() === '' ? 0 : value.trim().split(/\s+/).length
  const showWrite = mode !== 'preview'
  const showPreview = mode !== 'write'
  const showToolbar = showWrite && !readOnly

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="mb-2 flex items-center gap-2">
        {label === undefined ? null : (
          <span className="text-sm leading-none font-medium">{label}</span>
        )}
        <div className="ml-auto flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
          <ModeButton
            active={mode === 'write'}
            onClick={() => setMode('write')}
            icon={readOnly ? <CodeIcon /> : <PencilIcon />}
          >
            {readOnly ? 'Source' : 'Write'}
          </ModeButton>
          <ModeButton
            active={mode === 'split'}
            onClick={() => setMode('split')}
            icon={<Columns2Icon />}
            className="hidden lg:inline-flex"
          >
            Split
          </ModeButton>
          <ModeButton
            active={mode === 'preview'}
            onClick={() => setMode('preview')}
            icon={<EyeIcon />}
          >
            Preview
          </ModeButton>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        {showToolbar ? (
          <div className="taut-scroll flex shrink-0 items-center gap-0.5 overflow-x-auto border-b bg-muted/40 px-1.5 py-1">
            {COMMANDS.map((entry, index) =>
              entry === 'separator' ? (
                <span
                  key={`sep-${index}`}
                  aria-hidden
                  className="mx-1 h-4 w-px shrink-0 bg-border"
                />
              ) : (
                <ToolbarButton key={entry.key} command={entry} onRun={run} />
              )
            )}
          </div>
        ) : null}

        <div className={cn('min-h-0 flex-1', showWrite && showPreview ? 'grid grid-cols-2' : '')}>
          {showWrite ? (
            <textarea
              id={id}
              ref={areaRef}
              value={value}
              autoFocus={autoFocus}
              readOnly={readOnly}
              spellCheck={!readOnly}
              placeholder={placeholder}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={onKeyDown}
              className={cn(
                'taut-scroll size-full min-h-0 resize-none bg-transparent px-3 py-2.5 font-mono text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground',
                showPreview && 'border-r'
              )}
            />
          ) : null}
          {showPreview ? (
            <div className="taut-scroll size-full min-h-0 overflow-y-auto px-3 py-2.5">
              <Markdown source={value} />
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {hint === undefined ? null : <span className="min-w-0">{hint}</span>}
        <span className="ml-auto shrink-0 tabular-nums">
          {words} {words === 1 ? 'word' : 'words'} · {value.length} chars
        </span>
      </div>
    </div>
  )
}
