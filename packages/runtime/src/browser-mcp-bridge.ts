/**
 * Runs inside either agent provider, using the installed, pinned Playwright MCP.
 * The public MCP transport and BrowserContext APIs let us observe its selected tab
 * without changing focus. Keep the launcher self-contained: docker has no Taut sources.
 */
export const browserMcpBridgeSource = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const readline = require('node:readline')
const [cli, endpoint, outputDir, targetFile] = process.argv.slice(2)
const cliPath = path.isAbsolute(cli)
  ? cli
  : (process.env.PATH || '')
      .split(path.delimiter)
      .map((dir) => path.join(dir, cli))
      .find((file) => fs.existsSync(file))
if (!cliPath) throw new Error('Playwright MCP executable not found')
const packageDir = path.dirname(fs.realpathSync(cliPath))
const load = createRequire(path.join(packageDir, 'package.json'))
const { createConnection } = require(path.join(packageDir, 'index.js'))
const { chromium } = load('playwright')
let browser, context, selected, newTabCall
let publishing = Promise.resolve()
const targets = new WeakMap()
const toolCalls = new Set()
function publish(page) {
  publishing = publishing.then(async () => {
    if (!page || page.isClosed()) return
    try {
      let targetId = targets.get(page)
      if (!targetId) {
        const session = await context.newCDPSession(page)
        try {
          targetId = (await session.send('Target.getTargetInfo')).targetInfo
            .targetId
        } finally {
          void session.detach().catch(() => {})
        }
        targets.set(page, targetId)
      }
      const temporary = targetFile + '.' + process.pid
      await fs.promises.writeFile(temporary, targetId)
      await fs.promises.rename(temporary, targetFile)
    } catch {
      /* Preview telemetry must never fail an agent tool. */
    }
  })
  return publishing
}
async function main() {
  const server = await createConnection(
    { browser: { cdpEndpoint: endpoint }, outputDir },
    async () => {
      browser = await chromium.connectOverCDP(endpoint)
      context = browser.contexts()[0]
      selected = context.pages()[0]
      context.on('page', (page) => {
        // A new-tab tool selects its page immediately, before navigation finishes.
        // An unsolicited popup does not change MCP's current tab.
        if (newTabCall !== undefined || !selected || selected.isClosed()) {
          selected = page
          newTabCall = undefined
          void publish(page)
        }
      })
      await publish(selected)
      return context
    },
  )
  let input
  const transport = {
    async start() {
      input = readline.createInterface({ input: process.stdin })
      input.on('line', (line) => {
        try {
          const message = JSON.parse(line)
          if (message.method === 'tools/call') {
            toolCalls.add(message.id)
            if (
              message.params?.name === 'browser_tabs' &&
              message.params.arguments?.action === 'new'
            )
              newTabCall = message.id
          }
          transport.onmessage?.(message)
        } catch (error) {
          transport.onerror?.(error)
        }
      })
      input.on('close', () => {
        transport.onclose?.()
        process.exit(0)
      })
    },
    async send(message) {
      if (message.id === newTabCall) newTabCall = undefined
      if (toolCalls.delete(message.id) && context) {
        // MCP's tab list is in BrowserContext page order, with an explicit current
        // index. URLs and visibility cannot identify a tab (even duplicate URLs work).
        const text = (message.result?.content || [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n')
        const section = text.match(
          /### (?:Open tabs|Result)\n(- \d+:[\s\S]*?)(?=\n### |$)/,
        )
        const current = section?.[1].match(/^- (\d+): \(current\) /m)
        if (current) selected = context.pages()[Number(current[1])]
        else if (context.pages().length === 1) selected = context.pages()[0]
        await publish(selected)
      }
      await new Promise((resolve, reject) =>
        process.stdout.write(JSON.stringify(message) + '\n', (error) =>
          error ? reject(error) : resolve(),
        ),
      )
    },
    async close() {
      input?.close()
    },
  }
  await server.connect(transport)
}
main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
`
