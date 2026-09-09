import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { RuntimeKind } from '../domain/enums.js'
import { ModelCatalog } from '../domain/run.js'
import { Subscription } from '../domain/subscription.js'
import { Forbidden, NotFound, RuntimeUnavailable, Validation, VaultLocked } from '../errors.js'
import { SubscriptionId, VaultItemId } from '../ids.js'
import { Page, PageQuery } from './common.js'
import { Authentication } from './middleware.js'

export const AddSubscriptionPayload = Schema.Struct({
  runtime: RuntimeKind,
  label: Schema.NonEmptyString,
  /** Must be a kind the runtime accepts (`RuntimeCredentialKinds`), else `Validation`. */
  credentialId: VaultItemId,
  /** Must be a kind in `RuntimeUsageCredentialKinds[runtime]`, else `Validation`. */
  usageCredentialId: Schema.optional(VaultItemId),
  defaultModel: Schema.optional(Schema.String),
  weight: Schema.optional(Schema.NonNegativeInt)
})

export const SetWeightPayload = Schema.Struct({ weight: Schema.NonNegativeInt })

/** `usageCredentialId` absent detaches the seat's usage credential. */
export const SetUsageCredentialPayload = Schema.Struct({
  usageCredentialId: Schema.optional(VaultItemId)
})

const SubscriptionPath = Schema.Struct({ subscriptionId: SubscriptionId })

/**
 * `subscriptionId` names the seat whose credential is used to ask the provider
 * (docs/build-plan-run-overrides.md D6). Without one the healthiest seat for
 * `runtime` is used, and a runtime with no seat at all answers the fallback
 * list rather than a 404.
 */
export const ModelCatalogQuery = Schema.Struct({
  runtime: RuntimeKind,
  subscriptionId: Schema.optional(SubscriptionId),
  /** Skip the 30-minute cache and ask the provider again. */
  refresh: Schema.optional(Schema.BooleanFromString)
})

export class SubscriptionsGroup extends HttpApiGroup.make('subscriptions')
  .add(
    /** Any member may list (metadata only); writes below are admin+. */
    HttpApiEndpoint.get('list', '/').setUrlParams(PageQuery).addSuccess(Page(Subscription))
  )
  .add(
    /** Runs `detect()` after inserting and returns the item with its `status`. */
    HttpApiEndpoint.post('add', '/')
      .setPayload(AddSubscriptionPayload)
      .addSuccess(Subscription, { status: 201 })
      .addError(Forbidden)
      .addError(NotFound)
      .addError(Validation)
      .addError(VaultLocked)
  )
  .add(
    HttpApiEndpoint.del('remove', '/:subscriptionId')
      .setPath(SubscriptionPath)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.patch('setWeight', '/:subscriptionId/weight')
      .setPath(SubscriptionPath)
      .setPayload(SetWeightPayload)
      .addSuccess(Subscription)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    /**
     * Attach or detach the read-only credential the usage probe uses. Admin+.
     * A Claude seat needs one because its `setup-token` is inference-only.
     */
    HttpApiEndpoint.patch('setUsageCredential', '/:subscriptionId/usage-credential')
      .setPath(SubscriptionPath)
      .setPayload(SetUsageCredentialPayload)
      .addSuccess(Subscription)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Validation)
  )
  .add(
    /**
     * The models this runtime can actually reach, read live from the provider
     * and cached (D6). Any member may read it: it is a list of model names, and
     * everyone who can message an agent needs it. Never fails on a provider
     * outage — it answers `source: 'fallback'` with a reason.
     */
    HttpApiEndpoint.get('models', '/models')
      .setUrlParams(ModelCatalogQuery)
      .addSuccess(ModelCatalog)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    /**
     * Drop the seat's cooldown right now, without asking the provider.
     *
     * A seat is parked whenever a run trips *any* limit, but a limit is
     * per-model: one model out of quota parks a seat whose other models still
     * have room. `check` cannot fix that, because it only releases a seat the
     * provider agrees is free. This is the operator saying so instead. Admin+.
     */
    HttpApiEndpoint.post('clearCooldown', '/:subscriptionId/clear-cooldown')
      .setPath(SubscriptionPath)
      .addSuccess(Subscription)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    /** Re-runs runtime detection + credential check; updates `status`/`lastCheckedAt`. */
    HttpApiEndpoint.post('check', '/:subscriptionId/check')
      .setPath(SubscriptionPath)
      .addSuccess(Subscription)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(VaultLocked)
      .addError(RuntimeUnavailable)
  )
  .middleware(Authentication)
  .prefix('/subscriptions') {}
