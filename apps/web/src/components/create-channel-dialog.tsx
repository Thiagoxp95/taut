import * as React from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { DepartmentId } from '@taut/contract'
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
import { Field } from '@/components/page'
import { useDepartmentList } from '@/hooks/use-directory'
import { useCreateChannel } from '@/lib/api'
import { slugify } from '@/lib/format'
import { parseDepartmentId } from '@/lib/ids'

export function CreateChannelDialog({
  open,
  onOpenChange,
  departmentId,
  departmentName
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  departmentId?: DepartmentId
  departmentName?: string
}) {
  const [name, setName] = React.useState('')
  const [picked, setPicked] = React.useState<DepartmentId | undefined>(undefined)
  const { departments } = useDepartmentList()
  const createChannel = useCreateChannel()
  const navigate = useNavigate()
  const slug = slugify(name)

  // The server scopes every channel to a department; only DMs live outside one.
  const owner = departmentId ?? picked ?? departments[0]?.id
  const ready = slug !== '' && owner !== undefined

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!ready) return
    createChannel.mutate(
      { name: slug, departmentId: owner },
      {
        onSuccess: (channel) => {
          onOpenChange(false)
          setName('')
          void navigate({ to: '/c/$channelId', params: { channelId: channel.id } })
        }
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a channel</DialogTitle>
          <DialogDescription>
            {departmentName === undefined
              ? 'Every channel belongs to a department; its head manages the members.'
              : `Belongs to ${departmentName}. Its head manages the members.`}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <Field label="Name" htmlFor="channel-name" hint={slug === '' ? undefined : `#${slug}`}>
            <Input
              id="channel-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="backend"
            />
          </Field>
          {departmentId === undefined ? (
            <Field
              label="Department"
              htmlFor="channel-department"
              hint={
                departments.length === 0
                  ? 'Create a department first — every channel belongs to one.'
                  : "Its head manages the channel's members."
              }
            >
              <Select
                value={owner}
                disabled={departments.length === 0}
                onValueChange={(next) => setPicked(parseDepartmentId(next))}
              >
                <SelectTrigger id="channel-department" className="w-full">
                  <SelectValue placeholder="Pick a department" />
                </SelectTrigger>
                <SelectContent>
                  {departments.map((department) => (
                    <SelectItem key={department.id} value={department.id}>
                      {department.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || createChannel.isPending}>
              Create channel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
