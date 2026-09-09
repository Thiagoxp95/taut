import { Effect, Option, Schema } from 'effect'
/**
 * The only thing the shell remembers between launches: which Taut instance to
 * open, and how far its event log was replayed (so a restart resumes rather
 * than replaying a week of history for notifications).
 *
 * A plain JSON file in `app.getPath("userData")` — one dependency less than
 * `electron-store`, and readable when someone needs to reset it by hand.
 */
export declare const DesktopState: Schema.Struct<{
  instanceUrl: Schema.optional<typeof Schema.String>
  lastSeq: Schema.optionalWith<
    typeof Schema.Number,
    {
      default: () => number
    }
  >
}>
export type DesktopState = typeof DesktopState.Type
declare const Store_base: Effect.Service.Class<
  Store,
  'Store',
  {
    readonly effect: Effect.Effect<
      {
        readonly file: string
        readonly get: Effect.Effect<
          {
            readonly instanceUrl?: string | undefined
            readonly lastSeq: number
          },
          never,
          never
        >
        readonly instanceUrl: Effect.Effect<Option.Option<string>, never, never>
        readonly lastSeq: Effect.Effect<number, never, never>
        /** A new instance starts from the head of its own log, not from ours. */
        readonly setInstanceUrl: (instanceUrl: string) => Effect.Effect<
          {
            readonly instanceUrl?: string | undefined
            readonly lastSeq: number
          },
          never,
          never
        >
        readonly clearInstance: Effect.Effect<void, never, never>
        readonly setLastSeq: (lastSeq: number) => Effect.Effect<void, never, never>
      },
      never,
      never
    >
  }
>
/** Persisted shell state. Reads are in-memory; writes are best-effort. */
export declare class Store extends Store_base {}
export {}
