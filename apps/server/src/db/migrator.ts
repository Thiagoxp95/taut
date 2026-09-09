import { SqliteMigrator } from '@effect/sql-sqlite-node'
import { Layer } from 'effect'
import { migrationsDir } from '../paths.js'
import { SqliteLive } from './client.js'

/**
 * Runs every `src/db/migrations/NNNN_name.ts` (or `dist/db/migrations/NNNN_name.js`)
 * that is not yet recorded in `effect_sql_migrations`, in one transaction, at startup.
 *
 * Adding a migration: create `src/db/migrations/0002_<name>.ts` that default-exports an
 * `Effect` using `SqlClient` (see `0001_init.ts`). Ids must be unique and increasing;
 * applied migrations are never re-run, so never edit an existing file.
 */
export const MigratorLive = SqliteMigrator.layer({
  loader: SqliteMigrator.fromFileSystem(migrationsDir)
})

/** Migrated database: `SqliteClient` + `SqlClient`, with all migrations applied. */
export const DbLive = MigratorLive.pipe(Layer.provideMerge(SqliteLive))
