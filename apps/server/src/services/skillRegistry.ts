/**
 * Turning a source into files (docs/build-plan-skills.md D1, D4, D5, D10, D11).
 *
 * This is the only module in the build that touches the network. Everything it does, it does
 * over HTTPS against GitHub's REST API: no `git`, no `npm`, no `npx`, nothing spawned. A pasted
 * `npx skills@latest add ...` line is a *source string* (`parseSkillSource`), and running it was
 * never on the table — the server would be executing a command a stranger put on a web page.
 *
 * Three jobs:
 *
 *   preview       what skills are at this source, without installing anything
 *   fetch         one skill's whole directory, ready to write into a home
 *   upstreamHash  what one skill's SKILL.md hashes to right now, for the daily check
 *
 * The caps in `LIMITS` are the security surface. Unpacking a repository is unpacking a
 * stranger's idea of what your filesystem should look like, so every blob is counted, measured
 * and path-checked here, and then checked *again* by `AgentHomes.resolveInside` on the way to
 * disk. Symlinks are refused outright: a symlink in a skill directory is never an accident.
 */
import { FetchHttpClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { SqlClient } from '@effect/sql'
import type { SkillCandidate } from '@taut/contract/api'
import {
  type GithubSource,
  parseSkillSource,
  SKILL_SOURCE_HELP,
  type SkillSource
} from '@taut/contract/domain'
import { Validation } from '@taut/contract/errors'
import type { CompanyId } from '@taut/contract/ids'
import { Data, Effect, Either, Option, Redacted, Schema } from 'effect'
import { createHash } from 'node:crypto'
import { findOne } from '../db/sql.js'
import { RepositoryRow } from '../domain/rows.js'
import { GitHubApp } from './githubApp.js'
import { stripFrontmatter } from './homes.js'

const GITHUB_API = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 15_000

/** D5. Generous enough for every skill in the wild, small enough that nothing can flood a home. */
export const LIMITS = {
  /** Files in one skill directory, `SKILL.md` included. */
  maxFiles: 40,
  /** Bytes across the whole directory. */
  maxTotalBytes: 1024 * 1024,
  /** Bytes in any single file. */
  maxFileBytes: 256 * 1024,
  /** Skills `preview` will describe before it stops. */
  maxCandidates: 200,
  /** Bytes of an HTML page we will read looking for a skill (D4). */
  maxPageBytes: 2 * 1024 * 1024
} as const

/**
 * Extensions a skill may ship. A skill is instructions and the things instructions refer to;
 * anything binary is either a mistake or a payload, and neither belongs in an agent's home.
 */
const ALLOWED_EXTENSIONS = new Set([
  'md',
  'mdx',
  'markdown',
  'txt',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'csv',
  'tsv',
  'sh',
  'bash',
  'zsh',
  'py',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'html',
  'css',
  'sql',
  'xml',
  'env',
  'example',
  'gitignore',
  'lock'
])

export class SkillFetchFailure extends Data.TaggedError('SkillFetchFailure')<{
  readonly reason: string
}> {}

/** For the HTTP handlers, which may only fail with contract errors. */
export const asValidation = (error: SkillFetchFailure): Validation =>
  new Validation({ issues: [{ path: ['source'], message: error.reason }] })

/** One skill, resolved and ready for `AgentHomes.writeSkillDir`. */
export interface ResolvedSkill {
  readonly name: string
  readonly description: string
  /** `SKILL.md` below its frontmatter. */
  readonly body: string
  /** Sibling files, paths relative to the skill's own directory. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly contents: string }>
  readonly source: SkillSource
  /** Canonical `source` column value. */
  readonly canonical: string
  /** Repo-relative path of the `SKILL.md` this came from. */
  readonly sourcePath?: string
  readonly resolvedSha?: string
  /** sha256 of `SKILL.md` exactly as fetched (D10). */
  readonly contentHash: string
}

// -- GitHub payloads ---------------------------------------------------------

const RepoInfo = Schema.Struct({ default_branch: Schema.String })
const CommitInfo = Schema.Struct({ sha: Schema.String })
const TreeEntry = Schema.Struct({
  path: Schema.String,
  /** `blob` | `tree` | `commit` (a submodule). */
  type: Schema.String,
  /** `120000` is a symlink; refused (D5). */
  mode: Schema.String,
  size: Schema.optional(Schema.Number)
})
const TreeResponse = Schema.Struct({
  tree: Schema.Array(TreeEntry),
  truncated: Schema.optionalWith(Schema.Boolean, { default: () => false })
})

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const extensionOf = (path: string): string => {
  const base = path.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base.toLowerCase() : base.slice(dot + 1).toLowerCase()
}

/**
 * A control character in a path is never a filename; it is someone hiding one. Matching control
 * characters is the whole point here, so the rule that forbids them in a regex does not apply.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

const isSafeRelativePath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !/(^|\/)\.\.(\/|$)/.test(path) &&
  !CONTROL_CHARS.test(path)

/** The skill's name is its directory; a repo-root `SKILL.md` takes the repo's name. */
const nameOfSkillPath = (path: string, repo: string): string => {
  const parts = path.split('/').filter((p) => p.length > 0)
  parts.pop()
  return (parts[parts.length - 1] ?? repo).toLowerCase()
}

const withoutSkillMd = (path: string): string => path.replace(/\/?SKILL\.md$/i, '')

export class SkillRegistry extends Effect.Service<SkillRegistry>()('SkillRegistry', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const github = yield* GitHubApp
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.transformResponse(Effect.timeout(REQUEST_TIMEOUT_MS))
    )

    /**
     * D11: anonymous first. Sixty requests an hour per IP is plenty for one check per skill per
     * day, and it means a public skill works on an instance that has never seen GitHub. The
     * fallback is the company's own App token, which can only be minted for a repository the
     * company has actually attached — so a private skill repo is one you attach first.
     */
    const attachedRepo = findOne({
      Request: Schema.Struct({ companyId: Schema.String, fullName: Schema.String }),
      Result: RepositoryRow,
      execute: (r) => sql`
        SELECT id, company_id, github_id, owner, name, full_name, default_branch, private,
               clone_url, attached_at
        FROM repositories
        WHERE company_id = ${r.companyId} AND full_name = ${r.fullName} COLLATE NOCASE`
    })

    const authFor = (
      companyId: CompanyId,
      owner: string,
      repo: string
    ): Effect.Effect<string | undefined> =>
      attachedRepo({ companyId, fullName: `${owner}/${repo}` }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(undefined),
            onSome: (row) =>
              github.installationToken(companyId, { id: row.id, name: row.name }, 'ro').pipe(
                Effect.map((t) => `Bearer ${Redacted.value(t.token)}`),
                Effect.orElseSucceed(() => undefined)
              )
          })
        )
      )

    const headers = (authorization?: string): Record<string, string> => ({
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'taut-skills',
      ...(authorization === undefined ? {} : { authorization })
    })

    /** Anonymous attempt first, the company's token as the retry (D11). */
    const attempting = <A>(
      companyId: CompanyId,
      source: { readonly owner: string; readonly repo: string },
      attempt: (authorization?: string) => Effect.Effect<A, SkillFetchFailure>
    ): Effect.Effect<A, SkillFetchFailure> =>
      attempt().pipe(
        Effect.catchAll((first) =>
          authFor(companyId, source.owner, source.repo).pipe(
            Effect.flatMap((authorization) =>
              authorization === undefined ? Effect.fail(first) : attempt(authorization)
            )
          )
        )
      )

    /**
     * One GitHub call, decoded. GitHub's error bodies can echo what we sent, so `reason` is
     * built from the status and our own words and the body is never repeated.
     */
    const call = <A, I>(
      companyId: CompanyId,
      source: { readonly owner: string; readonly repo: string },
      url: string,
      result: Schema.Schema<A, I>,
      what: string
    ): Effect.Effect<A, SkillFetchFailure> =>
      attempting(companyId, source, (authorization) =>
        client
          .execute(
            HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers(authorization)))
          )
          .pipe(
            Effect.mapError(
              () => new SkillFetchFailure({ reason: `cannot reach GitHub to ${what}` })
            ),
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300
                ? response.json.pipe(
                    Effect.mapError(
                      () =>
                        new SkillFetchFailure({
                          reason: `GitHub sent unreadable JSON for ${what}`
                        })
                    )
                  )
                : Effect.fail(
                    new SkillFetchFailure({
                      reason:
                        response.status === 404
                          ? `${source.owner}/${source.repo} is not a public repository I can read — attach it to the company first if it is private`
                          : `GitHub refused to ${what} (HTTP ${response.status})`
                    })
                  )
            ),
            Effect.flatMap((json) =>
              Schema.decodeUnknown(result)(json).pipe(
                Effect.mapError(
                  () =>
                    new SkillFetchFailure({
                      reason: `GitHub sent an unexpected payload for ${what}`
                    })
                )
              )
            )
          )
      )

    const getText = (
      url: string,
      authorization?: string
    ): Effect.Effect<string, SkillFetchFailure> =>
      client
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers(authorization)))
        )
        .pipe(
          Effect.mapError(() => new SkillFetchFailure({ reason: `cannot reach ${url}` })),
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? response.text.pipe(
                  Effect.mapError(() => new SkillFetchFailure({ reason: `${url} is not text` }))
                )
              : Effect.fail(
                  new SkillFetchFailure({ reason: `${url} answered HTTP ${response.status}` })
                )
          )
        )

    /** Raw bytes of one blob at one commit. Not JSON, so it does not go through `call`. */
    const rawFile = (
      companyId: CompanyId,
      source: { readonly owner: string; readonly repo: string },
      sha: string,
      path: string
    ): Effect.Effect<string, SkillFetchFailure> => {
      const encoded = path.split('/').map(encodeURIComponent).join('/')
      const url = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${sha}/${encoded}`
      return attempting(companyId, source, (authorization) => getText(url, authorization))
    }

    /** A ref (or the default branch) becomes the commit everything else is pinned to. */
    const resolveSha = (
      companyId: CompanyId,
      source: GithubSource
    ): Effect.Effect<string, SkillFetchFailure> =>
      Effect.gen(function* () {
        const ref =
          source.ref ??
          (yield* call(
            companyId,
            source,
            `${GITHUB_API}/repos/${source.owner}/${source.repo}`,
            RepoInfo,
            `read ${source.owner}/${source.repo}`
          )).default_branch
        const commit = yield* call(
          companyId,
          source,
          `${GITHUB_API}/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(ref)}`,
          CommitInfo,
          `resolve ${ref}`
        )
        return commit.sha
      })

    const treeOf = (
      companyId: CompanyId,
      source: GithubSource,
      sha: string
    ): Effect.Effect<typeof TreeResponse.Type, SkillFetchFailure> =>
      call(
        companyId,
        source,
        `${GITHUB_API}/repos/${source.owner}/${source.repo}/git/trees/${sha}?recursive=1`,
        TreeResponse,
        `list ${source.owner}/${source.repo}`
      )

    /** Every SKILL.md in the repo at that commit — the same walk the `skills` CLI does. */
    const skillPaths = (
      companyId: CompanyId,
      source: GithubSource,
      sha: string
    ): Effect.Effect<ReadonlyArray<string>, SkillFetchFailure> =>
      treeOf(companyId, source, sha).pipe(
        Effect.map((tree) =>
          tree.tree
            .filter(
              (entry) =>
                entry.type === 'blob' &&
                entry.mode !== '120000' &&
                entry.path.split('/').pop()?.toUpperCase() === 'SKILL.MD' &&
                isSafeRelativePath(entry.path) &&
                (source.path === undefined ||
                  entry.path === `${source.path}/SKILL.md` ||
                  entry.path.startsWith(`${source.path}/`))
            )
            .map((entry) => entry.path)
            .sort()
        )
      )

    /**
     * D4: a page that talks about a skill, read through the ordered rules in `parsePage`.
     * Verified against the owner's aihero.dev page, which hits the first rule.
     */
    const resolvePage = (url: string): Effect.Effect<SkillSource, SkillFetchFailure> =>
      getText(url).pipe(
        Effect.map((html) => html.slice(0, LIMITS.maxPageBytes)),
        Effect.flatMap((html) =>
          Option.match(parsePage(html, url), {
            onNone: () =>
              Effect.fail(
                new SkillFetchFailure({
                  reason: `I read ${url} and could not find a skill on it. ${SKILL_SOURCE_HELP}`
                })
              ),
            onSome: Effect.succeed
          })
        )
      )

    /** Resolve a `page` once, so everything below only ever sees the other three kinds. */
    const ground = (source: SkillSource): Effect.Effect<SkillSource, SkillFetchFailure> =>
      source.kind === 'page' ? resolvePage(source.url) : Effect.succeed(source)

    // -- the three public jobs -------------------------------------------------

    const preview = (
      companyId: CompanyId,
      raw: SkillSource
    ): Effect.Effect<ReadonlyArray<SkillCandidate>, SkillFetchFailure> =>
      Effect.gen(function* () {
        const source = yield* ground(raw)
        if (source.kind === 'inline') {
          const one = yield* fromMarkdown(source.markdown, undefined)
          return [{ name: one.name, description: one.description, path: 'SKILL.md' }]
        }
        if (source.kind === 'raw') {
          const one = yield* fromMarkdown(yield* getText(source.url), source.name)
          return [{ name: one.name, description: one.description, path: source.url }]
        }
        if (source.kind === 'page') return []

        const sha = yield* resolveSha(companyId, source)
        const paths = yield* skillPaths(companyId, source, sha)
        if (paths.length === 0) {
          return yield* new SkillFetchFailure({
            reason: `${source.owner}/${source.repo} has no SKILL.md in it`
          })
        }
        const wanted =
          source.skills.length === 0
            ? paths
            : paths.filter((p) => source.skills.includes(nameOfSkillPath(p, source.repo)))
        const chosen = (wanted.length === 0 ? paths : wanted).slice(0, LIMITS.maxCandidates)
        return yield* Effect.forEach(
          chosen,
          (path) =>
            rawFile(companyId, source, sha, path).pipe(
              Effect.map((text) => frontmatterField(text, 'description') ?? ''),
              // One unreadable skill must not hide the other thirty-six.
              Effect.orElseSucceed(() => ''),
              Effect.map((description) => ({
                name: nameOfSkillPath(path, source.repo),
                description,
                path: withoutSkillMd(path)
              }))
            ),
          { concurrency: 6 }
        )
      })

    const fetch = (
      companyId: CompanyId,
      raw: SkillSource,
      wanted?: string
    ): Effect.Effect<ResolvedSkill, SkillFetchFailure> =>
      Effect.gen(function* () {
        const source = yield* ground(raw)

        if (source.kind === 'inline') {
          const one = yield* fromMarkdown(source.markdown, wanted)
          return {
            ...one,
            files: [],
            source,
            canonical: 'inline',
            contentHash: sha256(source.markdown)
          }
        }
        if (source.kind === 'raw') {
          const text = yield* getText(source.url)
          const one = yield* fromMarkdown(text, wanted ?? source.name)
          return {
            ...one,
            files: [],
            source,
            canonical: `raw:${source.url}`,
            contentHash: sha256(text)
          }
        }
        if (source.kind === 'page') {
          return yield* new SkillFetchFailure({
            reason: `${source.url} did not resolve to a skill`
          })
        }

        const sha = yield* resolveSha(companyId, source)
        const paths = yield* skillPaths(companyId, source, sha)
        const asked = wanted ?? source.skills[0]
        const target =
          (asked === undefined
            ? undefined
            : paths.find((p) => nameOfSkillPath(p, source.repo) === asked)) ??
          (paths.length === 1 ? paths[0] : undefined)
        if (target === undefined) {
          return yield* new SkillFetchFailure({
            reason:
              paths.length === 0
                ? `${source.owner}/${source.repo} has no SKILL.md in it`
                : `${source.owner}/${source.repo} has ${paths.length} skills in it; name the one you want`
          })
        }

        const dir = withoutSkillMd(target)
        const skillMd = yield* rawFile(companyId, source, sha, target)
        const one = yield* fromMarkdown(skillMd, nameOfSkillPath(target, source.repo))

        // Siblings: everything under the skill's own directory, minus the SKILL.md itself.
        const tree = yield* treeOf(companyId, source, sha)
        const prefix = dir === '' ? '' : `${dir}/`
        const siblings = tree.tree.filter(
          (entry) =>
            entry.type === 'blob' &&
            entry.path !== target &&
            (prefix === '' ? !entry.path.includes('/') : entry.path.startsWith(prefix))
        )
        const symlink = siblings.find((entry) => entry.mode === '120000')
        if (symlink !== undefined) {
          return yield* new SkillFetchFailure({
            reason: `${symlink.path} is a symlink; I will not unpack that into an agent's home`
          })
        }
        const usable = siblings.filter(
          (entry) =>
            isSafeRelativePath(entry.path) && ALLOWED_EXTENSIONS.has(extensionOf(entry.path))
        )
        if (usable.length + 1 > LIMITS.maxFiles) {
          return yield* new SkillFetchFailure({
            reason: `that skill ships ${usable.length + 1} files; the limit is ${LIMITS.maxFiles}`
          })
        }
        const oversized = usable.find((entry) => (entry.size ?? 0) > LIMITS.maxFileBytes)
        if (oversized !== undefined) {
          return yield* new SkillFetchFailure({
            reason: `${oversized.path} is larger than ${LIMITS.maxFileBytes} bytes`
          })
        }
        const total = usable.reduce(
          (sum, entry) => sum + (entry.size ?? 0),
          Buffer.byteLength(skillMd, 'utf8')
        )
        if (total > LIMITS.maxTotalBytes) {
          return yield* new SkillFetchFailure({
            reason: `that skill is ${total} bytes in total; the limit is ${LIMITS.maxTotalBytes}`
          })
        }

        const files = yield* Effect.forEach(
          usable,
          (entry) =>
            rawFile(companyId, source, sha, entry.path).pipe(
              Effect.map((contents) => ({
                path: prefix === '' ? entry.path : entry.path.slice(prefix.length),
                contents
              }))
            ),
          { concurrency: 4 }
        )

        const ref = source.ref === undefined ? '' : `@${source.ref}`
        const suffix = dir === '' ? `#${one.name}` : `/${dir}`
        return {
          ...one,
          files,
          source: { ...source, ...(dir === '' ? {} : { path: dir }), skills: [one.name] },
          canonical: `github:${source.owner}/${source.repo}${ref}${suffix}`,
          sourcePath: target,
          resolvedSha: sha,
          contentHash: sha256(skillMd)
        }
      })

    /**
     * D10: what upstream's SKILL.md hashes to right now. One request in the common case. `None`
     * when the source has no address to go back to, which is also why a pasted skill is never
     * checked.
     */
    const upstreamHash = (
      companyId: CompanyId,
      canonical: string,
      sourcePath?: string
    ): Effect.Effect<Option.Option<string>, SkillFetchFailure> =>
      Effect.gen(function* () {
        const parsed = parseSkillSource(canonical)
        if (Either.isLeft(parsed)) return Option.none()
        const source = yield* ground(parsed.right)
        if (source.kind === 'inline' || source.kind === 'page') return Option.none()
        if (source.kind === 'raw') return Option.some(sha256(yield* getText(source.url)))

        const sha = yield* resolveSha(companyId, source)
        const path =
          sourcePath ??
          (yield* skillPaths(companyId, source, sha)).find(
            (p) => nameOfSkillPath(p, source.repo) === source.skills[0]
          )
        if (path === undefined) return Option.none()
        return Option.some(sha256(yield* rawFile(companyId, source, sha, path)))
      })

    return { preview, fetch, upstreamHash, resolvePage, ground } as const
  }),
  dependencies: [GitHubApp.Default, FetchHttpClient.layer]
}) {}

// -- pure helpers, exported for their own tests ------------------------------

/** One frontmatter field, unquoted. Deliberately forgiving: upstream frontmatter is not ours. */
export const frontmatterField = (md: string, field: string): string | undefined => {
  if (!md.startsWith('---')) return undefined
  const end = md.indexOf('\n---', 3)
  if (end === -1) return undefined
  const match = new RegExp(`^\\s*${field}\\s*:\\s*(.+)$`, 'm').exec(md.slice(3, end))
  const value = match?.[1]?.trim()
  if (value === undefined) return undefined
  return /^(["']).*\1$/s.test(value) ? value.slice(1, -1) : value
}

/**
 * D4's ordered rules over one page's HTML. Pure, so the aihero fixture is a unit test rather
 * than a network test.
 */
export const parsePage = (html: string, pageUrl: string): Option.Option<SkillSource> => {
  const decoded = html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

  // 1. the install command the author printed
  const command =
    /\b(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(?:-y\s+)?[^\s<"]*skills[^\s<"]*\s+add\s+[^<"\n]+/i.exec(
      decoded
    )
  if (command !== null) {
    const parsed = parseSkillSource(command[0].replace(/\\\s*$/, '').trim())
    if (Either.isRight(parsed)) return Option.some(parsed.right)
  }

  // 2. a SKILL.md pasted into the page
  const fenced = /```(?:markdown|md)?\s*\n(---\r?\n[\s\S]*?)```/i.exec(decoded)
  const inline = fenced?.[1]
  if (inline !== undefined) {
    const parsed = parseSkillSource(inline.trim())
    if (Either.isRight(parsed) && parsed.right.kind === 'inline') return Option.some(parsed.right)
  }

  // 3/4. the links. skills.sh first: it names the skill more often than a bare repo link does.
  const slug = (() => {
    try {
      const last = new URL(pageUrl).pathname
        .split('/')
        .filter((s) => s.length > 0)
        .pop()
      const candidate = last?.replace(/^skills?-/, '').toLowerCase()
      return candidate !== undefined && /^[a-z0-9][a-z0-9_-]{1,31}$/.test(candidate)
        ? candidate
        : undefined
    } catch {
      return undefined
    }
  })()
  for (const pattern of [
    /skills\.sh\/(?:b\/)?([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)/,
    /github\.com\/([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)/
  ]) {
    const match = pattern.exec(decoded)
    const owner = match?.[1]
    const repo = match?.[2]?.replace(/\.git$/, '')
    if (owner !== undefined && repo !== undefined) {
      return Option.some({
        kind: 'github',
        owner,
        repo,
        skills: slug === undefined ? [] : [slug]
      })
    }
  }
  return Option.none()
}

/** A `SKILL.md` string becomes the name, description and body Taut stores. */
const fromMarkdown = (
  md: string,
  fallbackName: string | undefined
): Effect.Effect<
  { readonly name: string; readonly description: string; readonly body: string },
  SkillFetchFailure
> =>
  Effect.gen(function* () {
    if (Buffer.byteLength(md, 'utf8') > LIMITS.maxFileBytes) {
      return yield* new SkillFetchFailure({ reason: 'that SKILL.md is too large' })
    }
    const name = (frontmatterField(md, 'name') ?? fallbackName ?? '').trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(name)) {
      return yield* new SkillFetchFailure({
        reason:
          name === ''
            ? 'that skill has no `name:` in its frontmatter and the source does not imply one'
            : `\`${name}\` is not a usable skill name (2-32 chars of a-z, 0-9, _ and -)`
      })
    }
    const description = (frontmatterField(md, 'description') ?? '').trim()
    if (description === '') {
      return yield* new SkillFetchFailure({
        reason: `\`${name}\` has no \`description:\` line, and that is what an agent reads when it chooses a skill`
      })
    }
    return { name, description, body: stripFrontmatter(md) }
  })
