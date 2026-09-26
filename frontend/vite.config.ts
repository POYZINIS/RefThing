import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The e2e stack (e2e/stack.mjs) runs an isolated backend + Vite pair on other
// ports; everyday dev uses the defaults.
const apiPort = process.env.REFTHING_API_PORT ?? '7171';
const webPort = Number(process.env.REFTHING_WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The model worker is an ES module (three.js + its loaders).
  worker: { format: 'es' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': { target: `http://localhost:${apiPort}`, ws: true },
      '/blob': `http://localhost:${apiPort}`,
      '/ws': {
        target: `ws://localhost:${apiPort}`,
        ws: true,
      },
    },
  },
});
