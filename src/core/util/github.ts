/**
 * Pull request explainers.
 *
 * A pull request is read from GitHub's API rather than from the local clone, for
 * two reasons that both matter. It keeps the promise that nothing is written into
 * the repository being analysed — `git fetch origin pull/N/head` would add refs
 * to `.git` — and it works for a PR whose branch was never checked out, which is
 * the common case when someone links you a review to read.
 *
 * Everything else is reused: the result is an ordinary `Change`, so the explainer,
 * quiz, staleness tracking and HTML export are untouched.
 */
import { languageForHighlight } from '../analysis/languages.js';
import type { Change, ChangeFile } from '../types.js';
import { parseRemoteSlug, runGit, type CommitInfo } from './git.js';

export interface PullRequestSpec {
  number: number;
  /** Defaults to the `origin` remote of the repository being analysed. */
  owner?: string;
  repo?: string;
}

export interface PullRequestData {
  number: number;
  title: string;
  body: string;
  author: string;
  state: string;
  merged: boolean;
  draft: boolean;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  htmlUrl: string;
  /** Files GitHub could not include a patch for, usually because they are binary or very large. */
  patchlessFiles: number;
  files: ChangeFile[];
  commits: CommitInfo[];
}

export interface GitHubOptions {
  token?: string | null;
  /** Injected for tests; never reached in a hermetic run. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const API_BASE = 'https://api.github.com';
const USER_AGENT = 'repo-explorer';
/** GitHub caps a PR's file list at 300; three pages is the whole thing. */
const MAX_FILE_PAGES = 3;

interface GitHubPullShape {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  merged?: boolean;
  draft?: boolean;
  html_url?: string;
  user?: { login?: string } | null;
  base?: { ref?: string; sha?: string };
  head?: { ref?: string; sha?: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

interface GitHubFileShape {
  filename?: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

interface GitHubCommitShape {
  sha?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
  author?: { login?: string } | null;
}

/** A GitHub failure the reader can act on, rather than a bare status code. */
export class GitHubError extends Error {
  /** The HTTP status this should be reported as. A missing remote is the caller's problem, not a server fault. */
  readonly statusCode: number;

  constructor(
    message: string,
    readonly status: number,
    readonly kind: 'not-found' | 'auth' | 'rate-limit' | 'network' | 'bad-response' | 'no-remote',
  ) {
    super(message);
    this.name = 'GitHubError';
    this.statusCode = STATUS_FOR_KIND[kind];
  }
}

const STATUS_FOR_KIND: Record<GitHubError['kind'], number> = {
  // The repository has not been configured to point anywhere.
  'no-remote': 400,
  'not-found': 404,
  auth: 401,
  'rate-limit': 429,
  // GitHub being unreachable or answering nonsense is an upstream failure.
  network: 502,
  'bad-response': 502,
};

async function request<T>(path: string, options: GitHubOptions): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': USER_AGENT,
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);

  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE}${path}`, { headers, signal: controller.signal });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitHubError(`GitHub could not be reached (${detail}).`, 0, 'network');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }

  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    const wait =
      remaining === '0' && reset
        ? ` The rate limit resets at ${new Date(Number(reset) * 1000).toLocaleTimeString()}.`
        : '';
    if (response.status === 404) {
      throw new GitHubError(
        `Pull request not found. Check the number, and note that a private repository needs a GitHub token.`,
        404,
        'not-found',
      );
    }
    if (response.status === 401) {
      throw new GitHubError('GitHub rejected the token. Check GITHUB_TOKEN in your .env.', 401, 'auth');
    }
    if (response.status === 403 || response.status === 429) {
      throw new GitHubError(
        `GitHub refused the request — this is usually the unauthenticated rate limit of 60 requests an hour.` +
          `${wait} Add GITHUB_TOKEN to your .env to raise it.`,
        response.status,
        'rate-limit',
      );
    }
    throw new GitHubError(`GitHub returned ${response.status} for ${path}.`, response.status, 'bad-response');
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new GitHubError(`GitHub returned a response that could not be read for ${path}.`, response.status, 'bad-response');
  }
}

function mapStatus(status: string | undefined): ChangeFile['status'] {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'deleted';
    case 'modified':
    case 'changed':
      return 'modified';
    case 'renamed':
      return 'renamed';
    case 'copied':
      return 'copied';
    default:
      return 'unknown';
  }
}

/**
 * Which repository to ask about.
 *
 * Explicitly given details win, so a PR in another repository can be explained.
 * Otherwise the `origin` remote of the analysed repository is used, because that
 * is where the reader's PRs almost always are.
 */
export async function resolvePullRequestTarget(root: string, spec: PullRequestSpec): Promise<{ owner: string; repo: string; number: number }> {
  if (!Number.isInteger(spec.number) || spec.number <= 0) {
    throw new GitHubError(`A pull request number must be a positive integer, not "${spec.number}".`, 0, 'no-remote');
  }
  if (spec.owner && spec.repo) return { owner: spec.owner, repo: spec.repo, number: spec.number };

  const remote = await runGit(['remote', 'get-url', 'origin'], root, { timeoutMs: 10_000 });
  const url = remote.code === 0 ? remote.stdout.trim() : '';
  if (!url) {
    throw new GitHubError(
      'This repository has no `origin` remote, so there is no GitHub repository to ask about. Set one, or pass the owner and repository explicitly.',
      0,
      'no-remote',
    );
  }
  const slug = parseRemoteSlug(url);
  if (!slug || !slug.includes('/')) {
    throw new GitHubError(`The \`origin\` remote (${url}) is not a GitHub repository this app can resolve.`, 0, 'no-remote');
  }
  const [owner, repo] = slug.split('/');
  return { owner, repo: repo.replace(/\.git$/, ''), number: spec.number };
}

export async function fetchPullRequest(
  target: { owner: string; repo: string; number: number },
  options: GitHubOptions = {},
): Promise<PullRequestData> {
  const base = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const pull = await request<GitHubPullShape>(`${base}/pulls/${target.number}`, options);
  if (!pull || typeof pull !== 'object' || typeof pull.number !== 'number') {
    throw new GitHubError('GitHub returned something that is not a pull request.', 200, 'bad-response');
  }

  const files: ChangeFile[] = [];
  let patchlessFiles = 0;
  for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
    const batch = await request<GitHubFileShape[]>(`${base}/pulls/${target.number}/files?per_page=100&page=${page}`, options);
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const file of batch) {
      const path = file.filename ?? '';
      if (!path) continue;
      const patch = typeof file.patch === 'string' ? file.patch : '';
      if (!patch) patchlessFiles += 1;
      files.push({
        path,
        oldPath: file.previous_filename,
        status: mapStatus(file.status),
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        // GitHub omits the patch for binary and very large files rather than
        // failing, so a missing patch means "not shown", not "no change".
        binary: !patch,
        patch,
        language: languageForHighlight(path),
      });
    }
    if (batch.length < 100) break;
  }

  const rawCommits = await request<GitHubCommitShape[]>(`${base}/pulls/${target.number}/commits?per_page=100`, options);
  const commits: CommitInfo[] = (Array.isArray(rawCommits) ? rawCommits : []).map((commit) => {
    const message = commit.commit?.message ?? '';
    const sha = commit.sha ?? '';
    return {
      sha,
      short: sha.slice(0, 7),
      subject: message.split('\n')[0] ?? '',
      author: commit.commit?.author?.name ?? commit.author?.login ?? 'unknown',
      email: '',
      date: commit.commit?.author?.date ?? '',
      body: message.split('\n').slice(1).join('\n').trim(),
    };
  });

  return {
    number: pull.number,
    title: pull.title ?? '',
    body: pull.body ?? '',
    author: pull.user?.login ?? 'unknown',
    state: pull.state ?? 'unknown',
    merged: Boolean(pull.merged),
    draft: Boolean(pull.draft),
    baseRef: pull.base?.ref ?? '',
    baseSha: pull.base?.sha ?? '',
    headRef: pull.head?.ref ?? '',
    headSha: pull.head?.sha ?? '',
    additions: pull.additions ?? files.reduce((sum, file) => sum + file.additions, 0),
    deletions: pull.deletions ?? files.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: pull.changed_files ?? files.length,
    htmlUrl: pull.html_url ?? '',
    patchlessFiles,
    files,
    commits,
  };
}

/** A pull request as an ordinary change, so everything downstream is unchanged. */
export function pullRequestToChange(pull: PullRequestData, target: { owner: string; repo: string }): Change {
  const state = pull.merged ? 'merged' : pull.draft ? 'draft' : pull.state;
  const subtitle = [
    `${target.owner}/${target.repo}#${pull.number}`,
    state,
    `${pull.headRef} → ${pull.baseRef}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    id: `pr-${target.owner}-${target.repo}-${pull.number}`.replace(/[^A-Za-z0-9._-]/g, '-'),
    kind: 'pr',
    title: pull.title || `Pull request #${pull.number}`,
    subtitle,
    base: pull.baseSha,
    head: pull.headSha,
    author: pull.author,
    body: pull.body,
    commits: pull.commits,
    files: pull.files,
    stats: {
      files: pull.changedFiles,
      additions: pull.additions,
      deletions: pull.deletions,
    },
    url: pull.htmlUrl,
  };
}

export async function buildPullRequestChange(root: string, spec: PullRequestSpec, options: GitHubOptions = {}): Promise<Change> {
  const target = await resolvePullRequestTarget(root, spec);
  const pull = await fetchPullRequest(target, options);
  return pullRequestToChange(pull, target);
}
