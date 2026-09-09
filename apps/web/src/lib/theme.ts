import * as React from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'taut.theme'

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    /* private mode */
  }
  return 'system'
}

function apply(preference: ThemePreference): void {
  const dark =
    preference === 'dark' ||
    (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

export interface ThemeState {
  readonly preference: ThemePreference
  readonly resolved: 'light' | 'dark'
  readonly setPreference: (next: ThemePreference) => void
  readonly toggle: () => void
}

/** Light/dark via the `dark` class on <html>, honouring `prefers-color-scheme`. */
export function useTheme(): ThemeState {
  const [preference, setPreferenceState] = React.useState<ThemePreference>(readPreference)
  const [systemDark, setSystemDark] = React.useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  React.useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  React.useEffect(() => {
    apply(preference)
  }, [preference, systemDark])

  const setPreference = React.useCallback((next: ThemePreference) => {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* private mode */
    }
    setPreferenceState(next)
  }, [])

  const resolved: 'light' | 'dark' =
    preference === 'system' ? (systemDark ? 'dark' : 'light') : preference

  const toggle = React.useCallback(() => {
    setPreference(resolved === 'dark' ? 'light' : 'dark')
  }, [resolved, setPreference])

  return { preference, resolved, setPreference, toggle }
}
