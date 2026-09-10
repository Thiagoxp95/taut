/**
 * Browser access for agents (docs/build-plan-browser-vaults.md D1, D7): Playwright MCP
 * (`@playwright/mcp@0.0.80`) runs as a **second stdio MCP server inside the agent's
 * machine**, next to `taut`, under the server key `browser`. Headless Chromium, a
 * persistent profile at `<home>/.taut/browser/profile` (logins survive tasks) and
 * screenshots / traces under `<home>/.taut/browser/out`.
 *
 * Flags (verified against `playwright-mcp 0.0.80 --help` on 2026-09-08):
 *
 *   --headless --browser chromium [--no-sandbox] --user-data-dir <dir> --output-dir <dir>
 *
 * `--browser chromium` is the Playwright-managed "Chrome for Testing" build that
 * `playwright install chromium` downloads (`--help` lists only the branded channels
 * `chrome|firefox|webkit|msedge`, but `chromium` is accepted and is what the package's
 * own Dockerfile uses). `--no-sandbox` only inside containers: the container is the sandbox
 * (cap-drop ALL, no-new-privileges, read-only rootfs) and Chromium's own sandbox needs
 * caps it lacks. Playwright always adds `--disable-dev-shm-usage`, so `/dev/shm` size is
 * not a concern.
 *
 * Browser binaries: in the image at `/opt/pw-browsers` (`PLAYWRIGHT_BROWSERS_PATH`, set by
 * the Dockerfile). On the `local` provider the child's `HOME` is `<home>/.taut/home`
 * (`LOCAL_ENV_ALLOWLIST`), so Playwright would look for browsers in the wrong place —
 * `browserMcpSpec` therefore pins `PLAYWRIGHT_BROWSERS_PATH` to the host's real cache
 * (the one `npx playwright install chromium` fills).
 *
 * The server package: `writeMcpConfig` adds `extraServers: { browser: browserMcpSpec(…) }`
 * (`@taut/taut-mcp` `inject.ts`) and `buildCommand` gets
 * `mcp.allowedTools = ['mcp__taut__*', BROWSER_MCP_ALLOWED_TOOL]`.
 */
import type { RuntimeKind } from '@taut/contract/domain'
import { Effect } from 'effect'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'

import type { BinaryMissing, Machine, MachineUnavailable } from './machine/types.js'
import { ExecFailed } from './machine/types.js'

export { browserMcpBridgeSource } from './browser-mcp-bridge.js'

export const BROWSER_MCP_SERVER_KEY = 'browser'
/** Claude Code `--allowedTools` pattern for every Playwright MCP tool. */
export const BROWSER_MCP_ALLOWED_TOOL = 'mcp__browser__*'
/**
 * Claude Code's own web tools. They belong to no MCP server, but headless `claude` denies
 * anything the `--allowedTools` list does not name, so without an entry here they come back
 * as "Claude requested permissions to use WebSearch, but you haven't granted it yet".
 *
 * They ride with `browserAccess` because that switch is what the owner reads as "this agent
 * may reach the web". Observed on 2026-09-09: an agent asked for the day's AI news called
 * `WebSearch` first, was denied, and reported having no web capability at all — never trying
 * the `mcp__browser__*` tools it did have. `browserPromptLine` now names both halves.
 */
export const BROWSER_WEB_BUILTIN_TOOLS = ['WebSearch', 'WebFetch'] as const
/** Exact version pinned in package.json and the agent image. */
export const BROWSER_MCP_PACKAGE = '@playwright/mcp'
export const BROWSER_MCP_VERSION = '0.0.80'
/** Global bin name in the `taut/agent` image (`npm i -g @playwright/mcp`). */
export const BROWSER_MCP_DOCKER_COMMAND = 'playwright-mcp'
/** Where the image keeps Chromium (outside the bind-mounted home). */
export const DOCKER_PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers'

/**
 * Live view (docs/build-plan-workspace.md D11, D18): on docker, Taut starts Chromium
 * itself with its debug port bound to loopback *inside* the box, and `playwright-mcp`
 * attaches to it with `--cdp-endpoint` instead of launching its own. With the endpoint
 * and no `--isolated`, playwright-mcp binds `browser.contexts()[0]` — the default
 * context of that Chromium, i.e. the persistent profile — so a login a human does by
 * hand through the live view is the one the agent's tools see (verified in
 * playwright-core 1.63.0-alpha's `createCDPBrowser` / `contexts()[0]`, 2026-09-08).
 */
export const BROWSER_CDP_PORT = 9222
export const browserCdpEndpoint = (port: number = BROWSER_CDP_PORT): string =>
  `http://127.0.0.1:${port}`

/** Sub-paths under the agent home (machine-visible). */
export const BROWSER_PATHS = {
  profile: '.taut/browser/profile',
  output: '.taut/browser/out',
  bridge: '.taut/browser/mcp-bridge.cjs',
  activeTarget: '.taut/browser/active-target'
} as const

export interface BrowserMcpSpec {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env?: Record<string, string>
}

export interface BrowserMcpSpecOptions {
  /** Report the tool-selected CDP target to the live preview. Launcher must be installed first. */
  readonly follow?: boolean
  readonly provider: 'local' | 'docker'
  /** Agent home **as seen inside the machine** (`/home/agent` on docker; the host path on local). */
  readonly homeDir: string
  /**
   * Docker only: attach to the Chromium Taut started (`ensureBrowserDaemon`) instead of
   * launching one. Absent → the original self-launching spec, byte for byte.
   */
  readonly cdpEndpoint?: string
}

export const browserProfileDir = (homeDir: string): string =>
  posix.join(homeDir, BROWSER_PATHS.profile)
export const browserOutputDir = (homeDir: string): string =>
  posix.join(homeDir, BROWSER_PATHS.output)

/**
 * Path of `@playwright/mcp`'s `cli.js` for the `local` provider. The package's `exports`
 * map exposes only `.` and `./package.json`, so `cli.js` is resolved next to the latter.
 */
export const browserMcpCliPath = (): string =>
  join(
    dirname(createRequire(import.meta.url).resolve(`${BROWSER_MCP_PACKAGE}/package.json`)),
    'cli.js'
  )

/**
 * Playwright's default browser cache on the host — what `npx playwright install chromium`
 * fills (mirrors `playwright-core`'s `registryDirectory()`); `PLAYWRIGHT_BROWSERS_PATH` wins.
 */
export const hostPlaywrightBrowsersPath = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform
): string => {
  const explicit = env['PLAYWRIGHT_BROWSERS_PATH']
  if (explicit !== undefined && explicit.length > 0 && explicit !== '0') return explicit
  const home = env['HOME'] !== undefined && env['HOME'].length > 0 ? env['HOME'] : homedir()
  switch (platform) {
    case 'darwin':
      return join(home, 'Library', 'Caches', 'ms-playwright')
    case 'win32': {
      const local = env['LOCALAPPDATA']
      return join(local !== undefined && local.length > 0 ? local : home, 'ms-playwright')
    }
    default: {
      const xdg = env['XDG_CACHE_HOME']
      return join(xdg !== undefined && xdg.length > 0 ? xdg : join(home, '.cache'), 'ms-playwright')
    }
  }
}

const commonArgs = (homeDir: string): ReadonlyArray<string> => [
  '--headless',
  '--browser',
  'chromium',
  '--user-data-dir',
  browserProfileDir(homeDir),
  '--output-dir',
  browserOutputDir(homeDir)
]

/** Opt-in for the trusted shared-runtime image; ordinary local development keeps Chromium's sandbox. */
const localSandboxArgs = (): ReadonlyArray<string> =>
  process.env['TAUT_BROWSER_NO_SANDBOX'] === 'true' ? ['--no-sandbox'] : []

/**
 * How to start the `browser` MCP server inside the agent's machine.
 *
 * - `docker`: `playwright-mcp --headless --browser chromium --no-sandbox --user-data-dir … --output-dir …`
 * - `local` : `node <@playwright/mcp/cli.js> --headless --browser chromium --user-data-dir … --output-dir …`
 *   with `PLAYWRIGHT_BROWSERS_PATH` pointing at the host cache (see the file header).
 */
export const browserMcpSpec = (o: BrowserMcpSpecOptions): BrowserMcpSpec => {
  if (o.follow && o.cdpEndpoint) {
    return {
      command: 'node',
      args: [
        posix.join(o.homeDir, BROWSER_PATHS.bridge),
        o.provider === 'local' ? browserMcpCliPath() : BROWSER_MCP_DOCKER_COMMAND,
        o.cdpEndpoint,
        browserOutputDir(o.homeDir),
        posix.join(o.homeDir, BROWSER_PATHS.activeTarget)
      ],
      ...(o.provider === 'local'
        ? { env: { PLAYWRIGHT_BROWSERS_PATH: hostPlaywrightBrowsersPath() } }
        : {})
    }
  }
  switch (o.provider) {
    case 'docker':
      if (o.cdpEndpoint !== undefined) {
        // Launch flags (headless, sandbox, profile) belong to the Chromium Taut started.
        return {
          command: BROWSER_MCP_DOCKER_COMMAND,
          args: ['--cdp-endpoint', o.cdpEndpoint, '--output-dir', browserOutputDir(o.homeDir)]
        }
      }
      return {
        command: BROWSER_MCP_DOCKER_COMMAND,
        args: [
          '--headless',
          '--browser',
          'chromium',
          '--no-sandbox',
          ...commonArgs(o.homeDir).slice(3)
        ]
      }
    case 'local':
      if (o.cdpEndpoint !== undefined) {
        // Same deal as docker: the agent's tools attach to the Chromium Taut started
        // (`ensureLocalBrowserDaemon`), so the live view and the agent share one
        // browser — and one `--user-data-dir`, which Chromium will not open twice.
        return {
          command: 'node',
          args: [
            browserMcpCliPath(),
            '--cdp-endpoint',
            o.cdpEndpoint,
            '--output-dir',
            browserOutputDir(o.homeDir)
          ],
          env: { PLAYWRIGHT_BROWSERS_PATH: hostPlaywrightBrowsersPath() }
        }
      }
      return {
        command: 'node',
        args: [browserMcpCliPath(), ...commonArgs(o.homeDir), ...localSandboxArgs()],
        env: {
          PLAYWRIGHT_BROWSERS_PATH: hostPlaywrightBrowsersPath(),
          TMPDIR: process.platform === 'win32' ? tmpdir() : '/tmp'
        }
      }
  }
}

// ---------------------------------------------------------------------------
// The Chromium daemon in the box (D11)
// ---------------------------------------------------------------------------

export interface BrowserDaemonOptions {
  /** Agent home as the machine sees it. */
  readonly homeDir: string
  readonly port?: number
}

/**
 * `bash` that makes sure one headless Chromium is listening on `127.0.0.1:<port>` in the
 * box, and prints `running` (it already was) or `started`. Idempotent: the probe is a
 * bash `/dev/tcp` connect, so no second Chromium ever fights the first for the profile.
 *
 * - the binary is whatever `playwright install chromium` put under `/opt/pw-browsers`
 *   (`chromium-<rev>/chrome-linux{,64,-arm64}/chrome`, per playwright-core's registry)
 * - `--no-sandbox` because the container is the sandbox (build-plan-browser-vaults.md D7)
 * - `--remote-debugging-address=127.0.0.1`: never the bridge address, never `0.0.0.0` (D18)
 * - `env -u TAUT_EXEC_ID setsid nohup … &`: the daemon outlives this exec and carries no
 *   exec id, so neither an interrupted exec nor a D15 task freeze ever touches it
 * - stdio to `/dev/null`, so this exec's stream ends as soon as the port answers
 */
export const browserDaemonScript = (o: BrowserDaemonOptions): string => {
  const port = o.port ?? BROWSER_CDP_PORT
  const profile = browserProfileDir(o.homeDir)
  return [
    `port=${port}`,
    `profile=${JSON.stringify(profile)}`,
    'alive() { (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; }',
    'if alive; then echo running; exit 0; fi',
    'bin=""',
    `for c in ${DOCKER_PLAYWRIGHT_BROWSERS_PATH}/chromium-*/chrome-linux*/chrome; do if [ -x "$c" ]; then bin="$c"; break; fi; done`,
    `if [ -z "$bin" ]; then echo "no chromium under ${DOCKER_PLAYWRIGHT_BROWSERS_PATH}" >&2; exit 3; fi`,
    'mkdir -p "$profile"',
    'env -u TAUT_EXEC_ID setsid nohup "$bin" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage' +
      ' --no-first-run --no-default-browser-check --disable-background-networking' +
      ' --window-size=1280,800 "--remote-debugging-port=$port" --remote-debugging-address=127.0.0.1' +
      ' "--user-data-dir=$profile" about:blank >/dev/null 2>&1 </dev/null &',
    'for i in $(seq 1 100); do if alive; then echo started; exit 0; fi; sleep 0.1; done',
    'echo "chromium did not open 127.0.0.1:$port within 10s" >&2; exit 4'
  ].join('\n')
}

/**
 * Run `browserDaemonScript` in the box. Returns whether Chromium was already `running`
 * or was just `started`; any other outcome is an `ExecFailed` carrying the script's
 * stderr. Callers: the task runner before a browser-enabled task, and the terminal
 * socket when a viewer opens the live view.
 */
export const ensureBrowserDaemon = (
  machine: Pick<Machine, 'exec' | 'spec'>,
  options: BrowserDaemonOptions
): Effect.Effect<'running' | 'started', ExecFailed | BinaryMissing | MachineUnavailable> =>
  Effect.gen(function* () {
    const out: Array<string> = []
    const err: Array<string> = []
    const result = yield* machine.exec({
      cmd: ['bash', '-c', browserDaemonScript(options)],
      timeoutMs: 20_000,
      onLine: (line) => {
        out.push(line)
      },
      onStderr: (line) => {
        err.push(line)
      }
    })
    const last = out[out.length - 1]
    if (result.exitCode === 0 && (last === 'running' || last === 'started')) return last
    return yield* new ExecFailed({
      agentId: machine.spec.agentId,
      cmd: ['bash', 'browserDaemonScript'],
      reason: err.join(' ') || `chromium launch exited ${result.exitCode}`,
      exitCode: result.exitCode
    })
  })

// ---------------------------------------------------------------------------
// The Chromium daemon on the host (`local` provider)
// ---------------------------------------------------------------------------

/**
 * Where playwright-core puts the Chromium binary inside one `chromium-<rev>` dir,
 * per platform. Both the branded "Chrome for Testing" layout and the older
 * `Chromium.app` / `chrome-linux` ones, newest install wins.
 */
const CHROMIUM_RELATIVE_BINARIES: Readonly<Record<string, ReadonlyArray<string>>> = {
  darwin: [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium'
  ],
  linux: ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-linux-arm64/chrome'],
  win32: ['chrome-win/chrome.exe']
}

/** Revision number out of `chromium-1243` / `chromium_headless_shell-1243`; `-1` if none. */
const revisionOf = (name: string): number => {
  const dash = name.lastIndexOf('-')
  const n = dash === -1 ? NaN : Number(name.slice(dash + 1))
  return Number.isFinite(n) ? n : -1
}

/**
 * The headed Chromium `playwright install chromium` put in the host cache, or `null`
 * when there is none. The headless-shell build is deliberately *not* accepted: it
 * cannot render the screencast the live view is made of.
 */
export const hostChromiumExecutable = (
  root: string = hostPlaywrightBrowsersPath(),
  platform: NodeJS.Platform = process.platform
): string | null => {
  const candidates = CHROMIUM_RELATIVE_BINARIES[platform] ?? CHROMIUM_RELATIVE_BINARIES['linux']
  let entries: ReadonlyArray<string>
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }
  const installs = entries
    .filter((name) => name.startsWith('chromium-'))
    .sort((a, b) => revisionOf(b) - revisionOf(a))
  for (const install of installs) {
    for (const relative of candidates ?? []) {
      const binary = join(root, install, relative)
      if (existsSync(binary)) return binary
    }
  }
  return null
}

/**
 * `GET /json/version` on a loopback port, or `null` when nothing usable answers.
 * Short timeout: this runs on the request path of the Workspace tab.
 */
const cdpVersion = (
  port: number,
  timeoutMs = 1_000
): Promise<{ Browser?: string; 'User-Agent'?: string } | null> =>
  new Promise((resolve) => {
    const request = httpGet(
      { host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          resolve(null)
          return
        }
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          text += chunk
        })
        response.on('end', () => {
          try {
            resolve(JSON.parse(text) as { Browser?: string; 'User-Agent'?: string })
          } catch {
            resolve(null)
          }
        })
        response.on('error', () => resolve(null))
      }
    )
    request.on('timeout', () => {
      request.destroy()
      resolve(null)
    })
    request.on('error', () => resolve(null))
  })

/**
 * The one identity check that keeps the `local` live view off the owner's own browser.
 *
 * A developer machine very often already has a Chrome listening on the conventional
 * debug port (a devtools session, an extension's host) — attaching to it would put
 * that person's real tabs, cookies and logins on screen and under an agent's hands.
 * Taut's own daemon is headless, so a headed browser is never accepted.
 *
 * The tell is the **user agent**, not the `Browser` field: since `--headless=new`,
 * `/json/version` reports `Browser: "Chrome/153…"` exactly like a headed one, and only
 * the UA still carries `HeadlessChrome/…` (checked against Chrome for Testing 153 on
 * 2026-09-08). Ports are per agent and picked from the ephemeral range on top of this
 * (`freePort`), so the two never even meet in practice.
 */
const isTautBrowser = async (port: number): Promise<boolean> => {
  const version = await cdpVersion(port)
  const agent = version?.['User-Agent']
  return typeof agent === 'string' && agent.includes('HeadlessChrome')
}

/** A free loopback port from the ephemeral range, as the OS hands it out. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => (port === 0 ? reject(new Error('no free port')) : resolve(port)))
    })
  })

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** How long Chromium gets to open its debug port before the live view gives up. */
const LOCAL_BROWSER_START_TIMEOUT_MS = 20_000

/**
 * Where the agent's Chromium debug port is recorded, so the task runner (which writes
 * `--cdp-endpoint` into the MCP config) and the live view agree on one browser even
 * across a server restart.
 */
export const localBrowserPortFile = (homeDir: string): string =>
  posix.join(homeDir, '.taut/browser/cdp-port')

export interface LocalBrowserDaemon {
  readonly state: 'running' | 'started'
  /** Loopback port this agent's Chromium listens on. Per agent, never the shared 9222. */
  readonly port: number
}

const localBrowserStarts = new Map<string, Promise<LocalBrowserDaemon>>()

/**
 * Make sure one headless Chromium is listening on the host for this agent, on its own
 * profile, and say whether it already was (`running`) or was just `started`. The
 * `local` counterpart of `ensureBrowserDaemon`: there is no box here, so nothing is
 * relayed through `Machine.exec` — Node spawns the binary itself, detached and
 * `unref`ed, so it outlives the request that started it and is never caught by an
 * exec's process-group kill.
 *
 * This is not the D2 hazard: what a viewer drives is a browser Taut launched on the
 * agent's profile, not a shell on the owner's machine.
 */
export const ensureLocalBrowserDaemon = (
  options: BrowserDaemonOptions & {
    readonly agentId: string
    /** Override the resolved binary (tests). `null` means "there is none". */
    readonly executable?: string | null
  }
): Effect.Effect<LocalBrowserDaemon, ExecFailed | BinaryMissing | MachineUnavailable> =>
  Effect.tryPromise({
    try: async (): Promise<LocalBrowserDaemon> => {
      const pending = localBrowserStarts.get(options.homeDir)
      if (pending) return pending
      const start = startLocalBrowser()
      localBrowserStarts.set(options.homeDir, start)
      try {
        return await start
      } finally {
        localBrowserStarts.delete(options.homeDir)
      }

      async function startLocalBrowser(): Promise<LocalBrowserDaemon> {
        const portFile = localBrowserPortFile(options.homeDir)
        // `options.port` is only ever passed by a test; the daemon picks its own.
        const known = options.port ?? readPortFile(portFile)
        if (known !== null && (await isTautBrowser(known))) return { state: 'running', port: known }

        const binary =
          options.executable === undefined ? hostChromiumExecutable() : options.executable
        if (binary === null || binary === undefined) {
          throw new Error(
            `no Chromium under ${hostPlaywrightBrowsersPath()} — run \`pnpm exec playwright install chromium\``
          )
        }
        const port = known ?? (await freePort())
        const profile = browserProfileDir(options.homeDir)
        mkdirSync(profile, { recursive: true })
        const child = spawn(
          binary,
          [
            '--headless=new',
            ...localSandboxArgs(),
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking',
            '--window-size=1280,800',
            `--remote-debugging-port=${port}`,
            '--remote-debugging-address=127.0.0.1',
            `--user-data-dir=${profile}`,
            'about:blank'
          ],
          {
            detached: true,
            stdio: 'ignore',
            // Chromium creates its own private socket directory here. Agent homes
            // can exceed Unix socket path limits before that suffix is even added.
            env: { ...process.env, TMPDIR: process.platform === 'win32' ? tmpdir() : '/tmp' }
          }
        )
        let launchError: Error | undefined
        child.once('error', (error) => {
          launchError = error
        })
        child.unref()
        const deadline = Date.now() + LOCAL_BROWSER_START_TIMEOUT_MS
        while (Date.now() < deadline) {
          if (await isTautBrowser(port)) {
            writeFileSync(portFile, String(port), 'utf8')
            return { state: 'started', port }
          }
          if (launchError) throw launchError
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(
              `Chromium exited before opening its debug port (${child.signalCode ?? child.exitCode})`
            )
          }
          await wait(100)
        }
        child.kill()
        // The most likely cause by far: a task's own playwright-mcp already holds this
        // profile, and Chromium will not open one twice.
        throw new Error(
          existsSync(join(profile, 'SingletonLock'))
            ? "the agent's own browser is using this profile right now — the live view can attach once that task finishes"
            : `Chromium did not open 127.0.0.1:${port} within 20s`
        )
      }
    },
    catch: (cause) =>
      new ExecFailed({
        agentId: options.agentId,
        cmd: ['chromium', '--remote-debugging-port'],
        reason: cause instanceof Error ? cause.message : String(cause),
        cause
      })
  })

/**
 * The `--cdp-endpoint` for an agent whose Taut-started Chromium is **already** up on
 * this host, or `undefined`. This only probes; tasks and live views both use
 * `ensureLocalBrowserDaemon` so their first launch already shares one browser.
 */
export const localBrowserEndpoint = (homeDir: string): Effect.Effect<string | undefined> =>
  Effect.promise(async () => {
    const port = readPortFile(localBrowserPortFile(homeDir))
    if (port === null) return undefined
    return (await isTautBrowser(port)) ? browserCdpEndpoint(port) : undefined
  })

/** The port recorded for this agent, or `null` when there is no usable one. */
const readPortFile = (path: string): number | null => {
  try {
    const port = Number(readFileSync(path, 'utf8').trim())
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null
  } catch {
    return null
  }
}

/** Playwright MCP 0.0.80 tool names quoted in the prompt line (`tools/list`, 2026-09-08). */
export const BROWSER_TOOL_EXAMPLES = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_take_screenshot'
] as const

/**
 * How each runtime names the `browser` server's tools to the model:
 *
 * | runtime     | name the model sees                                        |
 * | ----------- | ---------------------------------------------------------- |
 * | claude-code | `mcp__browser__browser_navigate` (`mcp__<server>__<tool>`) |
 * | opencode    | `browser_browser_navigate` (`<server>_<tool>`)             |
 * | codex       | `browser_navigate`, listed under the `browser` server      |
 * | cursor      | `browser_navigate`, listed under the `browser` server      |
 */
const browserToolsPhrase = (kind: RuntimeKind): string => {
  const examples = (prefix: string) => BROWSER_TOOL_EXAMPLES.map((t) => `${prefix}${t}`).join(', ')
  switch (kind) {
    case 'claude-code':
      return `via the \`mcp__browser__*\` tools (e.g. ${examples('')})`
    case 'opencode':
      return `via the \`browser_*\` tools of the \`browser\` MCP server (e.g. ${examples('browser_')})`
    case 'codex':
    case 'cursor':
      return `via the tools of the \`browser\` MCP server (e.g. ${examples('')})`
  }
}

/**
 * One sentence for the task prompt / instructions when `agent.browserAccess` is on,
 * naming the tools the way `kind` exposes them (see `browserToolsPhrase`).
 *
 * The second half is not decoration. An agent asked to look something up reaches for a
 * search tool by reflex, and on every runtime but claude-code there is none — so it has to
 * be told, in the same breath, that the browser *is* how it reaches the web. On claude-code
 * `WebSearch` / `WebFetch` are allowed alongside (`BROWSER_WEB_BUILTIN_TOOLS`), so there the
 * line says both are open rather than steering it away from the shorter path.
 */
export const browserPromptLine = (homeDir: string, kind: RuntimeKind): string => {
  const web =
    kind === 'claude-code'
      ? `Both that browser and the built-in \`${BROWSER_WEB_BUILTIN_TOOLS.join('` / `')}\` tools ` +
        'are yours to use for anything on the web.'
      : 'That browser is your only way onto the web: there is no web-search tool, so open a ' +
        'search engine or the page itself with it rather than reporting that you cannot look ' +
        'things up.'
  return (
    `You have a headless Chromium browser ${browserToolsPhrase(kind)}; ` +
    `its profile persists between tasks and screenshots are saved under \`${browserOutputDir(homeDir)}\`. ` +
    web
  )
}
