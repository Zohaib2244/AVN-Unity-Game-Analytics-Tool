import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The admin website. FastAPI serves the build from avn_analytics/static/ at /assets/ (see
// avn_analytics/website.py): index.html for every page route, /assets/* for the files.
const api = process.env.AVN_API_URL || `http://127.0.0.1:${process.env.PORT || 8201}`;

export default defineConfig({
  plugins: [react()],
  base: '/assets/',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }, dedupe: ['react', 'react-dom', 'motion'] },
  build: {
    outDir: '../avn_analytics/static',
    emptyOutDir: true,
    assetsDir: 'build',
    sourcemap: false,
  },
  server: {
    port: 5190,
    proxy: { '/v1': api, '/nutbot': api, '/healthz': api },
  },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
