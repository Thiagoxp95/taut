/**
 * Agent home layout (docs/agent-model.md §5):
 *
 * ```
 * <home>/
 * ├── AGENT.md      rendered from `mandate` by the server; a placeholder is created if absent
 * ├── skills/       <name>/SKILL.md
 * ├── memory/       MEMORY.md, memory.db, notes/, files/
 * ├── inbox/        attachments humans send it
 * ├── work/         one folder per task; runtime cwd
 * ├── repos/        <owner>__<name>/ — a pristine clone per granted repository, never worked in
 * │                 (docs/build-plan-repositories.md D5); every task worktrees out of it
 * └── .taut/        audit.log, home/ (local HOME), claude/ (CLAUDE_CONFIG_DIR), codex/ (CODEX_HOME)
 * ```
 */
import { Effect } from 'effect'
import { chown, mkdir, open, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const HOME_DIRS = ['skills', 'memory', 'inbox', 'work', 'repos', '.taut'] as const

/** Sub-paths under `.taut/`, relative to the home. */
export const TAUT_PATHS = {
  /** `$HOME` for processes on the `local` provider (keeps host dotfiles out). */
  localHome: '.taut/home',
  /** `CLAUDE_CONFIG_DIR`. */
  claudeConfig: '.taut/claude',
  /** `CODEX_HOME`. */
  codexHome: '.taut/codex',
  auditLog: '.taut/audit.log'
} as const

export const AGENT_MD_PLACEHOLDER = `# AGENT.md

This file is rendered by Taut from the agent's mandate. Edit it here or in the
Taut UI — Taut keeps both sides in sync.
`

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

/** The uid/gid the docker agent runs as (`User: "1000:1000"`). */
export const AGENT_UID = 1000
export const AGENT_GID = 1000

export interface EnsureHomeOptions {
  /** chown the tree to 1000:1000 (best-effort, Linux only; needed for the docker bind mount). */
  readonly chownToAgent?: boolean
}

/** Create the layout above. Idempotent; never overwrites existing files. */
export const ensureHomeLayout = (
  homeDir: string,
  options: EnsureHomeOptions = {}
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      const created: Array<string> = []
      const mk = async (path: string) => {
        if (!(await exists(path))) created.push(path)
        await mkdir(path, { recursive: true })
      }
      await mk(homeDir)
      for (const dir of HOME_DIRS) await mk(join(homeDir, dir))
      for (const rel of [TAUT_PATHS.localHome, TAUT_PATHS.claudeConfig, TAUT_PATHS.codexHome]) {
        await mk(join(homeDir, rel))
      }
      const agentMd = join(homeDir, 'AGENT.md')
      if (!(await exists(agentMd))) {
        await writeFile(agentMd, AGENT_MD_PLACEHOLDER, 'utf8')
        created.push(agentMd)
      }
      const audit = join(homeDir, TAUT_PATHS.auditLog)
      if (!(await exists(audit))) {
        const fh = await open(audit, 'a')
        await fh.close()
        created.push(audit)
      }
      if (options.chownToAgent === true && process.platform === 'linux') {
        for (const path of created) {
          await chown(path, AGENT_UID, AGENT_GID).catch(() => undefined)
        }
      }
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(`ensureHomeLayout(${homeDir}): ${String(cause)}`)
  })
