import * as React from 'react'
import { Toaster as SonnerToaster, toast } from 'sonner'
import {
  CircleCheckIcon,
  AlertCircleIcon,
  InfoIcon,
  Loader2Icon,
  TriangleAlertIcon,
  XIcon
} from '@taut/ui/components/icons'

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
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <AlertCircleIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
        close: <XIcon className="size-3" />
      }}
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
