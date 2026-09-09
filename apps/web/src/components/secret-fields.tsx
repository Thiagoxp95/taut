import * as React from 'react'
import { AlertCircleIcon, CheckIcon, CopyIcon, EyeIcon, EyeOffIcon } from 'lucide-react'
import { Either } from 'effect'
import type { CredentialKind } from '@taut/contract'
import {
  credentialSecretProblem,
  isCredentialSecretUsable,
  normalizeCredentialSecret
} from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { toast } from '@taut/ui/components/sonner'
import { Field } from '@/components/page'
import {
  CREDENTIAL_GROUPS,
  CREDENTIAL_HELP,
  CREDENTIAL_LABELS,
  CREDENTIAL_PLACEHOLDER,
  CREDENTIAL_RECIPE,
  type CredentialRecipe,
  isCredentialKind
} from '@/lib/runtime-meta'

export interface NewSecret {
  readonly kind: CredentialKind
  readonly label: string
  readonly secret: string
}

export const emptySecret = (kind: CredentialKind = 'anthropic.api_key'): NewSecret => ({
  kind,
  label: '',
  secret: ''
})

export const isSecretReady = (value: NewSecret): boolean =>
  value.label.trim() !== '' && isCredentialSecretUsable(value.kind, value.secret)

/**
 * The exact bytes to send, which are not always the bytes that were pasted.
 *
 * A Claude login is copied whole, and the file also carries `mcpOAuth` — access
 * tokens for every MCP server that machine has signed into. The server drops
 * them before storing, but "dropped after it arrives" is not the same promise
 * as "never sent", and for other people's tokens it is the wrong one. So the
 * paste is reduced here, in the browser, to what the vault would have kept.
 *
 * Normalising is idempotent, so the server re-running it changes nothing; on
 * the impossible path where a submitted value does not normalise, the raw
 * string goes through and the server rejects it with the same message the field
 * was already showing.
 */
export const secretToStore = (value: NewSecret): string =>
  Either.getOrElse(normalizeCredentialSecret(value.kind, value.secret), () => value.secret)

/**
 * The command that produces the secret, with the one button that matters.
 *
 * A subscription login is not something you can be told to "find" — it is a
 * file on a machine. Copy, run, paste: the operator never reads the value, so
 * there is nothing to truncate or retype.
 */
/**
 * Copy text, including where the async clipboard API does not exist.
 *
 * `navigator.clipboard` is gated on a secure context, and a self-hosted Taut is
 * routinely opened at `http://<lan-ip>:<port>` — where the property is
 * `undefined`, so reaching for `.writeText` throws before any promise exists.
 * The first step of connecting a seat is this button, so it falls back to the
 * old selection-based copy rather than dying on the install people actually
 * run.
 */
const copyText = async (text: string): Promise<boolean> => {
  try {
    if (window.isSecureContext && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // A refused permission is not a reason to give up: fall through.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    // Off-screen rather than hidden — `display: none` cannot hold a selection.
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-9999px'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}

function RecipeBlock({ recipe }: { recipe: CredentialRecipe }) {
  const [copied, setCopied] = React.useState(false)

  return (
    <div className="rounded-md border bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground">{recipe.intro}</p>
      <div className="mt-2 flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded border bg-background px-2.5 py-2 font-mono text-[11px] leading-relaxed select-all">
          {recipe.command}
        </pre>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void copyText(recipe.command).then((ok) => {
              if (!ok) {
                toast.error('Could not copy — select the command and copy it yourself')
                return
              }
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{recipe.then}</p>
    </div>
  )
}

/**
 * Kind · label · secret — the three fields of a new vault item.
 *
 * Shared by `/vault` and the "connect a runtime" dialog so a credential is
 * described identically wherever it is created. The secret is a password input
 * with a reveal toggle; it is never echoed back by the server, so this is the
 * only moment it exists in the browser.
 *
 * The paste is judged as it is typed, by the same function the server uses
 * (`normalizeCredentialSecret`), so a half-copied login is refused here instead
 * of becoming an `auth-failed` seat later.
 */
export function SecretFields({
  idPrefix,
  value,
  onChange,
  /** Restrict the kind list — a runtime only accepts some (agent-model §4). */
  kinds,
  autoFocus = false
}: {
  idPrefix: string
  value: NewSecret
  onChange: (next: NewSecret) => void
  kinds?: readonly CredentialKind[]
  autoFocus?: boolean
}) {
  const [revealed, setRevealed] = React.useState(false)

  const groups = React.useMemo(
    () =>
      CREDENTIAL_GROUPS.map((group) => ({
        label: group.label,
        kinds: group.kinds.filter((kind) => kinds === undefined || kinds.includes(kind))
      })).filter((group) => group.kinds.length > 0),
    [kinds]
  )

  const recipe = CREDENTIAL_RECIPE[value.kind]
  const problem = credentialSecretProblem(value.kind, value.secret)

  return (
    <>
      <Field label="Kind" htmlFor={`${idPrefix}-kind`}>
        <Select
          value={value.kind}
          onValueChange={(next) => {
            if (isCredentialKind(next)) onChange({ ...value, kind: next })
          }}
        >
          <SelectTrigger id={`${idPrefix}-kind`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {groups.map((group) => (
              <SelectGroup key={group.label}>
                <SelectLabel>{group.label}</SelectLabel>
                {group.kinds.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {CREDENTIAL_LABELS[kind]}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field
        label="Label"
        htmlFor={`${idPrefix}-label`}
        hint="How it appears in the vault and on a subscription."
      >
        <Input
          id={`${idPrefix}-label`}
          autoFocus={autoFocus}
          autoComplete="off"
          value={value.label}
          onChange={(event) => onChange({ ...value, label: event.target.value })}
          placeholder="Acme Anthropic key"
        />
      </Field>

      {recipe === undefined ? null : <RecipeBlock recipe={recipe} />}

      <Field label="Secret" htmlFor={`${idPrefix}-secret`} hint={CREDENTIAL_HELP[value.kind]}>
        <div className="relative">
          <Input
            id={`${idPrefix}-secret`}
            type={revealed ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problem !== undefined}
            aria-describedby={problem === undefined ? undefined : `${idPrefix}-secret-problem`}
            className="pr-9 font-mono text-xs"
            value={value.secret}
            onChange={(event) => onChange({ ...value, secret: event.target.value })}
            placeholder={CREDENTIAL_PLACEHOLDER[value.kind]}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={revealed ? 'Hide the secret' : 'Reveal the secret'}
            className="absolute top-0.5 right-0.5 text-muted-foreground"
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        </div>
        {problem === undefined ? null : (
          <p
            id={`${idPrefix}-secret-problem`}
            className="flex items-start gap-1.5 text-xs text-destructive"
          >
            <AlertCircleIcon className="mt-px size-3.5 shrink-0" />
            {problem}
          </p>
        )}
      </Field>
    </>
  )
}
