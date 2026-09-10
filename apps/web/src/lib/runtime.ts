import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  type InfiniteData,
  type UseInfiniteQueryOptions,
  type UseInfiniteQueryResult,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult
} from '@tanstack/react-query'
import { Effect, Layer, ManagedRuntime } from 'effect'

import { Api, ApiLive, toApiError, type ApiError } from '@/lib/api-client'

/** The app's service layer: the typed `HttpApiClient` over `FetchHttpClient`. */
export const AppLayer: Layer.Layer<Api> = ApiLive

/**
 * One `ManagedRuntime` for the whole SPA, created at module load and never
 * rebuilt — React components only ever *run* effects on it.
 */
export const runtime: ManagedRuntime.ManagedRuntime<Api, never> = ManagedRuntime.make(AppLayer)

/**
 * Run an effect as a promise, translating any typed failure into the single
 * `ApiError` shape React deals with.
 */
export async function runEffect<A>(
  effect: Effect.Effect<A, unknown, Api>,
  signal?: AbortSignal
): Promise<A> {
  const result = await runtime.runPromise(
    Effect.either(effect),
    signal === undefined ? undefined : { signal }
  )
  if (result._tag === 'Left') throw toApiError(result.left)
  return result.right
}

/** Fire-and-forget escape hatch for event handlers. */
export function runFork(effect: Effect.Effect<unknown, unknown, Api>): void {
  runtime.runFork(Effect.ignoreLogged(effect))
}

export function runPromise<A>(effect: Effect.Effect<A, unknown, Api>): Promise<A> {
  return runEffect(effect)
}

type EffectQueryOptions<A> = Omit<
  UseQueryOptions<A, ApiError, A, readonly unknown[]>,
  'queryKey' | 'queryFn'
>

/**
 * Bridge an Effect into TanStack Query. The query is cancelled through the
 * `AbortSignal` React Query hands us, so an unmounted route stops its work.
 */
export function useEffectQuery<A>(
  key: readonly unknown[],
  effect: Effect.Effect<A, unknown, Api>,
  options?: EffectQueryOptions<A>
): UseQueryResult<A, ApiError> {
  return useQuery<A, ApiError, A, readonly unknown[]>({
    ...options,
    queryKey: key,
    queryFn: ({ signal }) => runEffect(effect, signal)
  })
}

/**
 * Cursors stay `string` on purpose: TanStack's `QueryFunctionContext` narrows
 * `pageParam` through a conditional type, which a free type parameter would
 * leave deferred. Callers brand it back (`MessageId.make(cursor)`).
 */
export type Cursor = string | undefined

type EffectInfiniteQueryOptions<A> = Omit<
  UseInfiniteQueryOptions<A, ApiError, InfiniteData<A, Cursor>, readonly unknown[], Cursor>,
  'queryKey' | 'queryFn' | 'initialPageParam' | 'getNextPageParam'
>

export type EffectInfiniteQueryResult<A> = UseInfiniteQueryResult<InfiniteData<A, Cursor>, ApiError>

/** Same bridge for paged endpoints: `page(cursor)` builds the request. */
export function useEffectInfiniteQuery<A>(
  key: readonly unknown[],
  page: (cursor: Cursor) => Effect.Effect<A, unknown, Api>,
  getNextPageParam: (last: A, all: readonly A[]) => Cursor,
  options?: EffectInfiniteQueryOptions<A>
): EffectInfiniteQueryResult<A> {
  return useInfiniteQuery<A, ApiError, InfiniteData<A, Cursor>, readonly unknown[], Cursor>({
    ...options,
    queryKey: key,
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) => runEffect(page(pageParam), signal),
    getNextPageParam: (last, all) => getNextPageParam(last, all)
  })
}

type EffectMutationOptions<A, V, C> = Omit<UseMutationOptions<A, ApiError, V, C>, 'mutationFn'>

/**
 * Bridge an Effect into a TanStack mutation; failures arrive as `ApiError`.
 *
 * `C` is the context `onMutate` hands to `onError` and `onSettled`, and it is a
 * parameter rather than TanStack's default `unknown` so an optimistic mutation
 * can carry the snapshot it has to roll back to (docs/build-plan-issues.md D3)
 * without a cast. It defaults to `unknown`, so every mutation that does not roll
 * anything back reads exactly as it did before.
 */
export function useEffectMutation<A, V = void, C = unknown>(
  mutate: (variables: V) => Effect.Effect<A, unknown, Api>,
  options?: EffectMutationOptions<A, V, C>
): UseMutationResult<A, ApiError, V, C> {
  return useMutation<A, ApiError, V, C>({
    ...options,
    mutationFn: (variables) => runEffect(mutate(variables))
  })
}
