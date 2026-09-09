/**
 * Git repositories inside the agent's box (docs/build-plan-repositories.md, "Inside the box").
 *
 * ```
 * <home>/repos/<owner>__<name>/     pristine clone, on <defaultBranch>, never worked in
 * <home>/work/<threadId>/<name>/    the worktree this conversation works in
 * ```
 *
 * Every task gets a worktree, never the clone itself (D5): a worktree is a clean checkout that
 * shares the object store, so the second task on a repository costs a `fetch` rather than a
 * clone. `rw` gets its own branch `taut/<handle>/<last 8 of the task id>`; `ro` gets a detached
 * head on `origin/<default>` — there is nothing to commit to, and a token minted with
 * `contents: read` would refuse the push anyway.
 *
 * `rw` also gets a `pre-push` hook that refuses the default branch (D6). The token carries
 * `contents: write`, and no GitHub permission can say "a branch, but not main"; the hook can.
 * A linked worktree's `.git` is a *file* pointing at `<primary>/.git/worktrees/<name>`, and
 * hooks live in the **common** dir — so the hook is resolved with `git rev-parse --git-path
 * hooks`, never assumed, and ends up shared by every worktree of that clone. That is the
 * intent: its body depends only on `defaultBranch`, so rewriting it each task is idempotent
 * and a stray push from anywhere in the clone is refused the same way.
 *
 * Credentials never touch the disk (D4). `git` is configured per-exec with a credential helper
 * that shells out to `taut git-credential`, which asks the Taut server for a fresh
 * repo-scoped installation token using the task's own bearer token (`gitCredentialEnv`).
 * Nothing here ever sees that token, so nothing here can log one.
 *
 * **Nothing in this file may fail a task.** Every step is best-effort: a failure logs a
 * warning and drops that repository from the set handed to the instruction file. An agent
 * still has to answer a message when GitHub is down.
 */
import { Effect } from 'effect'
import { posix } from 'node:path'

import type { Machine } from './machine/types.js'

/** `ro` | `rw`, the same vocabulary as file grants (D13). */
export type RepoMode = 'ro' | 'rw'

/** What this package needs to know about a granted repository. */
export interface RepoSpec {
  /** `octocat` in `octocat/hello-world`. */
  readonly owner: string
  /** `hello-world` in `octocat/hello-world`. */
  readonly name: string
  /** `https://github.com/octocat/hello-world.git`. */
  readonly cloneUrl: string
  /** What `ro` reads and `rw` branches from. */
  readonly defaultBranch: string
  readonly mode: RepoMode
}

/** A worktree that exists and is ready for the task. */
export interface PreparedRepo {
  readonly repo: RepoSpec
  /** `<home>/repos/<owner>__<name>` — the clone, machine-visible. */
  readonly primaryDir: string
  /** `<work>/<name>` — where the agent works, machine-visible. */
  readonly worktreeDir: string
  /** `taut/<handle>/<id>` for `rw`; `origin/<default>` (detached) for `ro`. */
  readonly branch: string
}

/** Sub-directory of the home holding the clones (added to `HOME_DIRS`). */
export const REPOS_DIR = 'repos'

/** `<owner>__<name>` — flat, collision-free, and readable in a `ls`. */
export const primaryDirName = (repo: Pick<RepoSpec, 'owner' | 'name'>): string =>
  `${repo.owner}__${repo.name}`

export const primaryDirOf = (homeDir: string, repo: Pick<RepoSpec, 'owner' | 'name'>): string =>
  posix.join(homeDir, REPOS_DIR, primaryDirName(repo))

export const worktreeDirOf = (workDir: string, repo: Pick<RepoSpec, 'name'>): string =>
  posix.join(workDir, repo.name)

/**
 * `taut/<handle>/<last 8 of the task id>` (D5). The prefix makes Taut's branches obvious in
 * the GitHub branch list, and the suffix keeps two tasks of the same agent apart.
 */
export const sessionBranch = (handle: string, sessionId: string): string =>
  `taut/${handle}/${sessionId.slice(-8)}`

// ---------------------------------------------------------------------------
// git configuration for an exec (D4)
// ---------------------------------------------------------------------------

/** The credential helper `git` runs. `!` makes git treat the value as a shell command. */
export const GIT_CREDENTIAL_HELPER = '!taut git-credential'
/** Only github.com in this phase (D10); one constant so adding GHES is one line. */
export const GITHUB_HOST = 'https://github.com'
export const GIT_CREDENTIAL_CONFIG_KEY = `credential.${GITHUB_HOST}.helper`
/**
 * **Deviation from the build plan, and a necessary one.** The plan lists one config entry.
 * Without `useHttpPath` git sends the helper only `protocol` and `host`, never the
 * `owner/name.git` path — and the server's `POST /git-credential` maps exactly that path to a
 * granted repository (D14). One entry would make every request unmappable.
 */
export const GIT_USE_HTTP_PATH_CONFIG_KEY = `credential.${GITHUB_HOST}.useHttpPath`
/**
 * **Reset, and it has to come first.** `credential.helper` is a *multi-valued* key: git runs
 * every helper it finds, in config order, and the ones in the host's `~/.gitconfig` are still
 * in that list when our env-level entry is added. On a macOS host that means `osxkeychain`
 * runs alongside ours and, on the `store` git sends after a successful clone, pops
 * "The keychain cannot be found to store 'https://x-access-token@github.com'". An **empty**
 * value clears the list collected so far, so this entry must be written before the helper.
 */
export const GIT_CREDENTIAL_RESET_CONFIG_KEY = 'credential.helper'

/**
 * `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` for `entries`, appended **after** whatever the base env
 * already declares — clobbering `GIT_CONFIG_COUNT` would silently drop someone else's config.
 * Env-only, so no global git config is ever written into the image or the home.
 *
 * `GIT_TERMINAL_PROMPT=0` is the other half of the contract: the helper exits 0 printing
 * nothing when it cannot answer, and without this git would then sit on a username prompt
 * forever instead of failing.
 */
export const gitConfigEnv = (
  entries: ReadonlyArray<readonly [string, string]>,
  base: Readonly<Record<string, string>> = {}
): Record<string, string> => {
  const start = Number.parseInt(base['GIT_CONFIG_COUNT'] ?? '0', 10)
  const from = Number.isFinite(start) && start > 0 ? start : 0
  const env: Record<string, string> = {}
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${from + i}`] = key
    env[`GIT_CONFIG_VALUE_${from + i}`] = value
  })
  env['GIT_CONFIG_COUNT'] = String(from + entries.length)
  return env
}

/**
 * Everything `git` needs to authenticate to github.com from inside the box, merged over
 * `base`. The helper itself reads `TAUT_URL` / `TAUT_TOKEN` from its own environment, so
 * every exec that runs `git` against a private repository must also carry those two.
 *
 * The empty `credential.helper` first drops every helper inherited from the host's git
 * config, so `!taut git-credential` is the only one git consults.
 */
export const gitCredentialEnv = (
  base: Readonly<Record<string, string>> = {}
): Record<string, string> => ({
  ...gitConfigEnv(
    [
      [GIT_CREDENTIAL_RESET_CONFIG_KEY, ''],
      [GIT_CREDENTIAL_CONFIG_KEY, GIT_CREDENTIAL_HELPER],
      [GIT_USE_HTTP_PATH_CONFIG_KEY, 'true']
    ],
    base
  ),
  GIT_TERMINAL_PROMPT: '0'
})

// ---------------------------------------------------------------------------
// command construction (kept pure, so the tests can read them)
// ---------------------------------------------------------------------------

/** `--filter=blob:none` — history without the file contents nobody asked for. */
export const cloneCommand = (
  repo: Pick<RepoSpec, 'cloneUrl'>,
  primaryDir: string
): ReadonlyArray<string> => ['git', 'clone', '--filter=blob:none', '--', repo.cloneUrl, primaryDir]

export const fetchCommand = (primaryDir: string): ReadonlyArray<string> => [
  'git',
  '-C',
  primaryDir,
  'fetch',
  '--prune',
  'origin'
]

/** `rw` → a named branch off `origin/<default>`; `ro` → a detached head on it. */
export const worktreeAddCommand = (
  primaryDir: string,
  worktreeDir: string,
  repo: Pick<RepoSpec, 'defaultBranch' | 'mode'>,
  branch: string
): ReadonlyArray<string> =>
  repo.mode === 'rw'
    ? [
        'git',
        '-C',
        primaryDir,
        'worktree',
        'add',
        '-b',
        branch,
        worktreeDir,
        `origin/${repo.defaultBranch}`
      ]
    : [
        'git',
        '-C',
        primaryDir,
        'worktree',
        'add',
        '--detach',
        worktreeDir,
        `origin/${repo.defaultBranch}`
      ]

/** Re-attach an existing branch (a parked task resumed under the same id). */
export const worktreeAddExistingCommand = (
  primaryDir: string,
  worktreeDir: string,
  branch: string
): ReadonlyArray<string> => ['git', '-C', primaryDir, 'worktree', 'add', worktreeDir, branch]

export const worktreeRemoveCommand = (
  primaryDir: string,
  worktreeDir: string
): ReadonlyArray<string> => ['git', '-C', primaryDir, 'worktree', 'remove', '--force', worktreeDir]

export const worktreePruneCommand = (primaryDir: string): ReadonlyArray<string> => [
  'git',
  '-C',
  primaryDir,
  'worktree',
  'prune'
]

/** How many commits the branch has that `origin/<default>` does not. `0` → safe to remove. */
export const aheadCountCommand = (
  primaryDir: string,
  repo: Pick<RepoSpec, 'defaultBranch'>,
  branch: string
): ReadonlyArray<string> => [
  'git',
  '-C',
  primaryDir,
  'rev-list',
  '--count',
  `origin/${repo.defaultBranch}..${branch}`
]

/** The real hooks directory of a worktree — the common dir, not `<worktree>/.git/hooks`. */
export const hooksPathCommand = (worktreeDir: string): ReadonlyArray<string> => [
  'git',
  '-C',
  worktreeDir,
  'rev-parse',
  '--git-path',
  'hooks'
]

/** `git rev-parse --git-dir`: exit 0 means the path is already a usable worktree. */
export const isWorktreeCommand = (worktreeDir: string): ReadonlyArray<string> => [
  'git',
  '-C',
  worktreeDir,
  'rev-parse',
  '--git-dir'
]

/** `git show-ref --verify --quiet refs/heads/<branch>`: exit 0 means the branch exists. */
export const branchExistsCommand = (primaryDir: string, branch: string): ReadonlyArray<string> => [
  'git',
  '-C',
  primaryDir,
  'show-ref',
  '--verify',
  '--quiet',
  `refs/heads/${branch}`
]

// ---------------------------------------------------------------------------
// the pre-push hook (D6)
// ---------------------------------------------------------------------------

/** POSIX-sh single-quoting: the only safe way to put a branch name into a script. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/** `chmod` bits the hook is written with — git ignores a hook that is not executable. */
export const PRE_PUSH_MODE = '0755'
export const PRE_PUSH_HOOK = 'pre-push'

/**
 * The hook body. `git` feeds `pre-push` one `<local ref> <local sha> <remote ref> <remote sha>`
 * line per ref being pushed on stdin; a non-zero exit refuses the whole push. Nothing else is
 * refused: a `taut/<handle>/<id>` branch pushes exactly as it would without the hook.
 */
export const prePushHook = (defaultBranch: string): string =>
  [
    '#!/bin/sh',
    '# Installed by Taut for a read-write repository grant (docs/build-plan-repositories.md D6).',
    '# Read-write means a branch and a pull request. No GitHub token can express "not the',
    '# default branch", so this hook does.',
    `branch=${shellQuote(defaultBranch)}`,
    `protected=${shellQuote(`refs/heads/${defaultBranch}`)}`,
    'while read -r _local_ref _local_sha remote_ref _remote_sha; do',
    '  if [ "$remote_ref" = "$protected" ]; then',
    '    echo "taut: refusing to push $branch directly — push your taut/… branch and open the pull request with the github_open_pr tool." >&2',
    '    exit 1',
    '  fi',
    'done',
    'exit 0',
    ''
  ].join('\n')

// ---------------------------------------------------------------------------
// the lifecycle, over Machine.exec
// ---------------------------------------------------------------------------

/** A clone can be big and the box's network is not ours; a fetch is bounded by the same. */
const CLONE_TIMEOUT_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 5 * 60 * 1000
const GIT_TIMEOUT_MS = 60 * 1000

interface GitOutcome {
  readonly ok: boolean
  readonly stdout: string
  /** Last lines of stderr, for the warning. Never contains a token: git never prints one. */
  readonly stderr: string
}

type ExecMachine = Pick<Machine, 'exec' | 'putFile' | 'spec'>

/**
 * Run one command in the box. Never fails: a spawn error, a missing binary and a non-zero
 * exit all come back as `ok: false` with whatever the command said.
 */
const sh = (
  machine: ExecMachine,
  cmd: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  timeoutMs: number = GIT_TIMEOUT_MS
): Effect.Effect<GitOutcome> => {
  const out: Array<string> = []
  const err: Array<string> = []
  return machine
    .exec({
      cmd,
      env,
      timeoutMs,
      onLine: (line) => {
        if (out.length < 64) out.push(line)
      },
      onStderr: (line) => {
        err.push(line)
        if (err.length > 8) err.shift()
      }
    })
    .pipe(
      Effect.map((result): GitOutcome => ({
        ok: result.exitCode === 0,
        stdout: out.join('\n').trim(),
        stderr: err.join(' ').trim()
      })),
      Effect.catchAll((e) =>
        Effect.succeed({
          ok: false,
          stdout: '',
          stderr: e._tag === 'BinaryMissing' ? `git is not installed in the box` : e.reason
        })
      )
    )
}

export interface PrepareReposOptions {
  readonly machine: ExecMachine
  /** The agent home as the *machine* sees it. */
  readonly homeDir: string
  /** `<home>/work/<threadId>`, the conversation's working directory. */
  readonly workDir: string
  readonly handle: string
  /**
   * The thread this run belongs to (docs/build-plan-sessions.md D6). A thread is a session, so
   * every turn of one conversation shares a branch and can amend its own PR.
   */
  readonly sessionId: string
  readonly repos: ReadonlyArray<RepoSpec>
  /**
   * Env for every git exec: `gitCredentialEnv(...)` plus the `TAUT_URL` / `TAUT_TOKEN` the
   * credential helper needs. Without them a private repository simply fails to clone, which
   * is a dropped repository, not a failed task.
   */
  readonly env: Readonly<Record<string, string>>
}

/**
 * Clone-if-missing, fetch, and put a worktree of every granted repository under the task's
 * work dir. Returns only the ones that made it — a repository that failed anywhere is logged
 * and dropped, so it never reaches the instruction file and the agent is never told about a
 * checkout it does not have.
 */
export const prepareRepos = (o: PrepareReposOptions): Effect.Effect<ReadonlyArray<PreparedRepo>> =>
  Effect.forEach(o.repos, (repo) => prepareRepo(o, repo)).pipe(
    Effect.map((prepared) => prepared.filter((p): p is PreparedRepo => p !== undefined))
  )

const prepareRepo = (
  o: PrepareReposOptions,
  repo: RepoSpec
): Effect.Effect<PreparedRepo | undefined> =>
  Effect.gen(function* () {
    const fullName = `${repo.owner}/${repo.name}`
    const primaryDir = primaryDirOf(o.homeDir, repo)
    const worktreeDir = worktreeDirOf(o.workDir, repo)
    const branch =
      repo.mode === 'rw' ? sessionBranch(o.handle, o.sessionId) : `origin/${repo.defaultBranch}`
    const drop = (reason: string) =>
      Effect.logWarning(`repos: dropping ${fullName} — ${reason}`).pipe(Effect.as(undefined))

    // The clone is idempotent by absence: `rev-parse` inside it is the cheapest "is it there
    // and not half-written" test there is.
    const cloned = yield* sh(o.machine, isWorktreeCommand(primaryDir), o.env)
    if (!cloned.ok) {
      const clone = yield* sh(o.machine, cloneCommand(repo, primaryDir), o.env, CLONE_TIMEOUT_MS)
      if (!clone.ok)
        return yield* drop(`clone failed: ${clone.stderr || 'git clone exited non-zero'}`)
    }

    const fetched = yield* sh(o.machine, fetchCommand(primaryDir), o.env, FETCH_TIMEOUT_MS)
    if (!fetched.ok) {
      return yield* drop(`fetch failed: ${fetched.stderr || 'git fetch exited non-zero'}`)
    }

    // A worktree left behind by a crashed task keeps its registration; prune before adding so
    // the path is free.
    yield* sh(o.machine, worktreePruneCommand(primaryDir), o.env)

    const existing = yield* sh(o.machine, isWorktreeCommand(worktreeDir), o.env)
    if (!existing.ok) {
      const added = yield* addWorktree(o, repo, primaryDir, worktreeDir, branch)
      if (!added.ok) {
        return yield* drop(
          `worktree add failed: ${added.stderr || 'git worktree add exited non-zero'}`
        )
      }
    }

    if (repo.mode === 'rw') yield* installPrePush(o, repo, worktreeDir)
    return { repo, primaryDir, worktreeDir, branch }
  })

/**
 * `worktree add -b <branch>`, falling back to checking the branch out when it already exists —
 * a task parked on a `taut_ask` resumes under the same id, and `-B` would reset the branch and
 * throw away whatever the first half of the task committed.
 */
const addWorktree = (
  o: PrepareReposOptions,
  repo: RepoSpec,
  primaryDir: string,
  worktreeDir: string,
  branch: string
): Effect.Effect<GitOutcome> =>
  Effect.gen(function* () {
    if (repo.mode === 'rw') {
      const exists = yield* sh(o.machine, branchExistsCommand(primaryDir, branch), o.env)
      if (exists.ok) {
        return yield* sh(
          o.machine,
          worktreeAddExistingCommand(primaryDir, worktreeDir, branch),
          o.env
        )
      }
    }
    return yield* sh(o.machine, worktreeAddCommand(primaryDir, worktreeDir, repo, branch), o.env)
  })

/**
 * Write `pre-push` into the worktree's *real* hooks directory and make it executable.
 * Best-effort like everything else: without the hook the grant is still `rw` and GitHub still
 * accepts the branch, so a failure is a warning, not a dropped repository.
 */
const installPrePush = (
  o: PrepareReposOptions,
  repo: RepoSpec,
  worktreeDir: string
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const resolved = yield* sh(o.machine, hooksPathCommand(worktreeDir), o.env)
    if (!resolved.ok || resolved.stdout.length === 0) {
      yield* Effect.logWarning(
        `repos: cannot resolve the hooks dir of ${worktreeDir}; the default-branch guard is not installed`
      )
      return
    }
    // `--git-path` answers relative to the repository when the path is inside it.
    const hooksDir = resolved.stdout.startsWith('/')
      ? resolved.stdout
      : posix.join(worktreeDir, resolved.stdout)
    const hookPath = posix.join(hooksDir, PRE_PUSH_HOOK)
    const written = yield* o.machine
      .putFile(hookPath, prePushHook(repo.defaultBranch))
      .pipe(Effect.either)
    if (written._tag === 'Left') {
      yield* Effect.logWarning(`repos: cannot write ${hookPath}: ${written.left.reason}`)
      return
    }
    const chmod = yield* sh(o.machine, ['chmod', PRE_PUSH_MODE, hookPath], o.env)
    if (!chmod.ok) {
      yield* Effect.logWarning(
        `repos: cannot make ${hookPath} executable: ${chmod.stderr || 'chmod exited non-zero'}`
      )
    }
  })

/**
 * Take the task's worktrees down. A `rw` branch carrying commits `origin/<default>` has not
 * seen is **left alone** — that is work the agent has not pushed yet, and removing it would
 * delete it; the branch name is logged and the next run's `prune` picks it up once it is
 * pushed. Pruning always runs, so a worktree removed by hand never leaves a stale entry.
 */
export const teardownRepos = (
  machine: ExecMachine,
  prepared: ReadonlyArray<PreparedRepo>,
  env: Readonly<Record<string, string>>
): Effect.Effect<void> =>
  Effect.forEach(
    prepared,
    (p) =>
      Effect.gen(function* () {
        const keep = p.repo.mode === 'rw' && (yield* hasUnpushedWork(machine, p, env))
        if (keep) {
          yield* Effect.logInfo(
            `repos: keeping worktree ${p.worktreeDir} — branch ${p.branch} has commits not on origin/${p.repo.defaultBranch}`
          )
        } else {
          const removed = yield* sh(
            machine,
            worktreeRemoveCommand(p.primaryDir, p.worktreeDir),
            env
          )
          if (!removed.ok) {
            yield* Effect.logWarning(
              `repos: cannot remove worktree ${p.worktreeDir}: ${removed.stderr || 'git worktree remove exited non-zero'}`
            )
          }
        }
        yield* sh(machine, worktreePruneCommand(p.primaryDir), env)
      }),
    { discard: true }
  )

/** `true` when the branch is ahead of `origin/<default>`, and when we cannot tell. */
const hasUnpushedWork = (
  machine: ExecMachine,
  p: PreparedRepo,
  env: Readonly<Record<string, string>>
): Effect.Effect<boolean> =>
  sh(machine, aheadCountCommand(p.primaryDir, p.repo, p.branch), env).pipe(
    Effect.map((outcome) => {
      if (!outcome.ok) return true
      const ahead = Number.parseInt(outcome.stdout, 10)
      return !Number.isFinite(ahead) || ahead > 0
    })
  )
