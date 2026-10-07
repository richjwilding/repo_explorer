import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, ensureDirs } from '../src/core/config.js';
import { Store } from '../src/core/store.js';
import { RepoService, type RepoContext } from '../src/core/service.js';
import { componentExplainer, repoExplainer } from '../src/core/explain/generate.js';
import { checkStaleness, buildFreshnessIndex, forgetFreshness, scopeFiles } from '../src/core/explain/staleness.js';
import { createFixtureRepo, createTempHome, type FixtureRepo } from './helpers/fixtureRepo.js';

let fixture: FixtureRepo;
let ctx: RepoContext;
let cleanupHome: () => void;

beforeAll(async () => {
  fixture = createFixtureRepo();
  const temp = createTempHome();
  cleanupHome = temp.cleanup;
  const cfg = loadConfig({
    home: temp.home,
    dataDir: `${temp.home}/data`,
    cacheDir: `${temp.home}/cache`,
    exportDir: `${temp.home}/exports`,
    provider: 'mock',
  });
  ensureDirs(cfg);
  ctx = await new RepoService(cfg, new Store(cfg)).open(fixture.root, { force: true });
}, 90_000);

afterAll(() => {
  fixture?.cleanup();
  cleanupHome?.();
});

async function freshness(explainer: Parameters<typeof checkStaleness>[1]) {
  forgetFreshness(ctx.model.repo.id);
  const index = await buildFreshnessIndex(ctx, { refresh: true });
  return checkStaleness(ctx, explainer, index);
}

describe('explainer staleness', () => {
  it('scopes an explainer to the files it actually covers', async () => {
    const component = ctx.model.components.find((candidate) => candidate.path === 'apps/api');
    expect(component).toBeDefined();
    if (!component) return;

    const explainer = await componentExplainer(ctx, component.id);
    expect(explainer.scope).toBeDefined();
    expect(explainer.scope?.fileCount).toBe(component.files.length);

    const files = scopeFiles(ctx.model, explainer);
    expect(files).toContain('apps/api/src/routes.ts');

    // A component's scope must not include another component's files.
    expect(files).not.toContain('apps/web/src/main.tsx');
  }, 60_000);

  it('is up to date immediately after being written', async () => {
    const component = ctx.model.components.find((candidate) => candidate.path === 'apps/api');
    if (!component) return;
    const explainer = await componentExplainer(ctx, component.id);
    const report = await freshness(explainer);
    expect(report.stale).toBe(false);
    expect(report.summary).toMatch(/Up to date/i);
  }, 60_000);

  it('reports an edited file as stale, without discarding the explainer', async () => {
    const component = ctx.model.components.find((candidate) => candidate.path === 'apps/api');
    if (!component) return;
    const explainer = await componentExplainer(ctx, component.id);

    // Change the code after the explanation was written.
    const target = path.join(fixture.root, 'apps/api/src/routes.ts');
    await new Promise((resolve) => setTimeout(resolve, 10));
    fs.appendFileSync(target, '\nexport const REVISION = 3;\n');

    const report = await freshness(explainer);
    expect(report.stale).toBe(true);
    expect(report.changedFiles).toContain('apps/api/src/routes.ts');
    expect(report.summary).toContain('changed');
    expect(report.checkedFiles).toBeGreaterThan(0);

    // The explainer itself is untouched and still complete: staleness is
    // reported, never acted on.
    expect(explainer.sections.length).toBeGreaterThan(0);
    expect(explainer.tldr.length).toBeGreaterThan(0);
  }, 60_000);

  it('does not treat a moved mtime as a change when the content is identical', async () => {
    // Regression: a checkout or a formatter rewrites identical bytes. Reporting
    // that as "out of date" makes the warning untrustworthy.
    const component = ctx.model.components.find((candidate) => candidate.path === 'apps/api');
    if (!component) return;
    const explainer = await componentExplainer(ctx, component.id, { refresh: true });
    expect((await freshness(explainer)).stale).toBe(false);

    const target = path.join(fixture.root, 'apps/api/src/db.ts');
    const original = fs.readFileSync(target);
    await new Promise((resolve) => setTimeout(resolve, 10));
    fs.writeFileSync(target, original); // identical bytes, new mtime

    const report = await freshness(explainer);
    expect(report.stale).toBe(false);
    expect(report.changedFiles).toEqual([]);
  }, 60_000);

  it('is not stale for a component whose files did not change', async () => {
    const web = ctx.model.components.find((candidate) => candidate.path === 'apps/web');
    if (!web) return;
    const explainer = await componentExplainer(ctx, web.id);
    const report = await freshness(explainer);
    // apps/api/src/routes.ts was edited above; the web component is unaffected.
    expect(report.changedFiles).not.toContain('apps/api/src/routes.ts');
    expect(report.stale).toBe(false);
  }, 60_000);

  it('reports a fresh explainer as current, and a changed repository as stale', async () => {
    // Regression: a freshly written explainer reported itself out of date,
    // because the baseline was the *analysis* (always older) rather than what
    // the explainer recorded for itself.
    const overview = await repoExplainer(ctx, { staticOnly: true, refresh: true });
    expect((await freshness(overview)).stale).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 10));
    fs.appendFileSync(path.join(fixture.root, 'README.md'), '\n<!-- touched after the explanation -->\n');
    const report = await freshness(overview);
    expect(report.stale).toBe(true);
    expect(report.changedFiles).toContain('README.md');
  }, 60_000);

  it('treats an explanation of a committed change as permanently valid', async () => {
    if (!fixture.hasGit) return;
    const commits = await ctx.store.listExplainers(ctx.model.repo.id);
    void commits;
    const change = await new RepoService(ctx.cfg, ctx.store).change(ctx, { kind: 'commit', sha: 'HEAD' });
    const explainer = {
      id: `change:${change.id}`,
      version: 1,
      kind: 'change' as const,
      target: { kind: 'change' as const, id: change.id, label: change.title, level: 0 },
      title: change.title,
      subtitle: '',
      tldr: '',
      sections: [],
      next: [],
      sources: [],
      model: 'test',
      provider: 'test',
      generatedAt: new Date().toISOString(),
    };
    const report = await freshness(explainer);
    expect(report.stale).toBe(false);
    expect(report.summary).toContain('does not go out of date');
  }, 60_000);
});
