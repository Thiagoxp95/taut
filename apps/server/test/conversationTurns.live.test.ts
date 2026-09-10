/** Opt in with TAUT_TEST_CONVERSATION=1; uses the host Claude login in an isolated workspace. */
import { layer } from '@effect/vitest'
import { Effect } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { Scheduler } from '../src/agents/scheduler.js'
import { Messages } from '../src/services/messages.js'
import { Tasks } from '../src/services/tasks.js'
import { makeClient } from './_client.js'
import { makeTempDir, removeDir, testApp } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

describe.skipIf(process.env['TAUT_TEST_CONVERSATION'] !== '1')('real two-agent discussion', () => {
  layer(testApp(dir, { TAUT_DEV_HOST_LOGIN: 'true' }), { excludeTestServices: true })((it) => {
    it.effect(
      'debates A/B, reports one decision, and acknowledges with a reaction',
      () =>
        Effect.gen(function* () {
          const owner = yield* makeClient
          yield* owner.api.auth.signup({
            payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
          })
          const avatar = { kind: 'emoji', value: 'A' } as const
          const company = yield* owner.api.companies.create({
            payload: { slug: 'discussion-test', name: 'Discussion test', avatar }
          })
          const me = yield* owner.api.auth.me()
          const department = yield* owner.api.departments.create({
            payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
          })
          for (const [handle, mandate] of [
            [
              'speed',
              'You care about shipping quickly. Initially make the strongest case for option A, then consider your colleague’s objections honestly.'
            ],
            [
              'cost',
              'You care about low ongoing cost. Initially make the strongest case for option B, then consider your colleague’s objections honestly.'
            ]
          ]) {
            yield* owner.api.agents.create({
              payload: {
                handle: handle!,
                name: handle!,
                avatar,
                role: 'Discusses product choices',
                mandate: mandate!,
                runtimeKind: 'claude-code',
                permissionMode: 'plan',
                departmentId: department.id
              }
            })
          }
          const channels = yield* owner.api.channels.list({ urlParams: {} })
          const channel = channels.items.find((c) => c.name === 'engineering')!
          const root = yield* owner.api.messages.create({
            payload: {
              channelId: channel.id,
              body: '@speed @cost Discuss which is better: A ships in one day and costs $100/month; B ships in three days and costs $10/month. We need to ship within a week and care most about annual cost. Compare your arguments and reach agreement. Once you agree, only one of you reports the result to me, starting with "Decision:"; the other gives that message a thumbs up. Keep each turn to two sentences.'
            }
          })
          const scheduler = yield* Scheduler
          const tasks = yield* Tasks
          const messages = yield* Messages
          let quiet = 0
          for (let n = 0; n < 240; n++) {
            yield* Effect.sleep('1 second')
            const running = yield* scheduler.runningTaskIds
            const thread = yield* messages.recent(company.id, channel.id, root.id, 30)
            quiet =
              running.length === 0 && thread.some((m) => m.authorKind === 'agent') ? quiet + 1 : 0
            if (quiet >= 2) break
          }
          const thread = yield* messages.recent(company.id, channel.id, root.id, 30)
          const replies = thread.filter((m) => m.authorKind === 'agent')
          const transcript = replies
            .map((m) => `${m.authorId}: ${m.body} ${m.reactions.map((r) => r.emoji).join('')}`)
            .join('\n')
          console.log(`Live discussion transcript:\n${transcript}`)
          expect(yield* scheduler.runningTaskIds, transcript).toEqual([])
          const list = yield* owner.api.tasks.list({ urlParams: { channelId: channel.id } })
          expect(
            list.items.every((t) => t.status === 'done'),
            transcript
          ).toBe(true)
          expect(
            replies.every((m) => m.status === 'sent'),
            transcript
          ).toBe(true)
          const conclusions = replies.filter((m) => /Decision:/i.test(m.body))
          expect(replies.length, transcript).toBeGreaterThanOrEqual(3)
          expect(conclusions, transcript).toHaveLength(1)
          const conclusion = conclusions[0]!
          expect(replies.at(-1)?.id, transcript).toBe(conclusion.id)
          expect(new Set(replies.slice(0, -1).map((m) => m.authorId)).size, transcript).toBe(2)
          expect(conclusion.body, transcript).toMatch(/Decision:[^\n]*\bB\b/i)
          expect(
            conclusion.reactions.some(
              (r) =>
                r.emoji === '👍' &&
                r.members.some((m) => m.kind === 'agent' && m.id !== conclusion.authorId)
            ),
            transcript
          ).toBe(true)
          expect(replies.length, transcript).toBeLessThan(10)
          expect((yield* tasks.live()).length).toBe(0)
        }),
      { timeout: 260_000 }
    )
  })
})
