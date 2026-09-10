import * as React from 'react'
import { Button } from '@taut/ui/components/button'
import { cn } from '@taut/ui/lib/utils'

export interface AuthorizationCardProps {
  title: string
  description: React.ReactNode
  children: React.ReactNode
  status: 'pending' | 'approved' | 'declined' | 'superseded'
  statusText: string
  canDecide: boolean
  busy?: boolean
  error?: string | undefined
  onDecide: (decision: 'approve' | 'decline') => void
  className?: string
}

/** Presentation only: callers own the preview, authorization policy and decision request. */
export function AuthorizationCard({
  title,
  description,
  children,
  status,
  statusText,
  canDecide,
  busy = false,
  error,
  onDecide,
  className
}: AuthorizationCardProps) {
  const titleId = React.useId()
  const descriptionId = React.useId()
  return (
    <section
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy}
      className={cn(
        'my-2 max-w-2xl overflow-hidden rounded-lg border bg-card text-card-foreground',
        className
      )}
    >
      <div className="space-y-1 border-b px-4 py-3">
        <p className="text-xs font-medium text-muted-foreground">Human authorization</p>
        <p id={titleId} className="text-sm font-semibold">
          {title}
        </p>
        <div id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </div>
      </div>
      <div className="min-w-0 px-4 py-3">{children}</div>
      <div className="space-y-2 border-t bg-muted/30 px-4 py-3">
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {busy ? 'Saving your decision…' : statusText}
        </p>
        {error === undefined ? null : (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {status === 'pending' && canDecide ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => onDecide('approve')}>
              Approve
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onDecide('decline')}
            >
              Decline
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
