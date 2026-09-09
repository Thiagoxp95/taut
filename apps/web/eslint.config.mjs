import { config } from '@taut/eslint-config/react'

export default [
  { ignores: ['dist', 'src/routeTree.gen.ts'] },
  ...config,
  {
    // TanStack Router files export a `Route` object next to the component.
    rules: { 'react-refresh/only-export-components': 'off' }
  }
]
