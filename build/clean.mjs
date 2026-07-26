// Removes the previously built artifacts from the repository root.
//
// The Vite build writes into the repository root (so GitHub Pages can serve the
// game directly), which means `emptyOutDir` must stay off — otherwise Vite
// would wipe `src/`, `package.json` and the git metadata. This script deletes
// only the specific paths the build produces, so stale content-hashed bundles
// don't accumulate between builds.
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = new URL('../', import.meta.url);

// Everything `vite build` emits into the repository root. `index.html` is left
// alone: the build overwrites it, and deleting it first would leave the repo
// without a landing page if the build then failed.
const BUILD_OUTPUTS = ['assets', 'sw.js', 'manifest.webmanifest'];

for (const entry of BUILD_OUTPUTS) {
  await rm(fileURLToPath(new URL(entry, repoRoot)), { recursive: true, force: true });
}
