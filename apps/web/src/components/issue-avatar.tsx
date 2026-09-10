import * as React from 'react'
import { UserIcon } from '@taut/ui/components/icons'
import type { IssueAssignee } from '@taut/contract'
import { useLinearUsers } from '@/lib/api'
import { MemberProfileTrigger } from '@/components/profile-card'
import { cn } from '@taut/ui/lib/utils'

/**
 * A person as *Linear* knows them (docs/build-plan-issues.md D11).
 *
 * Deliberately not `EntityAvatar`. That one draws a Taut member — a framed emoji
 * tile for a human, a blobatar for an agent — and the people on a mirrored ticket
 * are neither: an assignee, a creator, a history actor and the author of a Linear
 * comment are all Linear accounts, most of which map to nobody in Taut
 * (docs/build-plan-projects.md D15/D16). Drawing them as Taut members would say
 * they are, which is the same lie D11 refuses to tell about a comment.
 *
 * So it is Linear's own avatar: the account's picture when Linear has one, its
 * initials on the flat disc Linear falls back to otherwise, and the dashed
 * silhouette Linear draws for nobody at all. The placeholder is drawn rather than
 * left out so a column of rows keeps one straight edge, exactly as the priority
 * glyph does in the issues list.
 *
 * Sized in exact pixels because it is used at three of Linear's sizes: 16px in a
 * history row, 20px in a list row, 22px in the properties rail.
 */
function IssueAvatarVisual({
  person,
  px = 20,
  className
}: {
  /** Absent is a real value: unassigned, or a change Linear credits to no one. */
  person: IssueAssignee | undefined
  px?: number
  className?: string
}) {
  const [broken, setBroken] = React.useState(false)
  const size = { width: `${px}px`, height: `${px}px` }

  if (person === undefined) {
    return (
      <span
        title="Unassigned"
        style={size}
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground/60',
          className
        )}
      >
        <UserIcon size={Math.round(px * 0.6)} />
      </span>
    )
  }

  if (person.avatarUrl !== undefined && !broken) {
    return (
      <img
        src={person.avatarUrl}
        alt={person.name}
        title={person.name}
        loading="lazy"
        style={size}
        onError={() => setBroken(true)}
        className={cn('shrink-0 rounded-full object-cover', className)}
      />
    )
  }

  // `Ada Lovelace` → `AL`, `ada@acme.com` → `AC`: the same split the mention
  // index uses, so a person reads the same wherever Taut draws them.
  const initials = person.name
    .split(/[\s@.]+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

  return (
    <span
      title={person.name}
      style={{ ...size, fontSize: `${Math.max(9, Math.round(px * 0.45))}px` }}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-rose-400/80 font-medium text-background',
        className
      )}
    >
      {initials}
    </span>
  )
}

/** An explicit Linear mapping enables the same profile actions as a workspace avatar. */
export function IssueAvatar(props: React.ComponentProps<typeof IssueAvatarVisual>) {
  const users = useLinearUsers().data?.items
  const memberId = users?.find((user) => user.linearId === props.person?.linearId)?.member
  const avatar = <IssueAvatarVisual {...props} />
  return memberId === undefined ? (
    avatar
  ) : (
    <MemberProfileTrigger memberId={memberId}>{avatar}</MemberProfileTrigger>
  )
}
