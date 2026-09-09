import { describe, expect, it } from '@effect/vitest'
import { DateTime, Schema } from 'effect'

import { Call } from '../src/domain/call.js'
import { Message } from '../src/domain/message.js'
import { IssueState, ProjectIssue } from '../src/domain/project.js'
import { TimeOfDay } from '../src/domain/schedule.js'
import { Task } from '../src/domain/task.js'
import {
  Trigger,
  describeTrigger,
  matchesEvent,
  validateTrigger,
  type EventTrigger,
  type Trigger as TriggerT
} from '../src/domain/trigger.js'
import type { Event } from '../src/events.js'
import {
  AgentId,
  CallId,
  ChannelId,
  CompanyId,
  MessageId,
  ProjectId,
  ProjectIssueId,
  TaskId,
  UserId
} from '../src/ids.js'

const at = DateTime.unsafeMake('2026-09-09T15:42:00.000Z')
const companyId = CompanyId.make('cmp_acme')
const design = ChannelId.make('chn_design')
const support = ChannelId.make('chn_support')
const root = MessageId.make('msg_root')
const nova = AgentId.make('agt_nova')
const bruno = AgentId.make('agt_bruno')
const tedy = UserId.make('usr_tedy')
const taut = ProjectId.make('prj_taut')
const linear = ProjectId.make('prj_linear')

/** Every event below carries the same envelope; only `type`/`payload` reach `matchesEvent`. */
const envelope = { seq: 1, companyId, at }

const message = (fields: {
  readonly channelId: ChannelId
  readonly body: string
  readonly authorKind?: 'user' | 'agent'
  readonly threadId?: MessageId
}) =>
  new Message({
    id: MessageId.make('msg_1'),
    companyId,
    channelId: fields.channelId,
    threadId: fields.threadId,
    authorKind: fields.authorKind ?? 'user',
    authorId: fields.authorKind === 'agent' ? nova : tedy,
    body: fields.body,
    status: 'sent',
    seq: 1,
    createdAt: at
  })

const messageCreated = (fields: Parameters<typeof message>[0]): Event => ({
  ...envelope,
  type: 'message.created',
  payload: { message: message(fields) }
})

const callEnded = (channelId: ChannelId): Event => ({
  ...envelope,
  type: 'call.ended',
  payload: { callId: CallId.make('cal_1'), channelId, endedAt: at }
})

const callStarted = (channelId: ChannelId): Event => ({
  ...envelope,
  type: 'call.started',
  payload: {
    call: new Call({
      id: CallId.make('cal_1'),
      companyId,
      channelId,
      room: `huddle_${channelId}`,
      startedByKind: 'user',
      startedById: tedy,
      startedAt: at
    })
  }
})

const taskFailed = (agentId: AgentId): Event => ({
  ...envelope,
  type: 'agent.task.failed',
  payload: {
    task: new Task({
      id: TaskId.make('tsk_1'),
      companyId,
      agentId,
      channelId: design,
      threadId: root,
      messageId: MessageId.make('msg_out'),
      status: 'failed',
      startedAt: at
    }),
    message: message({ channelId: design, body: 'boom' }),
    error: 'boom'
  }
})

const issueCreated = (projectId: ProjectId): Event => ({
  ...envelope,
  type: 'project.issue.created',
  payload: {
    projectId,
    issue: new ProjectIssue({
      id: ProjectIssueId.make('pis_1'),
      projectId,
      linearId: 'a1b2',
      identifier: 'ENG-1',
      title: 'Triggers never fire',
      state: new IssueState({ id: 'st_1', name: 'Todo', type: 'unstarted', position: 1 }),
      priority: 2,
      labels: [],
      url: 'https://linear.app/taut/issue/ENG-1',
      sortOrder: 1,
      syncedAt: at
    })
  }
})

/** Names as the web supplies them; the server passes nothing and prints raw ids instead. */
const names = (id: string): string | undefined =>
  ({ [design]: '#design', [support]: '#support', [nova]: '@nova', [taut]: 'Taut' })[id]

describe('matchesEvent', () => {
  it('fires on the event whose name is the trigger tag, and on nothing else (D3)', () => {
    const trigger: EventTrigger = { _tag: 'call.started', channelIds: [design] }
    expect(matchesEvent(trigger, callStarted(design))).toBe(true)
    // same channel, wrong event
    expect(matchesEvent(trigger, callEnded(design))).toBe(false)
    expect(matchesEvent(trigger, messageCreated({ channelId: design, body: 'hi' }))).toBe(false)
  })

  it('call.ended: the channel and minSeconds both have to pass', () => {
    const trigger: EventTrigger = { _tag: 'call.ended', channelIds: [design], minSeconds: 60 }
    expect(matchesEvent(trigger, callEnded(design), { callDurationSeconds: 1440 })).toBe(true)
    // a misclick is not a meeting
    expect(matchesEvent(trigger, callEnded(design), { callDurationSeconds: 20 })).toBe(false)
    expect(matchesEvent(trigger, callEnded(support), { callDurationSeconds: 1440 })).toBe(false)
    // the event does not carry a duration, so an unsupplied one cannot clear the bar
    expect(matchesEvent(trigger, callEnded(design))).toBe(false)
    // …which only matters while the filter is on
    expect(
      matchesEvent({ _tag: 'call.ended', channelIds: [], minSeconds: 0 }, callEnded(support))
    ).toBe(true)
  })

  it('an empty channelIds matches every channel', () => {
    const trigger: EventTrigger = { _tag: 'call.started', channelIds: [] }
    expect(matchesEvent(trigger, callStarted(design))).toBe(true)
    expect(matchesEvent(trigger, callStarted(support))).toBe(true)
  })

  it('message.created: channel, author kind and thread replies', () => {
    const trigger: EventTrigger = {
      _tag: 'message.created',
      channelIds: [support],
      authorKinds: ['user'],
      includeThreadReplies: false
    }
    expect(matchesEvent(trigger, messageCreated({ channelId: support, body: 'help' }))).toBe(true)
    expect(matchesEvent(trigger, messageCreated({ channelId: design, body: 'help' }))).toBe(false)
    // an agent's post does not match a people-only filter
    const byAgent = messageCreated({ channelId: support, body: 'help', authorKind: 'agent' })
    expect(matchesEvent(trigger, byAgent)).toBe(false)
    expect(matchesEvent({ ...trigger, authorKinds: ['agent'] }, byAgent)).toBe(true)
    // a thread reply is not a post
    const reply = messageCreated({ channelId: support, body: 'help', threadId: root })
    expect(matchesEvent(trigger, reply)).toBe(false)
    expect(matchesEvent({ ...trigger, includeThreadReplies: true }, reply)).toBe(true)
  })

  it('message.created: `containing` is a case-insensitive substring', () => {
    const trigger: EventTrigger = {
      _tag: 'message.created',
      channelIds: [support],
      authorKinds: ['user'],
      containing: 'refund',
      includeThreadReplies: false
    }
    const said = (body: string) =>
      matchesEvent(trigger, messageCreated({ channelId: support, body }))
    expect(said('Please REFUND me')).toBe(true)
    expect(said('a refunded order')).toBe(true)
    expect(said('ship it')).toBe(false)
  })

  it('agent.task.failed: watching yourself is allowed — D6 blocks the actor, and there is none', () => {
    const watchNova: EventTrigger = { _tag: 'agent.task.failed', agentIds: [nova] }
    expect(matchesEvent(watchNova, taskFailed(nova))).toBe(true)
    expect(matchesEvent(watchNova, taskFailed(bruno))).toBe(false)
    expect(matchesEvent({ _tag: 'agent.task.failed', agentIds: [] }, taskFailed(bruno))).toBe(true)
  })

  it('project.issue.created: filters on the project the issue landed in', () => {
    const watchTaut: EventTrigger = { _tag: 'project.issue.created', projectIds: [taut] }
    expect(matchesEvent(watchTaut, issueCreated(taut))).toBe(true)
    expect(matchesEvent(watchTaut, issueCreated(linear))).toBe(false)
    expect(
      matchesEvent({ _tag: 'project.issue.created', projectIds: [] }, issueCreated(linear))
    ).toBe(true)
  })
})

describe('describeTrigger', () => {
  it('prints ids without `names` and labels with them', () => {
    const trigger: TriggerT = {
      _tag: 'event',
      event: { _tag: 'call.ended', channelIds: [design], minSeconds: 60 }
    }
    expect(describeTrigger(trigger)).toBe('When a huddle ends in chn_design (over 1 min)')
    expect(describeTrigger(trigger, names)).toBe('When a huddle ends in #design (over 1 min)')
  })

  it('says each event kind in one sentence', () => {
    const say = (event: EventTrigger) => describeTrigger({ _tag: 'event', event }, names)
    expect(say({ _tag: 'call.ended', channelIds: [], minSeconds: 0 })).toBe('When a huddle ends')
    expect(say({ _tag: 'call.started', channelIds: [design] })).toBe(
      'When a huddle starts in #design'
    )
    expect(
      say({
        _tag: 'message.created',
        channelIds: [support],
        authorKinds: ['user'],
        includeThreadReplies: false
      })
    ).toBe('When anyone posts in #support')
    expect(
      say({
        _tag: 'message.created',
        channelIds: [support, design],
        authorKinds: ['user', 'agent'],
        containing: 'refund',
        includeThreadReplies: true
      })
    ).toBe(
      'When anyone or an agent posts in #support and #design containing "refund", including thread replies'
    )
    expect(say({ _tag: 'agent.task.failed', agentIds: [] })).toBe("When any agent's run fails")
    expect(say({ _tag: 'agent.task.failed', agentIds: [nova] })).toBe("When @nova's run fails")
    expect(say({ _tag: 'project.issue.created', projectIds: [] })).toBe(
      'When an issue is filed in any project'
    )
    expect(say({ _tag: 'project.issue.created', projectIds: [taut] })).toBe(
      'When an issue is filed in Taut'
    )
  })

  it('the schedule arm is `describeSchedule`, unchanged', () => {
    const trigger: TriggerT = {
      _tag: 'schedule',
      schedule: { _tag: 'weekly', weekdays: [1, 2, 3, 4, 5], times: [TimeOfDay.make('09:00')] },
      timezone: 'America/Toronto'
    }
    expect(describeTrigger(trigger)).toBe('Every weekday at 9:00 AM')
    // `names` is meaningless for a clock and must not change the sentence
    expect(describeTrigger(trigger, names)).toBe('Every weekday at 9:00 AM')
  })
})

describe('validateTrigger', () => {
  const withContaining = (containing?: string): TriggerT => ({
    _tag: 'event',
    event: {
      _tag: 'message.created',
      channelIds: [support],
      authorKinds: ['user'],
      containing,
      includeThreadReplies: false
    }
  })

  it('rejects a whitespace-only `containing`', () => {
    expect(validateTrigger(withContaining('   '))).toEqual([
      { path: ['event', 'containing'], message: 'type something to look for, or leave it empty' }
    ])
  })

  it('accepts an absent `containing` and a filled one', () => {
    expect(validateTrigger(withContaining())).toEqual([])
    expect(validateTrigger(withContaining('refund'))).toEqual([])
  })

  it('delegates the schedule arm to `validateSchedule`, under a `schedule` path', () => {
    expect(
      validateTrigger({
        _tag: 'schedule',
        schedule: { _tag: 'cron', expression: 'not a cron' },
        timezone: 'America/Toronto'
      })
    ).toEqual([
      {
        path: ['schedule', 'expression'],
        message: 'expected five fields: minute hour day month weekday'
      }
    ])
  })
})

describe('Trigger schema', () => {
  it('fills the optional filters in on decode', () => {
    expect(
      Schema.decodeUnknownSync(Trigger)({ _tag: 'event', event: { _tag: 'call.ended' } })
    ).toEqual({ _tag: 'event', event: { _tag: 'call.ended', channelIds: [], minSeconds: 60 } })
  })

  it('refuses a `message.created` trigger with no channel — the filter is mandatory', () => {
    expect(() =>
      Schema.decodeUnknownSync(Trigger)({
        _tag: 'event',
        event: { _tag: 'message.created', channelIds: [] }
      })
    ).toThrow()
  })
})
