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
  codex: 'gpt-6-astra',
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
  'claude.oauth': 'Connect your Claude subscription using the token from claude setup-token.',
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

// Run locally, before any clipboard write: auth status can succeed without an
// exportable login. Keep unrelated MCP credentials out of the clipboard entirely.
const claudeLoginCommand = String.raw`node -e '
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const parse = (text) => {
  try {
    const oauth = JSON.parse(text).claudeAiOauth;
    if (typeof oauth?.accessToken === "string" && oauth.accessToken.trim() &&
        typeof oauth.refreshToken === "string" && oauth.refreshToken.trim()) {
      return { claudeAiOauth: oauth };
    }
  } catch {}
};
const readLogin = () => {
  const keychain = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8" });
  const login = keychain.status === 0 ? parse(keychain.stdout) : undefined;
  if (login) return login;
  try { return parse(readFileSync(join(config, ".credentials.json"), "utf8")); } catch {}
};
let login = readLogin();
if (!login) {
  console.error("No exportable Claude login found. Sign in with your Claude subscription.");
  const result = spawnSync("claude", ["auth", "login"], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error("Claude sign-in did not finish. Nothing was copied.");
    process.exit(1);
  }
  login = readLogin();
}
if (!login) {
  console.error("Claude still has no exportable access and refresh tokens. Nothing was copied. Run claude setup-token, then in Taut choose Subscription and paste the resulting token.");
  process.exit(1);
}
const encoded = Buffer.from(JSON.stringify(login)).toString("base64");
for (const [command, args] of [["pbcopy", []], ["wl-copy", []], ["xclip", ["-selection", "clipboard"]]]) {
  const result = spawnSync(command, args, { input: encoded, stdio: ["pipe", "ignore", "ignore"] });
  if (result.status === 0) {
    console.error("Claude login copied. Paste it into Taut.");
    process.exit(0);
  }
}
console.error("No clipboard tool available. Copy the following line into Taut:");
console.log(encoded);
'`

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
   * Validates the saved login before copying, with one interactive sign-in
   * attempt if neither credential store contains exportable tokens.
   */
  'claude.login': {
    intro:
      'Run this on the machine where you use Claude Code, with Node.js installed. It checks your saved login, signs in if needed, and copies only the Claude login.',
    command: claudeLoginCommand,
    then: 'When it says "Claude login copied", paste below. If it prints a long line instead, copy that line. If no login can be copied, follow the terminal instructions.'
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
