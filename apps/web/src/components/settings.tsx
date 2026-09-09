import * as React from 'react'
import { Link, type LinkProps } from '@tanstack/react-router'
import { Alert, AlertDescription, AlertTitle } from '@taut/ui/components/alert'
import { Button } from '@taut/ui/components/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@taut/ui/components/tabs'
import { cn } from '@taut/ui/lib/utils'

/**
 * The shape every settings surface in Taut wears: a rail on the left, a column of
 * cards on the right, each card a stack of `label + description | control` rows over
 * a sticky-feeling footer that only lights up once something is dirty.
 *
 * Everything here composes the shadcn primitives in `@taut/ui/components`; nothing
 * re-implements a control. See docs/design-settings.md.
 */

/** Rail + content. The rail collapses above the content on phones. */
export function SettingsShell({
  nav,
  children,
  className
}: {
  nav?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-5xl flex-col gap-6 md:flex-row md:items-start md:gap-8',
        className
      )}
    >
      {nav === undefined ? null : (
        <div className="md:sticky md:top-6 md:w-56 md:shrink-0">{nav}</div>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** The vertical rail. On phones it scrolls sideways instead of stacking ten items tall. */
export function SettingsNav({ children, className }: React.ComponentProps<'nav'>) {
  return (
    <nav
      className={cn(
        'flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0',
        className
      )}
    >
      {children}
    </nav>
  )
}

const navItemClass =
  "flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[active=true]:bg-accent data-[active=true]:text-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted-foreground data-[active=true]:[&_svg]:text-foreground"

/** A rail item that navigates. */
export function SettingsNavLink({
  icon,
  children,
  className,
  ...props
}: Omit<LinkProps, 'children'> & {
  icon?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <Link
      {...props}
      className={cn(navItemClass, className)}
      activeProps={{ 'data-active': 'true' }}
      activeOptions={{ exact: false }}
    >
      {icon}
      <span className="truncate">{children}</span>
    </Link>
  )
}

/**
 * A rail for one page's sections, driven by `Tabs` so arrow keys walk it and the
 * panels stay associated with their triggers. `SettingsPanel` renders one panel.
 */
export function SettingsTabs({
  value,
  onValueChange,
  nav,
  children,
  className
}: {
  value: string
  onValueChange: (next: string) => void
  nav: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <Tabs
      value={value}
      onValueChange={onValueChange}
      orientation="vertical"
      className={cn(
        'mx-auto w-full max-w-5xl flex-col gap-6 md:flex-row md:items-start md:gap-8',
        className
      )}
    >
      <TabsList className="h-auto w-full gap-1 overflow-x-auto rounded-none bg-transparent p-0 md:sticky md:top-6 md:w-56 md:shrink-0 md:flex-col md:overflow-visible">
        {nav}
      </TabsList>
      <div className="min-w-0 flex-1">{children}</div>
    </Tabs>
  )
}

export function SettingsTab({
  value,
  icon,
  children
}: {
  value: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <TabsTrigger
      value={value}
      data-active={undefined}
      className={cn(
        navItemClass,
        'h-auto w-auto flex-none justify-start data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:shadow-none md:w-full dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-accent dark:data-[state=active]:text-foreground',
        "data-[state=active]:[&_svg:not([class*='text-'])]:text-foreground"
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </TabsTrigger>
  )
}

export function SettingsPanel({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsContent value={value} className="grid gap-6">
      {children}
    </TabsContent>
  )
}

/**
 * The banner above the cards: one thing worth doing, with the buttons that do it.
 * `onDismiss` renders the quiet button; `action` is whatever the reader should press.
 */
export function SettingsCallout({
  icon,
  title,
  description,
  action,
  onDismiss,
  variant = 'attention'
}: {
  icon: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  onDismiss?: () => void
  variant?: 'attention' | 'success' | 'destructive' | 'default'
}) {
  return (
    <Alert variant={variant} className="mb-6 items-center gap-x-3 px-4 py-3.5">
      {icon}
      <div className="col-start-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <AlertTitle className="col-start-1">{title}</AlertTitle>
          {description === undefined ? null : (
            <AlertDescription className="col-start-1 mt-0.5">{description}</AlertDescription>
          )}
        </div>
        {onDismiss === undefined && action === undefined ? null : (
          <div className="flex shrink-0 items-center gap-2">
            {onDismiss === undefined ? null : (
              <Button variant="ghost" size="sm" onClick={onDismiss}>
                Dismiss
              </Button>
            )}
            {action}
          </div>
        )}
      </div>
    </Alert>
  )
}

/**
 * One card. `title`/`description` render the header; rows go in the body and are
 * separated for you. A card with a `footer` is a form: pass `onSubmit` and the
 * footer's save button submits it.
 */
export function SettingsCard({
  title,
  description,
  action,
  footer,
  onSubmit,
  children,
  className
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  /** Rendered at the top right of the header — an "Add" button, a status badge. */
  action?: React.ReactNode
  footer?: React.ReactNode
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void
  children: React.ReactNode
  className?: string
}) {
  const body = (
    <>
      {title === undefined ? null : (
        <header className="flex items-start gap-4 border-b px-6 py-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-base leading-tight font-semibold">{title}</h2>
            {description === undefined ? null : (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {action === undefined ? null : <div className="shrink-0">{action}</div>}
        </header>
      )}
      <div className="divide-y">{children}</div>
      {footer === undefined ? null : (
        <footer className="flex items-center justify-end gap-2 border-t px-6 py-4">{footer}</footer>
      )}
    </>
  )

  return (
    <section
      className={cn(
        'overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm',
        className
      )}
    >
      {onSubmit === undefined ? body : <form onSubmit={onSubmit}>{body}</form>}
    </section>
  )
}

/**
 * A card whose body is one padded block rather than a stack of rows — a list, a
 * table, an editor. Same frame as `SettingsCard`, so a page can mix the two.
 */
export function SettingsSection({
  title,
  description,
  action,
  footer,
  children,
  className
}: {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  footer?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <SettingsCard
      title={title}
      description={description}
      action={action}
      footer={footer}
      className={className}
    >
      <div className="grid min-w-0 gap-4 px-6 py-5 [&>*]:min-w-0">{children}</div>
    </SettingsCard>
  )
}

/**
 * A row: what it is on the left, the control on the right. `htmlFor` makes the
 * left column a real `<label>`; a row holding a group of controls omits it.
 */
export function SettingsRow({
  label,
  description,
  badge,
  htmlFor,
  children,
  className,
  /** A row whose control needs the full width (an editor, a list, a picker grid). */
  stacked = false
}: {
  label: React.ReactNode
  description?: React.ReactNode
  badge?: React.ReactNode
  htmlFor?: string
  children: React.ReactNode
  className?: string
  stacked?: boolean
}) {
  const Tag = htmlFor === undefined ? 'span' : 'label'
  return (
    <div
      className={cn(
        'grid gap-3 px-6 py-5',
        stacked ? null : 'sm:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] sm:items-start sm:gap-8',
        className
      )}
    >
      <div className="min-w-0">
        <Tag
          htmlFor={htmlFor}
          className="flex items-center gap-2 text-sm leading-none font-medium text-foreground select-none"
        >
          {label}
          {badge}
        </Tag>
        {description === undefined ? null : (
          <p className="mt-1.5 text-sm leading-snug text-muted-foreground">{description}</p>
        )}
      </div>
      <div
        className={cn(
          'grid min-w-0 gap-4 [&>*]:min-w-0',
          // Inputs and selects fill the column; a lone button sizes to its label.
          stacked ? null : 'sm:justify-items-stretch [&>button]:w-fit [&>button]:justify-self-start'
        )}
      >
        {children}
      </div>
    </div>
  )
}

/** A labelled control inside a row that carries more than one. */
export function SettingsField({
  label,
  htmlFor,
  hint,
  children,
  className
}: {
  label: string
  htmlFor?: string
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  const Tag = htmlFor === undefined ? 'span' : 'label'
  return (
    <div className={cn('grid gap-2', className)}>
      <Tag htmlFor={htmlFor} className="text-sm leading-none font-medium select-none">
        {label}
      </Tag>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * Cancel + Save, the pair every settings form ends with. `dirty` drives both: with
 * nothing edited there is nothing to cancel and nothing to save.
 */
export function SettingsSave({
  dirty,
  pending = false,
  onCancel,
  label = 'Save changes',
  cancelLabel = 'Cancel'
}: {
  dirty: boolean
  pending?: boolean
  onCancel: () => void
  label?: string
  cancelLabel?: string
}) {
  return (
    <>
      <Button type="button" variant="ghost" disabled={!dirty || pending} onClick={onCancel}>
        {cancelLabel}
      </Button>
      <Button type="submit" disabled={!dirty || pending}>
        {pending ? 'Saving…' : label}
      </Button>
    </>
  )
}

/** An input with a fixed lead-in — `@` before a handle, `https://` before a site. */
export function InputAffix({
  prefix,
  suffix,
  className,
  children
}: {
  prefix?: React.ReactNode
  suffix?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex h-9 w-full items-center rounded-md border bg-transparent shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30',
        className
      )}
    >
      {prefix === undefined ? null : (
        <span className="shrink-0 pl-3 text-sm text-muted-foreground select-none">{prefix}</span>
      )}
      {children}
      {suffix === undefined ? null : (
        <span className="shrink-0 pr-3 text-sm text-muted-foreground select-none">{suffix}</span>
      )}
    </div>
  )
}

/** The `Input` that goes inside `InputAffix`: no border, no ring, no double frame. */
export const affixInputClass =
  'h-full border-0 bg-transparent shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent'

/** A row of destructive actions, kept in its own card at the bottom of a page. */
export function DangerZone({ children }: { children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-destructive/30 bg-card text-card-foreground shadow-sm">
      <header className="border-b border-destructive/30 px-6 py-5">
        <h2 className="text-base leading-tight font-semibold text-destructive">Danger zone</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          These actions cannot be undone from here.
        </p>
      </header>
      <div className="divide-y divide-destructive/20">{children}</div>
    </section>
  )
}
