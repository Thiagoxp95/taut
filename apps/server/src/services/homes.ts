import { FileSystem, Path } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { SqlClient } from '@effect/sql'
import type { FileEntry } from '@taut/contract/api'
import { Forbidden, NotFound, Validation } from '@taut/contract/errors'
import { CompanyId } from '@taut/contract/ids'
import { DateTime, Effect, Option, Schema } from 'effect'
import { join } from 'node:path'
import { AppConfig } from '../config.js'
import { findOne } from '../db/sql.js'

/** Sub-folders every agent home starts with (docs/agent-model.md §5 "Home folder"). */
export const HOME_DIRS = ['skills', 'inbox', 'work', 'memory', 'repos', '.taut'] as const
export const AGENT_MD = 'AGENT.md'
export const SKILL_MD = 'SKILL.md'
export const AUDIT_LOG = join('.taut', 'audit.log')
/**
 * Where a skill waits for a human (docs/build-plan-skills.md D7). Under `.taut/`, so the gate is
 * a fact about the filesystem and not only a `WHERE` clause: nothing that renders instructions
 * ever walks in here. Created on demand, so it is deliberately not in `HOME_DIRS`.
 */
export const PENDING_SKILLS = join('.taut', 'pending-skills')

/** The two places a skill's files can live: in use, or waiting to be approved. */
export const skillDirOf = (name: string, pending: boolean): string =>
  pending ? join(PENDING_SKILLS, name) : join('skills', name)

/**
 * `<dataDir>/companies/<slug>/agents/<handle>` — the agent's home folder. Pure, so
 * `@taut/runtime` and tests can compute it without the service. Phase 4 mounts this at
 * `/home/agent` (docs/agent-model.md §7).
 */
export const agentHomePath = (dataDir: string, companySlug: string, handle: string): string =>
  join(dataDir, 'companies', companySlug, 'agents', handle)

export interface AgentMdSource {
  readonly name: string
  readonly handle: string
  readonly role: string
  readonly mandate: string
}

/** `AGENT.md`: the mandate is the body; name/handle/role are a small header. */
export const renderAgentMd = (a: AgentMdSource): string =>
  `# ${a.name} (@${a.handle})\n\n${a.role.trim() === '' ? '' : `> ${a.role.trim()}\n\n`}${a.mandate.trim()}\n`

/** `skills/<name>/SKILL.md` with the frontmatter Claude Code / Codex expect. */
export const renderSkillMd = (name: string, description: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`

/** Inverse of `renderSkillMd`: drop a leading `---\n…\n---\n` block, keep the body. */
export const stripFrontmatter = (md: string): string => {
  const normalise = (body: string): string =>
    body.trim() === '' ? '' : body.replace(/\n+$/, '') + '\n'
  if (!md.startsWith('---\n')) return normalise(md)
  const end = md.indexOf('\n---', 4)
  if (end === -1) return ''
  return normalise(md.slice(end + 4).replace(/^\r?\n+/, ''))
}

const isEscaping = (relative: string, sep: string): boolean =>
  relative === '..' || relative.startsWith(`..${sep}`) || relative.startsWith('/')

const toPosix = (p: string): string => p.split('\\').join('/')

/**
 * Everything that touches an agent's home on disk. Every path goes through
 * `resolveInside`, which rejects absolute paths, `..` and symlink escapes with
 * `Forbidden`. Infrastructure failures (permissions, disk) are defects.
 */
export class AgentHomes extends Effect.Service<AgentHomes>()('AgentHomes', {
  effect: Effect.gen(function* () {
    const config = yield* AppConfig
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const sql = yield* SqlClient.SqlClient

    const io = <A>(effect: Effect.Effect<A, PlatformError>): Effect.Effect<A> =>
      Effect.orDie(effect)

    const slugOf = findOne({
      Request: CompanyId,
      Result: Schema.Struct({ slug: Schema.String }),
      execute: (id) => sql`SELECT slug FROM companies WHERE id = ${id}`
    })

    /** Absolute home folder of `handle` in `companyId`. The company must exist. */
    const homeOf = (companyId: CompanyId, handle: string): Effect.Effect<string> =>
      slugOf(companyId).pipe(
        Effect.flatMap(Effect.orDie),
        Effect.map(({ slug }) => agentHomePath(config.dataDir, slug, handle))
      )

    const ensureLayout = (home: string): Effect.Effect<void> =>
      Effect.forEach(
        HOME_DIRS,
        (dir) => io(fs.makeDirectory(path.join(home, dir), { recursive: true })),
        { discard: true }
      )

    /**
     * `home/rel` as an absolute path, or `Forbidden` when `rel` is absolute, walks out
     * through `..`, or its deepest existing ancestor is a symlink pointing outside `home`.
     */
    const resolveInside = (home: string, rel: string): Effect.Effect<string, Forbidden> =>
      Effect.gen(function* () {
        const forbidden = new Forbidden({ message: `Path "${rel}" is outside the agent home` })
        if (rel.includes('\0') || path.isAbsolute(rel) || rel.startsWith('\\'))
          return yield* forbidden
        const target = path.resolve(home, rel)
        if (isEscaping(path.relative(home, target), path.sep)) return yield* forbidden

        yield* io(fs.makeDirectory(home, { recursive: true }))
        const realHome = yield* io(fs.realPath(home))
        let probe = target
        while (!(yield* io(fs.exists(probe)))) {
          const parent = path.dirname(probe)
          if (parent === probe) break
          probe = parent
        }
        const realProbe = yield* io(fs.realPath(probe))
        if (realProbe !== realHome && isEscaping(path.relative(realHome, realProbe), path.sep))
          return yield* forbidden
        return target
      })

    const writeAgentMd = (home: string, agent: AgentMdSource): Effect.Effect<void> =>
      ensureLayout(home).pipe(
        Effect.zipRight(io(fs.writeFileString(path.join(home, AGENT_MD), renderAgentMd(agent))))
      )

    /** `.taut/agent.json`: ids the runtime needs to talk back to the server. */
    const writeMeta = (home: string, meta: Record<string, string>): Effect.Effect<void> =>
      io(
        fs.writeFileString(
          path.join(home, '.taut', 'agent.json'),
          JSON.stringify(meta, null, 2) + '\n'
        )
      )

    const writeSkill = (
      home: string,
      name: string,
      description: string,
      body: string
    ): Effect.Effect<string, Forbidden> =>
      Effect.gen(function* () {
        const dir = yield* resolveInside(home, path.join('skills', name))
        yield* io(fs.makeDirectory(dir, { recursive: true }))
        const file = path.join(dir, SKILL_MD)
        yield* io(fs.writeFileString(file, renderSkillMd(name, description, body)))
        return file
      })

    /**
     * A skill installed from somewhere else is a **directory**, not a file (D5): the real ones
     * ship `references/`, `scripts/` and per-agent config next to `SKILL.md`, and a skill that
     * loses them is broken. The directory is replaced wholesale so a file upstream deleted does
     * not linger, and every sibling path is re-checked through `resolveInside` — a tarball is a
     * stranger's idea of what your filesystem should look like.
     */
    const writeSkillDir = (
      home: string,
      name: string,
      skill: {
        readonly description: string
        readonly body: string
        readonly files: ReadonlyArray<{ readonly path: string; readonly contents: string }>
      },
      options: { readonly pending?: boolean } = {}
    ): Effect.Effect<string, Forbidden> =>
      Effect.gen(function* () {
        const rel = skillDirOf(name, options.pending === true)
        const dir = yield* resolveInside(home, rel)
        yield* io(fs.remove(dir, { recursive: true, force: true }))
        yield* io(fs.makeDirectory(dir, { recursive: true }))
        yield* io(
          fs.writeFileString(
            path.join(dir, SKILL_MD),
            renderSkillMd(name, skill.description, skill.body)
          )
        )
        yield* Effect.forEach(
          skill.files,
          (file) =>
            Effect.gen(function* () {
              if (toPosix(file.path).toUpperCase() === SKILL_MD.toUpperCase()) return
              const target = yield* resolveInside(home, path.join(rel, file.path))
              yield* io(fs.makeDirectory(path.dirname(target), { recursive: true }))
              yield* io(fs.writeFileString(target, file.contents))
            }),
          { discard: true }
        )
        return dir
      })

    /**
     * Approval (D7): the whole directory moves from `.taut/pending-skills/<name>` into
     * `skills/<name>`, which is the moment the agent starts seeing it. A half-moved skill would
     * be worse than either state, so the target is cleared first and the move is a rename.
     */
    const promoteSkill = (home: string, name: string): Effect.Effect<void, Forbidden> =>
      Effect.gen(function* () {
        const from = yield* resolveInside(home, skillDirOf(name, true))
        const to = yield* resolveInside(home, skillDirOf(name, false))
        if (!(yield* io(fs.exists(from)))) return
        yield* io(fs.remove(to, { recursive: true, force: true }))
        yield* io(fs.makeDirectory(path.dirname(to), { recursive: true }))
        yield* io(fs.rename(from, to))
      })

    /** The markdown below the frontmatter of a skill's `SKILL.md`; `""` if the file is gone. */
    const readSkill = (
      home: string,
      name: string,
      options: { readonly pending?: boolean } = {}
    ): Effect.Effect<string, Forbidden> =>
      Effect.gen(function* () {
        const file = yield* resolveInside(
          home,
          path.join(skillDirOf(name, options.pending === true), SKILL_MD)
        )
        if (!(yield* io(fs.exists(file)))) return ''
        return stripFrontmatter(yield* io(fs.readFileString(file)))
      })

    /** Sibling files kept next to `SKILL.md`, home-relative and sorted; `SKILL.md` itself excluded. */
    const listSkillFiles = (
      home: string,
      name: string,
      options: { readonly pending?: boolean } = {}
    ): Effect.Effect<ReadonlyArray<string>, Forbidden> =>
      Effect.gen(function* () {
        const dir = yield* resolveInside(home, skillDirOf(name, options.pending === true))
        if (!(yield* io(fs.exists(dir)))) return []
        const walk = (at: string): Effect.Effect<ReadonlyArray<string>> =>
          io(fs.readDirectory(at)).pipe(
            Effect.flatMap((names) =>
              Effect.forEach(names, (entry) =>
                io(fs.stat(path.join(at, entry))).pipe(
                  Effect.flatMap((info) =>
                    info.type === 'Directory'
                      ? walk(path.join(at, entry))
                      : Effect.succeed([path.join(at, entry)])
                  )
                )
              )
            ),
            Effect.map((nested) => nested.flat()),
            Effect.orElseSucceed(() => [])
          )
        const found = yield* walk(dir)
        return found
          .map((absolute) => toPosix(path.relative(home, absolute)))
          .filter((rel) => !rel.endsWith(`/${SKILL_MD}`))
          .sort()
      })

    const removeSkill = (
      home: string,
      name: string,
      options: { readonly pending?: boolean } = {}
    ): Effect.Effect<void, Forbidden> =>
      resolveInside(home, skillDirOf(name, options.pending === true)).pipe(
        Effect.flatMap((dir) => io(fs.remove(dir, { recursive: true, force: true })))
      )

    const entryOf = (home: string, absolute: string): Effect.Effect<FileEntry> =>
      io(fs.stat(absolute)).pipe(
        Effect.map((info) => ({
          path: toPosix(path.relative(home, absolute)),
          kind: info.type === 'Directory' ? ('dir' as const) : ('file' as const),
          size: Number(info.size),
          modifiedAt: DateTime.unsafeFromDate(Option.getOrElse(info.mtime, () => new Date(0)))
        }))
      )

    /** Entries directly under `home/rel` (directories first). A missing folder lists as empty. */
    const list = (home: string, rel: string): Effect.Effect<ReadonlyArray<FileEntry>, Forbidden> =>
      Effect.gen(function* () {
        const dir = yield* resolveInside(home, rel)
        if (!(yield* io(fs.exists(dir)))) return []
        const info = yield* io(fs.stat(dir))
        if (info.type !== 'Directory') return [yield* entryOf(home, dir)]
        const names = yield* io(fs.readDirectory(dir))
        const entries = yield* Effect.forEach(names, (name) => entryOf(home, path.join(dir, name)))
        return [...entries].sort((a, b) =>
          a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'dir' ? -1 : 1
        )
      })

    /**
     * The absolute path and size of the file at `home/rel`, for streaming its bytes
     * (docs/build-plan-workspace.md D12: the browser output gallery). `NotFound` for a
     * missing path or a directory; escapes are `Forbidden` like everywhere else.
     */
    const readFile = (
      home: string,
      rel: string
    ): Effect.Effect<{ readonly path: string; readonly size: number }, Forbidden | NotFound> =>
      Effect.gen(function* () {
        const target = yield* resolveInside(home, rel)
        const missing = new NotFound({ entity: 'File', id: rel })
        if (!(yield* io(fs.exists(target)))) return yield* missing
        const info = yield* io(fs.stat(target))
        if (info.type !== 'File') return yield* missing
        return { path: target, size: Number(info.size) }
      })

    /** Write `bytes` as `home/relDir/name`. `name` must be a bare file name. */
    const writeFile = (
      home: string,
      relDir: string,
      name: string,
      bytes: Uint8Array
    ): Effect.Effect<FileEntry, Forbidden | Validation> =>
      Effect.gen(function* () {
        const base = path.basename(name)
        if (base === '' || base !== name || base === '.' || base === '..') {
          return yield* new Validation({
            issues: [{ path: ['file'], message: 'file name must be a bare name' }]
          })
        }
        const dir = yield* resolveInside(home, relDir)
        const target = yield* resolveInside(home, path.join(path.relative(home, dir), base))
        yield* io(fs.makeDirectory(dir, { recursive: true }))
        yield* io(fs.writeFile(target, bytes))
        return yield* entryOf(home, target)
      })

    /** Keep the folder on agent delete: rename to `<home>.deleted-<epoch ms>`. */
    const archive = (home: string): Effect.Effect<Option.Option<string>> =>
      Effect.gen(function* () {
        if (!(yield* io(fs.exists(home)))) return Option.none()
        const target = `${home}.deleted-${Date.now()}`
        yield* io(fs.rename(home, target))
        return Option.some(target)
      })

    /** Best effort: one line in `<home>/.taut/audit.log`; never fails. */
    const appendAudit = (home: string, line: string): Effect.Effect<void> =>
      ensureLayout(home).pipe(
        Effect.zipRight(fs.writeFileString(path.join(home, AUDIT_LOG), `${line}\n`, { flag: 'a' })),
        Effect.catchAll((error) => Effect.logWarning(`audit.log append failed: ${error.message}`))
      )

    return {
      homeOf,
      ensureLayout,
      resolveInside,
      writeAgentMd,
      writeMeta,
      writeSkill,
      writeSkillDir,
      promoteSkill,
      readSkill,
      listSkillFiles,
      removeSkill,
      list,
      readFile,
      writeFile,
      archive,
      appendAudit
    } as const
  })
}) {}
