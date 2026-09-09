/**
 * Turning "here, learn this" into something fetchable (docs/build-plan-skills.md D2/D3).
 *
 * A human hands an agent a skill in whatever form they had it in: a link they were reading, the
 * `npx skills@latest add …` line from that page, a bare `owner/repo`, or the markdown itself
 * pasted into chat. All four arrive as one string, and `parseSkillSource` is the only thing that
 * decides what it is. It is pure and total: no network, no throw, no I/O. Resolution — turning a
 * `page` into a `github`, listing a repo's skills, fetching blobs — happens server-side in
 * `SkillRegistry` (D1) and never here, so the web input, the MCP tool and the HTTP handler all
 * agree on what a source *is* before anyone touches the network.
 *
 * `npx …` strings are **parsed, never executed** (D1). Nothing in this build shells out.
 */
import { Either, Schema } from 'effect'

/** A GitHub repository, optionally pinned to a ref, a subdirectory, and named skills. */
export interface GithubSource {
  readonly kind: 'github'
  readonly owner: string
  readonly repo: string
  /** Branch, tag or commit the human asked for. Absent means the repo's default branch. */
  readonly ref?: string
  /** Repo-relative directory holding the skill, when the source named one. */
  readonly path?: string
  /** Skill names the human asked for; empty means "show me what is in there". */
  readonly skills: ReadonlyArray<string>
}

/** A direct link to one `SKILL.md`. No siblings, no repo to walk. */
export interface RawSource {
  readonly kind: 'raw'
  readonly url: string
  /** Skill name taken from the containing directory when the URL has one. */
  readonly name?: string
}

/** An HTML page that talks about a skill. `SkillRegistry.resolvePage` turns it into one of the above (D4). */
export interface PageSource {
  readonly kind: 'page'
  readonly url: string
  /** Last path segment, `skills-` stripped — the likely skill name. */
  readonly slug?: string
}

/** The markdown itself, pasted. Needs no network at all. */
export interface InlineSource {
  readonly kind: 'inline'
  readonly markdown: string
}

export type SkillSource = GithubSource | RawSource | PageSource | InlineSource

export class SkillSourceParseError extends Schema.TaggedError<SkillSourceParseError>()(
  'SkillSourceParseError',
  {
    input: Schema.String,
    /** One line, written to be shown to a human or handed back to an agent verbatim. */
    reason: Schema.String
  }
) {
  override get message(): string {
    return this.reason
  }
}

/**
 * The accepted forms, in one paragraph. The web input's helper text, the `skill_install` tool
 * description and every `Validation` message render this same string, so an agent that misreads
 * the field is reading exactly what a human would.
 */
export const SKILL_SOURCE_HELP = [
  'A skill source can be: a GitHub repo (`mattpocock/skills`, optionally `#skill-name` or',
  '`@branch`); a GitHub link to the repo, a folder or a `SKILL.md`; a `skills.sh` link; the',
  '`npx skills@latest add owner/repo --skill=name` command from a page (it is parsed, never run);',
  'any other web page that mentions the skill; or the `SKILL.md` markdown itself, pasted in full',
  'starting with its `---` frontmatter.'
].join(' ')

// --- helpers --------------------------------------------------------------

const fail = (input: string, reason: string): Either.Either<never, SkillSourceParseError> =>
  Either.left(new SkillSourceParseError({ input, reason }))

/** GitHub owner/repo segment: what GitHub itself allows, minus the `.git` suffix. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const stripGitSuffix = (repo: string): string => (repo.endsWith('.git') ? repo.slice(0, -4) : repo)

/** `a,b , c` → `['a','b','c']`; `*` and `all` mean "every skill", i.e. no filter. */
const splitSkills = (value: string): ReadonlyArray<string> =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '*' && s.toLowerCase() !== 'all')

/** Drop a trailing `SKILL.md` so `path` is always the skill's directory. */
const skillDir = (path: string): string => {
  const parts = path.split('/').filter((s) => s.length > 0 && s !== '.')
  if (parts[parts.length - 1]?.toLowerCase() === 'skill.md') parts.pop()
  return parts.join('/')
}

const lastSegment = (path: string): string | undefined => {
  const parts = path.split('/').filter((s) => s.length > 0)
  return parts[parts.length - 1]
}

const github = (
  owner: string,
  repo: string,
  extra: { ref?: string; path?: string; skills?: ReadonlyArray<string> } = {}
): GithubSource => ({
  kind: 'github',
  owner,
  repo: stripGitSuffix(repo),
  ...(extra.ref !== undefined && extra.ref !== '' ? { ref: extra.ref } : {}),
  ...(extra.path !== undefined && extra.path !== '' ? { path: extra.path } : {}),
  skills: extra.skills ?? []
})

/** A skill name we are willing to derive from a URL: what `Handle` accepts, lowercased. */
const cleanName = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  const name = raw.trim().toLowerCase().replace(/\.md$/, '')
  return /^[a-z0-9][a-z0-9_-]{1,31}$/.test(name) ? name : undefined
}

// --- the four shapes ------------------------------------------------------

/** `---\n…name/description…\n---` — the markdown itself. */
const parseInline = (input: string): Either.Either<SkillSource, SkillSourceParseError> => {
  const body = input.replace(/^\uFEFF/, '')
  const end = body.indexOf('\n---', 3)
  if (end === -1) {
    return fail(input, 'this looks like a pasted SKILL.md but its `---` frontmatter never closes')
  }
  const frontmatter = body.slice(3, end)
  if (!/^\s*(name|description)\s*:/m.test(frontmatter)) {
    return fail(
      input,
      'a pasted SKILL.md needs a `name:` or `description:` line in its frontmatter'
    )
  }
  return Either.right({ kind: 'inline', markdown: body })
}

/**
 * `npx skills@latest add mattpocock/skills --skill=grill-with-docs`, and the same command written
 * with `bunx`, `pnpm dlx` or `yarn dlx`, with or without `-y`, with `-s a,b` or `--skill a,b`.
 * The package argument is re-parsed through `parseSkillSource`, so a command carrying a full
 * GitHub URL works too.
 */
const unquote = (token: string): string =>
  /^(["']).*\1$/s.test(token) && token.length > 1 ? token.slice(1, -1) : token

/**
 * Split a pasted command the way a shell would: on whitespace, except inside quotes. Splitting on
 * whitespace alone loses `--skill="a, b"`, which is exactly how a careful person writes it.
 * Line continuations are joined first, so a command copied out of a `<pre>` block still parses.
 */
const shellSplit = (input: string): ReadonlyArray<string> => {
  const tokens: Array<string> = []
  let current = ''
  let quote: '"' | "'" | undefined
  let started = false
  for (const char of input.replace(/\\\r?\n/g, ' ')) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current.length > 0) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += char
  }
  if (started || current.length > 0) tokens.push(current)
  return tokens
}

const parseNpx = (input: string): Either.Either<SkillSource, SkillSourceParseError> => {
  const tokens = shellSplit(input)
  let i = 0
  const runner = tokens[i]?.toLowerCase()
  if (runner === 'pnpm' || runner === 'yarn' || runner === 'npm') i += 2
  else i += 1

  const requested: Array<string> = []
  let pkg: string | undefined
  let sawAdd = false

  const takeValue = (token: string, flag: string): string | undefined => {
    if (token.startsWith(`${flag}=`)) return unquote(token.slice(flag.length + 1))
    if (token === flag) {
      const next = tokens[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        i += 1
        return next
      }
    }
    return undefined
  }

  for (; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined) continue
    if (token.startsWith('-')) {
      const skills = takeValue(token, '--skill') ?? takeValue(token, '-s')
      if (skills !== undefined) {
        requested.push(...splitSkills(skills))
        continue
      }
      // Every other flag says where the CLI would have installed to, which is not our concern —
      // but its *value* has to be eaten, or `--agent claude-code` leaves `claude-code` looking
      // like the package argument.
      for (const flag of ['--agent', '-a', '--metadata', '--subagent']) {
        if (takeValue(token, flag) !== undefined) break
      }
      continue
    }
    if (!sawAdd) {
      // `skills`, `skills@latest`, `add-skill`, then the verb.
      if (token === 'add' || token === 'a') sawAdd = true
      continue
    }
    if (pkg === undefined) pkg = token
  }

  if (pkg === undefined) {
    return fail(
      input,
      'that looks like a `skills` command but I could not find the repo in it — expected something like `npx skills@latest add owner/repo --skill=name`'
    )
  }
  return parseSkillSource(pkg).pipe(
    Either.map((source) =>
      source.kind === 'github' && requested.length > 0
        ? { ...source, skills: [...new Set([...source.skills, ...requested])] }
        : source
    )
  )
}

/** Every `http(s)://` form: github.com, raw.githubusercontent.com, skills.sh, or an arbitrary page. */
const parseUrl = (input: string, url: URL): Either.Either<SkillSource, SkillSourceParseError> => {
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const segments = url.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map(decodeURIComponent)

  if (host === 'github.com') {
    const [owner, repo, kind, ref, ...rest] = segments
    if (owner === undefined || repo === undefined) {
      return fail(input, `\`${input}\` is a GitHub link but does not name a repository`)
    }
    if (kind === undefined) return Either.right(github(owner, repo))
    if (kind !== 'tree' && kind !== 'blob') {
      return fail(
        input,
        `I can read a GitHub repo, a folder (\`/tree/…\`) or a \`SKILL.md\` (\`/blob/…\`), not \`/${kind}/\``
      )
    }
    const path = skillDir(rest.join('/'))
    const name = cleanName(lastSegment(path))
    return Either.right(
      github(owner, repo, { ref, path, skills: name === undefined ? [] : [name] })
    )
  }

  if (host === 'raw.githubusercontent.com') {
    // `/owner/repo/<ref>/<path…>` — resolved as a repo rather than a bare file so the skill keeps
    // its sibling files (D5) and stays updatable (D10).
    const [owner, repo, ref, ...rest] = segments
    if (owner === undefined || repo === undefined || ref === undefined) {
      return fail(input, `\`${input}\` is not a complete raw.githubusercontent.com path`)
    }
    const path = skillDir(rest.join('/'))
    const name = cleanName(lastSegment(path))
    return Either.right(
      github(owner, repo, { ref, path, skills: name === undefined ? [] : [name] })
    )
  }

  if (host === 'skills.sh') {
    // `/owner/repo`, `/owner/repo/skill`, and the `/b/owner/repo` badge form.
    const parts = segments[0] === 'b' ? segments.slice(1) : segments
    const [owner, repo, skill] = parts
    if (owner === undefined || repo === undefined) {
      return fail(input, `\`${input}\` is a skills.sh link but does not name a repository`)
    }
    const name = cleanName(skill)
    return Either.right(github(owner, repo, { skills: name === undefined ? [] : [name] }))
  }

  if (/\.md$/i.test(url.pathname)) {
    return Either.right({
      kind: 'raw',
      url: url.toString(),
      ...(cleanName(lastSegment(skillDir(url.pathname))) !== undefined
        ? { name: cleanName(lastSegment(skillDir(url.pathname))) as string }
        : {})
    })
  }

  const slug = cleanName(lastSegment(url.pathname)?.replace(/^skills?-/, ''))
  return Either.right({
    kind: 'page',
    url: url.toString(),
    ...(slug !== undefined ? { slug } : {})
  })
}

/** `owner/repo`, `owner/repo@ref`, `owner/repo#skill`, `owner/repo/path/to/skill`. */
const parseShorthand = (input: string): Either.Either<SkillSource, SkillSourceParseError> => {
  const [beforeHash, afterHash] = input.split('#', 2)
  const base = (beforeHash ?? '').trim()
  const [beforeAt, afterAt] = base.split('@', 2)
  const segments = (beforeAt ?? '').split('/').filter((s) => s.length > 0)
  const [owner, repo, ...rest] = segments
  if (owner === undefined || repo === undefined || !SEGMENT.test(owner) || !SEGMENT.test(repo)) {
    return fail(input, `I could not tell what \`${input}\` is. ${SKILL_SOURCE_HELP}`)
  }
  const path = skillDir(rest.join('/'))
  const explicit = cleanName(afterHash)
  const fromPath = cleanName(lastSegment(path))
  const skills = explicit ?? fromPath
  return Either.right(
    github(owner, repo, { ref: afterAt, path, skills: skills === undefined ? [] : [skills] })
  )
}

// --- entry point ----------------------------------------------------------

/**
 * Total: every string either becomes a `SkillSource` or a one-line reason a human can act on.
 * Order matters — a pasted SKILL.md can contain anything, including URLs, so it is tested first.
 */
export const parseSkillSource = (
  raw: string
): Either.Either<SkillSource, SkillSourceParseError> => {
  const input = raw.trim()
  if (input.length === 0) return fail(raw, 'give me a link, a repo, or the skill markdown itself')
  if (input.length > 512 * 1024) return fail(raw, 'that is too long to be a skill source')

  if (input.startsWith('---')) return parseInline(input)

  // `github:owner/repo#skill` — what `formatSkillSource` writes, read back.
  const scheme = /^(github|raw|page):(.+)$/is.exec(input)
  if (scheme !== null) {
    const rest = (scheme[2] ?? '').trim()
    if (scheme[1]?.toLowerCase() === 'github') return parseShorthand(rest)
    return parseSkillSource(rest)
  }

  const first = input.split(/\s+/)[0]?.toLowerCase()
  if (
    first === 'npx' ||
    first === 'bunx' ||
    first === 'pnpm' ||
    first === 'yarn' ||
    first === 'npm'
  ) {
    return parseNpx(input)
  }

  if (/^https?:\/\//i.test(input)) {
    try {
      return parseUrl(input, new URL(input))
    } catch {
      return fail(input, `\`${input}\` is not a URL I can read`)
    }
  }
  if (input.includes(' ')) {
    return fail(input, `I could not tell what \`${input}\` is. ${SKILL_SOURCE_HELP}`)
  }
  return parseShorthand(input)
}

/**
 * The canonical string stored in `agent_skills.source` and shown in the UI.
 *
 * `github`, `raw` and `page` round-trip through `parseSkillSource`. `inline` does not: pasted
 * markdown has no address, so it formats to the bare word `inline` and the body on disk is the
 * only record of it.
 */
export const formatSkillSource = (source: SkillSource): string => {
  switch (source.kind) {
    case 'github': {
      const ref = source.ref === undefined ? '' : `@${source.ref}`
      // A path says exactly where the skill is; a bare name only says what to look for. When we
      // have both — a `/tree/…` link, say — the path is what round-trips.
      const suffix =
        source.path !== undefined
          ? `/${source.path}`
          : source.skills.length === 1
            ? `#${source.skills[0] as string}`
            : ''
      return `github:${source.owner}/${source.repo}${ref}${suffix}`
    }
    case 'raw':
      return `raw:${source.url}`
    case 'page':
      return `page:${source.url}`
    case 'inline':
      return 'inline'
  }
}

/** Human-facing one-liner for a source, e.g. "mattpocock/skills#grill-with-docs". */
export const describeSkillSource = (source: SkillSource): string =>
  source.kind === 'inline' ? 'pasted markdown' : formatSkillSource(source).replace(/^\w+:/, '')
