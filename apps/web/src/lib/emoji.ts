import * as React from 'react'
import type { EmojiMartData } from '@emoji-mart/data'

/**
 * Shortcodes to characters: `:robot_face:` → 🤖.
 *
 * Linear (like Slack, like GitHub) stores an emoji as its name, and a name is
 * what its API returns for a project icon. The table that turns one into the
 * other is `@emoji-mart/data` — the same Slack-derived dataset emoji pickers use,
 * so a name Linear accepted resolves here.
 *
 * It is ~430 kB of JSON, so it is imported dynamically: nothing downloads it
 * until something on screen actually has a shortcode to draw, and the chunk is
 * fetched once per session.
 */

let table: Map<string, string> | undefined
let loading: Promise<Map<string, string>> | undefined

/**
 * Every name that can reach an emoji: its own id, the dataset's aliases, and both
 * separator spellings — Slack writes `man-raising-hand` and `robot_face`, and
 * which one a given emoji uses is not something a caller should have to know.
 */
const build = (data: EmojiMartData): Map<string, string> => {
  const map = new Map<string, string>()
  const put = (name: string, native: string) => {
    for (const key of [name, name.replace(/_/g, '-'), name.replace(/-/g, '_')]) {
      if (!map.has(key)) map.set(key, native)
    }
  }
  for (const [id, emoji] of Object.entries(data.emojis)) {
    const native = emoji.skins[0]?.native
    if (native !== undefined) put(id, native)
  }
  for (const [alias, id] of Object.entries(data.aliases)) {
    const native = data.emojis[id]?.skins[0]?.native
    if (native !== undefined) put(alias, native)
  }
  return map
}

const load = (): Promise<Map<string, string>> =>
  (loading ??= import('@emoji-mart/data').then((module) => {
    // The package ships `EmojiMartData` but declares no default export, while the
    // file it points at is the JSON itself. The cast is that gap, and nothing more.
    table = build((module as unknown as { readonly default: EmojiMartData }).default)
    return table
  }))

/**
 * What to render for one icon value. Returns `undefined` for anything that is not
 * an emoji — Linear also stores icon *names* like `Building`, and a card is better
 * with no icon than with the word "Building" where a picture should be.
 */
const resolve = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  const value = raw.trim()
  if (value === '') return undefined
  const name = value.startsWith(':') && value.endsWith(':') ? value.slice(1, -1) : value
  const found = table?.get(name)
  if (found !== undefined) return found
  // Not a name we know: an emoji character passes through, a word does not.
  return /^[\w+-]+$/.test(value) ? undefined : value
}

/**
 * A resolver that re-renders its component once the table has arrived. Every
 * caller shares one download; a component that mounts later gets it synchronously.
 */
export function useEmoji(): (raw: string | undefined) => string | undefined {
  const [, setReady] = React.useState(table !== undefined)
  React.useEffect(() => {
    if (table !== undefined) return
    let live = true
    void load().then(() => {
      if (live) setReady(true)
    })
    return () => {
      live = false
    }
  }, [])
  return resolve
}
