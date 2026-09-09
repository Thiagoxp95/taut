/**
 * The MCP server: lists `tools` and dispatches `tools/call` through an Effect runtime that
 * holds the `TautClient`. Transport-agnostic — `mcp.ts` attaches stdio, tests attach
 * `InMemoryTransport`.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { FetchHttpClient } from '@effect/platform'
import { Cause, Effect, Exit, Layer, ManagedRuntime } from 'effect'
import { TautClient } from './client.js'
import { describeToolError, isToolError, runTool, tools } from './tools.js'

export const SERVER_NAME = 'taut'
export const SERVER_VERSION = '0.0.0'

/** Injected as MCP `instructions`; the runtime shows it alongside the tool list (§9 preamble). */
export const INSTRUCTIONS = [
  'You are a member of a Taut workspace. These tools are how you talk to your team and remember.',
  'Rules: check taut_inbox at checkpoints and right before taut_done. Call taut_done exactly once,',
  'last. If taut_ask returns { parked: true }, end your turn — you will be resumed with the answer.',
  'Search memory_search before asking a human something that may already have been decided.',
  'Never use your own AskUserQuestion-style tools: the humans are in Taut, not at your terminal.'
].join(' ')

/** The production layer: real HTTP, env-driven config. */
export const TautLive: Layer.Layer<
  TautClient,
  Layer.Layer.Error<typeof TautClient.Default>
> = TautClient.Default.pipe(Layer.provide(FetchHttpClient.layer))

export type TautRuntime = ManagedRuntime.ManagedRuntime<TautClient, unknown>

const ok = (result: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  structuredContent: result
})

const failed = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }]
})

/** Build a `Server` (not yet connected) whose tool calls run on `runtime`. */
export const createTautServer = (runtime: TautRuntime): Server => {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: t.inputSchema.type,
        properties: { ...t.inputSchema.properties },
        required: [...t.inputSchema.required],
        additionalProperties: false
      }
    }))
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const exit = await runtime.runPromiseExit(
      runTool(request.params.name, request.params.arguments ?? {})
    )
    return Exit.match(exit, {
      onSuccess: ok,
      onFailure: (cause) => {
        const failure = Cause.failureOption(cause)
        if (failure._tag === 'Some' && isToolError(failure.value)) {
          return failed(describeToolError(failure.value))
        }
        return failed(`tool crashed: ${Cause.pretty(cause)}`)
      }
    })
  })

  return server
}

/** Convenience for `mcp.ts` and tests: a runtime over the production layer (or an override). */
export const makeRuntime = (layer: Layer.Layer<TautClient, unknown> = TautLive): TautRuntime =>
  ManagedRuntime.make(layer)

/** Fail fast on a missing `TAUT_URL`/`TAUT_TOKEN` instead of on the first tool call. */
export const preflight = (runtime: TautRuntime): Promise<void> =>
  runtime.runPromise(Effect.asVoid(TautClient))
