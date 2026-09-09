import type { RuntimeKind } from '@taut/contract/domain'

import { claudeCode } from './claudeCode.js'
import { codex } from './codex.js'
import { cursor } from './cursor.js'
import { opencode } from './opencode.js'
import type { RuntimeAdapter } from './types.js'

export * from './types.js'
export {
  CLAUDE_BINARY,
  DEFAULT_MCP_ALLOWED_TOOLS,
  claudeCode,
  makeClaudeCodeAdapter,
  parseClaudeLine
} from './claudeCode.js'
export type { ClaudeCodeBuildInput, ClaudeCodeOptions } from './claudeCode.js'
export { CODEX_BINARY, buildCodexCommand, codex, parseCodexLine } from './codex.js'
export { CURSOR_BINARY, buildCursorCommand, cursor, parseCursorLine } from './cursor.js'
export {
  OPENCODE_BINARY,
  buildOpencodeCommand,
  opencode,
  opencodePermission,
  parseOpencodeLine
} from './opencode.js'
export type { OpencodeFileGrant, OpencodePermission } from './opencode.js'

/** One adapter per `RuntimeKind`. Only `claude-code` is exercised end to end in the MVP. */
export const adapters: Readonly<Record<RuntimeKind, RuntimeAdapter>> = {
  'claude-code': claudeCode,
  codex,
  cursor,
  opencode
}

export const adapterFor = (kind: RuntimeKind): RuntimeAdapter => adapters[kind]
