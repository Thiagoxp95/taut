/**
 * stdio entry point: `node dist/mcp.js` (bundled) or `tsx src/mcp.ts`. Reads `TAUT_URL` and
 * `TAUT_TOKEN` from the environment; nothing else. Logs go to stderr — stdout is the protocol.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createTautServer, makeRuntime, preflight } from './server.js'

const main = async (): Promise<void> => {
  const runtime = makeRuntime()
  try {
    await preflight(runtime)
  } catch (e) {
    process.stderr.write(`taut-mcp: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 1
    return
  }
  const server = createTautServer(runtime)
  const transport = new StdioServerTransport()
  const shutdown = async () => {
    await server.close().catch(() => undefined)
    await runtime.dispose().catch(() => undefined)
  }
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)))
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)))
  transport.onclose = () => void shutdown().then(() => process.exit(0))
  await server.connect(transport)
}

void main()
