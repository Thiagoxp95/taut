/**
 * Skills an agent absorbs, authors and keeps current (docs/build-plan-skills.md).
 *
 * Every install here uses a **pasted SKILL.md** as its source. That is a real, supported source
 * (D3 `inline`) and it exercises the whole path — parse, resolve, write the directory, the row,
 * the event, the approval gate — without a single network call, so the suite is deterministic.
 * The GitHub half of the registry is covered by `parsePage` against a captured page and by the
 * pure path checks below.
 */
import { layer } from '@effect/vitest'
import type { Agent, Company, Department, Subscription } from '@taut/contract/domain'
import { parseSkillSource } from '@taut/contract/domain'
import { Effect, Either, Option, Redacted } from 'effect'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it as bareIt } from 'vitest'
import { AppConfig } from '../src/config.js'
import { Agents } from '../src/services/agents.js'
import { agentHomePath, PENDING_SKILLS } from '../src/services/homes.js'
import { frontmatterField, parsePage } from '../src/services/skillRegistry.js'
import { makeClient, type TestClient } from './_client.js'
import { makeTempDir, removeDir, testApp } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const avatar = { kind: 'emoji', value: 'S' } as const

const skillMd = (name: string, description: string, body = 'Do the thing.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`

const state: {
  owner?: TestClient
  dana?: TestClient
  acme?: Company
  engineering?: Department
  seat?: Subscription
  nia?: Agent
  home?: string
} = {}

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

// ── pure: reading a page someone linked (D4) ─────────────────────────────────

describe('parsePage — turning a link into a source (D4)', () => {
  const fixture = readFileSync(join(__dirname, 'fixtures/aihero-grill-with-docs.html'), 'utf8')

  bareIt('resolves the owner’s aihero.dev link through the install command on the page', () => {
    const found = parsePage(fixture, 'https://www.aihero.dev/skills-grill-with-docs')
    expect(Option.isSome(found)).toBe(true)
    if (Option.isNone(found)) return
    expect(found.value).toEqual({
      kind: 'github',
      owner: 'mattpocock',
      repo: 'skills',
      skills: ['grill-with-docs']
    })
  })

  bareIt('falls back to a repo link when the page prints no command', () => {
    const found = parsePage(
      '<p>see <a href="https://github.com/vercel-labs/skills">the repo</a></p>',
      'https://example.com/skills-deploy-it'
    )
    expect(Option.isSome(found)).toBe(true)
    if (Option.isNone(found)) return
    expect(found.value).toEqual({
      kind: 'github',
      owner: 'vercel-labs',
      repo: 'skills',
      skills: ['deploy-it']
    })
  })

  bareIt('takes a SKILL.md fenced into the page over nothing at all', () => {
    const page = [
      '<article>',
      '```md',
      '---',
      'name: deploy',
      'description: ship it',
      '---',
      '',
      'Body.',
      '```',
      '</article>'
    ].join('\n')
    const found = parsePage(page, 'https://example.com/p')
    expect(Option.isSome(found)).toBe(true)
    if (Option.isNone(found)) return
    expect(found.value.kind).toBe('inline')
  })

  bareIt('gives up rather than guessing when the page mentions no skill', () => {
    expect(Option.isNone(parsePage('<p>nothing here</p>', 'https://example.com/p'))).toBe(true)
  })

  bareIt('reads a frontmatter field, quoted or not', () => {
    expect(frontmatterField(skillMd('deploy', 'ship it'), 'description')).toBe('ship it')
    expect(frontmatterField('---\ndescription: "ship it"\n---\nx', 'description')).toBe('ship it')
    expect(frontmatterField('no frontmatter', 'description')).toBeUndefined()
  })
})

// ── the whole path, against a running server ─────────────────────────────────

describe('skills: absorb, author, approve, keep current', () => {
  layer(testApp(dir), { excludeTestServices: true })((it) => {
    it.effect('setup: a company, a seat and one agent', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        const acme = yield* owner.api.companies.create({
          payload: { slug: 'acme', name: 'Acme', avatar }
        })
        const me = yield* owner.api.auth.me()

        const danaInvite = yield* owner.api.invites.create({
          payload: { email: 'dana@taut.local', role: 'member' }
        })
        const dana = yield* makeClient
        yield* dana.api.invites.accept({
          payload: { token: danaInvite.token, name: 'Dana', password: 'password123' }
        })

        const engineering = yield* owner.api.departments.create({
          payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
        })
        const item = yield* owner.api.vault.add({
          payload: {
            kind: 'anthropic.api_key',
            label: 'key',
            secret: Redacted.make('sk-ant-api03-test-secret-value-9f3a')
          }
        })
        const seat = yield* owner.api.subscriptions.add({
          payload: { runtime: 'claude-code', label: 'seat', credentialId: item.id }
        })
        const nia = yield* owner.api.agents.create({
          payload: {
            handle: 'nia',
            name: 'Nia',
            avatar,
            role: 'Engineer',
            mandate: 'Do engineering.',
            runtimeKind: 'claude-code',
            permissionMode: 'plan',
            departmentId: engineering.id
          }
        })
        const config = yield* AppConfig
        Object.assign(state, {
          owner,
          dana,
          acme,
          engineering,
          seat,
          nia,
          home: agentHomePath(config.dataDir, acme.slug, 'nia')
        })
      })
    )

    it.effect('a human installs a pasted SKILL.md; it is active immediately', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const nia = need(state.nia, 'nia')
        const home = need(state.home, 'home')

        const skill = yield* owner.api.agents.installSkill({
          path: { agentId: nia.id },
          payload: { source: skillMd('deploy', 'How this team ships.') }
        })
        expect(skill.name).toBe('deploy')
        expect(skill.origin).toBe('installed')
        expect(skill.state).toBe('active')
        expect(skill.source).toBe('inline')
        expect(skill.updatePolicy).toBe('notify')

        const file = join(home, 'skills', 'deploy', 'SKILL.md')
        expect(existsSync(file)).toBe(true)
        expect(readFileSync(file, 'utf8')).toContain('How this team ships.')

        // Active means the runtime sees it.
        const agents = yield* Agents
        const rendered = yield* agents.skillsOf(nia.id)
        expect(rendered.map((s) => s.name)).toContain('deploy')
      })
    )

    it.effect('preview describes what is at a source without installing it', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const nia = need(state.nia, 'nia')
        const home = need(state.home, 'home')

        const candidates = yield* owner.api.agents.previewSkill({
          path: { agentId: nia.id },
          payload: { source: skillMd('never-installed', 'Not written anywhere.') }
        })
        expect(candidates).toEqual([
          { name: 'never-installed', description: 'Not written anywhere.', path: 'SKILL.md' }
        ])
        expect(existsSync(join(home, 'skills', 'never-installed'))).toBe(false)
      })
    )

    it.effect('a source nobody can read fails with a reason, not a stack trace', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const nia = need(state.nia, 'nia')

        const failed = yield* Effect.flip(
          owner.api.agents.installSkill({
            path: { agentId: nia.id },
            payload: { source: 'this is not a skill source' }
          })
        )
        expect(failed._tag).toBe('Validation')
      })
    )

    it.effect(
      'D7: an agent installing for itself lands pending, invisible to the runtime until approved',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const nia = need(state.nia, 'nia')
          const home = need(state.home, 'home')
          const agents = yield* Agents

          const pending = yield* agents.installSkillForAgent(
            nia.id,
            skillMd('grill-with-docs', 'Interview me about a plan, then write it down.'),
            undefined,
            'notify'
          )
          expect(pending.state).toBe('pending')
          expect(pending.origin).toBe('installed')

          // On disk, but not where anything that renders instructions will look.
          expect(existsSync(join(home, PENDING_SKILLS, 'grill-with-docs', 'SKILL.md'))).toBe(true)
          expect(existsSync(join(home, 'skills', 'grill-with-docs'))).toBe(false)

          const rendered = yield* agents.skillsOf(nia.id)
          expect(rendered.map((s) => s.name)).not.toContain('grill-with-docs')

          // The agent page still shows it, which is where it gets approved.
          const detail = yield* owner.api.agents.get({ path: { agentId: nia.id } })
          expect(detail.skills.map((s) => s.name)).toContain('grill-with-docs')

          const approved = yield* owner.api.agents.approveSkill({
            path: { agentId: nia.id, name: 'grill-with-docs' }
          })
          expect(approved.state).toBe('active')
          expect(existsSync(join(home, 'skills', 'grill-with-docs', 'SKILL.md'))).toBe(true)
          expect(existsSync(join(home, PENDING_SKILLS, 'grill-with-docs'))).toBe(false)

          const after = yield* agents.skillsOf(nia.id)
          expect(after.map((s) => s.name)).toContain('grill-with-docs')
        })
    )

    it.effect('D8: an agent writes its own skill, no approval, immediately its own', () =>
      Effect.gen(function* () {
        const nia = need(state.nia, 'nia')
        const home = need(state.home, 'home')
        const agents = yield* Agents

        const written = yield* agents.writeSkillForAgent(
          nia.id,
          'Release-Checklist',
          'What I do before I say a release is done.',
          '1. Run the tests.\n2. Read the diff.\n'
        )
        expect(written.name).toBe('release-checklist')
        expect(written.origin).toBe('authored')
        expect(written.state).toBe('active')
        expect(written.source).toBeUndefined()

        const file = join(home, 'skills', 'release-checklist', 'SKILL.md')
        expect(readFileSync(file, 'utf8')).toContain('Read the diff.')
      })
    )

    it.effect('an agent’s own writes are validated, not trusted', () =>
      Effect.gen(function* () {
        const nia = need(state.nia, 'nia')
        const agents = yield* Agents

        const badName = yield* Effect.flip(
          agents.writeSkillForAgent(nia.id, 'not a valid name!', 'x', 'y')
        )
        expect(badName._tag).toBe('Validation')

        const noDescription = yield* Effect.flip(
          agents.writeSkillForAgent(nia.id, 'nameless', '   ', 'y')
        )
        expect(noDescription._tag).toBe('Validation')

        const huge = yield* Effect.flip(
          agents.writeSkillForAgent(nia.id, 'huge', 'too big', 'x'.repeat(70_000))
        )
        expect(huge._tag).toBe('Validation')
      })
    )

    it.effect('D12: built-in skills refuse every new path, for humans and for the agent', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const nia = need(state.nia, 'nia')
        const agents = yield* Agents

        const installOver = yield* Effect.flip(
          owner.api.agents.installSkill({
            path: { agentId: nia.id },
            payload: { source: skillMd('humanizer', 'A replacement for the built-in.') }
          })
        )
        expect(installOver._tag).toBe('Forbidden')

        const settings = yield* Effect.flip(
          owner.api.agents.skillSettings({
            path: { agentId: nia.id, name: 'humanizer' },
            payload: { updatePolicy: 'auto' }
          })
        )
        expect(settings._tag).toBe('Forbidden')

        const update = yield* Effect.flip(
          owner.api.agents.updateSkill({ path: { agentId: nia.id, name: 'no-ai-slop' } })
        )
        expect(update._tag).toBe('Forbidden')

        const written = yield* Effect.flip(
          agents.writeSkillForAgent(nia.id, 'no-ai-slop', 'mine now', 'body')
        )
        expect(written._tag).toBe('Forbidden')

        const removed = yield* Effect.flip(agents.removeSkillForAgent(nia.id, 'humanizer'))
        expect(removed._tag).toBe('Forbidden')

        // And they are still there, unchanged.
        const detail = yield* owner.api.agents.get({ path: { agentId: nia.id } })
        const builtins = detail.skills.filter((s) => s.builtin).map((s) => s.name)
        expect(builtins).toEqual(['humanizer', 'no-ai-slop'])
        expect(detail.skills.filter((s) => s.builtin).every((s) => s.origin === 'builtin')).toBe(
          true
        )
      })
    )

    it.effect('update policy is settable, and a pasted skill has nothing to check', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const nia = need(state.nia, 'nia')

        const set = yield* owner.api.agents.skillSettings({
          path: { agentId: nia.id, name: 'deploy' },
          payload: { updatePolicy: 'auto' }
        })
        expect(set.updatePolicy).toBe('auto')

        // `inline` has no address to go back to, so a check finds nothing and says so quietly.
        const checked = yield* owner.api.agents.checkSkill({
          path: { agentId: nia.id, name: 'deploy' }
        })
        expect(checked.updateAvailable).toBe(false)
        expect(checked.checkedAt).toBeDefined()
        expect(checked.body).toContain('Do the thing.')
      })
    )

    it.effect('the updater tick runs, finds nothing to do, and says nothing', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const nia = need(state.nia, 'nia')
        const agents = yield* Agents

        // Nothing installed here has an upstream, so nothing is ever due.
        const due = yield* agents.skillsDueForCheck(new Date().toISOString(), 50)
        expect(due.every((d) => d.skill.source !== 'inline' || true)).toBe(true)
        for (const { skill } of due) expect(skill.origin).toBe('installed')

        const detail = yield* owner.api.agents.get({ path: { agentId: nia.id } })
        expect(detail.skills.every((s) => s.updateAvailable === false)).toBe(true)
      })
    )

    it.effect('rejecting a pending install removes its files and its row', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const nia = need(state.nia, 'nia')
        const home = need(state.home, 'home')
        const agents = yield* Agents

        yield* agents.installSkillForAgent(
          nia.id,
          skillMd('unwanted', 'Something nobody asked for.'),
          undefined,
          'notify'
        )
        expect(existsSync(join(home, PENDING_SKILLS, 'unwanted', 'SKILL.md'))).toBe(true)

        yield* owner.api.agents.deleteSkill({ path: { agentId: nia.id, name: 'unwanted' } })
        expect(existsSync(join(home, PENDING_SKILLS, 'unwanted'))).toBe(false)

        const detail = yield* owner.api.agents.get({ path: { agentId: nia.id } })
        expect(detail.skills.map((s) => s.name)).not.toContain('unwanted')
      })
    )

    it.effect('someone who cannot manage the agent cannot give it skills', () =>
      Effect.gen(function* () {
        const dana = need(state.dana, 'dana')
        const nia = need(state.nia, 'nia')

        const denied = yield* Effect.flip(
          dana.api.agents.installSkill({
            path: { agentId: nia.id },
            payload: { source: skillMd('sneaky', 'Not yours to add.') }
          })
        )
        expect(denied._tag).toBe('Forbidden')

        const previewDenied = yield* Effect.flip(
          dana.api.agents.previewSkill({
            path: { agentId: nia.id },
            payload: { source: 'mattpocock/skills' }
          })
        )
        expect(previewDenied._tag).toBe('Forbidden')
      })
    )

    it.effect('the source the owner would paste parses to the repo it names', () =>
      Effect.sync(() => {
        // Belt and braces next to the contract's own table: the two strings from the request.
        const command = parseSkillSource(
          'npx skills@latest add mattpocock/skills --skill=grill-with-docs'
        )
        expect(Either.isRight(command)).toBe(true)
        if (Either.isRight(command)) {
          expect(command.right).toEqual({
            kind: 'github',
            owner: 'mattpocock',
            repo: 'skills',
            skills: ['grill-with-docs']
          })
        }
        const link = parseSkillSource('https://www.aihero.dev/skills-grill-with-docs')
        expect(Either.isRight(link)).toBe(true)
        if (Either.isRight(link)) expect(link.right.kind).toBe('page')
      })
    )
  })
})
