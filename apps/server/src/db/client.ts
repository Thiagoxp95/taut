import { Path } from '@effect/platform'
import { SqlClient } from '@effect/sql'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { Context, Effect, Layer } from 'effect'
import { AppConfig } from '../config.js'

export const DB_FILENAME = 'taut.db'

/** Per-connection settings. `SqliteClient` already enables WAL journaling itself. */
const applyPragmas = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`PRAGMA busy_timeout = 5000`
    yield* sql`PRAGMA synchronous = NORMAL`
  })

/**
 * `SqliteClient` at `<TAUT_DATA_DIR>/taut.db`: WAL mode, foreign keys on, 5s busy timeout.
 * Single connection; `sql.withTransaction` serialises transactions with a semaphore.
 */
export const SqliteLive: Layer.Layer<
  SqliteClient.SqliteClient | SqlClient.SqlClient,
  | Layer.Layer.Error<typeof AppConfig.Default>
  | Effect.Effect.Error<ReturnType<typeof applyPragmas>>,
  AppConfig | Path.Path
> = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const path = yield* Path.Path
    const filename = path.join(config.dataDir, DB_FILENAME)
    return SqliteClient.layer({ filename }).pipe(
      Layer.tap((context) => applyPragmas(Context.get(context, SqlClient.SqlClient))),
      Layer.tap(() => Effect.logDebug(`sqlite: ${filename}`))
    )
  })
)
