import * as React from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { cn } from '@taut/ui/lib/utils'

import { ProfilePopover } from '@/components/profile-card'
import { highlightLanguages, highlightSubset } from '@/lib/highlight-languages'
import { remarkMentions } from '@/lib/remark-mentions'

/**
 * The one rich-text renderer in the app: every message body, thread reply,
 * mandate and skill preview goes through it.
 *
 * `react-markdown` builds React nodes from an mdast/hast pipeline and never
 * touches `dangerouslySetInnerHTML`; raw HTML in a body is dropped rather than
 * parsed, so agent or operator text cannot inject markup. On top of stock
 * CommonMark it runs:
 *
 * - `remark-gfm` — tables, task lists, strikethrough, autolinks
 * - `remark-breaks` — a single newline is a line break, the way chat readers
 *   expect (a plain markdown renderer would join those lines into one)
 * - `remark-mentions` — `@handle` becomes a chip
 * - `rehype-highlight` — fenced code gets highlight.js token classes, themed
 *   against the app's palette in `styles/globals.css`
 */

type Plugins = React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']

const REMARK: Plugins = [remarkGfm, remarkBreaks, remarkMentions]
const REHYPE: Plugins = [
  [
    rehypeHighlight,
    { languages: highlightLanguages, subset: highlightSubset, detect: true, ignoreMissing: true }
  ]
]

const CODE_BLOCK = /(?:^|\s)(?:language-|hljs)/

/**
 * A mention chip. When the handle belongs to someone in the directory —
 * human or agent — clicking it opens their profile card; an unknown handle
 * stays inert text.
 */
function Mention({ handle, children }: { handle: string; children: React.ReactNode }) {
  return (
    <ProfilePopover handle={handle} className="align-baseline">
      <span
        data-mention={handle}
        className="rounded-[3px] bg-sidebar-primary/10 px-1 font-medium text-sidebar-primary transition-colors hover:bg-sidebar-primary/20 dark:bg-sidebar-primary/25 dark:text-sidebar-primary-foreground dark:hover:bg-sidebar-primary/40"
      >
        {children}
      </span>
    </ProfilePopover>
  )
}

const components: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,

  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="font-medium text-sidebar-primary underline underline-offset-2 hover:no-underline dark:text-sidebar-primary-foreground"
    >
      {children}
    </a>
  ),

  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-muted-foreground line-through">{children}</del>,

  h1: ({ children }) => <h3 className="mt-3 mb-1.5 text-base font-bold first:mt-0">{children}</h3>,
  h2: ({ children }) => (
    <h4 className="mt-3 mb-1.5 text-[15px] font-bold first:mt-0">{children}</h4>
  ),
  h3: ({ children }) => <h5 className="mt-3 mb-1 text-sm font-bold first:mt-0">{children}</h5>,
  h4: ({ children }) => <h6 className="mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h6>,
  h5: ({ children }) => (
    <h6 className="mt-2.5 mb-1 text-xs font-semibold tracking-wide uppercase first:mt-0">
      {children}
    </h6>
  ),
  h6: ({ children }) => (
    <h6 className="mt-2.5 mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase first:mt-0">
      {children}
    </h6>
  ),

  ul: ({ children, className }) => (
    <ul
      className={cn(
        'my-2 ml-5 space-y-1 first:mt-0 last:mb-0',
        // GFM task lists carry `contains-task-list` and draw their own markers.
        className?.includes('contains-task-list') ? 'ml-1 list-none' : 'list-disc'
      )}
    >
      {children}
    </ul>
  ),
  ol: ({ children, start }) => (
    <ol className="my-2 ml-5 list-decimal space-y-1 first:mt-0 last:mb-0" start={start}>
      {children}
    </ol>
  ),
  li: ({ children, className }) => (
    <li className={cn('pl-0.5 marker:text-muted-foreground', className)}>{children}</li>
  ),
  input: ({ checked, type }) =>
    type === 'checkbox' ? (
      <input
        type="checkbox"
        checked={checked}
        readOnly
        aria-hidden
        className="mr-1.5 translate-y-px accent-sidebar-primary"
      />
    ) : null,

  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground first:mt-0 last:mb-0">
      {children}
    </blockquote>
  ),

  hr: () => <hr className="my-3 border-border" />,

  pre: ({ children }) => (
    <pre className="taut-scroll my-2 overflow-x-auto rounded-md border bg-muted/60 p-3 font-mono text-xs leading-relaxed first:mt-0 last:mb-0">
      {children}
    </pre>
  ),
  code: ({ children, className }) =>
    className !== undefined && CODE_BLOCK.test(className) ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-muted px-1 py-px font-mono text-[0.85em] text-foreground/90">
        {children}
      </code>
    ),

  table: ({ children }) => (
    <div className="taut-scroll my-2 overflow-x-auto first:mt-0 last:mb-0">
      <table className="w-full border-collapse text-left text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
  th: ({ children, style }) => (
    <th className="border px-2 py-1 font-semibold" style={style}>
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className="border px-2 py-1 align-top" style={style}>
      {children}
    </td>
  ),

  img: ({ src, alt }) => (
    <img src={src} alt={alt ?? ''} className="my-2 max-h-80 max-w-full rounded-md border" />
  ),

  // `remark-mentions` emits `<span data-mention="…">`; everything else passes through.
  span: ({ children, ...props }) => {
    const handle = (props as Record<string, unknown>)['data-mention']
    return typeof handle === 'string' ? (
      <Mention handle={handle}>{children}</Mention>
    ) : (
      <span {...props}>{children}</span>
    )
  }
}

export interface RichTextProps {
  /** Markdown source — a message body, a mandate, a skill file. */
  source: string
  className?: string
  /** Draw a blinking caret after the last block (a streaming agent reply). */
  caret?: boolean
}

export function RichText({ source, className, caret = false }: RichTextProps) {
  const empty = source.trim() === ''
  return (
    <div
      className={cn(
        'taut-rich text-sm leading-relaxed break-words',
        caret && 'taut-caret',
        className
      )}
    >
      {empty ? (
        // A streaming reply starts empty; the caret still needs a line to sit on.
        <p className="min-h-[1lh]" />
      ) : (
        <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={components}>
          {source}
        </ReactMarkdown>
      )}
    </div>
  )
}
