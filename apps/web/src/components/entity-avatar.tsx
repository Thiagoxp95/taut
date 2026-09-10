import type { ComponentProps } from 'react'
import { AvatarVisual } from '@/components/avatar-visual'
import { MemberProfileTrigger } from '@/components/profile-card'

export { AvatarContext, type AvatarSize } from '@/components/avatar-visual'

/** Every saved member uses the same profile interaction; previews remain visual only. */
export function EntityAvatar({
  memberId,
  onProfileNavigate,
  ...props
}: ComponentProps<typeof AvatarVisual> & {
  memberId?: string | undefined
  onProfileNavigate?: (() => void) | undefined
}) {
  const avatar = <AvatarVisual {...props} />
  return memberId === undefined ? (
    avatar
  ) : (
    <MemberProfileTrigger memberId={memberId} onNavigate={onProfileNavigate}>
      {avatar}
    </MemberProfileTrigger>
  )
}
