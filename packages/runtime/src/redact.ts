/**
 * Secret redaction. Every stdout/stderr line passes through a `Redactor` built
 * from the task's plaintext secrets *before* it becomes an event or a log line
 * (docs/build-plan.md → Agent execution). Each secret is matched literally in
 * its raw, base64, base64url, URL-encoded and JSON-escaped forms and replaced
 * with `••••<last4>` (`••••` alone when the tail is not alphanumeric — see `maskFor`).
 *
 * A redactor is mutable on purpose: the server owns one per task and `add()`s
 * secrets that only become known mid-task (`vault_get`, build-plan-browser-vaults
 * D5), so the value can never appear in chat or logs.
 */

export const MASK_PREFIX = '••••'
/** Secrets shorter than this are ignored: masking them would mangle ordinary text. */
export const MIN_SECRET_LENGTH = 6

export interface Redactor {
  redact(text: string): string
  /** Number of distinct needles (all variants of all secrets). */
  readonly size: number
  /**
   * Register another plaintext secret. Same variants + longest-first ordering as
   * construction; safe to call at any time, including between `redact` calls.
   * Short (< `MIN_SECRET_LENGTH`) or already-known secrets are ignored.
   */
  add(secret: string): void
}

interface Needle {
  readonly value: string
  readonly mask: string
}

/** Only these may appear verbatim in a mask: safe inside a JSON string and on a log line. */
const SAFE_HINT = /^[A-Za-z0-9]{4}$/

/**
 * `••••<last4>` for secrets of 12+ chars whose last four are alphanumeric; bare `••••`
 * otherwise. The hint is embedded into NDJSON lines (the stream the reply is parsed
 * from) and log lines, so a quote, backslash, control character or any other
 * punctuation from the tail must never be emitted — it could close or escape the
 * JSON string the mask lands in (`vault_get` makes arbitrary secret shapes routine).
 */
const maskFor = (secret: string): string => {
  if (secret.length < 12) return MASK_PREFIX
  const hint = secret.slice(-4)
  return SAFE_HINT.test(hint) ? `${MASK_PREFIX}${hint}` : MASK_PREFIX
}

const variants = (secret: string): ReadonlyArray<string> => {
  const out = new Set<string>([secret])
  const buf = Buffer.from(secret, 'utf8')
  out.add(buf.toString('base64'))
  out.add(buf.toString('base64url'))
  out.add(encodeURIComponent(secret))
  out.add(JSON.stringify(secret).slice(1, -1))
  return [...out].filter((v) => v.length >= MIN_SECRET_LENGTH)
}

export const makeRedactor = (secrets: Iterable<string> = []): Redactor => {
  const needles: Array<Needle> = []
  const seen = new Set<string>()

  const add = (secret: string): void => {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) return
    const mask = maskFor(secret)
    let changed = false
    for (const value of variants(secret)) {
      if (seen.has(value)) continue
      seen.add(value)
      needles.push({ value, mask })
      changed = true
    }
    // Longest first so a secret that contains another is masked as a whole.
    if (changed) needles.sort((a, b) => b.value.length - a.value.length)
  }

  for (const secret of secrets) add(secret)

  return {
    get size() {
      return needles.length
    },
    add,
    redact: (text) => {
      if (needles.length === 0 || text.length === 0) return text
      let out = text
      for (const n of needles) {
        if (out.includes(n.value)) out = out.split(n.value).join(n.mask)
      }
      return out
    }
  }
}

/** A redactor that changes nothing (and forgets what it is told). */
export const noRedaction: Redactor = { size: 0, redact: (text) => text, add: () => undefined }

/** Collect every value of an env map plus the contents of any credential files. */
export const secretsOf = (
  env: Readonly<Record<string, string>> | undefined,
  files?: ReadonlyArray<{ readonly content: string }>
): Array<string> => [...Object.values(env ?? {}), ...(files ?? []).map((f) => f.content)]
