import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildChange, listBranches, revParseRef } from '../src/core/util/git.js';
import { emptyChangeExplainer } from '../src/core/explain/structural.js';
import type { Change } from '../src/core/types.js';

/**
 * Reading a branch is a comparison, and there are two of them. The one the app
 * used to always perform — the branch tip against its merge base — says nothing
 * at all once the branch has been merged back, which produced an explainer about
 * an empty diff at exactly the moment the reader was asking what the branch did.
 * These tests pin down which comparison is used, and what the reader is told.
 */

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  });
}

function write(dir: string, file: string, contents: string): void {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

function repo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repo-explorer-${prefix}-`));
  created.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'fixture@example.com']);
  git(dir, ['config', 'user.name', 'Fixture']);
  write(dir, 'src/app.ts', 'export const app = 1;\n');
  commitAll(dir, 'initial');
  return dir;
}

describe('reading a branch', () => {
  it('shows the branch owner commits when the branch has work of its own', async () => {
    const dir = repo('branch-own');
    git(dir, ['checkout', '-q', '-b', 'feature']);
    write(dir, 'src/feature.ts', 'export const feature = true;\n');
    commitAll(dir, 'add the feature');
    git(dir, ['checkout', '-q', 'main']);

    const change = await buildChange(dir, { kind: 'branch', branch: 'feature', base: 'main' });

    expect(change.compare?.mode).toBe('since-diverged');
    expect(change.compare?.baseRef).toBe('main');
    expect(change.files.map((file) => file.path)).toEqual(['src/feature.ts']);
    expect(change.commits).toHaveLength(1);
    expect(change.subtitle).toContain('1 commit ahead of main');
  });

  it('falls back to comparing tips when the branch has been merged, rather than showing nothing', async () => {
    const dir = repo('branch-merged');
    git(dir, ['checkout', '-q', '-b', 'feature']);
    write(dir, 'src/feature.ts', 'export const feature = true;\n');
    commitAll(dir, 'add the feature');
    git(dir, ['checkout', '-q', 'main']);
    git(dir, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature']);
    // Main moves on after the merge — this is what the tip comparison reveals.
    write(dir, 'src/later.ts', 'export const later = 2;\n');
    commitAll(dir, 'later work on main');

    const change = await buildChange(dir, { kind: 'branch', branch: 'feature', base: 'main' });

    expect(change.compare?.mode).toBe('against-tip');
    expect(change.compare?.note).toContain('no commits that main does not already contain');
    expect(change.subtitle).toContain('Already merged into main');
    // A merge-base diff here would be empty; the tip diff has real content.
    expect(change.files.length).toBeGreaterThan(0);
    expect(change.files.map((file) => file.path)).toContain('src/later.ts');
  });

  it('honours an explicit request for the tip comparison even with unique commits', async () => {
    const dir = repo('branch-tips');
    git(dir, ['checkout', '-q', '-b', 'feature']);
    write(dir, 'src/feature.ts', 'export const feature = true;\n');
    commitAll(dir, 'add the feature');
    git(dir, ['checkout', '-q', 'main']);
    write(dir, 'src/main-only.ts', 'export const mainOnly = true;\n');
    commitAll(dir, 'main moves on');
    git(dir, ['checkout', '-q', 'feature']);

    const diverged = await buildChange(dir, { kind: 'branch', branch: 'feature', base: 'main' });
    const tips = await buildChange(dir, { kind: 'branch', branch: 'feature', base: 'main', compare: 'against-tip' });

    // The merge-base reading explains the feature; the tip reading also shows
    // what main gained from the branch's point of view.
    expect(diverged.files.map((file) => file.path)).toEqual(['src/feature.ts']);
    expect(tips.compare?.mode).toBe('against-tip');
    expect(tips.files.map((file) => file.path).sort()).toEqual(['src/feature.ts', 'src/main-only.ts']);
    expect(tips.compare?.note).toContain('two branch tips');
  });

  it('says the two names are the same commit instead of pretending there is a diff', async () => {
    const dir = repo('branch-same');
    git(dir, ['checkout', '-q', '-b', 'copy']);

    const change = await buildChange(dir, { kind: 'branch', branch: 'copy', base: 'main' });

    expect(change.files).toEqual([]);
    expect(change.compare?.mode).toBe('against-tip');
    expect(change.subtitle).toContain('Same commit as main');
    expect(change.compare?.note).toContain('point at the same commit');
  });

  it('gives the same branch two different cache ids for the two readings', async () => {
    const dir = repo('branch-ids');
    git(dir, ['checkout', '-q', '-b', 'feature']);
    write(dir, 'src/feature.ts', 'export const feature = true;\n');
    commitAll(dir, 'add the feature');

    const diverged = await buildChange(dir, { kind: 'branch', branch: 'feature', base: 'main' });
    const tips = await buildChange(dir, { kind: 'branch', branch: 'feature', base: 'main', compare: 'against-tip' });

    // Sharing an id would let one reading's explainer answer for the other.
    expect(diverged.id).not.toBe(tips.id);
    expect(diverged.id).toContain('since-diverged');
    expect(tips.id).toContain('against-tip');
  });
});

describe('the branch list', () => {
  it('lists real branch names, not the fields they were formatted with', async () => {
    // `git for-each-ref` does not understand the `%x1f` escape that `git log`
    // uses, so the separator was emitted literally: every name came back as
    // "feature%x1f9f2c1ab%x1f2024-06-01 10:11:12 +0100%x1fMerge …". Picking one
    // sent that string back to git, nothing resolved, and the reader was told the
    // branch had no changes.
    const dir = repo('branch-list');
    git(dir, ['checkout', '-q', '-b', 'feature/readable-name']);
    write(dir, 'src/feature.ts', 'export const feature = true;\n');
    commitAll(dir, 'add the feature');
    git(dir, ['checkout', '-q', 'main']);

    const branches = await listBranches(dir);
    const names = branches.map((branch) => branch.name);

    expect(names).toContain('main');
    expect(names).toContain('feature/readable-name');
    for (const branch of branches) {
      expect(branch.name).not.toContain('%');
      expect(branch.name).not.toContain('\u001f');
      // Every listed name must be usable as a git revision.
      expect(await revParseRef(dir, branch.name)).not.toBeNull();
      expect(branch.lastCommit).toMatch(/^[0-9a-f]{7,}$/);
      expect(branch.subject.length).toBeGreaterThan(0);
    }
    expect(branches.find((branch) => branch.name === 'main')?.current).toBe(true);
    expect(branches.find((branch) => branch.name === 'feature/readable-name')?.current).toBe(false);
  });

  it('does not offer the origin/HEAD alias as a branch', async () => {
    const dir = repo('branch-alias');
    const mainSha = git(dir, ['rev-parse', 'HEAD']).trim();
    git(dir, ['update-ref', 'refs/remotes/origin/main', mainSha]);
    git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

    const names = (await listBranches(dir)).map((branch) => branch.name);

    expect(names).toContain('origin/main');
    expect(names).not.toContain('origin/HEAD');
  });

  it('refuses an unknown branch instead of reporting an empty comparison', async () => {
    const dir = repo('branch-unknown');
    // The shape of a name produced by the old formatting bug.
    await expect(buildChange(dir, { kind: 'branch', branch: 'feature%x1f9f2c1ab%1fhead', base: 'main' })).rejects.toThrow(
      /No branch or revision called/,
    );
    await expect(buildChange(dir, { kind: 'branch', branch: 'nope', base: 'main' })).rejects.toThrow(/statusCode|No branch/);
    await expect(buildChange(dir, { kind: 'branch', branch: 'main', base: 'nope' })).rejects.toThrow(/Cannot compare against/);
  });
});

describe('explaining an empty comparison', () => {
  const change = (overrides: Partial<Change>): Change => ({
    id: 'branch-x-since-diverged-abc',
    kind: 'branch',
    title: 'Branch x',
    subtitle: '0 commits ahead of main',
    base: 'abc123',
    head: 'x',
    commits: [],
    files: [],
    stats: { files: 0, additions: 0, deletions: 0 },
    body: '',
    ...overrides,
  });

  it('names the comparison that came back empty and offers the other one', () => {
    const explainer = emptyChangeExplainer(
      change({ compare: { mode: 'since-diverged', baseRef: 'main' } }),
    );
    const text = JSON.stringify(explainer);
    expect(explainer.tldr).toContain('no commits since it diverged from main');
    expect(text).toContain('Comparing the two branch tips');
  });

  it('does not suggest a tip comparison when the tips are the same commit', () => {
    const explainer = emptyChangeExplainer(
      change({ subtitle: 'Same commit as main', compare: { mode: 'against-tip', baseRef: 'main' } }),
    );
    expect(explainer.tldr).toContain('point at the same commit');
    expect(JSON.stringify(explainer)).toContain('Pick a different branch');
  });
});
