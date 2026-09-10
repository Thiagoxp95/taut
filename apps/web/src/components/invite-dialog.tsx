import * as React from 'react'
import { CheckIcon, CopyIcon } from '@taut/ui/components/icons'
import type { Invite, MembershipRole } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@taut/ui/components/dialog'
import { Input } from '@taut/ui/components/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { toast } from '@taut/ui/components/sonner'
import { Field } from '@/components/page'
import { useCreateInvite } from '@/lib/api'

export function inviteLink(token: string): string {
  return `${window.location.origin}/invite/${token}`
}

/** Copies the invite URL; there is no mail transport in the MVP. */
export function CopyInviteLink({ token, label = 'Copy link' }: { token: string; label?: string }) {
  const [copied, setCopied] = React.useState(false)

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard
          .writeText(inviteLink(token))
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => toast.error('Could not copy the invite link'))
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? 'Copied' : label}
    </Button>
  )
}

export function InviteDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [email, setEmail] = React.useState('')
  const [role, setRole] = React.useState<MembershipRole>('member')
  const [created, setCreated] = React.useState<Invite | null>(null)
  const createInvite = useCreateInvite()

  const close = (next: boolean): void => {
    onOpenChange(next)
    if (!next) {
      setEmail('')
      setRole('member')
      setCreated(null)
    }
  }

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (email.trim() === '') return
    createInvite.mutate(
      { email: email.trim(), role },
      { onSuccess: (invite) => setCreated(invite) }
    )
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite people</DialogTitle>
          <DialogDescription>
            Taut sends no email. Create the invite, then share the link yourself.
          </DialogDescription>
        </DialogHeader>

        {created === null ? (
          <form className="grid gap-4" onSubmit={submit}>
            <Field label="Email" htmlFor="invite-email">
              <Input
                id="invite-email"
                type="email"
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="teammate@acme.test"
              />
            </Field>
            <Field label="Role" htmlFor="invite-role">
              <Select
                value={role}
                onValueChange={(next) => {
                  if (next === 'owner' || next === 'admin' || next === 'member') setRole(next)
                }}
              >
                <SelectTrigger id="invite-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="owner">Owner</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={email.trim() === '' || createInvite.isPending}>
                Create invite
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid gap-4">
            <Field label="Invite link" htmlFor="invite-link" hint="Expires in seven days.">
              <div className="flex gap-2">
                <Input
                  id="invite-link"
                  readOnly
                  value={inviteLink(created.token)}
                  className="font-mono text-xs"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <CopyInviteLink token={created.token} />
              </div>
            </Field>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setCreated(null)}>
                Invite someone else
              </Button>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
