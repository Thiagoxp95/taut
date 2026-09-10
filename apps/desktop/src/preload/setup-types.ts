import type { DesktopUpdateBridge } from '@taut/contract/desktop'
/**
 * The Connect screen's bridge, as types only — kept out of `setup.ts` so the
 * renderer's type program can see `window.tautSetup` without pulling in
 * `electron`, which only exists in the preload's own runtime.
 */
export interface SetupState {
  readonly defaultUrl: string
  /** The instance the shell is already configured for, if any. */
  readonly instanceUrl?: string
}

export type ConnectResult =
  | { readonly ok: true; readonly url: string; readonly version: string }
  | { readonly ok: false; readonly message: string }

export interface TautSetupBridge {
  readonly updates: DesktopUpdateBridge
  readonly state: () => Promise<SetupState>
  /** Validates `GET <url>/api/health`, stores the URL, then loads the instance. */
  readonly connect: (url: string) => Promise<ConnectResult>
}

declare global {
  interface Window {
    /** Present only on the shell's own Connect screen, never on an instance page. */
    readonly tautSetup?: TautSetupBridge
  }
}
