import type { AgentEvent } from '@taut/runtime'
import { withoutActivitySummary } from './activity.js'

/** One attempt's candidate answer. Nothing here is persisted before successful completion. */
export const makeReplyText = () => {
  let text = ''
  let messageId: string | undefined

  return {
    observe: (event: AgentEvent): void => {
      if (event.type === 'text_delta') {
        if (event.snapshot || (event.messageId !== undefined && event.messageId !== messageId)) {
          text = ''
        }
        messageId = event.messageId
        text += event.text
      } else if (event.type === 'tool_use' || event.type === 'tool_result') {
        // Text before a tool was progress. A tool-only run has no answer to publish.
        text = ''
        messageId = undefined
      }
    },
    finish: (ok: boolean, summary?: string): string | undefined => {
      if (!ok) return undefined
      // Claude/Cursor report their complete final answer in the result frame.
      const answer = withoutActivitySummary(summary?.trim() ? summary : text)
      return answer.trim() ? answer : undefined
    }
  }
}
