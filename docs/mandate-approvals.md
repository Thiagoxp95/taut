# Mandate approvals

A human in an agent’s department can ask the agent to revise its mandate in a DM or channel thread. The agent discusses the changes and calls `mandate_propose` with the complete Markdown replacement. A permission card appears in the conversation with the proposed mandate, an expandable previous mandate, and **Approve** / **Decline** actions.

The server derives the agent, requester and conversation from the verified task token. Agent-authored requests, autonomous runs, routines, signals, handoffs and requests from outside the agent’s departments cannot create a proposal. The tool can only propose a change to its own agent.

Only a signed-in human who can read the conversation and shares a department with the agent may decide. The original requester’s department membership is rechecked as well. A decision submits only `approve` or `decline`; it cannot replace the stored preview. Ordinary message creation and edits cannot set or alter permission-card data, and agent bearer tokens cannot call the decision endpoint.

Approval updates the exact saved mandate, rewrites `AGENT.md`, clears previous runtime sessions and broadcasts the updated agent and message. A reply completing with the old mandate cannot restore its old session. Decline leaves the mandate unchanged. Decisions are serialized: repeat or competing decisions receive a conflict. A proposal whose previous mandate no longer matches, or whose agent was archived, becomes outdated when approval is attempted.

Cards and their decisions are persisted with the message and replay through the existing message events. They survive reloads and retain the deciding human and timestamp.

## Reuse

`packages/ui/src/components/authorization-card.tsx` is a presentation component with a title, description, arbitrary preview children, decision callbacks, access/busy/error state and a status description. It does not depend on mandates, HTTP, or the application’s domain types. Other tools can reuse it with their own previews and authorization rules.

`AuthorizationRequest` is currently the `mandate.update` action. Future actions should extend it as a discriminated union and provide their own server-side validation and execution in `Authorizations`; they should not accept arbitrary tool execution instructions from the browser.

## Validation

- `pnpm --filter @taut/server exec vitest run test/mandate-approvals.test.ts`
- `pnpm --filter @taut/taut-mcp exec vitest run test/mandate.test.ts`
- Browser: review, approve, decline and reload a card; inspect at desktop and mobile widths.
