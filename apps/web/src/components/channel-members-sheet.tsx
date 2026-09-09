import { UserMinusIcon, UsersIcon } from 'lucide-react'
import type { Channel } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@taut/ui/components/sheet'
import { EmptyState } from '@/components/page'
import { EntityAvatar } from '@/components/entity-avatar'
import { MemberPicker } from '@/components/member-picker'
import { useLookupMember } from '@/hooks/use-directory'
import { useAddChannelMember, useChannelMembers, useRemoveChannelMember } from '@/lib/api'

export function ChannelMembersSheet({
  channel,
  open,
  onOpenChange
}: {
  channel: Channel
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const members = useChannelMembers(channel.id)
  const lookup = useLookupMember()
  const addMember = useAddChannelMember()
  const removeMember = useRemoveChannelMember()

  const items = members.data?.items ?? []
  const present = new Set(items.map((member) => member.memberId))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 p-0">
        <SheetHeader className="border-b">
          <SheetTitle>Members of #{channel.name}</SheetTitle>
          <SheetDescription>
            {items.length} {items.length === 1 ? 'member' : 'members'}. Agents only see channels
            they belong to.
          </SheetDescription>
        </SheetHeader>

        <div className="taut-scroll min-h-0 flex-1 overflow-y-auto p-4">
          {items.length === 0 ? (
            <EmptyState
              icon={<UsersIcon className="size-5" />}
              title="No members yet"
              description="Add the people and agents who should see this channel."
            />
          ) : (
            <ul className="divide-y rounded-lg border">
              {items.map((member) => {
                const entry = lookup(member.memberId)
                return (
                  <li key={member.memberId} className="flex items-center gap-3 px-3 py-2">
                    <EntityAvatar
                      avatar={entry?.avatar ?? { kind: 'emoji', value: '👤' }}
                      kind={member.memberKind}
                      face={entry?.face}
                      name={entry?.name ?? member.memberId}
                      size="md"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{entry?.name ?? 'Unknown'}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        @{entry?.handle ?? member.memberId}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${entry?.name ?? 'member'}`}
                      onClick={() =>
                        removeMember.mutate({
                          channelId: channel.id,
                          memberKind: member.memberKind,
                          memberId: member.memberId
                        })
                      }
                    >
                      <UserMinusIcon />
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="flex justify-end border-t p-4">
          <MemberPicker
            exclude={present}
            onSelect={(member) => addMember.mutate({ channelId: channel.id, ...member })}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
