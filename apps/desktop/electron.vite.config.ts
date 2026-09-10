import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// `@taut/contract` ships TypeScript sources, so it can never be `require`d at
// runtime — it has to be bundled into both the main and the preload output.
const bundleWorkspace = { exclude: ['@taut/contract'] }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(bundleWorkspace)],
    build: { rollupOptions: { input: resolve('src/main/index.ts') } }
  },
  preload: {
    // sandbox: true means the preload cannot require() node_modules; bundle its deps.
    plugins: [externalizeDepsPlugin({ exclude: ['@electron-toolkit/preload', '@taut/contract'] })],
    build: {
      rollupOptions: {
        // Three preloads: `index` and `huddle` both ride on the remote Taut instance and
        // expose the same `window.taut` bridge — a window's preload path is fixed at
        // construction, so the huddle window needs its own entry
        // (docs/build-plan-huddle-window.md D13) — while `setup` runs only on the local
        // Connect screen. Each entry must come out self-contained: a sandboxed preload's
        // `require` reaches Electron built-ins and nothing else, so a module two entries
        // shared would be emitted as a chunk neither of them can load.
        input: {
          index: resolve('src/preload/index.ts'),
          huddle: resolve('src/preload/huddle.ts'),
          setup: resolve('src/preload/setup.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    // `pnpm dev` already owns 5173 (the web client); keep the shell's own
    // Connect-screen dev server out of its way.
    server: { port: 5273, strictPort: true },
    plugins: [react(), tailwindcss()]
  }
})
