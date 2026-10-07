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

export async function listBranches(root: string): Promise<{ name: string; current: boolean; lastCommit: string; subject: string; date: string }[]> {
  const res = await runGit(
    ['for-each-ref', '--sort=-committerdate', '--count=40', '--format=%(refname:short)%x1f%(objectname:short)%x1f%(committerdate:iso8601)%x1f%(subject)', 'refs/heads', 'refs/remotes'],
    root,
    { timeoutMs: 20_000 },
  );
  if (res.code !== 0) return [];
  const info = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root, { timeoutMs: 10_000 });
  const current = info.code === 0 ? info.stdout.trim() : '';
  return res.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((line) => !line.endsWith('/HEAD'))
    .map((line) => {
      const [name, lastCommit, date, subject] = line.split('\x1f');
      return { name, current: name === current, lastCommit, date, subject: subject ?? '' };
    });
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

export type ChangeSpec =
  | { kind: 'commit'; sha: string }
  | { kind: 'range'; base: string; head: string; label?: string }
  | { kind: 'branch'; branch: string; base?: string }
  | { kind: 'working' };

export async function buildChange(root: string, spec: ChangeSpec): Promise<Change> {
  const ref = await runGit(['rev-parse', '--short', 'HEAD'], root, { timeoutMs: 10_000 });
  const headRef = ref.code === 0 ? ref.stdout.trim() : 'HEAD';

  if (spec.kind === 'working') {
    const files = await workingChanges(root);
    const commits = await listCommits(root, { limit: 1 });
    return {
      id: `working-${shortHash(`${Date.now()}`)}`,
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
    const meta = await runGit(['show', '-s', `--format=${LOG_FORMAT}`, spec.sha], root, { timeoutMs: 20_000 });
    const [sha, short, author, email, date, subject, body] = meta.stdout.trim().split('\x1f');
    const parentRes = await runGit(['rev-parse', '--verify', '--quiet', `${spec.sha}^`], root, { timeoutMs: 10_000 });
    const base = parentRes.code === 0 ? parentRes.stdout.trim() : EMPTY_TREE;
    const files = await diffFilesBetween(root, base, spec.sha);
    return {
      id: `commit-${sha || spec.sha}`,
      kind: 'commit',
      title: subject || short || spec.sha,
      subtitle: `${short} · ${author}`,
      base,
      head: sha || spec.sha,
      author,
      date,
      commits: [{ sha, short, author, email, date, subject, body: (body ?? '').trim() }],
      files,
      stats: aggregateStats(files),
      body: (body ?? '').trim(),
    };
  }

  if (spec.kind === 'branch') {
    const base = spec.base ?? (await detectDefaultBranch(root)) ?? 'HEAD~20';
    const mergeBase = await runGit(['merge-base', base, spec.branch], root, { timeoutMs: 20_000 });
    const actualBase = mergeBase.code === 0 ? mergeBase.stdout.trim() : base;
    const files = await diffFilesBetween(root, actualBase, spec.branch);
    const commits = await listCommits(root, { limit: 100, ref: `${actualBase}..${spec.branch}` });
    return {
      id: `branch-${spec.branch}-${shortHash(actualBase).slice(0, 8)}`,
      kind: 'branch',
      title: `Branch ${spec.branch}`,
      subtitle: `${commits.length} commit(s) ahead of ${base}`,
      base: actualBase,
      head: spec.branch,
      commits,
      files,
      stats: aggregateStats(files),
      body: '',
    };
  }

  // range
  const files = await diffFilesBetween(root, spec.base, spec.head);
  const commits = await listCommits(root, { limit: 100, ref: `${spec.base}..${spec.head}` });
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

export { EMPTY_TREE };
