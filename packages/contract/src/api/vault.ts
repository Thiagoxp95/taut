import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { CredentialKind } from '../domain/enums.js'
import { VaultItemMeta } from '../domain/vault.js'
import { Forbidden, NotFound, Validation, VaultLocked } from '../errors.js'
import { AgentId, VaultItemId } from '../ids.js'
import { Page, PageQuery } from './common.js'
import { Authentication } from './middleware.js'

/**
 * `secret` is `Redacted` so it never shows up in logs or error output. `agentId` present =
 * an agent-scoped item (admin+ or the head of that agent's department); absent = a company
 * item (admin+).
 */
export const AddVaultItemPayload = Schema.Struct({
  kind: CredentialKind,
  label: Schema.NonEmptyString,
  secret: Schema.Redacted(Schema.NonEmptyString),
  agentId: Schema.optional(AgentId)
})

/** `agentId` absent = company items only (any member); present = that agent's items (managers only). */
export const ListVaultQuery = Schema.Struct({
  ...PageQuery.fields,
  agentId: Schema.optional(AgentId)
})
export type ListVaultQuery = typeof ListVaultQuery.Type

const VaultItemPath = Schema.Struct({ vaultItemId: VaultItemId })

/** No `get` on purpose: plaintext never leaves the server (docs/agent-model.md §2). */
export class VaultGroup extends HttpApiGroup.make('vault')
  .add(
    /**
     * Company items: any member (metadata only). `?agentId=`: that agent's items, admin+ or
     * the head of its department, else `Forbidden`; unknown agent → `NotFound`.
     */
    HttpApiEndpoint.get('list', '/')
      .setUrlParams(ListVaultQuery)
      .addSuccess(Page(VaultItemMeta))
      .addError(Forbidden)
      .addError(NotFound)
  )
  .add(
    /** Company item: admin+. Agent item (`agentId` set): admin+ or the head of its department. */
    HttpApiEndpoint.post('add', '/')
      .setPayload(AddVaultItemPayload)
      .addSuccess(VaultItemMeta, { status: 201 })
      .addError(Forbidden)
      .addError(NotFound)
      .addError(Validation)
      .addError(VaultLocked)
  )
  .add(
    /** Also cancels running tasks that resolved this item. */
    HttpApiEndpoint.del('revoke', '/:vaultItemId')
      .setPath(VaultItemPath)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .middleware(Authentication)
  .prefix('/vault') {}
