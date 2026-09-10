/**
 * How a file sent in chat is presented: is it an inline image, and which icon
 * family stands in for it when it is not (docs/build-plan-attachments.md D5).
 * `AttachmentIcon` in `@/components/attachment-list` draws the kind.
 *
 * Human-readable sizes come from `formatBytes` in `@/lib/format` — the same
 * formatter the agent file browser uses, so "12.4 KB" reads the same everywhere.
 */

/** Icon families a mime type collapses into. */
export type AttachmentKind = 'image' | 'pdf' | 'text' | 'archive' | 'file'

/** File extensions also cover documents uploaded as generic binary/plain text. */
export function canvasAttachmentFormat({
  name,
  mimeType
}: {
  name: string
  mimeType: string
}): 'html' | 'markdown' | undefined {
  const mime = mimeType.split(';')[0]?.trim().toLowerCase()
  if (/\.html?$/i.test(name) || mime === 'text/html' || mime === 'application/xhtml+xml')
    return 'html'
  if (/\.(md|markdown)$/i.test(name) || mime === 'text/markdown' || mime === 'text/x-markdown')
    return 'markdown'
  return undefined
}

const ARCHIVE_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/x-rar-compressed'
])

const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/javascript'
])

/**
 * Rendered as an `<img>` under the message body. SVG is excluded on purpose:
 * the server serves it as a download (D5) because it can carry script.
 */
export function isInlineImage(mimeType: string): boolean {
  return mimeType.startsWith('image/') && mimeType !== 'image/svg+xml'
}

export function attachmentKind(mimeType: string): AttachmentKind {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.startsWith('text/') || TEXT_TYPES.has(mimeType)) return 'text'
  if (ARCHIVE_TYPES.has(mimeType)) return 'archive'
  return 'file'
}
