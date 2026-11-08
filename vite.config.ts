import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Free PDF Editor',
        short_name: 'PDF Editor',
        description: 'Edit PDFs in your browser. Files never leave your device.',
        theme_color: '#ffffff',
        background_color: '#eef0f4',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Installed app shows up in "Open with…" for PDFs (Chromium).
        file_handlers: [{ action: '/', accept: { 'application/pdf': ['.pdf'] } }],
        launch_handler: { client_mode: 'focus-existing' },
      },
      workbox: {
        // App shell + pdf.js worker + wasm decoders (needed for scanned PDFs) are precached.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}', 'pdfjs/wasm/{openjpeg,jbig2,qcms_bg}.wasm'],
        globIgnores: ['**/pdfjs/cmaps/**', '**/pdfjs/standard_fonts/**'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: '/index.html',
        // Document fonts and pdf.js data are fetched on demand, then kept offline.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/pdfjs/'),
            handler: 'CacheFirst',
            options: { cacheName: 'on-demand-assets', expiration: { maxEntries: 500 } },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(import.meta.dirname, './src') },
      // pdf-lib's key derivation, needed to keep a PDF's original encryption (see keep-encryption.ts).
      // The same standard-font metrics pdf-lib bundles internally (the public "standard-fonts" export
      // is a second copy, +150 KB in the export worker).
      {
        find: /^@cantoo\/pdf-lib\/standard-fonts$/,
        replacement: path.resolve(import.meta.dirname, './node_modules/@cantoo/pdf-lib/es/packages/standard-fonts/index.js'),
      },
      {
        find: /^@cantoo\/pdf-lib\/crypto$/,
        replacement: path.resolve(import.meta.dirname, './node_modules/@cantoo/pdf-lib/es/core/crypto.js'),
      },
    ],
  },
  worker: { format: 'es' },
  // Pre-bundle everything up front so the dev server never reloads mid-session
  // when a lazily-imported dependency is first seen.
  optimizeDeps: {
    include: [
      'pdfjs-dist',
      'konva',
      'react-konva',
      'zustand',
      'zustand/react/shallow',
      'zundo',
      'idb-keyval',
      '@dnd-kit/core',
      '@dnd-kit/sortable',
      '@dnd-kit/utilities',
      'vaul',
      'radix-ui',
      'sonner',
      'lucide-react',
      '@cantoo/pdf-lib',
      '@cantoo/pdf-lib/crypto',
      '@cantoo/pdf-lib/standard-fonts',
      '@pdf-lib/fontkit',
      'regenerator-runtime/runtime',
    ],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
})
