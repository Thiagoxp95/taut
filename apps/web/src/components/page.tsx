import * as React from 'react'
import { LockIcon } from 'lucide-react'
import { cn } from '@taut/ui/lib/utils'
import { SidebarTrigger } from '@taut/ui/components/sidebar'

export function PageHeader({
  title,
  description,
  icon,
  actions
}: {
  title: React.ReactNode
  description?: React.ReactNode
  icon?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <header className="taut-topbar flex h-14 shrink-0 items-center gap-3 border-b bg-background px-6">
      {/* On phones the sidebar is a sheet, so every page carries its handle. */}
      <SidebarTrigger className="-ml-2 shrink-0 md:hidden" />
      {icon !== undefined ? <span className="text-muted-foreground">{icon}</span> : null}
      <div className="min-w-0">
        <h1 className="truncate text-[15px] leading-tight font-semibold">{title}</h1>
        {description !== undefined ? (
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      ) : null}
    </header>
  )
}

export function PageBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('taut-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6', className)}
      {...props}
    />
  )
}

export function PageSection({
  title,
  description,
  actions,
  children,
  className
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('mb-8', className)}>
      <div className="mb-3 flex items-end gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description !== undefined ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions !== undefined ? <div className="ml-auto">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center',
        className
      )}
    >
      <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        {icon}
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action !== undefined ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

/** Shown instead of a save button to someone who may only read what they are looking at. */
export function ReadOnlyNote() {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <LockIcon className="size-3.5" />
      Read only — an owner, an admin, or the head of one of its departments can change this.
    </p>
  )
}

/** Label + control + hint, used by every form in the shell. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
  className
}: {
  label: string
  /**
   * Omitted for a field that is a group of controls rather than one — there is
   * nothing for `for` to point at, and a `<label>` aimed at nothing is worse
   * than plain text. Such a field labels itself (`role="group"`).
   */
  htmlFor?: string
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  const Tag = htmlFor === undefined ? 'span' : 'label'
  return (
    <div className={cn('grid gap-2', className)}>
      <Tag
        htmlFor={htmlFor}
        className="text-sm leading-none font-medium text-foreground select-none"
      >
        {label}
      </Tag>
      {children}
      {hint !== undefined ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
