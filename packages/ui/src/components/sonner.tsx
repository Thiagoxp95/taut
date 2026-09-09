import * as React from 'react'
import { Toaster as SonnerToaster, toast } from 'sonner'

type ToasterProps = React.ComponentProps<typeof SonnerToaster>

/**
 * Theme is read from the `dark` class on <html> (see `useTheme` in the app),
 * so this package stays free of a theme-provider dependency.
 */
function useHtmlTheme(): 'light' | 'dark' {
  const [theme, setTheme] = React.useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light'
  )

  React.useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      setTheme(root.classList.contains('dark') ? 'dark' : 'light')
    })
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return theme
}

function Toaster({ ...props }: ToasterProps) {
  const theme = useHtmlTheme()

  return (
    <SonnerToaster
      theme={theme}
      className="toaster group"
      position="bottom-right"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)'
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster, toast }
