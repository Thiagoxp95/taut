import { app } from 'electron'
import { Effect, Option, Ref, Schema } from 'effect'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
/**
 * The only thing the shell remembers between launches: which Taut instance to
 * open, and how far its event log was replayed (so a restart resumes rather
 * than replaying a week of history for notifications).
 *
 * A plain JSON file in `app.getPath("userData")` — one dependency less than
 * `electron-store`, and readable when someone needs to reset it by hand.
 */
export const DesktopState = Schema.Struct({
  instanceUrl: Schema.optional(Schema.String),
  lastSeq: Schema.optionalWith(Schema.Number, { default: () => 0 })
})
const EMPTY = { lastSeq: 0 }
const decode = Schema.decodeUnknownOption(DesktopState)
const encode = Schema.encodeSync(DesktopState)
const STATE_FILE = 'instance.json'
/** Persisted shell state. Reads are in-memory; writes are best-effort. */
export class Store extends Effect.Service()('Store', {
  effect: Effect.gen(function* () {
    const file = join(app.getPath('userData'), STATE_FILE)
    const loaded = yield* Effect.sync(() => {
      try {
        return decode(JSON.parse(readFileSync(file, 'utf8')))
      } catch {
        return Option.none()
      }
    })
    const ref = yield* Ref.make(Option.getOrElse(loaded, () => EMPTY))
    const flush = (state) =>
      Effect.try(() => {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `${JSON.stringify(encode(state), null, 2)}\n`, 'utf8')
      }).pipe(
        // A read-only userData dir must not take the app down; it only costs
        // the user one extra trip through the Connect screen.
        Effect.catchAll((error) => Effect.logWarning(`store: could not persist ${file}`, error))
      )
    const update = (f) => Ref.updateAndGet(ref, f).pipe(Effect.tap(flush))
    return {
      file,
      get: Ref.get(ref),
      instanceUrl: Ref.get(ref).pipe(Effect.map((state) => Option.fromNullable(state.instanceUrl))),
      lastSeq: Ref.get(ref).pipe(Effect.map((state) => state.lastSeq)),
      /** A new instance starts from the head of its own log, not from ours. */
      setInstanceUrl: (instanceUrl) =>
        update((state) =>
          state.instanceUrl === instanceUrl ? state : { instanceUrl, lastSeq: 0 }
        ),
      clearInstance: update(() => EMPTY).pipe(Effect.asVoid),
      setLastSeq: (lastSeq) =>
        update((state) => (lastSeq > state.lastSeq ? { ...state, lastSeq } : state)).pipe(
          Effect.asVoid
        )
    }
  })
}) {}
