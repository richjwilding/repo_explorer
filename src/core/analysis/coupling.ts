/**
 * Coupling and ownership, read from history rather than from code.
 *
 * The import graph shows the architecture the code declares. History shows the
 * architecture it actually has: which files have to move together, and who
 * holds the knowledge. Both are things a new leader needs and neither can be
 * derived from reading source.
 *
 * Two measurements, both from one `git log` pass:
 *
 * - **Co-change**: how often two files appear in the same commit, with a
 *   confidence of "when one changes, the other does". A pair that spans two
 *   components is the interesting case — it is a dependency the import graph
 *   does not show, and usually the reason a small change turns out to be large.
 * - **Ownership**: who writes each file, and how many people would have to
 *   leave before nobody is left who knows it.
 */
import { runGit } from '../util/git.js';

export interface ChangeCoupling {
  a: string;
  b: string;
  /** Commits containing both files. */
  together: number;
  /** together / min(commits in a, commits in b) — 1 means they always move as a pair. */
  confidence: number;
  /** together / totalCommits — how much of the project's history this pair explains. */
  support: number;
  /** The two files live in different components, so the graph does not show this. */
  crossComponent: boolean;
}

export interface FileOwnership {
  path: string;
  commits: number;
  authors: number;
  topAuthor: string;
  /** Share of this file's commits written by the top author, 0–1. */
  topAuthorShare: number;
  /** How many authors it takes to account for half of this file's commits. */
  busFactor: number;
}

export interface ComponentOwnership {
  id: string;
  name: string;
  commits: number;
  authors: number;
  topAuthor: string;
  topAuthorShare: number;
  busFactor: number;
}

export interface CouplingInfo {
  /** Pairs that move together, cross-component and most confident first. */
  pairs: ChangeCoupling[];
  /** Per-file ownership, busiest first. */
  files: FileOwnership[];
  /** Ownership rolled up per component. */
  components: ComponentOwnership[];
  /** Components where one person accounts for most of the history. */
  singleOwner: ComponentOwnership[];
  totalCommits: number;
  /** Commits skipped for touching too many files (merges, mass reformats). */
  skippedLargeCommits: number;
  warnings: string[];
}

export const EMPTY_COUPLING: CouplingInfo = {
  pairs: [],
  files: [],
  components: [],
  singleOwner: [],
  totalCommits: 0,
  skippedLargeCommits: 0,
  warnings: [],
};

export interface CouplingInput {
  root: string;
  totalCommits: number;
  /** Only files that exist in the analysis are worth reporting. */
  knownPaths: Set<string>;
  fileToComponent: Map<string, { id: string; name: string }>;
  maxCommits?: number;
  maxPairs?: number;
}

/** Files whose content is generated or pinned: they couple with everything, meaninglessly. */
const NOISE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.(min\.js|min\.css|map)$|(^|\/)dist\//i;

/** Above this many files, a commit is a merge, a format sweep or a rename. */
const LARGE_COMMIT_FILES = 40;

function busFactorFor(counts: Map<string, number>, total: number): number {
  const sorted = [...counts.values()].sort((a, b) => b - a);
  let covered = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    covered += sorted[index];
    if (covered >= total / 2) return index + 1;
  }
  return sorted.length;
}

function summariseOwnership(counts: Map<string, number>, commits: number) {
  const authors = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = authors[0];
  return {
    authors: authors.length,
    topAuthor: top?.[0] ?? 'unknown',
    topAuthorShare: commits > 0 && top ? top[1] / commits : 0,
    busFactor: busFactorFor(counts, commits),
  };
}

/**
 * One `git log` pass, read two ways.
 *
 * Commits touching an implausible number of files are skipped: a merge or a
 * whole-repo reformat couples every file to every other file and would bury the
 * real signal. They are counted so the UI can say so.
 */
export async function computeCoupling(input: CouplingInput): Promise<CouplingInfo> {
  const { root, totalCommits, knownPaths, fileToComponent } = input;
  const maxCommits = input.maxCommits ?? 500;
  const maxPairs = input.maxPairs ?? 60;
  const warnings: string[] = [];

  const res = await runGit(
    ['log', '--name-only', '--format=%x00%an', `--max-count=${maxCommits}`, '--no-merges', '--no-renames'],
    root,
    { maxBuffer: 64 * 1024 * 1024, timeoutMs: 45_000 },
  );
  if (res.code !== 0) {
    return { ...EMPTY_COUPLING, totalCommits, warnings: ['git history could not be read for coupling analysis.'] };
  }

  const commitsPerFile = new Map<string, number>();
  const authorsPerFile = new Map<string, Map<string, number>>();
  const pairCounts = new Map<string, number>();
  let commitsSeen = 0;
  let skippedLargeCommits = 0;

  let author = '';
  let touched: string[] = [];

  const flush = () => {
    if (touched.length === 0) return;
    commitsSeen += 1;
    // A pair is only meaningful between files that exist now.
    const files = touched;
    for (const file of files) {
      commitsPerFile.set(file, (commitsPerFile.get(file) ?? 0) + 1);
      let authors = authorsPerFile.get(file);
      if (!authors) {
        authors = new Map();
        authorsPerFile.set(file, authors);
      }
      authors.set(author, (authors.get(author) ?? 0) + 1);
    }
    if (files.length > LARGE_COMMIT_FILES) {
      skippedLargeCommits += 1;
    } else if (files.length > 1) {
      for (let i = 0; i < files.length; i += 1) {
        for (let j = i + 1; j < files.length; j += 1) {
          const [a, b] = files[i] < files[j] ? [files[i], files[j]] : [files[j], files[i]];
          const key = `${a}\u0000${b}`;
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
        }
      }
    }
  };

  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('\u0000')) {
      flush();
      author = line.slice(1).trim() || 'unknown';
      touched = [];
      continue;
    }
    const path = line.trim();
    if (!path) continue;
    if (NOISE_RE.test(path)) continue;
    if (!knownPaths.has(path)) continue;
    if (!touched.includes(path)) touched.push(path);
  }
  flush();

  const effectiveCommits = commitsSeen || totalCommits || 1;
  // A file touched in most commits couples with everything; that is a fact about
  // the file being a hub, not a hidden dependency. Only applied once there is
  // enough history for "most commits" to mean anything: in a ten-commit
  // repository almost every file looks ubiquitous, and filtering would leave
  // nothing behind.
  const ubiquityThreshold = effectiveCommits >= 20 ? Math.max(10, effectiveCommits * 0.4) : Number.POSITIVE_INFINITY;
  const minTogether = Math.min(5, Math.max(2, Math.ceil(effectiveCommits * 0.02)));

  const pairs: ChangeCoupling[] = [];
  for (const [key, together] of pairCounts) {
    if (together < minTogether) continue;
    const [a, b] = key.split('\u0000');
    const commitsA = commitsPerFile.get(a) ?? 0;
    const commitsB = commitsPerFile.get(b) ?? 0;
    if (commitsA > ubiquityThreshold || commitsB > ubiquityThreshold) continue;
    const confidence = together / Math.max(1, Math.min(commitsA, commitsB));
    if (confidence < 0.5) continue;
    const componentA = fileToComponent.get(a);
    const componentB = fileToComponent.get(b);
    pairs.push({
      a,
      b,
      together,
      confidence: Math.round(confidence * 100) / 100,
      support: Math.round((together / effectiveCommits) * 1000) / 1000,
      crossComponent: Boolean(componentA && componentB && componentA.id !== componentB.id),
    });
  }

  // Cross-component coupling first: it is the kind the import graph does not show.
  pairs.sort(
    (x, y) =>
      Number(y.crossComponent) - Number(x.crossComponent) ||
      y.confidence - x.confidence ||
      y.together - x.together ||
      x.a.localeCompare(y.a),
  );

  // Keep a file from filling the list on its own.
  const perFile = new Map<string, number>();
  const limited: ChangeCoupling[] = [];
  for (const pair of pairs) {
    const countA = perFile.get(pair.a) ?? 0;
    const countB = perFile.get(pair.b) ?? 0;
    if (countA >= 4 || countB >= 4) continue;
    perFile.set(pair.a, countA + 1);
    perFile.set(pair.b, countB + 1);
    limited.push(pair);
    if (limited.length >= maxPairs) break;
  }

  const files: FileOwnership[] = [...authorsPerFile.entries()]
    .map(([path, authors]) => {
      const commits = commitsPerFile.get(path) ?? 0;
      return { path, commits, ...summariseOwnership(authors, commits) };
    })
    .sort((a, b) => b.commits - a.commits || a.path.localeCompare(b.path))
    .slice(0, 60);

  // Roll ownership up per component, weighting by commits.
  const byComponent = new Map<string, { name: string; counts: Map<string, number>; commits: number }>();
  for (const [path, authors] of authorsPerFile.entries()) {
    const component = fileToComponent.get(path);
    if (!component) continue;
    const entry = byComponent.get(component.id) ?? { name: component.name, counts: new Map<string, number>(), commits: 0 };
    for (const [name, count] of authors) entry.counts.set(name, (entry.counts.get(name) ?? 0) + count);
    entry.commits += commitsPerFile.get(path) ?? 0;
    byComponent.set(component.id, entry);
  }

  const components: ComponentOwnership[] = [...byComponent.entries()]
    .map(([id, entry]) => ({ id, name: entry.name, commits: entry.commits, ...summariseOwnership(entry.counts, entry.commits) }))
    .sort((a, b) => b.commits - a.commits);

  // One person accounting for most of a component's history is a key-person
  // risk, but only where there is enough history for the share to mean something.
  const singleOwner = components.filter((component) => component.commits >= 10 && component.authors > 1 && component.topAuthorShare >= 0.8);

  if (skippedLargeCommits > 0) {
    warnings.push(
      `${skippedLargeCommits} commit(s) touching more than ${LARGE_COMMIT_FILES} files were excluded from coupling: a merge or a whole-repo reformat couples everything to everything.`,
    );
  }

  return {
    pairs: limited,
    files,
    components,
    singleOwner,
    totalCommits: effectiveCommits,
    skippedLargeCommits,
    warnings,
  };
}
