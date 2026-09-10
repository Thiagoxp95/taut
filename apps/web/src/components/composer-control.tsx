import * as React from 'react'
import { ChevronDownIcon } from '@taut/ui/components/icons'
import { Button } from '@taut/ui/components/button'
import { cn } from '@taut/ui/lib/utils'

/**
 * The composer's resting controls — the small text buttons that sit on the
 * toolbar row and say what the next message will ask for.
 *
 * They are quiet on purpose: muted text at rest, foreground on hover, no
 * border and no fill, so a row of them reads as a sentence about the run
 * rather than as a strip of buttons competing with Send. Shaped after
 * t3code's composer controls (`ComposerControl`).
 */
export function ComposerControl({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        'h-7 min-h-7 gap-1.5 px-2 text-xs font-normal text-muted-foreground transition-none hover:text-foreground',
        className
      )}
      {...props}
    />
  )
}

/** The control's disclosure caret; its negative end margin tightens the button. */
export function ComposerControlChevron({ className }: { readonly className?: string }) {
  return (
    <ChevronDownIcon
      aria-hidden
      strokeWidth={2.25}
      className={cn('-me-1 size-3.5 shrink-0 text-muted-foreground/70', className)}
    />
  )
}
