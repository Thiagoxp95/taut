import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { InlineMessageComponent } from '../src/components/message-component'
import { qk } from '../src/lib/query-keys'
import '../src/styles/globals.css'

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } }
})
client.setQueryData(qk.me, { user: { id: 'usr_fixture' } })
window.componentClient = client
window.componentRequests = []
window.componentQuestions = {
  kind: 'questions',
  title: 'Before I begin',
  recipientId: 'usr_fixture',
  status: 'pending',
  questions: [
    {
      id: '__proto__',
      question: 'How should I pace the work?',
      options: [{ label: 'Steady' }, { label: 'Fast' }]
    },
    {
      id: 'toString',
      question: 'What should I include?',
      multiSelect: true,
      options: [{ label: 'Design' }, { label: 'Code' }, { label: 'Tests' }]
    }
  ]
}
window.componentTimer = {
  kind: 'timer',
  title: 'Focus timer',
  durationSeconds: 120,
  endsAt: new Date(Date.now() + 120_000).toISOString(),
  signalId: 'sig_fixture',
  onComplete: 'Check progress and suggest the **next step**.'
}
window.fetch = async (input, options) => {
  const url = input instanceof Request ? input.url : String(input)
  if (!url.endsWith('/api/messages/msg_fixture/component/answer')) {
    throw new Error(`Unexpected test request: ${url}`)
  }
  const payload = JSON.parse(
    typeof options?.body === 'string'
      ? options.body
      : options?.body instanceof Uint8Array
        ? new TextDecoder().decode(options.body)
        : await input.text()
  )
  window.componentRequests.push(payload)
  if (window.componentFail) return Response.json({ message: 'Try again' }, { status: 500 })
  return Response.json({
    id: 'msg_fixture',
    companyId: 'cmp_fixture',
    channelId: 'chn_fixture',
    authorKind: 'agent',
    authorId: 'agt_fixture',
    body: '',
    status: 'sent',
    seq: 1,
    createdAt: '2026-09-10T12:00:00Z',
    component: {
      ...window.componentQuestions,
      status: 'answered',
      answers: payload.answers,
      answeredBy: 'usr_fixture',
      answeredAt: '2026-09-10T12:01:00Z'
    }
  })
}
let revision = 0
const root = createRoot(document.getElementById('root'))
window.renderComponents = () => {
  revision++
  root.render(
    <QueryClientProvider client={client}>
      <main className="max-w-2xl bg-background p-4 text-foreground">
        <InlineMessageComponent
          key={`questions-${revision}`}
          messageId="msg_fixture"
          component={window.componentQuestions}
        />
        <InlineMessageComponent
          key={`timer-${revision}`}
          messageId="msg_timer"
          component={window.componentTimer}
        />
        <InlineMessageComponent
          messageId="msg_card"
          component={{ kind: 'card', title: 'Next steps', body: 'Review the **result**.' }}
        />
      </main>
    </QueryClientProvider>
  )
}
window.renderComponents()
