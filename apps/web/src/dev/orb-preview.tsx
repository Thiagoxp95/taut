// TEMPORARY visual harness for the avatar morph. Delete after the browser pass.
// `?tick=1` runs the page off a timer and pretends the tab is visible, so the
// morph can be inspected while Chrome has the window occluded (rAF frozen).
if (new URLSearchParams(location.search).get('tick') === '1') {
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true })
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(performance.now()), 16)) as typeof window.requestAnimationFrame
}
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/globals.css'
import { EntityAvatar, type AvatarSize } from '@/components/entity-avatar'

const AGENTS = [
  { id: 'agent_bruno', face: { seed: 'bruno|Bruno|Engineer|', shape: 0.54 }, name: 'Bruno' },
  { id: 'agent_vera', face: { seed: 'vera|Vera|Researcher|', shape: 0.11 }, name: 'Vera' },
  { id: 'agent_wren', face: { seed: 'wren|Wren|Writer|', shape: 0.825 }, name: 'Wren' },
  { id: 'agent_kai', face: { seed: 'kai|Kai|Designer|', shape: 0.965 }, name: 'Kai' }
]
const SIZES: AvatarSize[] = ['sm', 'md', 'lg', 'xl']

function App() {
  const [working, setWorking] = React.useState(false)
  const [dark, setDark] = React.useState(false)
  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])
  return (
    <div className="min-h-screen bg-background p-8 text-foreground">
      <div className="mb-6 flex gap-3">
        <button
          id="toggle"
          className="rounded-md border px-3 py-1.5 text-sm"
          onClick={() => setWorking((value) => !value)}
        >
          {working ? 'working → idle' : 'idle → working'}
        </button>
        <button
          id="theme"
          className="rounded-md border px-3 py-1.5 text-sm"
          onClick={() => setDark((value) => !value)}
        >
          {dark ? 'dark' : 'light'}
        </button>
        <span className="self-center text-sm text-muted-foreground">
          state: {working ? 'working' : 'idle'}
        </span>
      </div>
      <div className="flex flex-col gap-6">
        {SIZES.map((size) => (
          <div key={size} className="flex items-center gap-8">
            <span className="w-8 text-xs text-muted-foreground">{size}</span>
            {AGENTS.map((agent) => (
              <div key={agent.id} className="flex items-center gap-2">
                <EntityAvatar kind="agent" face={agent.face} name={agent.name} size={size} />
                <span className="text-sm">{agent.name}</span>
              </div>
            ))}
          </div>
        ))}
        <div className="flex items-center gap-8">
          <span className="w-8 text-xs text-muted-foreground">orb</span>
          {(['working', 'composing', 'searching', 'breathing'] as const).map((orb) => (
            <div key={orb} className="flex items-center gap-2">
              <EntityAvatar
                kind="agent"
                working
                orb={orb}
                face={AGENTS[0]!.face}
                name="Bruno"
                size="lg"
              />
              <span className="text-sm">{orb}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
