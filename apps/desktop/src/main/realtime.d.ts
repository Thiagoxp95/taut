import { Effect, Stream } from 'effect'
import { Store } from './store'
declare const Realtime_base: Effect.Service.Class<
  Realtime,
  'Realtime',
  {
    readonly scoped: Effect.Effect<
      {
        /** Every event the socket delivered, in order. Consumed once, by the shell. */
        readonly events: Stream.Stream<
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'message.created'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly message: import('@taut/contract/domain').Message
                readonly mentions?:
                  | readonly {
                      readonly handle: string
                      readonly memberKind: 'user' | 'agent'
                      readonly memberId:
                        | (string & import('effect/Brand').Brand<'UserId'>)
                        | (string & import('effect/Brand').Brand<'AgentId'>)
                    }[]
                  | undefined
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'message.updated'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly message: import('@taut/contract/domain').Message
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'message.deleted'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly channelId: string & import('effect/Brand').Brand<'ChannelId'>
                readonly messageId: string & import('effect/Brand').Brand<'MessageId'>
                readonly threadId?: (string & import('effect/Brand').Brand<'MessageId'>) | undefined
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'agent.task.started'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly message: import('@taut/contract/domain').Message
                readonly task: import('@taut/contract/domain').Task
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'agent.task.delta'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly messageId: string & import('effect/Brand').Brand<'MessageId'>
                readonly taskId: string & import('effect/Brand').Brand<'TaskId'>
                readonly delta: string
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'agent.task.done'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly message: import('@taut/contract/domain').Message
                readonly task: import('@taut/contract/domain').Task
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'agent.task.failed'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly message: import('@taut/contract/domain').Message
                readonly error: string
                readonly task: import('@taut/contract/domain').Task
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'presence.changed'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload:
                | {
                    readonly state: 'online' | 'away' | 'offline'
                    readonly memberKind: 'user'
                    readonly memberId: string & import('effect/Brand').Brand<'UserId'>
                  }
                | {
                    readonly state: 'idle' | 'working'
                    readonly memberKind: 'agent'
                    readonly memberId: string & import('effect/Brand').Brand<'AgentId'>
                  }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'typing'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly channelId: string & import('effect/Brand').Brand<'ChannelId'>
                readonly userId: string & import('effect/Brand').Brand<'UserId'>
                readonly threadId?: (string & import('effect/Brand').Brand<'MessageId'>) | undefined
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'notification'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly notification: import('@taut/contract/domain').Notification
                readonly channelId?:
                  (string & import('effect/Brand').Brand<'ChannelId'>) | undefined
                readonly messageId?:
                  (string & import('effect/Brand').Brand<'MessageId'>) | undefined
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'unread.changed'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly channelId: string & import('effect/Brand').Brand<'ChannelId'>
                readonly userId: string & import('effect/Brand').Brand<'UserId'>
                readonly threadId?: (string & import('effect/Brand').Brand<'MessageId'>) | undefined
                readonly mentions: number
                readonly unread: number
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'membership.created'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly user: import('@taut/contract/domain').User
                readonly membership: import('@taut/contract/domain').Membership
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'membership.updated'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly membership: import('@taut/contract/domain').Membership
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'membership.deleted'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly userId: string & import('effect/Brand').Brand<'UserId'>
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'company.updated'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly company: import('@taut/contract/domain').Company
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'company.deleted'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'department.created'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly department: import('@taut/contract/domain').Department
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'department.updated'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly department: import('@taut/contract/domain').Department
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'department.deleted'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly departmentId: string & import('effect/Brand').Brand<'DepartmentId'>
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'channel.created'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly channel: import('@taut/contract/domain').Channel
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'channel.updated'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly channel: import('@taut/contract/domain').Channel
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'channel.deleted'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly channelId: string & import('effect/Brand').Brand<'ChannelId'>
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'agent.created'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly agent: import('@taut/contract/domain').Agent
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'agent.updated'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly agent: import('@taut/contract/domain').Agent
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'agent.deleted'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly agentId: string & import('effect/Brand').Brand<'AgentId'>
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'agent.skill.changed'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly skill: import('@taut/contract/domain').AgentSkill
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'agent.skill.removed'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly name: string
                readonly agentId: string & import('effect/Brand').Brand<'AgentId'>
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'vault.item.created'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly item: import('@taut/contract/domain').VaultItemMeta
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'vault.item.updated'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly item: import('@taut/contract/domain').VaultItemMeta
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'vault.item.revoked'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly vaultItemId: string & import('effect/Brand').Brand<'VaultItemId'>
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'subscription.created'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly subscription: import('@taut/contract/domain').Subscription
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'subscription.updated'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly subscription: import('@taut/contract/domain').Subscription
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'subscription.deleted'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly subscriptionId: string & import('effect/Brand').Brand<'SubscriptionId'>
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'task.updated'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly task: import('@taut/contract/domain').Task
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'routine.created'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly routine: import('@taut/contract/domain').Routine
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'routine.updated'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly routine: import('@taut/contract/domain').Routine
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'routine.deleted'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly agentId: string & import('effect/Brand').Brand<'AgentId'>
                readonly routineId: string & import('effect/Brand').Brand<'RoutineId'>
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'repository.attached'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly repository: import('@taut/contract/domain').Repository
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'repository.detached'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly repositoryId: string & import('effect/Brand').Brand<'RepositoryId'>
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'repository.github.changed'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly connection: import('@taut/contract/domain').GithubConnection
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'repository.grant.changed'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly mode: 'ro' | 'rw'
                readonly agentId: string & import('effect/Brand').Brand<'AgentId'>
                readonly repositoryId: string & import('effect/Brand').Brand<'RepositoryId'>
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'repository.grant.revoked'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly agentId: string & import('effect/Brand').Brand<'AgentId'>
                readonly repositoryId: string & import('effect/Brand').Brand<'RepositoryId'>
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'project.synced'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly count: number
                readonly syncedAt: import('effect/DateTime').Utc
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'project.linear.changed'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly connection: import('@taut/contract/domain').LinearConnection
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'call.started'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly call: import('@taut/contract/domain').Call
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'call.updated'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly call: import('@taut/contract/domain').Call
              }
            }
          | {
              readonly at: import('effect/DateTime').Utc
              readonly type: 'call.ended'
              readonly companyId: string & import('effect/Brand').Brand<'CompanyId'>
              readonly seq: number
              readonly payload: {
                readonly channelId: string & import('effect/Brand').Brand<'ChannelId'>
                readonly endedAt: import('effect/DateTime').Utc
                readonly callId: string & import('effect/Brand').Brand<'CallId'>
              }
            },
          never,
          never
        >
        readonly connect: (
          instanceUrl: string,
          partition: string
        ) => Effect.Effect<void, never, never>
        readonly stop: Effect.Effect<void, never, never>
      },
      never,
      Store | import('effect/Scope').Scope
    >
    readonly dependencies: readonly [import('effect/Layer').Layer<Store, never, never>]
  }
>
/**
 * The shell's own `/ws` connection — the same socket the web client opens
 * (docs/agent-model.md §8), but held by the main process so notifications and
 * the dock badge survive the window being hidden or the renderer being busy.
 *
 * Authentication is the instance's `taut_session` cookie, read out of the
 * window's `persist:taut` partition and replayed as a `Cookie` header. Before
 * the user logs in there is no cookie and the upgrade is refused with 401 —
 * which is not an error, just "not yet", so every failure retries on the same
 * capped, jittered backoff and the socket comes up on its own once login lands.
 */
export declare class Realtime extends Realtime_base {}
export {}
