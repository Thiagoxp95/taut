import type { AuthorizationRequest, MessageId } from '@taut/contract'
import { AuthorizationCard } from '@taut/ui/components/authorization-card'
import { RichText } from '@/components/rich-text'
import { useLookupMember } from '@/hooks/use-directory'
import { useAuthorizationAccess, useDecideAuthorization } from '@/lib/api'

export function MessageAuthorization({
  messageId,
  request
}: {
  messageId: MessageId
  request: AuthorizationRequest
}) {
  const access = useAuthorizationAccess(messageId, request.status === 'pending')
  const decide = useDecideAuthorization()
  const lookup = useLookupMember()
  const agentName = lookup(request.agentId)?.name ?? 'this agent'
  const decidedBy =
    request.decidedBy === undefined
      ? 'a department member'
      : (lookup(request.decidedBy)?.name ?? 'a department member')
  const statusText =
    request.status === 'approved'
      ? `Approved by ${decidedBy}. The mandate was updated.`
      : request.status === 'declined'
        ? `Declined by ${decidedBy}. The mandate was not changed.`
        : request.status === 'superseded'
          ? 'This proposal is outdated because the agent or its mandate changed. Ask for a new proposal.'
          : access.isPending
            ? 'Checking your permission…'
            : access.data?.canDecide
              ? 'Awaiting your approval. The current mandate stays in effect until approved.'
              : 'Awaiting authorization from a human in the agent’s department.'
  return (
    <AuthorizationCard
      title={`Update ${agentName}’s mandate`}
      description="Review the complete replacement below. Approving changes this agent’s standing instructions."
      status={request.status}
      statusText={statusText}
      canDecide={access.data?.canDecide === true}
      busy={decide.isPending}
      error={decide.error?.message ?? access.error?.message}
      onDecide={(decision) => decide.mutate({ messageId, decision })}
    >
      <p className="mb-2 text-xs font-medium text-muted-foreground">Proposed mandate</p>
      <div
        className="max-h-96 overflow-auto overscroll-contain break-words rounded-md border bg-background p-3"
        tabIndex={0}
        role="region"
        aria-label="Proposed mandate"
      >
        <RichText source={request.proposedMandate} />
      </div>
      <details className="mt-3 text-xs">
        <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
          View previous mandate
        </summary>
        <div
          className="mt-2 max-h-64 overflow-auto overscroll-contain break-words rounded-md border p-3"
          tabIndex={0}
          role="region"
          aria-label="Previous mandate"
        >
          {request.previousMandate.trim() === '' ? (
            'No previous mandate.'
          ) : (
            <RichText source={request.previousMandate} />
          )}
        </div>
      </details>
    </AuthorizationCard>
  )
}
