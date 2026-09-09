/**
 * Copy and constants for runtimes and credential kinds.
 *
 * The contract knows the *shapes* (`RuntimeKind`, `CredentialKind`,
 * `RuntimeCredentialKinds`); the words an operator reads live here so the
 * vault, subscriptions and agent forms all say exactly the same thing.
 *
 * Sources: docs/agent-model.md §4 (runtime/credential table, rotation,
 * licensing note) and §7 (machines, binaries).
 */
import type {
  CredentialKind,
  ReasoningEffort,
  RuntimeKind,
  SubscriptionStatus
} from '@taut/contract'

export const RUNTIME_ORDER: readonly RuntimeKind[] = ['claude-code', 'codex', 'cursor', 'opencode']

export const RUNTIME_LABELS: Record<RuntimeKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode'
}

/** The binary the machine must be able to find (docs/agent-model.md §4). */
export const RUNTIME_BINARY: Record<RuntimeKind, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  opencode: 'opencode'
}

/** Shown on the card header when a seat reports `binary-missing`. */
export const RUNTIME_INSTALL_HINT: Record<RuntimeKind, string> = {
  'claude-code': 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
  cursor: 'curl https://cursor.com/install -fsS | bash',
  opencode: 'npm i -g opencode-ai'
}

export const RUNTIME_BLURB: Record<RuntimeKind, string> = {
  'claude-code': "Anthropic's headless CLI. Streams NDJSON and resumes sessions.",
  codex: "OpenAI's `codex exec`. Sandboxed by default, JSON output.",
  cursor: 'Cursor Agent. `--mode plan` is read-only; `--force` applies edits.',
  opencode: 'OpenCode. Bring an Anthropic or OpenAI key; provider chosen per model.'
}

/**
 * Placeholder text for a model field, one example the runtime accepts. The real
 * list is the provider's and arrives through `useModelCatalog`
 * (docs/build-plan-run-overrides.md D6); this is only what the empty field hints.
 */
export const RUNTIME_MODEL_EXAMPLE: Record<RuntimeKind, string> = {
  'claude-code': 'claude-sonnet-4-5',
  codex: 'gpt-5-codex',
  cursor: 'auto',
  opencode: 'anthropic/claude-sonnet-4-5'
}

/** How hard the model thinks, in the composer's words (D7). */
export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max'
}

/** One line under the reasoning row, so the choice is not four bare adjectives. */
export const REASONING_BLURB: Record<ReasoningEffort, string> = {
  minimal: 'Answer straight away. Cheapest and fastest.',
  low: 'A short think before answering.',
  medium: 'Room to work a problem through.',
  high: 'Long deliberation; slower and dearer.',
  max: 'Everything it has. For the hardest work only.'
}

export function isRuntimeKind(value: string): value is RuntimeKind {
  return RUNTIME_ORDER.some((runtime) => runtime === value)
}

// --- credentials ----------------------------------------------------------

export const CREDENTIAL_ORDER: readonly CredentialKind[] = [
  'anthropic.api_key',
  'claude.login',
  'claude.oauth',
  'openai.api_key',
  'openai.oauth',
  'cursor.api_key',
  'generic.secret'
]

export const CREDENTIAL_LABELS: Record<CredentialKind, string> = {
  'anthropic.api_key': 'Anthropic API key',
  'claude.oauth': 'Claude setup token',
  'claude.login': 'Claude login',
  'openai.api_key': 'OpenAI API key',
  'openai.oauth': 'OpenAI subscription',
  'cursor.api_key': 'Cursor API key',
  'generic.secret': 'Generic secret'
}

/** The one helper line under the secret field. Kind-specific, deliberately short. */
export const CREDENTIAL_HELP: Record<CredentialKind, string> = {
  'anthropic.api_key': 'Create one at console.anthropic.com → API keys.',
  'claude.oauth':
    'Runs agents, but cannot read usage — a seat on this shows no limits. Prefer the Claude login.',
  'claude.login':
    "Runs agents and reads this seat's limits. A shared login rather than a key — check your provider's terms.",
  'openai.api_key': 'Create one at platform.openai.com → API keys.',
  'openai.oauth': "A shared login rather than a key — check your provider's terms.",
  'cursor.api_key': 'Cursor → Settings → Integrations → API keys.',
  'generic.secret':
    'Anything else an agent needs at spawn time. Granted per agent, injected by label.'
}

/**
 * How an operator *gets* the thing the field wants.
 *
 * The subscription kinds are the reason this exists. A Codex login is a file,
 * not a key: told to "paste ~/.codex/auth.json" people paste half of it, the
 * seat stores fine and fails an hour later. So the recipe is one block they
 * copy, run, and get a single line back on the clipboard — nothing to read,
 * nothing to select, nothing to truncate.
 */
export interface CredentialRecipe {
  /** What the block does, in one sentence, before they run it. */
  readonly intro: string
  /** Copied verbatim by the Copy button. Runs on the machine holding the login. */
  readonly command: string
  /** What they should see when it worked. */
  readonly then: string
}

export const CREDENTIAL_RECIPE: Partial<Record<CredentialKind, CredentialRecipe>> = {
  'openai.oauth': {
    intro: 'Run this on the Mac where you use ChatGPT. It signs Codex in, then copies the login.',
    command:
      "codex login status || codex login\nbase64 < ~/.codex/auth.json | tr -d '\\n' | pbcopy",
    then: 'It prints nothing. The login is on your clipboard — paste it below.'
  },
  'claude.oauth': {
    intro: 'Run this on a machine signed in to Claude. It opens a browser, then prints one line.',
    command: 'claude setup-token',
    then: 'Copy the line it prints and paste it below.'
  },
  /**
   * Signs in if needed, then copies the login Claude Code saved — the macOS
   * Keychain item or the file Linux writes, whichever exists. The clipboard
   * command is whichever of the three is installed, and a machine with none
   * (a server over SSH) gets the line printed instead of a silent no-op.
   */
  'claude.login': {
    intro:
      'Run this on the machine signed in to Claude. It copies the whole login, which both runs the seat and reads its limits.',
    command:
      "claude auth status >/dev/null 2>&1 || claude auth login\n{ security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null || cat ~/.claude/.credentials.json; } | base64 | tr -d '\\n' | { pbcopy 2>/dev/null || wl-copy 2>/dev/null || xclip -selection clipboard 2>/dev/null || cat; }",
    then: 'The login is on your clipboard — paste it below. If it printed a long line instead, this machine has no clipboard tool: copy that line.'
  }
}

export const CREDENTIAL_PLACEHOLDER: Record<CredentialKind, string> = {
  'anthropic.api_key': 'sk-ant-…',
  'claude.oauth': 'sk-ant-oat01-…',
  'claude.login': 'paste the copied login',
  'openai.api_key': 'sk-…',
  'openai.oauth': 'paste the copied login',
  'cursor.api_key': 'key_…',
  'generic.secret': '••••••••'
}

/** `true` for the shared-seat kinds the licensing note applies to (§4). */
export const isSubscriptionSeat = (kind: CredentialKind): boolean =>
  kind === 'claude.oauth' || kind === 'claude.login' || kind === 'openai.oauth'

export interface CredentialGroup {
  readonly label: string
  readonly kinds: readonly CredentialKind[]
}

export const CREDENTIAL_GROUPS: readonly CredentialGroup[] = [
  { label: 'API keys', kinds: ['anthropic.api_key', 'openai.api_key', 'cursor.api_key'] },
  { label: 'Subscription seats', kinds: ['claude.login', 'openai.oauth', 'claude.oauth'] },
  { label: 'Other', kinds: ['generic.secret'] }
]

export function isCredentialKind(value: string): value is CredentialKind {
  return CREDENTIAL_ORDER.some((kind) => kind === value)
}

// --- subscription status --------------------------------------------------

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  ok: 'Healthy',
  'auth-failed': 'Auth failed',
  'binary-missing': 'Binary missing',
  unchecked: 'Unchecked'
}

/** One line, shown once per subscriptions page (docs/agent-model.md §4). */
export const ROTATION_RULE =
  'At task start Taut picks the healthiest seat that is not cooling down, then the lowest tasks today, then the highest weight. Weight 0 drains a seat without removing it.'
