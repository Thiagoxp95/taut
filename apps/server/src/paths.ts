import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(import.meta.url)

const findPackageRoot = (start: string): string => {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

/** Absolute path of `apps/server`, whether running from `src/` (tsx, vitest) or `dist/` (tsup). */
export const packageRoot = findPackageRoot(dirname(here))

export const runningFromDist = here.startsWith(join(packageRoot, 'dist') + sep)

/** Directory the `@effect/sql` file-system migration loader reads `NNNN_name.(ts|js)` from. */
export const migrationsDir = join(packageRoot, runningFromDist ? 'dist' : 'src', 'db', 'migrations')

/** Built web client, served at `/` with SPA fallback when present. */
export const defaultWebDist = resolve(packageRoot, '..', 'web', 'dist')
