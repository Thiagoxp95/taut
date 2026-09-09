import * as React from 'react'
import type { GithubManifest } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { useGithubManifest } from '@/lib/api'

/**
 * GitHub's App manifest flow is a browser form POST to github.com, not an API
 * call: what comes back is GitHub's own create-app page, so `fetch` has nowhere
 * to put it. The form is built here, carries the single hidden `manifest` field
 * the flow expects, and submits straight away
 * (docs/build-plan-repositories.md, "The GitHub App manifest flow").
 */
export function submitGithubManifest(manifest: GithubManifest): void {
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = manifest.postUrl
  form.hidden = true

  const field = document.createElement('input')
  field.type = 'hidden'
  field.name = 'manifest'
  field.value = manifest.manifest

  form.append(field)
  document.body.append(form)
  form.submit()
}

/**
 * The one control that starts the connection, shared by company settings and
 * the onboarding step. It asks the server for a manifest, then leaves the page
 * for github.com, so it never returns to an idle state on success.
 */
export function GithubConnectButton({
  label = 'Connect GitHub',
  disabled = false,
  block = false,
  variant,
  size,
  className
}: {
  label?: string
  /** True for a member: the server refuses the manifest for anyone below admin. */
  disabled?: boolean
  /** Fills the width of its column, the way the auth cards' buttons do. */
  block?: boolean
  variant?: React.ComponentProps<typeof Button>['variant']
  size?: React.ComponentProps<typeof Button>['size']
  className?: string
}) {
  const manifest = useGithubManifest()

  return (
    <div className={className}>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={block ? 'w-full' : undefined}
        disabled={disabled || manifest.isPending || manifest.isSuccess}
        onClick={() =>
          manifest.mutate(undefined, { onSuccess: (result) => submitGithubManifest(result) })
        }
      >
        {manifest.isPending || manifest.isSuccess ? 'Opening GitHub…' : label}
      </Button>
      {manifest.isError ? (
        <p className="mt-2 text-xs text-destructive">{manifest.error.message}</p>
      ) : null}
    </div>
  )
}
