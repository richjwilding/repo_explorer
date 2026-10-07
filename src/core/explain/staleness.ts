import fs from 'node:fs';
import path from 'node:path';
import type { Explainer, ExplainerScope, FileEntry, RepoModel, StalenessReport } from '../types.js';
import type { RepoContext } from '../service.js';
import { shortHash } from '../util/id.js';
import { readTextFileSync } from '../util/fs.js';
import { revParseHead } from '../util/git.js';
import { log } from '../logger.js';

/**
 * Staleness detection for explainers.
 *
 * An explainer is a snapshot of an understanding, and code keeps moving. The
 * reader is told when a given explainer no longer matches the code — but it is
 * never hidden, deleted, or silently regenerated: a slightly out-of-date
 * explanation of a component is usually still worth reading, and regenerating
 * costs minutes and tokens.
 *
 * Detection is deliberately cheap: files are compared by modification time and
 * size rather than content, so a check is a few thousand `stat` calls rather
 * than re-reading the repository.
 */

export interface FreshnessIndex {
  /** Git HEAD right now, when the repository is a git repository. */
  head: string | null;
  /** Current on-disk mtime and size for every analysed file. */
  stats: Map<string, { mtimeMs: number; size: number }>;
  builtAt: number;
}

/**
 * Whether a file's content actually differs from a recorded baseline.
 *
 * A moved mtime is only a hint: checkouts and formatters rewrite identical
 * bytes. The content is re-read and hashed only when the mtime or size moved,
 * so an unchanged repository costs nothing beyond `stat` calls.
 */
function contentDiffers(
  ctx: RepoContext,
  filePath: string,
  baseline: { mtimeMs: number; size: number; hash?: string },
  current: { mtimeMs: number; size: number },
): boolean {
  const moved = Math.round(baseline.mtimeMs) !== Math.round(current.mtimeMs) || baseline.size !== current.size;
  if (!moved) return false;
  if (!baseline.hash) return true;
  const text = readTextFileSync(path.join(ctx.root, filePath), 2_000_000);
  if (text === null) return true;
  return shortHash(text, 16) !== baseline.hash;
}

const CACHE_TTL_MS = 5000;
/** Above this many files an explainer keeps its fingerprint but not the list. */
const MAX_TRACKED_FILES = 4000;
const cache = new Map<string, FreshnessIndex>();

/** Invalidate after a repository is re-analysed or its files change. */
export function forgetFreshness(repoId: string): void {
  cache.delete(repoId);
}

export async function buildFreshnessIndex(ctx: RepoContext, options: { refresh?: boolean } = {}): Promise<FreshnessIndex> {
  const cached = cache.get(ctx.model.repo.id);
  if (!options.refresh && cached && Date.now() - cached.builtAt < CACHE_TTL_MS) return cached;

  const stats = new Map<string, { mtimeMs: number; size: number }>();
  for (const file of ctx.model.files) {
    try {
      const stat = fs.statSync(path.join(ctx.root, file.path));
      stats.set(file.path, { mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // Absent from the map means "gone", which the caller reports as removed.
    }
  }

  const head = ctx.model.git.isRepo ? await revParseHead(ctx.root) : null;
  return { head, stats, builtAt: Date.now() };
}

/** The files an explainer was written against. */
export function scopeFiles(model: RepoModel, explainer: Explainer): string[] {
  const { kind, id } = explainer.target;

  if (kind === 'repo-overview') {
    return model.files.filter((file) => !file.isNoise).map((file) => file.path);
  }
  if (kind === 'component') {
    const component = model.components.find((candidate) => candidate.id === id);
    return component ? component.files : [];
  }
  if (kind === 'module') {
    const prefix = id ? `${id}/` : '';
    return model.files.filter((file) => (id === '' ? true : file.path.startsWith(prefix) || file.path === id)).map((file) => file.path);
  }
  if (kind === 'flow') {
    const flow = model.dataFlows.find((candidate) => candidate.id === id);
    if (!flow) return [];
    const files = new Set(flow.evidence);
    for (const componentId of flow.path) {
      const component = model.components.find((candidate) => candidate.id === componentId);
      for (const file of component?.files ?? []) files.add(file);
    }
    return [...files];
  }
  // A change is a diff, which is immutable once committed; only an explanation
  // of the working tree can go out of date, and that is handled in the caller.
  return [];
}

export function fingerprintFiles(files: { path: string; mtimeMs: number; size: number }[]): string {
  return shortHash(
    files
      .map((file) => `${file.path}\t${Math.round(file.mtimeMs)}\t${file.size}`)
      .sort()
      .join('\n'),
    16,
  );
}

/** Fingerprint the scope of an explainer as it stands on disk right now. */
export function currentScopeFingerprint(index: FreshnessIndex, files: string[], model: RepoModel): string {
  const known = new Map(model.files.map((file) => [file.path, file] as [string, FileEntry]));
  const entries = files.map((filePath) => {
    const stat = index.stats.get(filePath) ?? known.get(filePath);
    return { path: filePath, mtimeMs: stat?.mtimeMs ?? 0, size: stat?.size ?? 0 };
  });
  return fingerprintFiles(entries);
}

export function recordScope(ctx: RepoContext, explainer: Explainer, index?: FreshnessIndex): void {
  const model = ctx.model;
  const files = scopeFiles(model, explainer);
  const known = new Map(model.files.map((file) => [file.path, file] as [string, FileEntry]));

  // The baseline must describe one consistent snapshot: the state on disk when
  // the explainer was written. Mixing on-disk mtimes with the analysis's content
  // hash flagged every file edited since the analysis as permanently changed.
  const entries = files.map((filePath) => {
    const analysed = known.get(filePath);
    const stat = index?.stats.get(filePath);
    const mtimeMs = stat?.mtimeMs ?? analysed?.mtimeMs ?? 0;
    const size = stat?.size ?? analysed?.size ?? 0;
    const unchangedSinceAnalysis =
      Boolean(analysed?.hash) &&
      analysed !== undefined &&
      stat !== undefined &&
      Math.round(analysed.mtimeMs) === Math.round(stat.mtimeMs) &&
      analysed.size === stat.size;
    let hash = unchangedSinceAnalysis ? analysed?.hash : undefined;
    if (!hash && analysed && !analysed.isNoise) {
      // Only re-read files that moved since the analysis; the rest reuse its hash.
      const text = readTextFileSync(path.join(ctx.root, filePath), 2_000_000);
      if (text !== null) hash = shortHash(text, 16);
    }
    return { path: filePath, mtimeMs, size, hash };
  });
  explainer.scope = {
    fingerprint: fingerprintFiles(entries),
    fileCount: files.length,
    head: index?.head ?? model.git.head ?? null,
    ...(entries.length <= MAX_TRACKED_FILES
      ? {
          files: entries
            .map((entry) => `${entry.path}\t${Math.round(entry.mtimeMs)}\t${entry.size}\t${entry.hash ?? ''}`)
            .join('\n'),
        }
      : {}),
  };
}

/** Parse the baseline an explainer recorded for itself. */
function parseScopeFiles(
  scope: ExplainerScope | undefined,
): Map<string, { mtimeMs: number; size: number; hash?: string }> | null {
  if (!scope?.files) return null;
  const map = new Map<string, { mtimeMs: number; size: number; hash?: string }>();
  for (const line of scope.files.split('\n')) {
    const [filePath, mtime, size, hash] = line.split('\t');
    if (!filePath || mtime === undefined || size === undefined) continue;
    map.set(filePath, { mtimeMs: Number(mtime), size: Number(size), ...(hash ? { hash } : {}) });
  }
  return map;
}

/**
 * Whether the *analysis* still matches the working tree.
 *
 * Independent of any explainer: the analysis is the ground truth every
 * explainer is built from, and a working-tree edit does not move HEAD, so this
 * is the only signal that a re-analysis is due.
 */
export async function checkAnalysisStaleness(
  ctx: RepoContext,
  index: FreshnessIndex,
): Promise<{ stale: boolean; changedFiles: string[]; removedFiles: string[]; summary: string }> {
  const changedFiles: string[] = [];
  const removedFiles: string[] = [];

  for (const file of ctx.model.files) {
    if (file.isNoise) continue;
    const current = index.stats.get(file.path);
    if (!current) {
      removedFiles.push(file.path);
      continue;
    }
    if (contentDiffers(ctx, file.path, file, current)) changedFiles.push(file.path);
  }

  const headMoved = Boolean(ctx.model.git.head && index.head && ctx.model.git.head !== index.head);
  const stale = changedFiles.length > 0 || removedFiles.length > 0 || headMoved;
  const parts: string[] = [];
  if (changedFiles.length > 0) parts.push(`${changedFiles.length} file(s) changed since it ran`);
  if (removedFiles.length > 0) parts.push(`${removedFiles.length} removed`);
  if (headMoved) parts.push('new commits');

  return {
    stale,
    changedFiles: changedFiles.slice(0, 40),
    removedFiles: removedFiles.slice(0, 20),
    summary: stale ? `Analysis out of date: ${parts.join(', ')}.` : 'Analysis is current.',
  };
}

export function checkStaleness(ctx: RepoContext, explainer: Explainer, index: FreshnessIndex): StalenessReport {
  const model = ctx.model;
  const scope = explainer.scope;

  // Explanations of the working tree describe a moving target.
  const isWorkingTree = explainer.kind === 'change' && explainer.target.id.startsWith('working');
  if (explainer.kind === 'change' && !isWorkingTree) {
    return {
      stale: false,
      headMoved: false,
      changedFiles: [],
      removedFiles: [],
      checkedFiles: 0,
      summary: 'A committed change does not go out of date.',
    };
  }

  const files = scopeFiles(model, explainer);
  if (files.length === 0 && !isWorkingTree) {
    // A component or directory can disappear in a refactor. The explainer is not
    // merely old, it describes something that is no longer there — worth saying
    // plainly rather than reporting an empty scope.
    const orphaned = explainer.kind === 'component' || explainer.kind === 'module';
    return {
      stale: orphaned,
      headMoved: false,
      changedFiles: [],
      removedFiles: [],
      checkedFiles: 0,
      summary: orphaned
        ? 'This describes a part of the system that no longer exists in the current analysis.'
        : 'No files in scope.',
    };
  }

  const headMoved = Boolean(scope?.head && index.head && scope.head !== index.head);
  const changedFiles: string[] = [];
  const removedFiles: string[] = [];

  // Compare against what the *explainer* recorded, not against the analysis:
  // the analysis is always older than the explainer, so using it made a freshly
  // written explainer report itself as out of date.
  const baseline = parseScopeFiles(scope);
  for (const filePath of files) {
    const current = index.stats.get(filePath);
    if (!current) {
      removedFiles.push(filePath);
      continue;
    }
    const previous = baseline?.get(filePath);
    if (!previous) continue;
    if (contentDiffers(ctx, filePath, previous, current)) changedFiles.push(filePath);
  }

  // With a per-file baseline the content check is the decision: an mtime that
  // moved for a checkout or a formatter must not count as a change. Without a
  // baseline (a scope too large to track) the aggregate fingerprint is the best
  // available signal, and it errs towards reporting possible staleness.
  const fingerprintChanged = scope ? currentScopeFingerprint(index, files, model) !== scope.fingerprint : false;
  const stale = baseline
    ? changedFiles.length > 0 || removedFiles.length > 0 || headMoved
    : fingerprintChanged || headMoved;

  return {
    stale,
    headMoved,
    changedFiles: changedFiles.slice(0, 40),
    removedFiles: removedFiles.slice(0, 20),
    checkedFiles: files.length,
    summary: summarise({ stale, headMoved, changedFiles, removedFiles, files, approximate: !baseline && fingerprintChanged }),
  };
}

function summarise(input: {
  stale: boolean;
  headMoved: boolean;
  changedFiles: string[];
  removedFiles: string[];
  files: string[];
  approximate?: boolean;
}): string {
  if (!input.stale) return 'Up to date with the code.';
  const parts: string[] = [];
  if (input.changedFiles.length > 0) {
    parts.push(`${input.changedFiles.length} of ${input.files.length} file(s) changed`);
  }
  if (input.removedFiles.length > 0) parts.push(`${input.removedFiles.length} removed`);
  if (input.headMoved) parts.push('new commits since it was written');
  if (parts.length === 0) {
    return input.approximate ? 'Out of date: files may have changed (the scope is too large to check file by file).' : 'Out of date.';
  }
  return `Out of date: ${parts.join(', ')}.`;
}

/** Convenience for endpoints that need the report without the ceremony. */
export async function stalenessFor(ctx: RepoContext, explainer: Explainer): Promise<StalenessReport> {
  try {
    const index = await buildFreshnessIndex(ctx);
    return checkStaleness(ctx, explainer, index);
  } catch (error) {
    log.debug('staleness check failed', error instanceof Error ? error.message : error);
    return { stale: false, headMoved: false, changedFiles: [], removedFiles: [], checkedFiles: 0, summary: 'Could not check freshness.' };
  }
}
