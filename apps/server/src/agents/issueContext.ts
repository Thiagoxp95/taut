import type { IssueDetail } from '@taut/contract/domain'

/** How much of the ticket body travels with the prompt (docs/build-plan-issues.md D17). */
const DESCRIPTION_CHARS = 1_200

/** Linear's five priority words, so the block reads the way the ticket does. */
const PRIORITY_WORDS = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const

/**
 * The ticket an agent was woken about, in five lines at the top of its prompt
 * (docs/build-plan-issues.md D17).
 *
 * Without it the first thing every agent does in an issue thread is ask which
 * ticket this is — and the humans in that thread have the answer on screen, so
 * asking reads as not paying attention rather than as diligence.
 *
 * Deliberately not the whole `IssueDetail`: no sub-issue list, no comments, no
 * activity. This is the identity of the ticket and its current state, which is
 * what a reader needs to know what "it" refers to; everything else is a question
 * the agent can ask a tool for once it knows which ticket to ask about.
 *
 * ```
 * Ticket ENG-4636 — Development cycle. (In progress · Medium · @thiago · Chore)
 * Project: Standard procedures · Milestone: none · Due: none
 * https://linear.app/acme/issue/ENG-4636
 *
 * <description, ≤ 1 200 chars>
 * ---
 * ```
 */
export const issueContextBlock = (detail: IssueDetail): string => {
  const { issue, project } = detail
  const facts = [
    issue.state.name,
    PRIORITY_WORDS[issue.priority] ?? 'No priority',
    // The assignee is a Linear person, so this is their Linear name and not a
    // Taut `@handle` — writing it as one would invite the agent to `taut_send`
    // to somebody who may not be in this workspace at all.
    issue.assignee === undefined ? 'unassigned' : `@${issue.assignee.name}`,
    ...issue.labels.map((label) => label.name)
  ]
  const lines = [
    `Ticket ${issue.identifier} — ${issue.title} (${facts.join(' · ')})`,
    `Project: ${project.name} · Milestone: ${issue.milestoneName ?? 'none'} · Due: ${issue.dueDate ?? 'none'}`,
    issue.url
  ]
  const description = issue.description?.trim() ?? ''
  if (description !== '') {
    lines.push(
      '',
      description.length <= DESCRIPTION_CHARS
        ? description
        : `${description.slice(0, DESCRIPTION_CHARS)}…`
    )
  }
  lines.push('---')
  return lines.join('\n')
}
