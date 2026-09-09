import { Effect } from 'effect'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { renderInstructions, writeInstructions } from '../src/instructions.js'
import { makeLocalProvider } from '../src/machine/local.js'
import { specFor, tempHome } from './helpers.js'

const agent = { name: 'Bruno', handle: 'bruno', role: 'Backend engineer', mandate: 'Ship it.\n' }
const skills = [
  { name: 'review-pr', description: 'Review pull requests', body: '# review-pr\nSteps…' },
  { name: 'deploy', description: 'Deploy to staging' }
]

describe('renderInstructions', () => {
  it('renders CLAUDE.md with @imports for skills and memory', () => {
    const out = renderInstructions({ kind: 'claude-code', agent, skills, memoryMd: '# memory' })
    expect(out.path).toBe('CLAUDE.md')
    expect(out.content).toContain('# Bruno (@bruno) — Backend engineer')
    expect(out.content).toContain('## Mandate\n\nShip it.')
    expect(out.content).toContain('@../../skills/review-pr/SKILL.md')
    expect(out.content).toContain('@../../skills/deploy/SKILL.md')
    expect(out.content).toContain('@../../memory/MEMORY.md')
    expect(out.content).not.toContain('Steps…') // imported, not inlined
  })

  it('flattens skills and memory into AGENTS.md for codex and opencode', () => {
    for (const kind of ['codex', 'opencode'] as const) {
      const out = renderInstructions({ kind, agent, skills, memoryMd: '# memory\n- likes tests' })
      expect(out.path).toBe('AGENTS.md')
      expect(out.content).toContain('### review-pr')
      expect(out.content).toContain('Steps…')
      expect(out.content).toContain('See `../../skills/deploy/SKILL.md`.')
      expect(out.content).toContain('- likes tests')
      expect(out.content).not.toContain('@../../')
    }
  })

  it('renders a cursor rule with frontmatter', () => {
    const out = renderInstructions({
      kind: 'cursor',
      agent,
      skills: [],
      homeFromWork: '/home/agent'
    })
    expect(out.path).toBe('.cursor/rules/taut.mdc')
    expect(out.content.startsWith('---\ndescription: Taut agent bruno')).toBe(true)
    expect(out.content).toContain('alwaysApply: true')
    expect(out.content).not.toContain('## Skills')
  })

  it('lists file grants in a "File access" section for every runtime', () => {
    const fileGrants = [
      { path: '/srv/shared', mode: 'ro' as const },
      { path: '/srv/scratch', mode: 'rw' as const }
    ]
    for (const kind of ['claude-code', 'codex', 'opencode', 'cursor'] as const) {
      const out = renderInstructions({ kind, agent, skills: [], fileGrants, extra: '## Taut\n\nx' })
      expect(out.content).toContain('## File access')
      expect(out.content).toContain('- `/srv/shared` (read-only)')
      expect(out.content).toContain('- `/srv/scratch` (read/write)')
      expect(out.content.indexOf('## File access')).toBeLessThan(out.content.indexOf('## Taut'))
    }
    const none = renderInstructions({ kind: 'codex', agent, skills: [], fileGrants: [] })
    expect(none.content).not.toContain('## File access')
  })

  it('lists repository worktrees, with the two rules on the read-write ones', () => {
    const repos = [
      {
        fullName: 'octocat/hello-world',
        path: '/home/agent/work/tsk_1/hello-world',
        mode: 'rw' as const,
        branch: 'taut/bruno/12345678',
        defaultBranch: 'main'
      },
      {
        fullName: 'octocat/docs',
        path: '/home/agent/work/tsk_1/docs',
        mode: 'ro' as const,
        branch: 'origin/trunk',
        defaultBranch: 'trunk'
      }
    ]
    for (const kind of ['claude-code', 'codex', 'opencode', 'cursor'] as const) {
      const out = renderInstructions({ kind, agent, skills: [], repos, extra: '## Taut\n\nx' })
      expect(out.content).toContain('## Repositories')
      expect(out.content).toContain('`/home/agent/work/tsk_1/hello-world`')
      expect(out.content).toContain('read-write, on branch `taut/bruno/12345678`')
      expect(out.content).toContain('never push `main`')
      expect(out.content).toContain('`github_open_pr`')
      expect(out.content).toContain('**octocat/docs**, read-only, detached at `origin/trunk`')
      expect(out.content.indexOf('## Repositories')).toBeLessThan(out.content.indexOf('## Taut'))
    }
  })

  it('says nothing at all about repositories when the task prepared none', () => {
    for (const kind of ['claude-code', 'codex', 'opencode', 'cursor'] as const) {
      expect(renderInstructions({ kind, agent, skills: [] }).content).not.toContain(
        '## Repositories'
      )
      expect(renderInstructions({ kind, agent, skills: [], repos: [] }).content).not.toContain(
        '## Repositories'
      )
    }
  })
})

describe('writeInstructions', () => {
  let home = ''
  let cleanup = async () => {}
  beforeAll(async () => ({ home, cleanup } = await tempHome()))
  afterAll(() => cleanup())

  it('writes the file into the task work dir through the machine', async () => {
    const provider = makeLocalProvider()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const machine = yield* provider.ensure(specFor(home))
        const workDir = join(machine.paths.home, 'work', 'tsk_1')
        return yield* writeInstructions(machine, workDir, { kind: 'claude-code', agent, skills })
      })
    )
    expect(result.path).toBe('CLAUDE.md')
    const onDisk = await readFile(join(home, 'work', 'tsk_1', 'CLAUDE.md'), 'utf8')
    expect(onDisk).toBe(result.content)
  })
})
