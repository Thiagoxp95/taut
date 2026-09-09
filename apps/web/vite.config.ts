import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Follows PORT, so `PORT=3100 pnpm dev:ts` works when something else owns 3000.
const API_TARGET = `http://localhost:${process.env['PORT'] ?? 3000}`

/**
 * `scripts/dev.sh` sets these when it fronts this dev server with
 * `tailscale serve`. TLS is terminated out there, so the HMR client has to be
 * told to dial wss://<ts host>:<ts port> instead of ws://<whatever it loaded from>.
 */
const tsHost = process.env['TAUT_DEV_TS_HOST']
const tsPort = Number(process.env['TAUT_DEV_TS_PORT'] ?? 443)

export default defineConfig({
  plugins: [
    // Must run before @vitejs/plugin-react so generated routes are transformed too.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    /**
     * Installable shell + the push service worker. `injectManifest` because `src/sw.ts`
     * is ours (it owns `push` / `notificationclick`); Workbox only injects the
     * precache list. Registration happens in `lib/pwa.ts`, not by an injected script.
     */
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: null,
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon-32.png'],
      manifest: {
        name: 'Taut',
        short_name: 'Taut',
        description: 'Your company, its people and its agents, in one place.',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#fafafa',
        theme_color: '#18181b',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The whole client is code-split; a few chunks are over the 2 MiB default.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024
      },
      devOptions: {
        // Lets `pnpm dev` exercise the real SW (push included) over http://localhost.
        enabled: true,
        type: 'module',
        navigateFallback: 'index.html'
      }
    })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    // 0.0.0.0, so the Tailscale proxy (and the tailnet) can reach it.
    host: tsHost === undefined ? 'localhost' : true,
    // Vite rejects unknown Host headers; `.ts.net` covers every tailnet name.
    allowedHosts: tsHost === undefined ? [] : ['.ts.net'],
    hmr: tsHost === undefined ? undefined : { protocol: 'wss', host: tsHost, clientPort: tsPort },
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, ws: true, changeOrigin: true }
    }
  }
})
