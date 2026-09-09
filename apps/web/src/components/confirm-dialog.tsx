import * as React from 'react'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@taut/ui/components/dialog'

/**
 * The confirmation dialog behind every destructive action in the shell.
 *
 * `confirmWord` turns it into a type-to-confirm (deleting an agent asks for its
 * handle); without it the confirm button is live immediately. The body is a
 * separate component so closing the dialog unmounts it — the typed word never
 * survives into the next confirmation.
 */
function ConfirmBody({
  title,
  description,
  confirmLabel,
  confirmWord,
  confirmWordHint,
  pending,
  onCancel,
  onConfirm
}: {
  title: string
  description: React.ReactNode
  confirmLabel: string
  confirmWord?: string
  confirmWordHint?: React.ReactNode
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const [typed, setTyped] = React.useState('')
  const ready = confirmWord === undefined || typed.trim() === confirmWord

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (ready && !pending) onConfirm()
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription asChild>
          <div className="space-y-2">{description}</div>
        </DialogDescription>
      </DialogHeader>

      {confirmWord === undefined ? (
        <div className="h-2" />
      ) : (
        <div className="grid gap-2 py-4">
          <label htmlFor="confirm-word" className="text-sm leading-none font-medium select-none">
            {confirmWordHint ?? (
              <>
                Type <span className="font-mono">{confirmWord}</span> to confirm
              </>
            )}
          </label>
          <Input
            id="confirm-word"
            autoFocus
            autoComplete="off"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={confirmWord}
          />
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={!ready || pending}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  confirmWord,
  confirmWordHint,
  pending = false,
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: React.ReactNode
  confirmLabel?: string
  confirmWord?: string
  confirmWordHint?: React.ReactNode
  pending?: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <ConfirmBody
          title={title}
          description={description}
          confirmLabel={confirmLabel}
          confirmWord={confirmWord}
          confirmWordHint={confirmWordHint}
          pending={pending}
          onCancel={() => onOpenChange(false)}
          onConfirm={onConfirm}
        />
      </DialogContent>
    </Dialog>
  )
}
