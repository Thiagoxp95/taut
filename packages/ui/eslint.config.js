import { config } from '@taut/eslint-config/react'

export default [
  ...config,
  {
    // shadcn components export variants alongside components; not a Vite HMR boundary.
    rules: { 'react-refresh/only-export-components': 'off' }
  }
]
