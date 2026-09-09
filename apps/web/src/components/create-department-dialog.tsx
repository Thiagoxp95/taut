import * as React from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { DepartmentShape, UserId } from '@taut/contract'
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
import { DepartmentShapePicker, autoTrait } from '@/components/department-shape-picker'
import { MemberSelect } from '@/components/member-picker'
import { Field } from '@/components/page'
import { useCurrentUser } from '@/hooks/use-directory'
import { useCreateDepartment, useDepartments } from '@/lib/api'
import { slugify } from '@/lib/format'

export function CreateDepartmentDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const me = useCurrentUser()
  const [name, setName] = React.useState('')
  const [slugTouched, setSlugTouched] = React.useState(false)
  const [slug, setSlug] = React.useState('')
  const [head, setHead] = React.useState<UserId | undefined>(undefined)
  const [shape, setShape] = React.useState<DepartmentShape | undefined>(undefined)
  const departments = useDepartments()
  const createDepartment = useCreateDepartment()
  const navigate = useNavigate()

  const effectiveSlug = slugTouched ? slug : slugify(name)
  const headUserId = head ?? me?.id

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (name.trim() === '' || effectiveSlug === '' || headUserId === undefined) return
    createDepartment.mutate(
      { name: name.trim(), slug: effectiveSlug, headUserId, shape },
      {
        onSuccess: (department) => {
          onOpenChange(false)
          setName('')
          setSlug('')
          setSlugTouched(false)
          setShape(undefined)
          void navigate({
            to: '/departments/$departmentId/settings',
            params: { departmentId: department.id }
          })
        }
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a department</DialogTitle>
          <DialogDescription>
            Departments own channels, members and agents. Their head is always a human.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <Field label="Name" htmlFor="department-name">
            <Input
              id="department-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Engineering"
            />
          </Field>
          <Field label="Slug" htmlFor="department-slug" hint="Used in URLs and on disk.">
            <Input
              id="department-slug"
              value={effectiveSlug}
              onChange={(event) => {
                setSlugTouched(true)
                setSlug(slugify(event.target.value))
              }}
              placeholder="engineering"
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Head" htmlFor="department-head" hint="Heads are humans.">
            <MemberSelect
              value={headUserId}
              only="user"
              placeholder="Pick a head"
              onSelect={(member) => {
                if (member.memberKind === 'user') setHead(member.memberId)
              }}
            />
          </Field>
          <Field label="Agent shape" hint="The silhouette every agent in this department wears.">
            <DepartmentShapePicker
              value={shape}
              seed={effectiveSlug === '' ? 'department' : effectiveSlug}
              auto={autoTrait(departments.data?.items ?? [])}
              onChange={setShape}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={name.trim() === '' || effectiveSlug === '' || createDepartment.isPending}
            >
              Create department
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
