#!/usr/bin/env node
/**
 * Make sure a build exists before `npm start` runs the compiled server.
 *
 * `dist/` is not committed, so a fresh clone has no build — and `npm start` only
 * points at the compiled entry point, which meant the first thing a new checkout
 * did was fail with `MODULE_NOT_FOUND: dist/server/server/index.js`. Requiring a
 * build is reasonable; making the user discover it from a stack trace is not.
 *
 * It also rebuilds when the sources are newer than the build. That matters more
 * than it sounds: a stale build serves old behaviour that looks like new code,
 * and the failure is silent. One mtime scan is much cheaper than that.
 *
 * Exported for the launcher in `repo-explorer.mjs`, so both entry points share
 * one definition of "needs a build".
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '..');

/** Where the build writes, relative to the project root. */
const ARTIFACT_PATHS = ['dist/server/server/index.js', 'dist/web/index.html'];

/** Files whose change should trigger a rebuild even though they are not in `src/`. */
const EXTRA_INPUTS = ['package.json', 'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts'];

function newestMtime(dir, newest = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = newestMtime(full, newest);
      continue;
    }
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      /* a file that vanished mid-scan is not worth failing over */
    }
  }
  return newest;
}

/**
 * Whether a build is needed, and why.
 *
 * Returns the reason so the caller can say something useful instead of silently
 * spending three seconds.
 */
export function buildNeeded(base = projectRoot) {
  const artifacts = ARTIFACT_PATHS.map((relative) => path.join(base, relative));
  const missing = artifacts.filter((artifact) => !fs.existsSync(artifact));
  if (missing.length > 0) {
    const names = missing.map((artifact) => path.relative(base, artifact)).join(' and ');
    return { needed: true, reason: `no build found (${names})` };
  }

  // The oldest artifact is the one that decides: if any input is newer than it,
  // part of the build is out of date.
  let oldestArtifact = Number.POSITIVE_INFINITY;
  for (const artifact of artifacts) oldestArtifact = Math.min(oldestArtifact, fs.statSync(artifact).mtimeMs);

  let newestInput = newestMtime(path.join(base, 'src'));
  for (const extra of EXTRA_INPUTS) {
    const full = path.join(base, extra);
    if (!fs.existsSync(full)) continue;
    newestInput = Math.max(newestInput, fs.statSync(full).mtimeMs);
  }

  if (newestInput > oldestArtifact) return { needed: true, reason: 'the sources are newer than the build' };
  return { needed: false, reason: 'the build is up to date' };
}

/** Build, or exit with something a person can act on. */
export function runBuild() {
  const build = spawnSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'inherit' });
  if (build.error) {
    console.error(`Could not run the build: ${build.error.message}`);
    return false;
  }
  return build.status === 0;
}

export function ensureBuild({ quiet = false } = {}) {
  const { needed, reason } = buildNeeded();
  if (!needed) {
    if (!quiet) console.log('Build is up to date.');
    return true;
  }
  if (!quiet) console.log(`Building first — ${reason}. This takes a few seconds.`);
  if (runBuild()) return true;
  console.error(
    '\nThe build failed, so there is nothing to start.\n' +
      'Check the output above. `npm run typecheck` reports type errors; `npm run dev` runs the\n' +
      'UI from source with hot reload and does not need a build.\n',
  );
  return false;
}

// Only act when run directly, so importing this from the launcher is side-effect free.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(ensureBuild() ? 0 : 1);
}
