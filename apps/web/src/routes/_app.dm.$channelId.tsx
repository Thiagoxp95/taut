import { Link, createFileRoute } from '@tanstack/react-router'
import { BotIcon } from 'lucide-react'
import { Button } from '@taut/ui/components/button'
import { ChannelView } from '@/components/channel-view'
import { EntityAvatar } from '@/components/entity-avatar'
import { presenceLabel } from '@/components/presence-dot'
import { useDmView } from '@/hooks/use-directory'
import { parseMessageId } from '@/lib/ids'
import { usePresence } from '@/lib/live'
import { RUNTIME_LABELS } from '@/lib/runtime-meta'

export interface DmSearch {
  readonly thread?: string
  /** A message to scroll to and flash — where a ⌘K search hit lands. */
  readonly at?: string
}

function DirectMessageRoute() {
  const { channelId } = Route.useParams()
  const { thread, at } = Route.useSearch()
  const view = useDmView(channelId)
  const partner = view?.partner
  const presence = usePresence(partner?.id, partner?.defaultPresence ?? 'offline')

  const name = partner?.name ?? view?.label ?? 'Direct message'
  const handle = partner?.handle ?? view?.label ?? channelId
  const avatar = partner?.avatar ?? { kind: 'emoji' as const, value: '💬' }
  const agent = partner?.kind === 'agent' ? partner.agent : undefined

  return (
    <ChannelView
      channel={view?.channel}
      title={name}
      subtitle={
        partner === undefined
          ? 'Direct message'
          : agent === undefined
            ? `${partner.subtitle} · ${presenceLabel(presence)}`
            : `${agent.role || 'Agent'} · ${RUNTIME_LABELS[agent.runtimeKind]} · ${presenceLabel(presence)}`
      }
      headerAvatar={
        <EntityAvatar
          avatar={avatar}
          kind={partner?.kind ?? 'user'}
          face={partner?.face}
          name={name}
          presence={presence}
          size="md"
        />
      }
      headerActions={
        agent === undefined ? null : (
          <Button asChild variant="ghost" size="sm">
            <Link to="/agents/$agentId" params={{ agentId: agent.id }}>
              <BotIcon />
              Agent profile
            </Link>
          </Button>
        )
      }
      intro={
        agent === undefined
          ? `This is the start of your direct message history with ${name}.`
          : `This is your direct line to @${handle}${agent.role === '' ? '' : `, ${agent.role.toLowerCase()}`}. Anything you send here runs on the company's ${RUNTIME_LABELS[agent.runtimeKind]} pool.`
      }
      threadId={parseMessageId(thread)}
      focusMessageId={parseMessageId(at)}
    />
  )
}

export const Route = createFileRoute('/_app/dm/$channelId')({
  validateSearch: (search: Record<string, unknown>): DmSearch => ({
    thread: typeof search.thread === 'string' ? search.thread : undefined,
    at: typeof search.at === 'string' ? search.at : undefined
  }),
  component: DirectMessageRoute
})
