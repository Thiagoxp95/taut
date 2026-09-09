import { defineConfig } from 'tsup'

// Single-file bundles so the runtime image runs `node /opt/taut/mcp.js` with no node_modules.
export default defineConfig({
  entry: { mcp: 'src/mcp.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  minify: false,
  clean: true,
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'
  }
})
