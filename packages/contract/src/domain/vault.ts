import { Schema } from 'effect'

import { AgentId, CompanyId, VaultItemId } from '../ids.js'
import { CredentialKind } from './enums.js'

/**
 * The public shape of a vault item: metadata only, never the ciphertext and
 * never the plaintext. `hint` (last 4 chars) is the only plaintext-derived
 * field ever shown (docs/agent-model.md §2).
 */
export class VaultItemMeta extends Schema.Class<VaultItemMeta>('VaultItemMeta')({
  id: VaultItemId,
  companyId: CompanyId,
  kind: CredentialKind,
  label: Schema.String,
  hint: Schema.String,
  createdAt: Schema.DateTimeUtc,
  lastUsedAt: Schema.optional(Schema.DateTimeUtc),
  lastUsedBy: Schema.optional(AgentId),
  /**
   * Scope. Absent = company item (usable by every agent of the company); present = agent
   * item, usable only by that agent and managed by admin+ or the head of its department.
   */
  agentId: Schema.optional(AgentId)
}) {}
