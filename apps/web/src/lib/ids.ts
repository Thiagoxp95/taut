/** Safe decoders for ids that arrive from the URL, where anything can appear. */
import {
  AgentId,
  ChannelId,
  DepartmentId,
  MessageId,
  RoutineId,
  SignalId,
  SubscriptionId,
  VaultItemId
} from '@taut/contract'
import { Option, Schema } from 'effect'

const messageId = Schema.decodeUnknownOption(MessageId)
const channelId = Schema.decodeUnknownOption(ChannelId)
const departmentId = Schema.decodeUnknownOption(DepartmentId)
const agentId = Schema.decodeUnknownOption(AgentId)
const vaultItemId = Schema.decodeUnknownOption(VaultItemId)
const subscriptionId = Schema.decodeUnknownOption(SubscriptionId)
const routineId = Schema.decodeUnknownOption(RoutineId)
const signalId = Schema.decodeUnknownOption(SignalId)

export const parseMessageId = (value: unknown): MessageId | undefined =>
  Option.getOrUndefined(messageId(value))

export const parseChannelId = (value: unknown): ChannelId | undefined =>
  Option.getOrUndefined(channelId(value))

export const parseDepartmentId = (value: unknown): DepartmentId | undefined =>
  Option.getOrUndefined(departmentId(value))

export const parseAgentId = (value: unknown): AgentId | undefined =>
  Option.getOrUndefined(agentId(value))

export const parseVaultItemId = (value: unknown): VaultItemId | undefined =>
  Option.getOrUndefined(vaultItemId(value))

export const parseSubscriptionId = (value: unknown): SubscriptionId | undefined =>
  Option.getOrUndefined(subscriptionId(value))

export const parseRoutineId = (value: unknown): RoutineId | undefined =>
  Option.getOrUndefined(routineId(value))

export const parseSignalId = (value: unknown): SignalId | undefined =>
  Option.getOrUndefined(signalId(value))
