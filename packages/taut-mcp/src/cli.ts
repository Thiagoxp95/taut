/** bin entry: `taut …` (bundled to `dist/cli.js`). */
import { runCli } from './cli-core.js'
import { makeRuntime } from './server.js'

/** git's credential block, read to EOF. Only `git-credential` asks for it. */
const readStdin = async (): Promise<string> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  // The credential helper answers git, not a human: a missing TAUT_URL, an unreachable server
  // or any other failure must exit 0 with an empty stdout, or git falls back to prompting for
  // a username on a terminal that does not exist and the clone hangs forever.
  const isCredentialHelper = argv[0] === 'git-credential'
  const stdin = isCredentialHelper ? await readStdin() : ''
  const runtime = makeRuntime()
  try {
    const { stdout, exitCode } = await runtime.runPromise(runCli(argv, stdin))
    process.stdout.write(stdout.length === 0 ? '' : `${stdout}\n`)
    process.exitCode = exitCode
  } catch (e) {
    // Only config errors escape `runCli` (missing TAUT_URL / TAUT_TOKEN).
    if (isCredentialHelper) {
      process.exitCode = 0
      return
    }
    process.stderr.write(`taut: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 2
  } finally {
    await runtime.dispose().catch(() => undefined)
  }
}

void main()
