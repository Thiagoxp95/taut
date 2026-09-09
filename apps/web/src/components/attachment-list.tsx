import * as React from 'react'
import { DownloadIcon, FileArchiveIcon, FileIcon, FileTextIcon, ImageIcon } from 'lucide-react'
import type { Attachment } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@taut/ui/components/dialog'
import { attachmentUrl } from '@/lib/api'
import { attachmentKind, isInlineImage } from '@/lib/attachments'
import { formatBytes } from '@/lib/format'

/** The stand-in for a file that is not shown inline. Also used by the composer strip. */
export function AttachmentIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  switch (attachmentKind(mimeType)) {
    case 'image':
      return <ImageIcon className={className} />
    case 'pdf':
    case 'text':
      return <FileTextIcon className={className} />
    case 'archive':
      return <FileArchiveIcon className={className} />
    case 'file':
      return <FileIcon className={className} />
  }
}

/**
 * Everything sent with a message (docs/build-plan-attachments.md D5): images in
 * a grid that opens a lightbox, every other file as a download card. Shared by
 * the channel, the thread panel and anything else that renders a `Message`.
 */
export function AttachmentList({
  attachments,
  className
}: {
  attachments: readonly Attachment[]
  className?: string
}) {
  const [preview, setPreview] = React.useState<Attachment | null>(null)

  const images = attachments.filter((attachment) => isInlineImage(attachment.mimeType))
  const files = attachments.filter((attachment) => !isInlineImage(attachment.mimeType))
  if (attachments.length === 0) return null

  return (
    <div className={cn('mt-1.5 flex max-w-lg flex-col gap-2', className)}>
      {images.length === 0 ? null : (
        <ul
          className={cn(
            'grid gap-2',
            images.length === 1 ? 'grid-cols-1' : 'grid-cols-2 sm:grid-cols-3'
          )}
        >
          {images.map((attachment) => (
            <li key={attachment.id}>
              <button
                type="button"
                title={attachment.name}
                onClick={() => setPreview(attachment)}
                className="block w-full overflow-hidden rounded-md border bg-muted/40 outline-none transition-opacity hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <img
                  src={attachmentUrl(attachment.id)}
                  alt={attachment.name}
                  loading="lazy"
                  decoding="async"
                  className="max-h-80 w-full object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      )}

      {files.length === 0 ? null : (
        <ul className="flex flex-col gap-1.5">
          {files.map((attachment) => (
            <li key={attachment.id}>
              <FileCard attachment={attachment} />
            </li>
          ))}
        </ul>
      )}

      <Lightbox attachment={preview} onClose={() => setPreview(null)} />
    </div>
  )
}

function FileCard({ attachment }: { attachment: Attachment }) {
  return (
    <a
      href={attachmentUrl(attachment.id, { download: true })}
      download={attachment.name}
      className="group/file flex items-center gap-3 rounded-md border bg-background px-3 py-2 transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <AttachmentIcon mimeType={attachment.mimeType} className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{attachment.name}</span>
        <span className="block text-[11px] text-muted-foreground">
          {formatBytes(attachment.size)}
        </span>
      </span>
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover/file:opacity-100 group-focus-visible/file:opacity-100">
        <DownloadIcon className="size-3.5" />
        Download
      </span>
    </a>
  )
}

/** The full-size image, its name, and a link that forces `Content-Disposition: attachment`. */
function Lightbox({ attachment, onClose }: { attachment: Attachment | null; onClose: () => void }) {
  return (
    <Dialog open={attachment !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-[calc(100%-2rem)] gap-3 sm:max-w-3xl">
        {attachment === null ? null : (
          <>
            <DialogHeader>
              <DialogTitle className="truncate pr-8 text-sm">{attachment.name}</DialogTitle>
              <DialogDescription className="text-xs">
                {formatBytes(attachment.size)} · {attachment.mimeType}
              </DialogDescription>
            </DialogHeader>
            <img
              src={attachmentUrl(attachment.id)}
              alt={attachment.name}
              className="max-h-[70vh] w-full rounded-md object-contain"
            />
            <a
              href={attachmentUrl(attachment.id, { download: true })}
              download={attachment.name}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground"
            >
              <DownloadIcon className="size-3.5" />
              Download
            </a>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
