import { Effect, Either } from 'effect'
declare const InvalidInstanceUrl_base: new <A extends Record<string, any> = {}>(
  args: import('effect/Types').VoidIfEmpty<{
    readonly [P in keyof A as P extends '_tag' ? never : P]: A[P]
  }>
) => import('effect/Cause').YieldableError & {
  readonly _tag: 'InvalidInstanceUrl'
} & Readonly<A>
export declare class InvalidInstanceUrl extends InvalidInstanceUrl_base<{
  readonly message: string
}> {}
declare const InstanceUnreachable_base: new <A extends Record<string, any> = {}>(
  args: import('effect/Types').VoidIfEmpty<{
    readonly [P in keyof A as P extends '_tag' ? never : P]: A[P]
  }>
) => import('effect/Cause').YieldableError & {
  readonly _tag: 'InstanceUnreachable'
} & Readonly<A>
export declare class InstanceUnreachable extends InstanceUnreachable_base<{
  readonly message: string
}> {}
/**
 * `localhost:3000` → `http://localhost:3000`, and every form collapses to an
 * origin: the allowlist below compares origins, so a stored path or query
 * would quietly widen it.
 */
export declare const normalizeInstanceUrl: (
  raw: string
) => Either.Either<string, InvalidInstanceUrl>
/** `http://host` → `ws://host/ws?since=n` (and `https` → `wss`). */
export declare const socketUrl: (instanceUrl: string, since: number) => string
/**
 * Is this a Taut server? `GET /api/health` is unauthenticated, so it answers
 * before the user has logged in — which is the whole point of the check.
 */
export declare const probeInstance: (origin: string) => Effect.Effect<
  {
    readonly version: string
  },
  InstanceUnreachable
>
export {}
