import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@taut/ui/lib/utils'

const alertVariants = cva(
  'relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground [&>svg]:text-muted-foreground',
        /** A nudge that has something for the reader to do — never an error. */
        attention: 'border-amber-500/35 bg-amber-500/[0.07] text-foreground [&>svg]:text-amber-500',
        success:
          'border-emerald-500/35 bg-emerald-500/[0.07] text-foreground [&>svg]:text-emerald-500',
        destructive:
          'border-destructive/40 bg-destructive/[0.07] text-foreground [&>svg]:text-destructive'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

function Alert({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-variant={variant}
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn('col-start-2 min-h-4 font-medium tracking-tight', className)}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed',
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, alertVariants }
