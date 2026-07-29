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

// Everything `vite build` emits into the repository root except the pages
// themselves. `index.html` and `game/index.html` are left alone: the build
// overwrites both, and deleting them first would leave the repository with no
// pages at all if the build then failed.
const BUILD_OUTPUTS = ['assets', 'sw.js', 'manifest.webmanifest'];

for (const entry of BUILD_OUTPUTS) {
  await rm(fileURLToPath(new URL(entry, repoRoot)), { recursive: true, force: true });
}
