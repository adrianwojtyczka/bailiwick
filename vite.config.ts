import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { serviceWorker } from './build/sw-plugin';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// Sources live in `src/`; the built game is committed to the repository root so
// GitHub Pages can serve it straight from the default branch. `emptyOutDir` is
// off because the output directory is also the repository — `npm run prebuild`
// (build/clean.mjs) removes the previous `assets/` and `sw.js` instead.
export default defineConfig({
  root: 'src',
  base: './',
  plugins: [serviceWorker()],
  build: {
    outDir: repoRoot,
    emptyOutDir: false,
    assetsDir: 'assets',
    target: 'es2022',
    cssMinify: true,
    reportCompressedSize: false,
  },
  server: {
    host: true,
    port: 5173,
  },
});
