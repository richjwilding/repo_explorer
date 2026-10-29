import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { Change, ChangeFile, FileChurn, GitSummary, RepoRef } from '../types.js';
import { isoWeekKey, repoId, shortHash } from './id.js';
import { toPosix } from './fs.js';

const execFileAsync = promisify(execFile);

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export async function runGit(
  args: string[],
  cwd: string,
  opts: { maxBuffer?: number; timeoutMs?: number } = {},
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: opts.maxBuffer ?? 128 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 60_000,
      encoding: 'utf8',
      env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string; killed?: boolean };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr || err.message || 'git failed',
    };
  }
}

export async function isGitRepo(root: string): Promise<boolean> {
  const res = await runGit(['rev-parse', '--is-inside-work-tree'], root, { timeoutMs: 10_000 });
  return res.code === 0 && res.stdout.trim() === 'true';
}

/** Current HEAD in one command — used by freshness checks, not full summaries. */
export async function revParseHead(root: string): Promise<string | null> {
  const res = await runGit(['rev-parse', 'HEAD'], root, { timeoutMs: 5000 });
  const sha = res.stdout.trim();
  return res.code === 0 && sha ? sha : null;
}

export async function gitRoot(cwd: string): Promise<string | null> {
  const res = await runGit(['rev-parse', '--show-toplevel'], cwd, { timeoutMs: 10_000 });
  if (res.code !== 0) return null;
  const root = res.stdout.trim();
  return root ? toPosix(root) : null;
}

export async function makeRepoRef(dir: string): Promise<RepoRef> {
  const resolved = path.resolve(dir);
  const remote = await runGit(['config', '--get', 'remote.origin.url'], resolved, { timeoutMs: 10_000 });
  const slug = remote.code === 0 ? parseRemoteSlug(remote.stdout.trim()) : null;
  return {
    id: repoId(resolved),
    path: toPosix(resolved),
    name: path.basename(resolved),
    slug: slug ?? undefined,
  };
}

export function parseRemoteSlug(url: string): string | null {
  if (!url) return null;
  const ssh = url.match(/^git@[^:]+:(.+?)(?:\.git)?$/);
  if (ssh) return ssh[1];
  const https = url.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (https) return https[1];
  return null;
}

export async function gitSummary(root: string): Promise<GitSummary> {
  const empty: GitSummary = {
    isRepo: false,
    branch: null,
    head: null,
    headShort: null,
    commitCount: 0,
    firstCommitDate: null,
    lastCommitDate: null,
    remoteUrl: null,
    contributors: [],
    activity: [],
    churn: [],
    defaultBranch: null,
    tags: [],
  };

  if (!(await isGitRepo(root))) return empty;

  const [head, branch, remote, count, first, last, log, tags, churn] = await Promise.all([
    runGit(['rev-parse', 'HEAD'], root, { timeoutMs: 10_000 }),
    runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root, { timeoutMs: 10_000 }),
    runGit(['config', '--get', 'remote.origin.url'], root, { timeoutMs: 10_000 }),
    runGit(['rev-list', '--count', 'HEAD'], root, { timeoutMs: 20_000 }),
    runGit(['log', '--reverse', '--format=%aI', '--max-count=1'], root, { timeoutMs: 20_000 }),
    runGit(['log', '--format=%aI', '--max-count=1'], root, { timeoutMs: 20_000 }),
    runGit(['log', '--format=%aI%x00%an%x00%ae', '--max-count=1500'], root, { timeoutMs: 30_000 }),
    runGit(['tag', '--sort=-creatordate'], root, { timeoutMs: 10_000 }),
    computeChurn(root),
  ]);

  const contributors = new Map<string, { name: string; email: string; commits: number }>();
  const activity = new Map<string, number>();
  if (log.code === 0 && log.stdout.trim()) {
    for (const line of log.stdout.trim().split('\n')) {
      const [dateIso, name, email] = line.split('\u0000');
      if (!dateIso) continue;
      const date = new Date(dateIso);
      if (Number.isNaN(date.getTime())) continue;
      activity.set(isoWeekKey(date), (activity.get(isoWeekKey(date)) ?? 0) + 1);
      const key = `${name} <${email}>`;
      const entry = contributors.get(key);
      if (entry) entry.commits += 1;
      else contributors.set(key, { name, email, commits: 1 });
    }
  }

  const headSha = head.code === 0 ? head.stdout.trim() : null;

  return {
    isRepo: true,
    branch: branch.code === 0 && branch.stdout.trim() !== 'HEAD' ? branch.stdout.trim() : null,
    head: headSha,
    headShort: headSha ? headSha.slice(0, 8) : null,
    commitCount: count.code === 0 ? Number.parseInt(count.stdout.trim(), 10) || 0 : 0,
    firstCommitDate: first.code === 0 ? first.stdout.trim() || null : null,
    lastCommitDate: last.code === 0 ? last.stdout.trim() || null : null,
    remoteUrl: remote.code === 0 ? remote.stdout.trim() || null : null,
    contributors: [...contributors.values()].sort((a, b) => b.commits - a.commits).slice(0, 12),
    activity: [...activity.entries()].map(([week, commits]) => ({ week, commits })).sort((a, b) => a.week.localeCompare(b.week)),
    churn,
    defaultBranch: await detectDefaultBranch(root),
    tags: tags.code === 0 ? tags.stdout.trim().split('\n').filter(Boolean).slice(0, 30) : [],
  };
}

/**
 * Historical churn per file. Churn is the best cheap proxy we have for
 * "this file is complicated or contested" — high churn plus high size is
 * where a new leader should look first.
 */
export async function computeChurn(root: string, maxCommits = 400, top = 80): Promise<FileChurn[]> {
  const res = await runGit(['log', '--numstat', '--format=%x00%H', `--max-count=${maxCommits}`, '--no-renames', '--no-merges'], root, {
    maxBuffer: 64 * 1024 * 1024,
    timeoutMs: 45_000,
  });
  if (res.code !== 0) return [];

  interface Accumulator {
    commits: number;
    additions: number;
    deletions: number;
  }
  const byFile = new Map<string, Accumulator>();
  let currentCommitTouched = new Set<string>();

  const flush = () => {
    for (const file of currentCommitTouched) {
      const entry = byFile.get(file);
      if (entry) entry.commits += 1;
    }
    currentCommitTouched = new Set();
  };

  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('\u0000')) {
      flush();
      continue;
    }
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const additions = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10) || 0;
    const deletions = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10) || 0;
    const filePath = parts.slice(2).join('\t');
    if (!filePath || filePath.includes('=>')) continue;
    const entry = byFile.get(filePath) ?? { commits: 0, additions: 0, deletions: 0 };
    entry.additions += additions;
    entry.deletions += deletions;
    byFile.set(filePath, entry);
    currentCommitTouched.add(filePath);
  }
  flush();

  return [...byFile.entries()]
    .map(([path, entry]) => ({ path, commits: entry.commits, additions: entry.additions, deletions: entry.deletions }))
    .sort((a, b) => b.commits - a.commits || b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, top);
}

async function detectDefaultBranch(root: string): Promise<string | null> {
  const symbolic = await runGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], root, { timeoutMs: 8000 });
  if (symbolic.code === 0) {
    const ref = symbolic.stdout.trim();
    const match = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  }
  for (const candidate of ['main', 'master']) {
    const res = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], root, { timeoutMs: 8000 });
    if (res.code === 0) return candidate;
  }
  return null;
}

/**
 * Files that make up the repository: tracked files plus untracked-but-not-ignored.
 * Using git here (rather than a filesystem walk) gives us .gitignore semantics for free.
 */
export async function gitVisibleFiles(root: string): Promise<string[] | null> {
  if (!(await isGitRepo(root))) return null;
  const res = await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root, {
    maxBuffer: 64 * 1024 * 1024,
    timeoutMs: 60_000,
  });
  if (res.code !== 0) return null;
  return res.stdout
    .split('\u0000')
    .filter(Boolean)
    .map((p) => toPosix(p))
    .sort((a, b) => a.localeCompare(b));
}

export interface CommitInfo {
  sha: string;
  short: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
}

const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e';

export async function listCommits(root: string, opts: { limit?: number; ref?: string; path?: string } = {}): Promise<CommitInfo[]> {
  const args = ['log', `--format=${LOG_FORMAT}`, `--max-count=${opts.limit ?? 60}`, '--no-color'];
  if (opts.ref) args.push(opts.ref);
  if (opts.path) args.push('--', opts.path);
  const res = await runGit(args, root, { maxBuffer: 32 * 1024 * 1024, timeoutMs: 30_000 });
  if (res.code !== 0) return [];
  return res.stdout
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, short, author, email, date, subject, body] = record.split('\x1f');
      return { sha, short, author, email, date, subject, body: (body ?? '').trim() };
    });
}

/**
 * The field separator used when asking git for several values per line.
 *
 * `git log --format` writes `%x1f` for a control character; `git for-each-ref`
 * does not understand that spelling and emits the four characters literally. It
 * does understand `%1f` — the bare hex form — so ref listings use that and
 * `git log` listings keep `%x1f`. Getting this wrong is not a cosmetic problem:
 * every branch name came back as `feature%x1f9f2c1ab%x1f2024-06-01…`, nothing
 * resolved when it was passed back to git, and the reader was told the branch held
 * no changes.
 */
const REF_FIELD = '%1f';

/** Parse records written with {@link REF_FIELD}, dropping anything malformed. */
function parseRefLines(stdout: string, fields: number): string[][] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\u001f'))
    // A row that did not split cleanly would otherwise become a "branch" called
    // by its own field string, which then fails every git call it is used in.
    .filter((parts) => parts.length >= fields && parts[0].length > 0 && !parts[0].includes('%'));
}

export async function listBranches(root: string): Promise<{ name: string; current: boolean; lastCommit: string; subject: string; date: string }[]> {
  const res = await runGit(
    [
      'for-each-ref',
      '--sort=-committerdate',
      '--count=40',
      `--format=%(refname:short)${REF_FIELD}%(objectname:short)${REF_FIELD}%(committerdate:iso8601)${REF_FIELD}%(subject)`,
      'refs/heads',
      'refs/remotes',
    ],
    root,
    { timeoutMs: 20_000 },
  );
  if (res.code !== 0) return [];
  const info = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root, { timeoutMs: 10_000 });
  const current = info.code === 0 ? info.stdout.trim() : '';
  return parseRefLines(res.stdout, 4)
    // `origin/HEAD` is a symbolic alias for `origin/main`, not a branch of its
    // own, and offering it duplicates the default branch under a name that is
    // confusing to compare against.
    .filter(([name]) => !name.endsWith('/HEAD'))
    .map(([name, lastCommit, date, subject]) => ({ name, current: name === current, lastCommit, date, subject: subject ?? '' }));
}

/* ------------------------------------------------------------------ *
 * Diff parsing
 * ------------------------------------------------------------------ */

export interface ParsedPatch {
  path: string;
  oldPath?: string;
  status: ChangeFile['status'];
  patch: string;
}

export function parseUnifiedDiff(patchText: string): ParsedPatch[] {
  const files: ParsedPatch[] = [];
  const lines = patchText.split('\n');
  let current: ParsedPatch | null = null;
  let buffer: string[] = [];
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let isNew = false;
  let isDeleted = false;

  const flush = () => {
    if (!current) return;
    let status: ChangeFile['status'] = 'modified';
    if (isNew) status = 'added';
    else if (isDeleted) status = 'deleted';
    else if (renameFrom && renameTo) status = renameFrom === renameTo ? 'modified' : 'renamed';
    files.push({ ...current, oldPath: renameFrom ?? undefined, status, patch: buffer.join('\n') });
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      renameFrom = null;
      renameTo = null;
      isNew = false;
      isDeleted = false;
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const filePath = m ? m[2] : line.replace('diff --git ', '');
      current = { path: filePath, status: 'modified', patch: '' };
      buffer = [line];
      continue;
    }
    if (!current) continue;
    buffer.push(line);
    if (line.startsWith('new file mode')) isNew = true;
    else if (line.startsWith('deleted file mode')) isDeleted = true;
    else if (line.startsWith('rename from ')) renameFrom = line.slice('rename from '.length);
    else if (line.startsWith('rename to ')) renameTo = line.slice('rename to '.length);
  }
  flush();
  return files;
}

interface NumstatEntry {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  oldPath?: string;
}

function parseNumstat(output: string): Map<string, NumstatEntry> {
  const map = new Map<string, NumstatEntry>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addRaw, delRaw, ...rest] = parts;
    // Rename entries look like: "0\t0\t\told => new" or "12\t3\told\tnew"
    const filePath = rest.filter(Boolean).join('\t');
    const renameMatch = filePath.match(/^(.*?)\{.*? => (.*?)\}(.*)$/);
    let path = filePath;
    let oldPath: string | undefined;
    if (renameMatch) {
      path = `${renameMatch[1]}${renameMatch[2]}${renameMatch[3]}`;
      oldPath = `${renameMatch[1]}${renameMatch[1] !== '' ? '' : ''}`;
    }
    if (rest.length === 2) {
      oldPath = rest[0];
      path = rest[1];
    }
    map.set(path, {
      path,
      additions: addRaw === '-' ? 0 : Number.parseInt(addRaw, 10) || 0,
      deletions: delRaw === '-' ? 0 : Number.parseInt(delRaw, 10) || 0,
      binary: addRaw === '-' || delRaw === '-',
      oldPath,
    });
  }
  return map;
}

function languageForDiff(patch: string, filePath: string): string {
  if (/^Binary files /m.test(patch) || /GIT binary patch/.test(patch)) return 'text';
  const fromHeader = patch.match(/^diff --git a\/.*? b\/(.+)$/m);
  return fromHeader ? fromHeader[1] : filePath;
}

const MAX_PATCH_CHARS_PER_FILE = 120_000;

export async function diffFilesBetween(root: string, base: string, head: string): Promise<ChangeFile[]> {
  const [numstatRes, patchRes] = await Promise.all([
    runGit(['diff', '--numstat', '-M', '--no-color', base, head], root, { maxBuffer: 64 * 1024 * 1024, timeoutMs: 60_000 }),
    runGit(['diff', '-M', '--no-color', '--unified=3', '--no-ext-diff', base, head], root, {
      maxBuffer: 256 * 1024 * 1024,
      timeoutMs: 90_000,
    }),
  ]);
  const numstat = parseNumstat(numstatRes.stdout);
  const patches = parseUnifiedDiff(patchRes.stdout);
  const files: ChangeFile[] = [];
  const seen = new Set<string>();

  for (const parsed of patches) {
    seen.add(parsed.path);
    const stat = numstat.get(parsed.path);
    files.push({
      path: parsed.path,
      oldPath: parsed.oldPath,
      status: parsed.status,
      additions: stat?.additions ?? countDiffLines(parsed.patch, '+'),
      deletions: stat?.deletions ?? countDiffLines(parsed.patch, '-'),
      binary: stat?.binary ?? /^Binary files /m.test(parsed.patch),
      patch: parsed.patch.length > MAX_PATCH_CHARS_PER_FILE ? `${parsed.patch.slice(0, MAX_PATCH_CHARS_PER_FILE)}\n… [patch truncated]` : parsed.patch,
      language: languageForDiff(parsed.patch, parsed.path),
    });
  }

  // Binary files produce no textual hunks, so they appear in numstat only.
  for (const [filePath, stat] of numstat) {
    if (seen.has(filePath)) continue;
    if (!stat.binary) continue;
    files.push({
      path: filePath,
      oldPath: stat.oldPath,
      status: stat.oldPath && stat.oldPath !== filePath ? 'renamed' : 'modified',
      additions: 0,
      deletions: 0,
      binary: true,
      patch: '',
      language: 'text',
    });
  }

  return files.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
}

function countDiffLines(patch: string, prefix: string): number {
  let n = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith(prefix) && !line.startsWith(prefix.repeat(3))) n += 1;
  }
  return n;
}

/**
 * Two ways to read a branch, and they answer different questions.
 *
 * `since-diverged` diffs the merge base with the branch tip — only the work the
 * branch itself did. `against-tip` diffs the base branch's current tip with the
 * branch's current tip, which also includes everything the base gained since the
 * branch left it (shown as reversals). The first is the better answer to "what is
 * this branch about"; the second is the only answer that produces anything once
 * the branch has been merged back.
 */
export type BranchCompareMode = 'since-diverged' | 'against-tip';

export type ChangeSpec =
  | { kind: 'commit'; sha: string }
  | { kind: 'range'; base: string; head: string; label?: string }
  | { kind: 'branch'; branch: string; base?: string; compare?: BranchCompareMode }
  | { kind: 'pr'; number: number; owner?: string; repo?: string }
  | { kind: 'working' };

export async function buildChange(root: string, spec: ChangeSpec): Promise<Change> {
  const ref = await runGit(['rev-parse', '--short', 'HEAD'], root, { timeoutMs: 10_000 });
  const headRef = ref.code === 0 ? ref.stdout.trim() : 'HEAD';

  if (spec.kind === 'working') {
    const files = await workingChanges(root);
    const commits = await listCommits(root, { limit: 1 });
    return {
      // Stable while the working tree is stable: the same uncommitted edits keep
      // the same id, so a second look reuses the explainer instead of piling up
      // a new file (and a fresh model run) every time.
      id: `working-${shortHash(files.map((file) => `${file.path}:${file.additions}:${file.deletions}`).join('|') || 'clean')}`,
      kind: 'working',
      title: 'Uncommitted changes',
      subtitle: `Working tree on ${headRef}`,
      base: 'HEAD',
      head: 'working tree',
      commits,
      files,
      stats: aggregateStats(files),
      body: '',
    };
  }

  if (spec.kind === 'commit') {
    const commitSha = await revParseRef(root, spec.sha);
    if (!commitSha) {
      throw Object.assign(new Error(`No commit called "${spec.sha}" in this repository.`), { statusCode: 400 });
    }
    const meta = await runGit(['show', '-s', `--format=${LOG_FORMAT}`, commitSha], root, { timeoutMs: 20_000 });
    const [sha, short, author, email, date, subject, body] = meta.stdout.trim().split('\x1f');
    const parentRes = await runGit(['rev-parse', '--verify', '--quiet', `${commitSha}^`], root, { timeoutMs: 10_000 });
    const base = parentRes.code === 0 ? parentRes.stdout.trim() : EMPTY_TREE;
    const files = await diffFilesBetween(root, base, commitSha);
    return {
      id: `commit-${commitSha}`,
      kind: 'commit',
      title: subject || short || spec.sha,
      subtitle: `${short} · ${author}`,
      base,
      head: commitSha,
      author,
      date,
      commits: [{ sha, short, author, email, date, subject, body: (body ?? '').trim() }],
      files,
      stats: aggregateStats(files),
      body: (body ?? '').trim(),
    };
  }

  if (spec.kind === 'branch') {
    const explicitBase = spec.base?.trim() || '';
    let baseRef = explicitBase || (await detectDefaultBranch(root)) || 'HEAD~20';
    const branchTip = await revParseRef(root, spec.branch);
    // A name that does not resolve must be an error, not an empty comparison.
    // Passing a garbled branch name to `git diff` used to leave the file list
    // empty and the reader looking at an explainer that said nothing happened.
    if (!branchTip) {
      throw Object.assign(new Error(`No branch or revision called "${spec.branch}" in this repository.`), { statusCode: 400 });
    }

    let baseTip = await revParseRef(root, baseRef);
    if (!baseTip && !explicitBase) {
      // No default branch could be detected and `HEAD~20` is past the start of a
      // short history: compare against the branch's own first commit instead of
      // giving up.
      const rootCommit = await runGit(['rev-list', '--max-parents=0', spec.branch], root, { timeoutMs: 20_000 });
      const first = rootCommit.stdout.trim().split('\n')[0] ?? '';
      if (rootCommit.code === 0 && first) {
        baseRef = first;
        baseTip = first;
      }
    }
    if (!baseTip) {
      throw Object.assign(new Error(`Cannot compare against "${baseRef}": no such branch or revision.`), { statusCode: 400 });
    }

    const mergeBaseRes = await runGit(['merge-base', baseRef, spec.branch], root, { timeoutMs: 20_000 });
    const mergeBase = mergeBaseRes.code === 0 ? mergeBaseRes.stdout.trim() || null : null;

    // A branch that is already merged into the base — or that is simply the base
    // — has the same tip as its merge base, so the merge-base diff is empty. The
    // reader then gets an explainer about "no changes", which is the least
    // useful thing we can say about a branch they just asked about. Fall back to
    // comparing the two tips, which always has something to show, and say so.
    const sameTip = branchTip === baseTip;
    const noOwnCommits = mergeBase === branchTip;
    const requested: BranchCompareMode = spec.compare ?? 'since-diverged';
    const mode: BranchCompareMode = requested === 'against-tip' || noOwnCommits || sameTip ? 'against-tip' : 'since-diverged';
    const diffBase = mode === 'against-tip' ? baseTip : (mergeBase ?? baseTip);

    const files = await diffFilesBetween(root, diffBase, spec.branch);
    const commits = await listCommits(root, { limit: 100, ref: `${diffBase}..${spec.branch}` });

    let note: string | undefined;
    if (sameTip) {
      note = `${spec.branch} and ${baseRef} point at the same commit, so there is nothing between them. Pick a different comparison branch, or check the branches you expected to differ.`;
    } else if (noOwnCommits) {
      note = `${spec.branch} has no commits that ${baseRef} does not already contain, so there is nothing of its own to show. This compares the two branch tips instead — everything that differs now, including what ${baseRef} gained after the branch left it.`;
    } else if (requested === 'against-tip') {
      note = `Comparing the two branch tips: the diff also includes what ${baseRef} gained since the branch diverged, which appears as reversals.`;
    }

    const subtitle =
      mode === 'since-diverged'
        ? `${pluralizeCommits(commits.length)} ahead of ${baseRef}`
        : sameTip
          ? `Same commit as ${baseRef}`
          : noOwnCommits
            ? `Already merged into ${baseRef} — comparing the two tips`
            : `Tip-to-tip comparison with ${baseRef}`;

    return {
      id: `branch-${spec.branch}-${mode}-${shortHash(`${diffBase}..${branchTip}`).slice(0, 8)}`,
      kind: 'branch',
      title: `Branch ${spec.branch}`,
      subtitle,
      compare: { mode, baseRef, note },
      base: diffBase,
      head: spec.branch,
      commits,
      files,
      stats: aggregateStats(files),
      body: '',
    };
  }

  // A pull request is built from the GitHub API, not from the clone, because
  // fetching `pull/N/head` would write refs into the repository being analysed.
  if (spec.kind === 'pr') {
    throw new Error('Pull request changes are built from GitHub, not from the local clone.');
  }

  // range
  const [baseSha, headSha] = await Promise.all([revParseRef(root, spec.base), revParseRef(root, spec.head)]);
  if (!baseSha || !headSha) {
    const missing = !baseSha ? spec.base : spec.head;
    throw Object.assign(new Error(`Cannot compare ${spec.base} with ${spec.head}: no branch or revision called "${missing}".`), {
      statusCode: 400,
    });
  }
  const files = await diffFilesBetween(root, baseSha, headSha);
  const commits = await listCommits(root, { limit: 100, ref: `${baseSha}..${headSha}` });
  return {
    id: `range-${shortHash(`${spec.base}..${spec.head}`).slice(0, 10)}`,
    kind: 'range',
    title: spec.label ?? `${spec.base} → ${spec.head}`,
    subtitle: `${commits.length} commit(s)`,
    base: spec.base,
    head: spec.head,
    commits,
    files,
    stats: aggregateStats(files),
    body: '',
  };
}

async function workingChanges(root: string): Promise<ChangeFile[]> {
  const [numstatRes, patchRes] = await Promise.all([
    runGit(['diff', '--numstat', '-M', '--no-color', 'HEAD'], root, { maxBuffer: 64 * 1024 * 1024, timeoutMs: 30_000 }),
    runGit(['diff', '-M', '--no-color', '--unified=3', 'HEAD'], root, { maxBuffer: 128 * 1024 * 1024, timeoutMs: 60_000 }),
  ]);
  const numstat = parseNumstat(numstatRes.stdout);
  const patches = parseUnifiedDiff(patchRes.stdout);
  const seen = new Set<string>();
  const files: ChangeFile[] = patches.map((parsed) => {
    seen.add(parsed.path);
    const stat = numstat.get(parsed.path);
    return {
      path: parsed.path,
      oldPath: parsed.oldPath,
      status: parsed.status,
      additions: stat?.additions ?? countDiffLines(parsed.patch, '+'),
      deletions: stat?.deletions ?? countDiffLines(parsed.patch, '-'),
      binary: stat?.binary ?? false,
      patch: parsed.patch.length > MAX_PATCH_CHARS_PER_FILE ? `${parsed.patch.slice(0, MAX_PATCH_CHARS_PER_FILE)}\n… [patch truncated]` : parsed.patch,
      language: languageForDiff(parsed.patch, parsed.path),
    };
  });
  for (const [filePath, stat] of numstat) {
    if (seen.has(filePath) || !stat.binary) continue;
    files.push({
      path: filePath,
      status: 'modified',
      additions: 0,
      deletions: 0,
      binary: true,
      patch: '',
      language: 'text',
    });
  }
  return files.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
}

function aggregateStats(files: ChangeFile[]): Change['stats'] {
  return {
    files: files.length,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
  };
}

/** Read a file's contents at a given ref. Returns null when unavailable. */
export async function showFileAt(root: string, ref: string, filePath: string): Promise<string | null> {
  const res = await runGit(['show', `${ref}:${filePath}`], root, { maxBuffer: 8 * 1024 * 1024, timeoutMs: 20_000 });
  return res.code === 0 ? res.stdout : null;
}

export async function listChangedFiles(root: string, ref: string): Promise<string[]> {
  const res = await runGit(['diff', '--name-only', '-M', ref], root, { timeoutMs: 30_000 });
  if (res.code !== 0) return [];
  return res.stdout.trim().split('\n').filter(Boolean).map(toPosix);
}

function pluralizeCommits(count: number): string {
  return `${count} commit${count === 1 ? '' : 's'}`;
}

/** Resolve any revision to a full commit sha, or null when it does not exist. */
export async function revParseRef(root: string, ref: string): Promise<string | null> {
  if (!ref || ref.startsWith('-')) return null;
  const res = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root, { timeoutMs: 10_000 });
  const sha = res.stdout.trim();
  return res.code === 0 && sha ? sha : null;
}

export { EMPTY_TREE };
