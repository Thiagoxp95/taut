/**
 * Renders the agent's mandate + skills + memory into the runtime's native
 * instruction file (docs/agent-model.md §5 "At task start the adapter renders
 * AGENT.md + skills + memory/MEMORY.md into the runtime's native format").
 *
 * | runtime      | file (relative to the task work dir) | style                                  |
 * | ------------ | ------------------------------------ | -------------------------------------- |
 * | claude-code  | `CLAUDE.md`                          | `@<home>/skills/<n>/SKILL.md` imports  |
 * | codex        | `AGENTS.md`                          | flattened (skill bodies + memory inline)|
 * | opencode     | `AGENTS.md`                          | flattened                              |
 * | cursor       | `.cursor/rules/taut.mdc`             | flattened, `alwaysApply: true`         |
 *
 * The work dir is `<home>/work/<taskId>`, so the home is `../..` from it —
 * override `homeFromWork` if the layout differs.
 *
 * File grants (`agent_file_grants`) are listed in a "## File access" section for every
 * runtime: it is the only channel for cursor (no `--add-dir`, `--force` scopes nothing) and
 * complements `--add-dir` on claude-code / codex and `permission` in `opencode.json`.
 *
 * Repository grants get their own "## Repositories" section (docs/build-plan-repositories.md):
 * one line per worktree the task runner prepared. It is the only place the agent is told those
 * checkouts exist, and the only place the two `rw` rules are written down — never push the
 * default branch, open the pull request with `github_open_pr`. Nothing is emitted without
 * grants, so an agent with none reads exactly the file it read before (D14).
 */
import type { RuntimeKind } from '@taut/contract/domain'
import { Effect } from 'effect'
import { posix } from 'node:path'

import type { ExecFailed, Machine } from './machine/types.js'

export interface InstructionAgent {
  readonly name: string
  readonly handle: string
  readonly role: string
  /** Markdown; the contents of `AGENT.md`. */
  readonly mandate: string
}

export interface InstructionSkill {
  readonly name: string
  readonly description: string
  /** `SKILL.md` contents. Required for the flattened formats; optional for claude-code. */
  readonly body?: string
}

export interface InstructionFileGrant {
  /** Absolute, machine-visible path. */
  readonly path: string
  readonly mode: 'ro' | 'rw'
}

/**
 * One prepared worktree (`PreparedRepo` in `repos.ts`, flattened). `branch` is the task branch
 * for `rw` and `origin/<default>` — where the detached head sits — for `ro`.
 */
export interface InstructionRepo {
  /** `octocat/hello-world`. */
  readonly fullName: string
  /** Absolute, machine-visible path of the worktree. */
  readonly path: string
  readonly mode: 'ro' | 'rw'
  readonly branch: string
  readonly defaultBranch: string
}

export interface InstructionsInput {
  readonly kind: RuntimeKind
  readonly agent: InstructionAgent
  readonly skills: ReadonlyArray<InstructionSkill>
  /** `memory/MEMORY.md` contents, if any. */
  readonly memoryMd?: string
  /** Directories outside the home the agent may use (`agent_file_grants`). */
  readonly fileGrants?: ReadonlyArray<InstructionFileGrant>
  /** Worktrees prepared for this task (`agent_repos`). Omit or leave empty for no section. */
  readonly repos?: ReadonlyArray<InstructionRepo>
  /** Relative path from the work dir to the agent home. Default `../..`. */
  readonly homeFromWork?: string
  /** Extra markdown appended verbatim at the end (e.g. the server's Taut section). */
  readonly extra?: string
}

export interface RenderedInstructions {
  /** Relative to the task work dir. */
  readonly path: string
  readonly content: string
}

export const instructionsPath = (kind: RuntimeKind): string => {
  switch (kind) {
    case 'claude-code':
      return 'CLAUDE.md'
    case 'codex':
    case 'opencode':
      return 'AGENTS.md'
    case 'cursor':
      return '.cursor/rules/taut.mdc'
  }
}

const header = (agent: InstructionAgent): string =>
  `# ${agent.name} (@${agent.handle}) — ${agent.role}\n\n` +
  `You are ${agent.name}, an agent member of this company's Taut workspace. ` +
  `Your standing instructions (mandate) follow. Your home directory holds ` +
  `\`skills/\`, \`memory/\`, \`inbox/\` and \`work/\`; this task runs in its own \`work/\` folder.\n\n` +
  `## Mandate\n\n${agent.mandate.trim()}\n`

const skillsPath = (home: string, name: string): string =>
  posix.join(home, 'skills', name, 'SKILL.md')
const memoryPath = (home: string): string => posix.join(home, 'memory', 'MEMORY.md')

/** Same section for every runtime; empty when there are no grants. */
const renderFileAccess = (
  grants: ReadonlyArray<InstructionFileGrant> | undefined
): ReadonlyArray<string> =>
  grants === undefined || grants.length === 0
    ? []
    : [
        '## File access\n',
        "Besides your home and this task's work folder you may use these directories (granted in Taut). Leave every other path outside your home alone.\n",
        ...grants.map((g) => `- \`${g.path}\` (${g.mode === 'rw' ? 'read/write' : 'read-only'})`),
        ''
      ]

/**
 * Same section for every runtime; empty when the task prepared no worktree — including when a
 * repository was granted but its clone failed, which is why this reads the *prepared* set and
 * not the grants.
 */
const renderRepositories = (
  repos: ReadonlyArray<InstructionRepo> | undefined
): ReadonlyArray<string> =>
  repos === undefined || repos.length === 0
    ? []
    : [
        '## Repositories\n',
        'Each of these is a git worktree of a company repository, checked out for this task alone. Work in the worktree; never touch the clone it came from.\n',
        ...repos.map((r) =>
          r.mode === 'rw'
            ? `- \`${r.path}\` — **${r.fullName}**, read-write, on branch \`${r.branch}\` (branched from \`${r.defaultBranch}\`). Commit and push \`${r.branch}\`; never push \`${r.defaultBranch}\`, and open the pull request with the \`github_open_pr\` tool rather than by hand.`
            : `- \`${r.path}\` — **${r.fullName}**, read-only, detached at \`${r.branch}\`. Read it; do not commit or push.`
        ),
        ''
      ]

const renderClaude = (input: InstructionsInput, home: string): string => {
  const parts = [header(input.agent)]
  if (input.skills.length > 0) {
    parts.push('## Skills\n')
    for (const skill of input.skills) {
      parts.push(`- **${skill.name}** — ${skill.description}\n  @${skillsPath(home, skill.name)}`)
    }
    parts.push('')
  }
  if (input.memoryMd !== undefined) {
    parts.push('## Memory\n', `@${memoryPath(home)}`, '')
  }
  parts.push(...renderFileAccess(input.fileGrants))
  parts.push(...renderRepositories(input.repos))
  if (input.extra !== undefined) parts.push(input.extra.trim(), '')
  return parts.join('\n')
}

const renderFlat = (input: InstructionsInput, home: string): string => {
  const parts = [header(input.agent)]
  if (input.skills.length > 0) {
    parts.push('## Skills\n')
    for (const skill of input.skills) {
      parts.push(`### ${skill.name}\n\n${skill.description}\n`)
      if (skill.body !== undefined) parts.push(`${skill.body.trim()}\n`)
      else parts.push(`See \`${skillsPath(home, skill.name)}\`.\n`)
    }
  }
  if (input.memoryMd !== undefined) {
    parts.push('## Memory\n', `${input.memoryMd.trim()}\n`)
  }
  parts.push(...renderFileAccess(input.fileGrants))
  parts.push(...renderRepositories(input.repos))
  if (input.extra !== undefined) parts.push(`${input.extra.trim()}\n`)
  return parts.join('\n')
}

const renderCursor = (input: InstructionsInput, home: string): string =>
  `---\ndescription: Taut agent ${input.agent.handle} — mandate, skills and memory\nalwaysApply: true\n---\n\n` +
  renderFlat(input, home)

export const renderInstructions = (input: InstructionsInput): RenderedInstructions => {
  const home = input.homeFromWork ?? '../..'
  const path = instructionsPath(input.kind)
  switch (input.kind) {
    case 'claude-code':
      return { path, content: renderClaude(input, home) }
    case 'codex':
    case 'opencode':
      return { path, content: renderFlat(input, home) }
    case 'cursor':
      return { path, content: renderCursor(input, home) }
  }
}

/** Render and write into `workDir` (machine-visible) via `machine.putFile`. */
export const writeInstructions = (
  machine: Machine,
  workDir: string,
  input: InstructionsInput
): Effect.Effect<RenderedInstructions, ExecFailed> => {
  const rendered = renderInstructions(input)
  return machine
    .putFile(posix.join(workDir, rendered.path), rendered.content)
    .pipe(Effect.as(rendered))
}
