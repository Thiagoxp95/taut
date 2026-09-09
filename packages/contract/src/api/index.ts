import { HttpApi } from '@effect/platform'

import { RateLimited, Validation } from '../errors.js'
import { AgentsGroup } from './agents.js'
import { AttachmentsGroup } from './attachments.js'
import { AuthGroup } from './auth.js'
import { CallsGroup, HooksGroup } from './calls.js'
import { ChannelsGroup } from './channels.js'
import { CompaniesGroup } from './companies.js'
import { DepartmentsGroup } from './departments.js'
import { HandoversGroup } from './handovers.js'
import { InvitesGroup } from './invites.js'
import { MessagesGroup } from './messages.js'
import { ProjectsGroup } from './projects.js'
import { PushGroup } from './push.js'
import { RepositoriesGroup } from './repositories.js'
import { RoutinesGroup } from './routines.js'
import { SearchGroup } from './search.js'
import { SignalsGroup } from './signals.js'
import { SubscriptionsGroup } from './subscriptions.js'
import { TasksGroup } from './tasks.js'
import { VaultGroup } from './vault.js'

/**
 * The whole HTTP surface, mounted at `/api`. The server implements it with
 * `HttpApiBuilder`; the web derives a client with `HttpApiClient.make(TautApi)`.
 * `/ws` is not part of this api — see `events.ts` for its message schemas.
 */
export class TautApi extends HttpApi.make('taut')
  .add(AuthGroup)
  .add(InvitesGroup)
  .add(CompaniesGroup)
  .add(DepartmentsGroup)
  .add(ChannelsGroup)
  .add(MessagesGroup)
  .add(AttachmentsGroup)
  .add(VaultGroup)
  .add(SubscriptionsGroup)
  .add(PushGroup)
  .add(AgentsGroup)
  .add(RepositoriesGroup)
  .add(ProjectsGroup)
  .add(TasksGroup)
  .add(RoutinesGroup)
  .add(SignalsGroup)
  .add(HandoversGroup)
  .add(SearchGroup)
  .add(CallsGroup)
  .add(HooksGroup)
  .addError(Validation)
  .addError(RateLimited)
  .prefix('/api') {}

export * from './agents.js'
export * from './attachments.js'
export * from './auth.js'
export * from './calls.js'
export * from './channels.js'
export * from './common.js'
export * from './companies.js'
export * from './departments.js'
export * from './handovers.js'
export * from './invites.js'
export * from './messages.js'
export * from './middleware.js'
export * from './projects.js'
export * from './push.js'
export * from './repositories.js'
export * from './routines.js'
export * from './search.js'
export * from './signals.js'
export * from './subscriptions.js'
export * from './tasks.js'
export * from './vault.js'
