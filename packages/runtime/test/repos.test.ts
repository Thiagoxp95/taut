/* eslint-disable turbo/no-undeclared-env-vars -- the integration block needs the host PATH for git */
import { Effect } from 'effect'
import { execFile } from 'node:child_process'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makeLocalProvider } from '../src/machine/local.js'
import type { Machine } from '../src/machine/types.js'
import {
  GIT_CREDENTIAL_CONFIG_KEY,
  GIT_CREDENTIAL_HELPER,
  GIT_CREDENTIAL_RESET_CONFIG_KEY,
  GIT_USE_HTTP_PATH_CONFIG_KEY,
  aheadCountCommand,
  cloneCommand,
  fetchCommand,
  gitConfigEnv,
  gitCredentialEnv,
  hooksPathCommand,
  prePushHook,
  prepareRepos,
  primaryDirOf,
  sessionBranch,
  teardownRepos,
  worktreeAddCommand,
  worktreeDirOf,
  worktreeRemoveCommand
} from '../src/repos.js'
import type { RepoSpec } from '../src/repos.js'
import { onPath, specFor, tempHome } from './helpers.js'

const repo = (mode: 'ro' | 'rw'): RepoSpec => ({
  owner: 'octocat',
  name: 'hello-world',
  cloneUrl: 'https://github.com/octocat/hello-world.git',
  defaultBranch: 'main',
  mode
})

describe('worktree command construction', () => {
  it('puts the clone under <home>/repos/<owner>__<name> and the worktree under the work dir', () => {
    expect(primaryDirOf('/home/agent', repo('rw'))).toBe('/home/agent/repos/octocat__hello-world')
    expect(worktreeDirOf('/home/agent/work/tsk_1234abcd5678', repo('rw'))).toBe(
      '/home/agent/work/tsk_1234abcd5678/hello-world'
    )
  })

  it('names the branch taut/<handle>/<last 8 of the task id>', () => {
    expect(sessionBranch('bruno', 'msg_0102030405061234abcd5678')).toBe('taut/bruno/abcd5678')
    expect(sessionBranch('ana', 'msg_12345678')).toBe('taut/ana/12345678')
  })

  it('branches from origin/<default> for rw and detaches for ro', () => {
    const primary = '/home/agent/repos/octocat__hello-world'
    const work = '/home/agent/work/tsk_x/hello-world'
    expect(worktreeAddCommand(primary, work, repo('rw'), 'taut/bruno/12345678')).toEqual([
      'git',
      '-C',
      primary,
      'worktree',
      'add',
      '-b',
      'taut/bruno/12345678',
      work,
      'origin/main'
    ])
    expect(worktreeAddCommand(primary, work, repo('ro'), 'origin/main')).toEqual([
      'git',
      '-C',
      primary,
      'worktree',
      'add',
      '--detach',
      work,
      'origin/main'
    ])
  })

  it('clones blobless and fetches with --prune', () => {
    expect(cloneCommand(repo('ro'), '/p')).toEqual([
      'git',
      'clone',
      '--filter=blob:none',
      '--',
      'https://github.com/octocat/hello-world.git',
      '/p'
    ])
    expect(fetchCommand('/p')).toEqual(['git', '-C', '/p', 'fetch', '--prune', 'origin'])
    expect(worktreeRemoveCommand('/p', '/w')).toEqual([
      'git',
      '-C',
      '/p',
      'worktree',
      'remove',
      '--force',
      '/w'
    ])
    expect(aheadCountCommand('/p', repo('rw'), 'taut/bruno/1')).toEqual([
      'git',
      '-C',
      '/p',
      'rev-list',
      '--count',
      'origin/main..taut/bruno/1'
    ])
    // A worktree's `.git` is a file: the hooks dir is asked for, never assumed.
    expect(hooksPathCommand('/w')).toEqual(['git', '-C', '/w', 'rev-parse', '--git-path', 'hooks'])
  })
})

describe('git configuration for an exec', () => {
  it('declares the credential helper and the http path through GIT_CONFIG_*', () => {
    const env = gitCredentialEnv()
    expect(env['GIT_CONFIG_COUNT']).toBe('3')
    // The reset comes first: an empty `credential.helper` clears the helpers git already
    // collected from the system and global config (macOS ships `osxkeychain` in the system
    // one), so ours is the only helper left. Out of order it would clear ours too.
    expect(env['GIT_CONFIG_KEY_0']).toBe(GIT_CREDENTIAL_RESET_CONFIG_KEY)
    expect(env['GIT_CONFIG_KEY_0']).toBe('credential.helper')
    expect(env['GIT_CONFIG_VALUE_0']).toBe('')
    expect(env['GIT_CONFIG_KEY_1']).toBe(GIT_CREDENTIAL_CONFIG_KEY)
    expect(env['GIT_CONFIG_KEY_1']).toBe('credential.https://github.com.helper')
    expect(env['GIT_CONFIG_VALUE_1']).toBe(GIT_CREDENTIAL_HELPER)
    expect(env['GIT_CONFIG_VALUE_1']).toBe('!taut git-credential')
    expect(env['GIT_CONFIG_KEY_2']).toBe(GIT_USE_HTTP_PATH_CONFIG_KEY)
    expect(env['GIT_CONFIG_VALUE_2']).toBe('true')
    // Without this git prompts on a box that has no terminal, and the clone hangs.
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0')
  })

  it('appends to an existing GIT_CONFIG_COUNT instead of clobbering it', () => {
    const base = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'someone'
    }
    const env = gitCredentialEnv(base)
    expect(env['GIT_CONFIG_COUNT']).toBe('4')
    expect(env['GIT_CONFIG_KEY_0']).toBeUndefined()
    expect(env['GIT_CONFIG_KEY_1']).toBe(GIT_CREDENTIAL_RESET_CONFIG_KEY)
    expect(env['GIT_CONFIG_KEY_2']).toBe(GIT_CREDENTIAL_CONFIG_KEY)
    expect(env['GIT_CONFIG_KEY_3']).toBe(GIT_USE_HTTP_PATH_CONFIG_KEY)
    expect({ ...base, ...env }['GIT_CONFIG_KEY_0']).toBe('user.name')
  })

  it('treats a nonsense count as zero rather than producing a gap', () => {
    expect(gitConfigEnv([['a.b', 'c']], { GIT_CONFIG_COUNT: 'x' })['GIT_CONFIG_COUNT']).toBe('1')
  })
})

describe('pre-push hook', () => {
  const hook = prePushHook('main')

  it('is a shell script that refuses only the default branch', () => {
    expect(hook.startsWith('#!/bin/sh')).toBe(true)
    expect(hook).toContain("protected='refs/heads/main'")
    expect(hook).toContain('while read -r _local_ref _local_sha remote_ref _remote_sha; do')
    expect(hook).toContain('if [ "$remote_ref" = "$protected" ]; then')
    expect(hook).toContain('exit 1')
    expect(hook.trimEnd().endsWith('exit 0')).toBe(true)
  })

  it('names github_open_pr in its one-line message', () => {
    expect(hook).toContain('github_open_pr')
    expect(hook).toContain('refusing to push')
  })

  it('single-quotes the branch name, so a hostile one cannot break out', () => {
    expect(prePushHook("main';rm -rf /;'")).toContain(
      `protected='refs/heads/main'\\'';rm -rf /;'\\'''`
    )
  })
})

// ---------------------------------------------------------------------------
// The real thing: a local provider, a real git, a real worktree.
// ---------------------------------------------------------------------------

const exec = promisify(execFile)
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  exec('git', [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Taut',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'Taut',
      GIT_COMMITTER_EMAIL: 't@example.com'
    }
  })

describe.runIf(onPath('git'))('prepareRepos / teardownRepos against real git', () => {
  let home = ''
  let cleanup = async () => {}
  let machine: Machine
  let origin = ''
  let spec: RepoSpec
  const sessionId = 'msg_0102030412345678'
  const workDir = () => join(home, 'work', sessionId)

  beforeAll(async () => {
    ;({ home, cleanup } = await tempHome())
    origin = join(home, 'origin.git')
    const seed = join(home, 'seed')
    await mkdir(seed, { recursive: true })
    await git(home, 'init', '--bare', '--initial-branch=main', origin)
    await git(home, 'init', '--initial-branch=main', seed)
    await writeFile(join(seed, 'README.md'), '# hello\n')
    await git(seed, 'add', '.')
    await git(seed, 'commit', '-m', 'init')
    await git(seed, 'remote', 'add', 'origin', origin)
    await git(seed, 'push', 'origin', 'main')
    spec = {
      owner: 'octocat',
      name: 'hello-world',
      cloneUrl: `file://${origin}`,
      defaultBranch: 'main',
      mode: 'rw'
    }
    await mkdir(workDir(), { recursive: true })
    const provider = makeLocalProvider({ hostEnv: { PATH: process.env['PATH'] } })
    machine = await Effect.runPromise(provider.ensure(specFor(home)))
  }, 60_000)

  afterAll(async () => {
    await cleanup()
  })

  const prepare = (mode: 'ro' | 'rw') =>
    Effect.runPromise(
      prepareRepos({
        machine,
        homeDir: machine.paths.home,
        workDir: workDir(),
        handle: 'bruno',
        sessionId,
        repos: [{ ...spec, mode }],
        env: {}
      })
    )

  it('clones once, worktrees the task branch and installs an executable pre-push hook', async () => {
    const prepared = await prepare('rw')
    expect(prepared).toHaveLength(1)
    const p = prepared[0]!
    expect(p.branch).toBe('taut/bruno/12345678')
    expect(p.primaryDir).toBe(join(machine.paths.home, 'repos', 'octocat__hello-world'))
    expect(p.worktreeDir).toBe(join(workDir(), 'hello-world'))
    expect((await stat(join(p.worktreeDir, 'README.md'))).isFile()).toBe(true)

    // The worktree's `.git` is a file pointing into the clone, exactly why the hooks path
    // has to be resolved rather than guessed.
    expect((await stat(join(p.worktreeDir, '.git'))).isFile()).toBe(true)
    const hook = join(p.primaryDir, '.git', 'hooks', 'pre-push')
    const mode = (await stat(hook)).mode & 0o777
    expect(mode).toBe(0o755)

    const branch = await git(p.worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD')
    expect(branch.stdout.trim()).toBe('taut/bruno/12345678')
  }, 60_000)

  it('refuses a push of the default branch and lets the task branch through', async () => {
    const worktree = join(workDir(), 'hello-world')
    await writeFile(join(worktree, 'note.txt'), 'work\n')
    await git(worktree, 'add', '.')
    await git(worktree, 'commit', '-m', 'work')

    await expect(git(worktree, 'push', 'origin', 'HEAD:refs/heads/main')).rejects.toThrow(
      /refusing to push main/
    )
    await git(worktree, 'push', 'origin', 'HEAD:refs/heads/taut/bruno/12345678')
    const refs = await git(origin, 'branch', '--list')
    expect(refs.stdout).toContain('taut/bruno/12345678')
  }, 60_000)

  it('keeps a worktree whose branch is ahead of origin/<default>', async () => {
    const prepared = await prepare('rw')
    await Effect.runPromise(teardownRepos(machine, prepared, {}))
    // One commit ahead of origin/main → left standing, unpushed work is never deleted.
    expect((await stat(join(workDir(), 'hello-world'))).isDirectory()).toBe(true)
  }, 60_000)

  it('removes a read-only worktree on teardown', async () => {
    const other = join(home, 'work', 'tsk_readonly')
    await mkdir(other, { recursive: true })
    const prepared = await Effect.runPromise(
      prepareRepos({
        machine,
        homeDir: machine.paths.home,
        workDir: other,
        handle: 'bruno',
        sessionId: 'tsk_readonly',
        repos: [{ ...spec, mode: 'ro' }],
        env: {}
      })
    )
    expect(prepared).toHaveLength(1)
    expect(prepared[0]!.branch).toBe('origin/main')
    const head = await git(prepared[0]!.worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD')
    expect(head.stdout.trim()).toBe('HEAD') // detached
    await Effect.runPromise(teardownRepos(machine, prepared, {}))
    await expect(stat(prepared[0]!.worktreeDir)).rejects.toThrow()
  }, 60_000)

  it('drops a repository that cannot be cloned instead of failing', async () => {
    const other = join(home, 'work', 'tsk_broken')
    await mkdir(other, { recursive: true })
    const prepared = await Effect.runPromise(
      prepareRepos({
        machine,
        homeDir: machine.paths.home,
        workDir: other,
        handle: 'bruno',
        sessionId: 'tsk_broken',
        repos: [
          { ...spec, owner: 'nobody', name: 'nowhere', cloneUrl: `file://${home}/absent.git` }
        ],
        env: {}
      })
    )
    expect(prepared).toEqual([])
  }, 60_000)
})
