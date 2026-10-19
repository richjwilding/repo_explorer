import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — a plain ESM script with no type declarations.
import { buildNeeded } from '../bin/ensure-build.mjs';

/**
 * `dist/` is not committed, so a fresh clone has no build and `npm start` used to
 * fail with `MODULE_NOT_FOUND` for the compiled entry point. The first thing a new
 * checkout does should not be a stack trace.
 *
 * The staleness half matters just as much: a build older than its sources serves
 * old behaviour that looks like new code, and nothing says so. That is a silent
 * wrong answer rather than a crash, which is worse.
 */

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Layout {
  artifacts?: Partial<Record<'server' | 'web', number>>;
  sourceAge?: number;
}

/** A project skeleton with mtimes chosen relative to now. */
function project({ artifacts = {}, sourceAge }: Layout): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'build-check-'));
  created.push(base);
  const now = Date.now();

  fs.mkdirSync(path.join(base, 'src', 'server'), { recursive: true });
  const source = path.join(base, 'src', 'server', 'index.ts');
  fs.writeFileSync(source, 'export {};\n');
  if (sourceAge !== undefined) fs.utimesSync(source, new Date(now - sourceAge), new Date(now - sourceAge));

  const write = (relative: string, age: number) => {
    const full = path.join(base, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '<html></html>\n');
    fs.utimesSync(full, new Date(now - age), new Date(now - age));
  };
  if (artifacts.server !== undefined) write('dist/server/server/index.js', artifacts.server);
  if (artifacts.web !== undefined) write('dist/web/index.html', artifacts.web);
  return base;
}

describe('deciding whether a build is needed', () => {
  it('builds when there is no build at all, and says which files are missing', () => {
    const result = buildNeeded(project({}));
    expect(result.needed).toBe(true);
    expect(result.reason).toContain('no build found');
    expect(result.reason).toContain('dist/server/server/index.js');
    expect(result.reason).toContain('dist/web/index.html');
  });

  it('builds when only one half of the build is present', () => {
    // The server compiled but the UI did not: the API would start and serve a
    // 404 for the interface.
    const result = buildNeeded(project({ artifacts: { server: 0 } }));
    expect(result.needed).toBe(true);
    expect(result.reason).toContain('dist/web/index.html');
    expect(result.reason).not.toContain('dist/server/server/index.js');
  });

  it('does not build when the build is newer than the sources', () => {
    const result = buildNeeded(project({ artifacts: { server: 0, web: 0 }, sourceAge: 60_000 }));
    expect(result.needed).toBe(false);
  });

  it('builds when a source file is newer than the build', () => {
    // The silent case: old behaviour served as if it were new.
    const result = buildNeeded(project({ artifacts: { server: 60_000, web: 60_000 }, sourceAge: 0 }));
    expect(result.needed).toBe(true);
    expect(result.reason).toContain('newer than the build');
  });

  it('uses the oldest artifact, so a half-updated build still rebuilds', () => {
    const base = project({ artifacts: { server: 0, web: 120_000 }, sourceAge: 60_000 });
    expect(buildNeeded(base).needed).toBe(true);
  });

  it('rebuilds when a config file changes, not only source', () => {
    const base = project({ artifacts: { server: 60_000, web: 60_000 }, sourceAge: 60_000 });
    fs.writeFileSync(path.join(base, 'vite.config.ts'), 'export default {};\n');
    expect(buildNeeded(base).needed).toBe(true);
  });

  it('does not fall over on a project with no src directory', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'build-check-'));
    created.push(base);
    expect(buildNeeded(base).needed).toBe(true);
  });
});
