import { cn } from '@taut/ui/lib/utils'

import { RichText } from '@/components/rich-text'

/**
 * A mandate or skill body, rendered with the same pipeline as a message
 * (`components/rich-text.tsx`) so a preview looks like what the channel shows.
 */
export function Markdown({ source, className }: { source: string; className?: string }) {
  if (source.trim() === '') {
    return <p className={cn('text-sm text-muted-foreground italic', className)}>Nothing yet.</p>
  }
  return <RichText source={source} className={className} />
}
