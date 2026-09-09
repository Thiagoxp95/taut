import { NodeContext } from '@effect/platform-node'
import type { MachineProviderTag } from '@taut/runtime'
import { Effect, Layer } from 'effect'
import { AgentApi } from './agents/agentApi.js'
import { MemoryIngest } from './agents/memoryIngest.js'
import { MachineProviderFromConfig } from './agents/provider.js'
import { RoutineRunner } from './agents/routineRunner.js'
import { SignalRunner } from './agents/signalRunner.js'
import { TriggerContext } from './agents/triggerContext.js'
import { TriggerRunner } from './agents/triggerRunner.js'
import { SkillUpdater } from './agents/skillUpdater.js'
import { TaskRunner } from './agents/runTask.js'
import { Scheduler } from './agents/scheduler.js'
import { AgentSessions } from './agents/sessions.js'
import { TaskTokens } from './agents/tokens.js'
import { Sessions } from './auth/sessions.js'
import { WsAuthenticatorLive } from './auth/wsAuthenticator.js'
import { AppConfig } from './config.js'
import { DbLive } from './db/migrator.js'
import { AgentRuntimeLive } from './http/agentRuntime.js'
import { HttpLive, HttpNodeServer } from './http/server.js'
import { PushNotifier } from './push/notifier.js'
import { PushSender } from './push/sender.js'
import { Bus } from './realtime/bus.js'
import { EventLog } from './realtime/eventLog.js'
import { TerminalLimits, type TerminalLimitsShape } from './realtime/terminalLimits.js'
import { TerminalWsServer } from './realtime/terminalWs.js'
import { WsServer } from './realtime/ws.js'
import { Agents } from './services/agents.js'
import { Attachments } from './services/attachments.js'
import { Auth } from './services/auth.js'
import { Calls } from './services/calls.js'
import { Channels } from './services/channels.js'
import { Companies } from './services/companies.js'
import { Departments } from './services/departments.js'
import { Handovers } from './services/handovers.js'
import { AgentHomes } from './services/homes.js'
import { Invites } from './services/invites.js'
import { Messages } from './services/messages.js'
import { EventPublisher } from './services/publisher.js'
import { GitHubApp } from './services/githubApp.js'
import { Linear } from './services/linear.js'
import { PushDevices } from './services/pushDevices.js'
import { Reactions } from './services/reactions.js'
import { Projects } from './services/projects.js'
import { Repositories } from './services/repositories.js'
import { SkillRegistry } from './services/skillRegistry.js'
import { Routines } from './services/routines.js'
import { Signals } from './services/signals.js'
import { RuntimeDetector } from './services/runtimeDetector.js'
import { Search } from './services/search.js'
import { ModelCatalogs } from './services/modelCatalog.js'
import { ThreadContexts } from './services/threadContext.js'
import { Subscriptions } from './services/subscriptions.js'
import { Tasks } from './services/tasks.js'
import { UsageProbe } from './services/usageProbe.js'
import { Users } from './services/users.js'
import { Vault } from './services/vault.js'
import { Workspace } from './services/workspace.js'

/**
 * Layer graph (built bottom-up, released top-down). Every service is built exactly
 * once: stateful ones (`Bus`) are shared by `provideMerge`, never re-created through
 * `Effect.Service` `dependencies`.
 *
 *   AppConfig ── NodeContext
 *       │
 *   SqliteLive → MigratorLive                                  (= DbLive)
 *       │
 *   EventLog · Bus                                             (realtime)
 *       │
 *   Sessions · Users · EventPublisher · AgentHomes · RuntimeDetector
 *   · UsageProbe · ModelCatalogs · PushDevices · PushSender · GitHubApp
 *   · ThreadContexts (context meter)
 *   · Linear                                                          (core)
 *       │
 *   Auth · Companies · Channels · Vault · Tasks · WsAuthenticator      (domain, tier 1)
 *       │
 *   Attachments · Reactions (Messages hydrates through both) · Repositories
 *   · Projects                                                        (domain, tier 1b)
 *       │
 *   Invites · Departments · Messages · Subscriptions · Agents
 *   · PushNotifier (bus → web push)                                   (domain, tier 2)
 *       │
 *   Handovers · Routines (rows only; the runner fires them) · Signals · Calls  (domain, tier 3)
 *   · HttpNodeServer                                                   (= InfraLive)
 *       │
 *   TaskTokens · AgentSessions · MemoryIngest  ── MachineProvider (config, or a test fake)
 *       │
 *   TaskRunner → Scheduler · AgentApi · Search · RoutineRunner         (= AgentsLive, Phase 4)
 *   · TriggerContext → TriggerRunner (bus → fire) · SignalRunner (tick → bus + wake)
 *   · Workspace (machine control + PTY seam for the terminal)
 *       │
 *   HttpLive  (NodeHttpServer + HttpApi groups + AuthenticationLive + agent-runtime router + static SPA)
 *       │
 *   WsServer · TerminalWsServer  (/ws and /ws/terminal on the same Node server; released before it closes)
 */
const RealtimeLive = Layer.mergeAll(EventLog.Default, Bus.Default)

const CoreLive = Layer.mergeAll(
  Sessions.Default,
  Users.Default,
  EventPublisher.Default,
  AgentHomes.Default,
  RuntimeDetector.Default,
  UsageProbe.Default,
  ModelCatalogs.Default,
  GitHubApp.Default,
  Linear.Default,
  PushDevices.Default,
  PushSender.Default
).pipe(Layer.provideMerge(RealtimeLive))

const DomainTier1 = Layer.mergeAll(
  Auth.Default,
  Companies.Default,
  Channels.Default,
  Vault.Default,
  Tasks.Default,
  /** The context meter's store (docs/build-plan-context-meter.md); needs only `EventPublisher`. */
  ThreadContexts.Default,
  WsAuthenticatorLive
).pipe(Layer.provideMerge(CoreLive))

/** Between the tiers: needs `Channels` (D8 authorization); `Messages` and `Agents` need it. */
const DomainTier1b = Layer.mergeAll(
  Attachments.Default,
  Reactions.Default,
  Repositories.Default,
  /** The Linear mirror (docs/build-plan-projects.md); reads nothing but its own tables and `Linear`. */
  Projects.Default,
  /** `Agents` installs skills through it; it reads `repositories` for the private-repo token (D11). */
  SkillRegistry.Default
).pipe(Layer.provideMerge(DomainTier1))

const DomainTier2 = Layer.mergeAll(
  Invites.Default,
  Departments.Default,
  Messages.Default,
  Subscriptions.Default,
  Agents.Default,
  PushNotifier.Default
).pipe(
  Layer.provideMerge(DomainTier1b),
  Layer.provideMerge(DbLive),
  Layer.provideMerge(NodeContext.layer),
  Layer.provideMerge(AppConfig.Default)
)

/** Domain services + realtime + db + config: everything the HTTP handlers and `/ws` need. */
export const ServicesLive = Layer.mergeAll(
  Handovers.Default,
  Routines.Default,
  /** Signal rows and their budgets; `agents/signalRunner.ts` delivers them (Part II, D19). */
  Signals.Default,
  /** Posts the D7 huddle summary through `Messages`, so it sits above tier 2. */
  Calls.Default
).pipe(Layer.provideMerge(DomainTier2))

/**
 * Re-assert the built-in skills (`agents/defaultSkills.ts`) on every agent: adds them
 * to agents created before a built-in existed, and restores any whose row or
 * `SKILL.md` drifted from the source. Runs once, after the services are built and
 * before anything serves traffic. Agents already matching the source are untouched.
 */
const BuiltinSkillsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const agents = yield* Agents
    const touched = yield* agents.ensureBuiltinSkills()
    if (touched > 0) yield* Effect.logInfo(`built-in skills: refreshed ${touched} agent(s)`)
  })
).pipe(Layer.provideMerge(ServicesLive))

export const InfraLive = Layer.mergeAll(BuiltinSkillsLive, HttpNodeServer.Default)

const AgentsTier1 = Layer.mergeAll(TaskTokens.Default, AgentSessions.Default, MemoryIngest.Default)
const AgentsTier2 = TaskRunner.Default.pipe(Layer.provideMerge(AgentsTier1))

/**
 * Phase 4: scheduler, task runner, agent-runtime API service, memory ingest. Needs a
 * `MachineProviderTag`. `Search` sits here because its agent-notes half reads through
 * `MemoryIngest.memoryOf`; `RoutineRunner` because a fire goes through the `Scheduler`.
 */
const AgentsTier3 = Scheduler.Default.pipe(Layer.provideMerge(AgentsTier2))
const AgentsTier4 = Layer.mergeAll(
  AgentApi.Default,
  Search.Default,
  RoutineRunner.Default,
  /**
   * The prose block an event-fired routine is woken with (docs/build-plan-triggers.md D5). It
   * reads `Calls`, `Channels`, `Agents` and `Users` and writes nothing; it sits here only
   * because `Calls` is built one tier below and `TriggerRunner` one tier above.
   */
  TriggerContext.Default,
  /** The daily upstream check for installed skills (docs/build-plan-skills.md D9). */
  SkillUpdater.Default,
  Workspace.Default
).pipe(Layer.provideMerge(AgentsTier3))

/**
 * The bus half of a routine's fire condition (docs/build-plan-triggers.md D1), and the 5-second
 * tick that feeds it. `TriggerRunner` calls the *same* `RoutineRunner.fire` the clock does, so it
 * has to be built above it; `SignalRunner` posts through the `Scheduler` and publishes on the
 * bus, which is the only place the two halves of a signal meet.
 */
export const AgentsLive = Layer.mergeAll(TriggerRunner.Default, SignalRunner.Default).pipe(
  Layer.provideMerge(AgentsTier4)
)

/**
 * Everything, with the machine provider injected — `MachineProviderFromConfig` in `main.ts`,
 * a fake in tests. Outputs every service so tests and `main.ts` can reach into the running app.
 * `terminal` shrinks the D10 terminal limits (tests only; production keeps the defaults).
 */
export const appLive = <E, R>(
  provider: Layer.Layer<MachineProviderTag, E, R>,
  terminal: Partial<TerminalLimitsShape> = {}
) =>
  Layer.mergeAll(
    WsServer.Default,
    TerminalWsServer.Default.pipe(Layer.provide(TerminalLimits.layer(terminal)))
  ).pipe(
    Layer.provideMerge(HttpLive.pipe(Layer.provide(AgentRuntimeLive))),
    Layer.provideMerge(AgentsLive),
    Layer.provideMerge(InfraLive),
    Layer.provideMerge(provider),
    Layer.provideMerge(InfraLive)
  )

export const AppLive = appLive(MachineProviderFromConfig)
