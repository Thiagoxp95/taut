import { defineConfig } from 'tsup'

// Migrations are emitted as separate files so the file-system migration loader
// can `import()` them from `dist/db/migrations` at runtime (see src/paths.ts).
export default defineConfig({
  entry: ['src/main.ts', 'src/seed.ts', 'src/db/migrations/*.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  // The workspace packages ship TypeScript source; bundle them so `node dist/main.js` needs no
  // loader. Their native / CJS-only dependencies stay in node_modules (`pnpm deploy --prod`
  // keeps them): dockerode's ssh2 + cpu-features `.node` addons and better-sqlite3.
  noExternal: ['@taut/contract', '@taut/runtime', '@taut/memory', '@taut/taut-mcp'],
  external: ['dockerode', 'ssh2', 'cpu-features', 'better-sqlite3'],
  banner: {
    // Bundled CJS remnants may still reference `require` / `__filename` / `__dirname`.
    js: [
      "import { createRequire as __tautCreateRequire } from 'node:module';",
      "import { fileURLToPath as __tautFileURLToPath } from 'node:url';",
      "import { dirname as __tautDirname } from 'node:path';",
      'const require = __tautCreateRequire(import.meta.url);',
      'const __filename = __tautFileURLToPath(import.meta.url);',
      'const __dirname = __tautDirname(__filename);'
    ].join('\n')
  },
  splitting: false,
  sourcemap: true,
  clean: true
})
