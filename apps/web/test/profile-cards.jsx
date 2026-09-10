import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  Outlet
} from '@tanstack/react-router'
import { ContextMeter } from '../src/components/context-meter'
import { IssueAvatar } from '../src/components/issue-avatar'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@taut/ui/components/dialog'
import { EntityAvatar } from '../src/components/entity-avatar'
import { ProfilePopover } from '../src/components/profile-card'
import { HuddleProvider } from '../src/hooks/use-huddle'
import { qk } from '../src/lib/query-keys'
import '../src/styles/globals.css'

const user = {
  id: 'usr_ada',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  avatar: { kind: 'emoji', value: '👩🏻' }
}
const me = {
  id: 'usr_me',
  name: 'Grace Hopper',
  email: 'grace@example.test',
  avatar: { kind: 'emoji', value: '👩🏼' }
}
const agent = {
  id: 'agt_bruno',
  name: 'Bruno',
  handle: 'bruno',
  role: 'Software engineer',
  avatar: { kind: 'emoji', value: '🤖' },
  runtimeKind: 'claude-code',
  status: 'active',
  departmentIds: ['dep_eng']
}
const department = { id: 'dep_eng', name: 'Engineering', headUserId: me.id }
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } }
})
client.setQueryData(qk.me, {
  user: me,
  activeCompanyId: 'cmp_test',
  memberships: [{ company: { id: 'cmp_test' }, role: 'owner' }]
})
client.setQueryData([...qk.members, 'cmp_test'], {
  items: [
    { user, role: 'member' },
    { user: me, role: 'owner' }
  ]
})
client.setQueryData(qk.agents, { items: [agent] })
client.setQueryData(qk.departments, { items: [department] })
client.setQueryData(qk.department(department.id), {
  department,
  members: [{ memberKind: 'user', memberId: user.id }]
})
client.setQueryData(qk.agent(agent.id), {
  agent,
  skills: [
    { name: 'code-review', description: 'Review code', state: 'active' },
    { name: 'pending-skill', state: 'pending' }
  ]
})
client.setQueryData(qk.channels, { items: [] })
client.setQueryData(qk.callsConfig, { enabled: true })
client.setQueryData(qk.activeCalls, [])
client.setQueryData(qk.linearUsers, { items: [{ linearId: 'linear-ada', member: user.id }] })
window.profileClient = client
window.profileRequests = []
navigator.mediaDevices.getUserMedia = async () => {
  throw new DOMException('No devices in profile tests', 'NotAllowedError')
}
navigator.mediaDevices.enumerateDevices = async () => []
window.fetch = async (input, options) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url.endsWith('/api/channels/dm')) {
    const payload = JSON.parse(
      typeof options?.body === 'string'
        ? options.body
        : options?.body instanceof Uint8Array
          ? new TextDecoder().decode(options.body)
          : await input.text()
    )
    window.profileRequests.push(payload)
    return Response.json({
      id: 'chn_testdm',
      companyId: 'cmp_test',
      name: 'Direct message',
      kind: 'dm',
      createdAt: '2026-09-10T12:00:00Z'
    })
  }
  throw new Error(`Unexpected test request: ${url}`)
}
function Fixture() {
  const [modal, setModal] = React.useState(false)
  return (
    <main className="flex min-h-screen flex-wrap content-start items-start gap-12 bg-background p-24 text-foreground">
      <div data-testid="human">
        <EntityAvatar memberId={user.id} name={user.name} avatar={user.avatar} size="lg" />
      </div>
      <div data-testid="agent">
        <EntityAvatar memberId={agent.id} kind="agent" name={agent.name} size="lg" />
      </div>
      <div data-testid="self">
        <EntityAvatar memberId={me.id} name={me.name} avatar={me.avatar} size="lg" />
      </div>
      <ProfilePopover handle="ada">@ada</ProfilePopover>
      <button
        data-testid="parent"
        onClick={() => {
          window.parentClicked = true
        }}
      >
        <EntityAvatar memberId={agent.id} kind="agent" name={agent.name} />
      </button>
      <button data-testid="modal-open" onClick={() => setModal(true)}>
        Open member dialog
      </button>
      <Dialog open={modal} onOpenChange={setModal}>
        <DialogContent>
          <DialogTitle>Member dialog</DialogTitle>
          <DialogDescription>Profile navigation test</DialogDescription>
          <div data-testid="modal-agent">
            <EntityAvatar
              memberId={agent.id}
              kind="agent"
              name={agent.name}
              onProfileNavigate={() => setModal(false)}
            />
          </div>
        </DialogContent>
      </Dialog>
      <div data-testid="context">
        <ContextMeter
          context={{
            usedTokens: 10000,
            maxTokens: 100000,
            runtime: 'claude-code',
            compactsAutomatically: true,
            compacting: false
          }}
        >
          <EntityAvatar memberId={agent.id} kind="agent" name={agent.name} />
        </ContextMeter>
      </div>
      <div data-testid="linear">
        <IssueAvatar person={{ linearId: 'linear-ada', name: 'Ada in Linear' }} />
      </div>
      <div data-testid="unknown">
        <EntityAvatar name="Unknown member" />
      </div>
    </main>
  )
}
const root = createRootRoute({ component: Outlet })
const home = createRoute({ getParentRoute: () => root, path: '/', component: Fixture })
const dm = createRoute({
  getParentRoute: () => root,
  path: '/dm/$channelId',
  component: () => <p>DM destination</p>
})
const config = createRoute({
  getParentRoute: () => root,
  path: '/agents/$agentId',
  component: () => <p>Agent configuration destination</p>
})
const router = createRouter({
  routeTree: root.addChildren([home, dm, config]),
  history: createMemoryHistory({ initialEntries: ['/'] })
})
window.profileRouter = router
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}>
    <HuddleProvider>
      <RouterProvider router={router} />
    </HuddleProvider>
  </QueryClientProvider>
)
