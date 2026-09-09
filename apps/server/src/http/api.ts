import { HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'
import { AuthenticationLive } from '../auth/authentication.js'
import { AgentsLive } from './agents.js'
import { AttachmentsLive } from './attachments.js'
import { AuthLive } from './auth.js'
import { CallsLive, HooksLive } from './calls.js'
import { ChannelsLive } from './channels.js'
import { CompaniesLive } from './companies.js'
import { DepartmentsLive } from './departments.js'
import { HandoversLive } from './handovers.js'
import { HealthLive } from './health.js'
import { InvitesLive } from './invites.js'
import { MessagesLive } from './messages.js'
import { ProjectsLive } from './projects.js'
import { PushLive } from './push.js'
import { RepositoriesLive } from './repositories.js'
import { RoutinesLive } from './routines.js'
import { SearchLive } from './search.js'
import { ServerApi } from './serverApi.js'
import { SignalsLive } from './signals.js'
import { SubscriptionsLive } from './subscriptions.js'
import { TasksLive } from './tasks.js'
import { VaultLive } from './vault.js'

/**
 * Every group of `ServerApi` (= contract `TautApi` + `/api/health`). `HttpApiBuilder.api`
 * fails typecheck until each group is provided, so a new contract group needs a layer here.
 * Handlers reach their services (`Auth`, `Companies`, …) through `InfraLive` (src/layers.ts).
 */
const groups = Layer.mergeAll(
  HealthLive,
  AuthLive,
  InvitesLive,
  CompaniesLive,
  DepartmentsLive,
  ChannelsLive,
  MessagesLive,
  AttachmentsLive,
  VaultLive,
  SubscriptionsLive,
  PushLive,
  AgentsLive,
  RepositoriesLive,
  ProjectsLive,
  TasksLive,
  RoutinesLive,
  SignalsLive,
  HandoversLive,
  SearchLive,
  CallsLive,
  HooksLive
)

export const ApiLive = HttpApiBuilder.api(ServerApi).pipe(
  Layer.provide(groups),
  Layer.provide(AuthenticationLive)
)
