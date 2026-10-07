import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeCoupling } from '../src/core/analysis/coupling.js';

/**
 * Coupling is measured from real history, so these tests build real
 * repositories. The interesting cases are all about refusing to over-claim:
 * a hub file that touches everything, a merge that couples the whole repo, a
 * lockfile that changes in every commit.
 */

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface CommitSpec {
  files: string[];
  author?: string;
}

/** A throwaway git repository whose history is exactly the commits given. */
function makeHistoryRepo(commits: CommitSpec[], options: { initialFiles?: string[] } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-explorer-coupling-'));
  created.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Default Author'], { cwd: dir, stdio: 'pipe' });

  for (const file of options.initialFiles ?? []) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '// placeholder\n');
  }

  commits.forEach((commit, index) => {
    for (const file of commit.files) {
      const full = path.join(dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.appendFileSync(full, `// change ${index}\n`);
    }
    // Stage explicitly: without `git add` every commit is empty, and
    // `--allow-empty` would hide that rather than fail.
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    const args = ['commit', '-q', '--allow-empty', '-m', `commit ${index}`];
    const env = commit.author ? { ...process.env, GIT_AUTHOR_NAME: commit.author, GIT_COMMITTER_NAME: commit.author } : process.env;
    execFileSync('git', args, { cwd: dir, stdio: 'pipe', env });
  });

  return dir;
}

function analyze(dir: string, maps: Record<string, string> = {}) {
  const fileToComponent = new Map<string, { id: string; name: string }>();
  for (const [file, component] of Object.entries(maps)) fileToComponent.set(file, { id: component, name: component });
  const knownPaths = new Set<string>();
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else knownPaths.add(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  const commitCount = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim());
  return computeCoupling({ root: dir, totalCommits: commitCount, knownPaths, fileToComponent });
}

describe('co-change detection', () => {
  it('finds files that repeatedly change together and scores their confidence', async () => {
    const dir = makeHistoryRepo([
      { files: ['src/a.ts', 'src/b.ts'] },
      { files: ['src/a.ts', 'src/b.ts'] },
      { files: ['src/a.ts', 'src/b.ts'] },
      { files: ['src/a.ts', 'src/c.ts'] },
    ]);
    const info = await analyze(dir);
    const ab = info.pairs.find((pair) => pair.a === 'src/a.ts' && pair.b === 'src/b.ts');
    expect(ab).toBeDefined();
    expect(ab?.together).toBe(3);
    // a changes 4 times, b changes 3: confidence is 3/3.
    expect(ab?.confidence).toBe(1);
    // One shared commit is not coupling.
    expect(info.pairs.find((pair) => pair.b === 'src/c.ts')).toBeUndefined();
  });

  it('does not treat a single shared commit as coupling', async () => {
    const dir = makeHistoryRepo([{ files: ['x.ts', 'y.ts'] }, { files: ['x.ts'] }, { files: ['y.ts'] }]);
    const info = await analyze(dir);
    expect(info.pairs).toEqual([]);
  });

  it('marks pairs that cross a component boundary', async () => {
    const dir = makeHistoryRepo([
      { files: ['api/handler.ts', 'db/schema.ts'] },
      { files: ['api/handler.ts', 'db/schema.ts'] },
      { files: ['api/handler.ts', 'db/schema.ts'] },
    ]);
    const info = await analyze(dir, { 'api/handler.ts': 'api', 'db/schema.ts': 'db' });
    const pair = info.pairs[0];
    expect(pair?.crossComponent).toBe(true);

    const together = await analyze(dir, { 'api/handler.ts': 'api', 'db/schema.ts': 'api' });
    expect(together.pairs[0]?.crossComponent).toBe(false);
  });

  it('ranks cross-component pairs first, since the import graph does not show them', async () => {
    const dir = makeHistoryRepo([
      { files: ['api/handler.ts', 'db/schema.ts'] },
      { files: ['api/handler.ts', 'db/schema.ts'] },
      { files: ['api/handler.ts', 'db/schema.ts'] },
      { files: ['api/handler.ts', 'api/other.ts'] },
      { files: ['api/handler.ts', 'api/other.ts'] },
      { files: ['api/handler.ts', 'api/other.ts'] },
    ]);
    const info = await analyze(dir, { 'api/handler.ts': 'api', 'api/other.ts': 'api', 'db/schema.ts': 'db' });
    expect(info.pairs[0].crossComponent).toBe(true);
  });

  it('ignores lockfiles and generated output, which change in every commit', async () => {
    const files = ['package-lock.json', 'src/a.ts'];
    const dir = makeHistoryRepo(Array.from({ length: 5 }, () => ({ files })));
    const info = await analyze(dir);
    expect(info.pairs).toEqual([]);
  });

  it('excludes commits that touch an implausible number of files, and says so', async () => {
    const many = Array.from({ length: 45 }, (_, index) => `bulk/file${index}.ts`);
    const dir = makeHistoryRepo([{ files: many }, { files: many }]);
    const info = await analyze(dir);
    expect(info.pairs).toEqual([]);
    expect(info.skippedLargeCommits).toBe(2);
    expect(info.warnings.join(' ')).toContain('touching more than 40 files');
  });

  it('drops a hub file that changes in almost every commit', async () => {
    // 40 commits. `hub.ts` is in all of them; `left.ts` and `right.ts` move
    // together in 12. The hub co-occurs with left 12 times too, and with the
    // same confidence — only ubiquity separates them.
    const commits: CommitSpec[] = Array.from({ length: 40 }, (_, index) => ({
      files: index < 12 ? ['hub.ts', 'left.ts', 'right.ts'] : ['hub.ts'],
    }));
    const dir = makeHistoryRepo(commits);
    const info = await analyze(dir);
    expect(info.pairs.some((pair) => pair.a === 'left.ts' && pair.b === 'right.ts')).toBe(true);
    expect(info.pairs.some((pair) => pair.a === 'hub.ts' || pair.b === 'hub.ts')).toBe(false);
  });
});

describe('ownership', () => {
  it('counts authors per file and per component', async () => {
    const dir = makeHistoryRepo(
      [
        { files: ['src/a.ts'], author: 'Ada' },
        { files: ['src/a.ts'], author: 'Ada' },
        { files: ['src/a.ts'], author: 'Grace' },
      ],
      { initialFiles: ['src/b.ts'] },
    );
    const info = await analyze(dir, { 'src/a.ts': 'core', 'src/b.ts': 'core' });
    const file = info.files.find((entry) => entry.path === 'src/a.ts');
    expect(file?.commits).toBe(3);
    expect(file?.authors).toBe(2);
    expect(file?.topAuthor).toBe('Ada');
    expect(file?.topAuthorShare).toBeCloseTo(2 / 3, 3);
    // Two authors cover half of three commits only if both are counted.
    expect(file?.busFactor).toBe(1);

    const component = info.components.find((entry) => entry.id === 'core');
    expect(component?.authors).toBe(2);
    expect(component?.topAuthor).toBe('Ada');
  });

  it('reports a bus factor of one when a single author dominates', async () => {
    const dir = makeHistoryRepo(Array.from({ length: 12 }, () => ({ files: ['solo.ts'], author: 'Ada' })));
    const info = await analyze(dir, { 'solo.ts': 'core' });
    const component = info.components[0];
    expect(component.authors).toBe(1);
    expect(component.busFactor).toBe(1);
    expect(component.topAuthorShare).toBe(1);
  });

  it('flags key-person risk only where the pattern is meaningful', async () => {
    // One dominant author over plenty of commits, with a second author present.
    const dominant = makeHistoryRepo([
      ...Array.from({ length: 11 }, () => ({ files: ['owned.ts'], author: 'Ada' })),
      { files: ['owned.ts'], author: 'Grace' },
    ]);
    const flagged = await analyze(dominant, { 'owned.ts': 'core' });
    expect(flagged.singleOwner.map((entry) => entry.id)).toEqual(['core']);

    // A repository with a single author throughout is not a finding per component.
    const onlyAuthor = makeHistoryRepo(Array.from({ length: 11 }, () => ({ files: ['owned.ts'], author: 'Ada' })));
    expect((await analyze(onlyAuthor, { 'owned.ts': 'core' })).singleOwner).toEqual([]);

    // Too little history for the share to mean anything.
    const young = makeHistoryRepo(Array.from({ length: 3 }, () => ({ files: ['owned.ts'], author: 'Ada' })));
    expect((await analyze(young, { 'owned.ts': 'core' })).singleOwner).toEqual([]);
  });
});

describe('degenerate history', () => {
  it('reports too little history rather than inventing coupling', async () => {
    const dir = makeHistoryRepo([{ files: ['a.ts', 'b.ts'] }]);
    const info = await analyze(dir);
    expect(info.pairs).toEqual([]);
    expect(info.totalCommits).toBe(1);
  });

  it('returns a usable empty result outside a git repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-explorer-nogit-'));
    created.push(dir);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    const info = await computeCoupling({ root: dir, totalCommits: 0, knownPaths: new Set(['a.ts']), fileToComponent: new Map() });
    expect(info.pairs).toEqual([]);
    expect(info.components).toEqual([]);
    expect(info.warnings.join(' ')).toContain('could not be read');
  });

  it('ignores paths that are no longer in the analysis', async () => {
    const dir = makeHistoryRepo([
      { files: ['kept.ts', 'deleted.ts'] },
      { files: ['kept.ts', 'deleted.ts'] },
      { files: ['kept.ts', 'deleted.ts'] },
    ]);
    fs.rmSync(path.join(dir, 'deleted.ts'));
    const info = await analyze(dir);
    expect(info.pairs).toEqual([]);
    expect(info.files.map((entry) => entry.path)).toEqual(['kept.ts']);
  });
});
