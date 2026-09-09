/**
 * A remark plugin that lifts `@handle` out of ordinary text so the renderer can
 * draw it as a chip. Where a handle starts and ends is `lib/mentions.ts`, shared
 * with the composer so a draft highlights exactly what the sent message chips.
 *
 * Matches become nodes carrying `data.hName` / `hProperties` / `hChildren`,
 * which is the mdast → hast escape hatch: they land as
 * `<span data-mention="handle">@handle</span>` for `RichText` to style.
 */
import type { Nodes, Parent, PhrasingContent, Root, Text } from 'mdast'
import { SKIP, visit } from 'unist-util-visit'

import { mentionSegments } from '@/lib/mentions'

const mentionNode = (handle: string): PhrasingContent =>
  ({
    type: 'text',
    value: `@${handle}`,
    data: {
      hName: 'span',
      hProperties: { 'data-mention': handle },
      hChildren: [{ type: 'text', value: `@${handle}` }]
    }
  }) as PhrasingContent

/** Node types whose text is already special — never mention-ify inside them. */
const OPAQUE = new Set(['link', 'linkReference', 'inlineCode', 'code', 'definition'])

export function remarkMentions() {
  return (tree: Root): void => {
    visit(tree, 'text', (node: Text, index: number | undefined, parent: Parent | undefined) => {
      if (parent === undefined || index === undefined) return
      if (OPAQUE.has((parent as Nodes).type)) return SKIP

      const segments = mentionSegments(node.value)
      if (!segments.some((segment) => segment.handle !== undefined)) return

      const parts: PhrasingContent[] = segments.map((segment) =>
        segment.handle === undefined
          ? ({ type: 'text', value: segment.text } as PhrasingContent)
          : mentionNode(segment.handle)
      )

      parent.children.splice(index, 1, ...parts)
      return [SKIP, index + parts.length]
    })
  }
}
