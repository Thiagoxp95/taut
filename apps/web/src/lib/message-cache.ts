/**
 * Surgical edits to the message caches.
 *
 * Channel pages come back newest-first (`messages.list`), thread pages
 * oldest-first (`messages.thread`), so "the newest message" lives at opposite
 * ends. Everything here is id-deduped: a message that arrives twice — once
 * from the POST response, once from the `message.created` event — lands once.
 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { Message } from '@taut/contract'

import { qk, type PageOf } from '@/lib/query-keys'

export type MessagePage = PageOf<Message>
export type MessagePages = InfiniteData<MessagePage, string | undefined>

const hasMessage = (data: MessagePages, id: string): boolean =>
  data.pages.some((page) => page.items.some((item) => item.id === id))

function insert(data: MessagePages, message: Message, at: 'head' | 'tail'): MessagePages {
  if (hasMessage(data, message.id)) return replace(data, message)
  const index = at === 'head' ? 0 : data.pages.length - 1
  const target = data.pages[index]
  if (target === undefined) {
    return { ...data, pages: [{ items: [message] }], pageParams: [undefined] }
  }
  const items = at === 'head' ? [message, ...target.items] : [...target.items, message]
  const pages = data.pages.map((page, i) => (i === index ? { ...page, items } : page))
  return { ...data, pages }
}

function replace(data: MessagePages, message: Message): MessagePages {
  let touched = false
  const pages = data.pages.map((page) => {
    if (!page.items.some((item) => item.id === message.id)) return page
    touched = true
    return { ...page, items: page.items.map((item) => (item.id === message.id ? message : item)) }
  })
  return touched ? { ...data, pages } : data
}

function drop(data: MessagePages, messageId: string): MessagePages {
  let touched = false
  const pages = data.pages.map((page) => {
    if (!page.items.some((item) => item.id === messageId)) return page
    touched = true
    return { ...page, items: page.items.filter((item) => item.id !== messageId) }
  })
  return touched ? { ...data, pages } : data
}

const edit =
  (f: (data: MessagePages) => MessagePages) =>
  (data: MessagePages | undefined): MessagePages | undefined =>
    data === undefined ? undefined : f(data)

/** A new message: newest end of its channel, or the tail of its thread. */
export function addMessage(queryClient: QueryClient, message: Message): void {
  if (message.threadId === undefined) {
    queryClient.setQueryData<MessagePages>(
      qk.messages(message.channelId),
      edit((data) => insert(data, message, 'head'))
    )
    return
  }
  queryClient.setQueryData<MessagePages>(
    qk.thread(message.threadId),
    edit((data) => insert(data, message, 'tail'))
  )
}

export function updateMessage(queryClient: QueryClient, message: Message): void {
  queryClient.setQueriesData<MessagePages>(
    { queryKey: qk.allMessages },
    edit((data) => replace(data, message))
  )
  queryClient.setQueriesData<MessagePages>(
    { queryKey: qk.allThreads },
    edit((data) => replace(data, message))
  )
}

export function removeMessage(queryClient: QueryClient, messageId: string): void {
  queryClient.setQueriesData<MessagePages>(
    { queryKey: qk.allMessages },
    edit((data) => drop(data, messageId))
  )
  queryClient.setQueriesData<MessagePages>(
    { queryKey: qk.allThreads },
    edit((data) => drop(data, messageId))
  )
  queryClient.removeQueries({ queryKey: qk.thread(messageId) })
}

/**
 * `agent.task.delta` only carries a `messageId`, so the growing reply is found
 * by scanning the loaded caches rather than by channel.
 *
 * The spread keeps every other field of the message — `attachments` included
 * (docs/build-plan-attachments.md): a streaming reply that already carries files
 * must not lose them between deltas.
 */
export function appendToMessage(queryClient: QueryClient, messageId: string, delta: string): void {
  const grow = edit((data) => {
    let touched = false
    const pages = data.pages.map((page) => {
      if (!page.items.some((item) => item.id === messageId)) return page
      touched = true
      return {
        ...page,
        items: page.items.map((item) =>
          item.id === messageId ? new Message({ ...item, body: item.body + delta }, true) : item
        )
      }
    })
    return touched ? { ...data, pages } : data
  })

  queryClient.setQueriesData<MessagePages>({ queryKey: qk.allMessages }, grow)
  queryClient.setQueriesData<MessagePages>({ queryKey: qk.allThreads }, grow)
}

/** Flatten an infinite result into oldest-first render order. */
export function flattenChannel(data: MessagePages | undefined): readonly Message[] {
  if (data === undefined) return []
  const out: Message[] = []
  for (const page of data.pages) out.push(...page.items)
  return out.reverse()
}

/** Threads already arrive oldest-first. */
export function flattenThread(data: MessagePages | undefined): readonly Message[] {
  if (data === undefined) return []
  const out: Message[] = []
  for (const page of data.pages) out.push(...page.items)
  return out
}
