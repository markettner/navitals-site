import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Served at navitals.kettner.berlin/planner/. The site's fonts and icon live one level up and are
// bundled from there, so the planner keeps no copies of its own.
export default defineConfig({
  base: '/planner/',
  plugins: [svelte()],
  server: { fs: { allow: ['..'] } },
  // MapLibre's worker is an ES module (it imports the code it shares with the page).
  worker: { format: 'es' },
  // MapLibre alone is about 1 MB minified (280 KB gzipped), and the page is nothing without it.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
