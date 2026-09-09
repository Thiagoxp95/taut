import * as React from 'react'
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
import { EmojiPicker } from '@/components/emoji-picker'
import { Field } from '@/components/page'
import { useCompanySwitcher } from '@/hooks/use-company-switcher'
import { useCreateCompany } from '@/lib/api'
import { slugify } from '@/lib/format'

export function CreateCompanyDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = React.useState('')
  const [slug, setSlug] = React.useState('')
  const [slugTouched, setSlugTouched] = React.useState(false)
  const [avatar, setAvatar] = React.useState('🅰️')
  const createCompany = useCreateCompany()
  const switchTo = useCompanySwitcher()

  const effectiveSlug = slugTouched ? slug : slugify(name)

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (name.trim() === '' || effectiveSlug === '') return
    createCompany.mutate(
      { name: name.trim(), slug: effectiveSlug, avatar: { kind: 'emoji', value: avatar } },
      {
        onSuccess: (company) => {
          onOpenChange(false)
          setName('')
          setSlug('')
          setSlugTouched(false)
          void switchTo(company.id)
        }
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a company</DialogTitle>
          <DialogDescription>
            A company owns its vault, its subscriptions, its agents and their files. Nothing crosses
            the boundary.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="flex gap-4">
            <Field label="Avatar" htmlFor="new-company-avatar">
              <EmojiPicker id="new-company-avatar" value={avatar} onChange={setAvatar} />
            </Field>
            <Field label="Name" htmlFor="new-company-name" className="flex-1">
              <Input
                id="new-company-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Acme"
              />
            </Field>
          </div>
          <Field
            label="Slug"
            htmlFor="new-company-slug"
            hint={`Files live at /data/companies/${effectiveSlug === '' ? '<slug>' : effectiveSlug}/`}
          >
            <Input
              id="new-company-slug"
              value={effectiveSlug}
              onChange={(event) => {
                setSlugTouched(true)
                setSlug(slugify(event.target.value))
              }}
              placeholder="acme"
              className="font-mono text-xs"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={name.trim() === '' || effectiveSlug === '' || createCompany.isPending}
            >
              Create company
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
