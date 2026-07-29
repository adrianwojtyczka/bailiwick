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
    // Two pages, not one: the title is a plain document at the root and the
    // game is its own at `game/`, so opening the title costs nothing but the
    // drawing and neither page has to carry the other's code.
    rollupOptions: {
      input: {
        title: fileURLToPath(new URL('src/index.html', import.meta.url)),
        game: fileURLToPath(new URL('src/game/index.html', import.meta.url)),
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
