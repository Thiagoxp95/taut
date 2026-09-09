import type { Avatar as AvatarValue, MemberKind } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'
import { AgentFigure, type OrbState } from '@/components/agent-figure'
import { PresenceDot } from '@/components/presence-dot'
import type { AgentFace } from '@/lib/agent-avatar'
import type { Presence } from '@/lib/live'

const SIZES = {
  sm: 'size-5 text-[11px] rounded-[5px]',
  md: 'size-8 text-base rounded-md',
  lg: 'size-10 text-xl rounded-lg',
  xl: 'size-16 text-3xl rounded-xl'
} as const

export type AvatarSize = keyof typeof SIZES

/** The same sizes in pixels, for the orb's canvas. Keep in step with `SIZES`. */
const PX: Record<AvatarSize, number> = { sm: 20, md: 32, lg: 40, xl: 64 }

/** `image` avatars are not served yet (no asset endpoint in the contract). */
function glyph(avatar: AvatarValue | undefined, fallback: string): string {
  if (avatar?.kind === 'emoji') return avatar.value
  return fallback.charAt(0).toUpperCase() || '·'
}

/**
 * An avatar. Humans get a framed tile with the emoji they picked. Agents are a
 * character, not a picture: a deterministic blobatar drawn from `face` (see
 * `@/lib/agent-avatar`) standing free of any frame — the frame is what marks a
 * human.
 *
 * The orb is not an ambient status light: it belongs to the reply the agent is
 * writing and nowhere else. Only a caller that is drawing that reply passes
 * `working`, and the creature then morphs into a thinking orb in its own colour
 * (`components/agent-figure.tsx`): the face granulates into particles in its own
 * fills, they gather onto the orb, and they carry it home again when it stops.
 * Sidebar rows, member lists, profile cards and pickers stay a still face however
 * busy the agent is.
 *
 * The silhouette is the agent's department and the rest of the creature is the
 * agent, so a channel of blobatars reads as an org chart before it reads as a
 * list of names.
 *
 * Always pass `face` for an agent. Without it the drawing falls back to `name`,
 * which is a different string from the seed and therefore a different agent,
 * shaped by nothing.
 */
export function EntityAvatar({
  avatar,
  kind = 'user',
  presence,
  working = false,
  orb = 'working',
  face,
  size = 'md',
  name = '',
  className
}: {
  /** Humans only — agents draw a blobatar and ignore it. */
  avatar?: AvatarValue
  kind?: MemberKind
  /** Humans only: the dot. Agents draw nothing for it. */
  presence?: Presence
  /**
   * Agents only: morph into the thinking orb. Reserved for the reply the agent
   * is writing — no other surface asks for it, so an agent is a still face
   * everywhere else.
   */
  working?: boolean
  /** Agents only: which orb to become while working. */
  orb?: OrbState
  /** Agents only: seed + department silhouette. Falls back to the name when unknown. */
  face?: AgentFace
  size?: AvatarSize
  name?: string
  className?: string
}) {
  const seed = face?.seed ?? name
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      {kind === 'agent' ? (
        <AgentFigure
          seed={seed}
          shape={face?.shape}
          state={orb}
          working={kind === 'agent' && working}
          px={PX[size]}
        />
      ) : (
        <span
          aria-hidden
          className={cn(
            'flex items-center justify-center bg-muted leading-none select-none',
            SIZES[size]
          )}
        >
          {glyph(avatar, name)}
        </span>
      )}
      {presence !== undefined && kind !== 'agent' ? (
        <PresenceDot presence={presence} ringed className="absolute -right-0.5 -bottom-0.5" />
      ) : null}
    </span>
  )
}
