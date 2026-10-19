import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPullRequestChange,
  fetchPullRequest,
  GitHubError,
  pullRequestToChange,
  resolvePullRequestTarget,
} from '../src/core/util/github.js';

/**
 * Pull request explainers are read from GitHub's API, never from the local clone,
 * so these tests inject a fake `fetch` and never touch the network. What matters
 * here is that a failure tells the reader which of several very different things
 * went wrong — a private repository looks exactly like a wrong number otherwise.
 */

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fake fetch that answers by path and records what was asked for. */
function fakeFetch(routes: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: { headers?: Record<string, string> }) => {
    const href = String(url);
    calls.push({ url: href, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = Object.keys(routes).find((pattern) => href.includes(pattern));
    if (!key) {
      return {
        ok: false,
        status: 404,
        headers: new Map(),
        json: async () => ({}),
      } as unknown as Response;
    }
    const route = routes[key];
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map(Object.entries(route.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      json: async () => route.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A fake `Response.headers.get` shim, since the code reads rate-limit headers. */
function headersWith(entries: Record<string, string>) {
  return {
    get: (name: string) => entries[name.toLowerCase()] ?? null,
  };
}

const pull = {
  number: 542,
  title: 'fix(ci): match release tags exactly',
  body: 'The release workflow matched any tag containing the version.',
  state: 'open',
  merged: false,
  draft: false,
  html_url: 'https://github.com/acme/widgets/pull/542',
  user: { login: 'ada' },
  base: { ref: 'main', sha: 'base123' },
  head: { ref: 'fix/tags', sha: 'head456' },
  additions: 12,
  deletions: 3,
  changed_files: 2,
};

const files = [
  { filename: '.github/workflows/release.yml', status: 'modified', additions: 10, deletions: 3, patch: '@@ -1 +1 @@\n-old\n+new' },
  { filename: 'logo.png', status: 'added', additions: 2, deletions: 0 },
  { filename: 'old-name.ts', previous_filename: 'name.ts', status: 'renamed', additions: 0, deletions: 0, patch: '@@ -0 +0 @@' },
];

const commits = [
  { sha: 'abc1234567', commit: { message: 'fix: tags\n\nLonger explanation.', author: { name: 'Ada', date: '2026-10-01T10:00:00Z' } } },
];

describe('reading a pull request', () => {
  it('maps the metadata, files and commits onto a change', async () => {
    const { impl } = fakeFetch({
      '/pulls/542/files': { body: files },
      '/pulls/542/commits': { body: commits },
      '/pulls/542': { body: pull },
    });
    const result = await fetchPullRequest({ owner: 'acme', repo: 'widgets', number: 542 }, { fetchImpl: impl, token: 't' });
    expect(result.title).toBe('fix(ci): match release tags exactly');
    expect(result.body).toContain('release workflow');
    expect(result.author).toBe('ada');
    expect(result.baseRef).toBe('main');
    expect(result.headSha).toBe('head456');
    expect(result.files).toHaveLength(3);
    expect(result.commits[0].subject).toBe('fix: tags');
    expect(result.commits[0].body).toBe('Longer explanation.');
  });

  it('maps GitHub statuses onto the app vocabulary', async () => {
    const { impl } = fakeFetch({
      '/files': { body: [...files, { filename: 'gone.ts', status: 'removed', additions: 0, deletions: 9, patch: '@@' }] },
      '/commits': { body: [] },
      '/pulls/542': { body: pull },
    });
    // Ordered longest-first so `/files` wins over `/pulls/542`.
    const result = await fetchPullRequest({ owner: 'a', repo: 'b', number: 542 }, { fetchImpl: impl });
    expect(result.files.map((file) => `${file.path}:${file.status}`)).toEqual([
      '.github/workflows/release.yml:modified',
      'logo.png:added',
      'old-name.ts:renamed',
      'gone.ts:deleted',
    ]);
    expect(result.files[2].oldPath).toBe('name.ts');
  });

  it('marks a file with no patch as binary rather than as unchanged', async () => {
    // GitHub omits the patch for binary and very large files; that means "not
    // shown", not "no change", and reporting it as unchanged would be a lie.
    const { impl } = fakeFetch({ '/files': { body: files }, '/commits': { body: [] }, '/pulls/542': { body: pull } });
    const result = await fetchPullRequest({ owner: 'a', repo: 'b', number: 542 }, { fetchImpl: impl });
    expect(result.files.find((file) => file.path === 'logo.png')?.binary).toBe(true);
    expect(result.patchlessFiles).toBe(1);
  });

  it('pages through the file list', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ filename: `src/f${index}.ts`, status: 'modified', additions: 1, deletions: 0, patch: '@@' }));
    const secondPage = [{ filename: 'src/last.ts', status: 'added', additions: 1, deletions: 0, patch: '@@' }];
    let page = 0;
    const impl = (async (url: string) => {
      const href = String(url);
      if (href.includes('/pulls/542/files')) {
        page += 1;
        return { ok: true, status: 200, headers: headersWith({}), json: async () => (page === 1 ? firstPage : secondPage) } as unknown as Response;
      }
      if (href.includes('/commits')) return { ok: true, status: 200, headers: headersWith({}), json: async () => [] } as unknown as Response;
      return { ok: true, status: 200, headers: headersWith({}), json: async () => pull } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await fetchPullRequest({ owner: 'a', repo: 'b', number: 542 }, { fetchImpl: impl });
    expect(result.files).toHaveLength(101);
  });

  it('sends the token as a bearer header, and none when there is no token', async () => {
    const withToken = fakeFetch({ '/files': { body: [] }, '/commits': { body: [] }, '/pulls/542': { body: pull } });
    await fetchPullRequest({ owner: 'a', repo: 'b', number: 542 }, { fetchImpl: withToken.impl, token: 'secret-token' });
    expect(withToken.calls[0].headers.authorization).toBe('Bearer secret-token');

    const without = fakeFetch({ '/files': { body: [] }, '/commits': { body: [] }, '/pulls/542': { body: pull } });
    await fetchPullRequest({ owner: 'a', repo: 'b', number: 542 }, { fetchImpl: without.impl });
    expect(without.calls[0].headers.authorization).toBeUndefined();
  });
});

describe('failures a reader can act on', () => {
  const expectKind = async (status: number, kind: string, headers: Record<string, string> = {}) => {
    const impl = (async () => ({ ok: false, status, headers: headersWith(headers), json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchPullRequest({ owner: 'a', repo: 'b', number: 1 }, { fetchImpl: impl })).rejects.toMatchObject({ kind });
  };

  it('says a private repository needs a token, not merely "not found"', async () => {
    await expectKind(404, 'not-found');
    const impl = (async () => ({ ok: false, status: 404, headers: headersWith({}), json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchPullRequest({ owner: 'a', repo: 'b', number: 1 }, { fetchImpl: impl })).rejects.toThrow(/private repository needs a GitHub token/);
  });

  it('explains the rate limit and how to raise it', async () => {
    const impl = (async () =>
      ({
        ok: false,
        status: 403,
        headers: headersWith({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1760000000' }),
        json: async () => ({}),
      }) as unknown as Response) as unknown as typeof fetch;
    const error = await fetchPullRequest({ owner: 'a', repo: 'b', number: 1 }, { fetchImpl: impl }).then(
      () => null,
      (caught: unknown) => caught as GitHubError,
    );
    expect(error?.kind).toBe('rate-limit');
    expect(error?.message).toContain('60 requests an hour');
    expect(error?.message).toContain('GITHUB_TOKEN');
  });

  it('distinguishes a rejected token from a missing one', async () => {
    await expectKind(401, 'auth');
  });

  it('reports a network failure as a network failure', async () => {
    const impl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    }) as unknown as typeof fetch;
    await expect(fetchPullRequest({ owner: 'a', repo: 'b', number: 1 }, { fetchImpl: impl })).rejects.toMatchObject({ kind: 'network' });
  });

  it('rejects a response that is not a pull request', async () => {
    const impl = (async () => ({ ok: true, status: 200, headers: headersWith({}), json: async () => ({ message: 'nope' }) }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchPullRequest({ owner: 'a', repo: 'b', number: 1 }, { fetchImpl: impl })).rejects.toMatchObject({ kind: 'bad-response' });
  });
});

describe('turning a pull request into a change', () => {
  const target = { owner: 'acme', repo: 'widgets' };
  const data = {
    number: 542,
    title: 'fix(ci): match release tags exactly',
    body: 'why',
    author: 'ada',
    state: 'open',
    merged: false,
    draft: false,
    baseRef: 'main',
    baseSha: 'base123',
    headRef: 'fix/tags',
    headSha: 'head456',
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    htmlUrl: 'https://github.com/acme/widgets/pull/542',
    patchlessFiles: 0,
    files: [],
    commits: [],
  };

  it('produces an ordinary change the rest of the pipeline already understands', () => {
    const change = pullRequestToChange(data, target);
    expect(change.kind).toBe('pr');
    expect(change.title).toBe('fix(ci): match release tags exactly');
    expect(change.base).toBe('base123');
    expect(change.head).toBe('head456');
    expect(change.url).toBe('https://github.com/acme/widgets/pull/542');
    expect(change.stats).toEqual({ files: 2, additions: 12, deletions: 3 });
    // The subtitle carries the things a reader needs to place it.
    expect(change.subtitle).toContain('acme/widgets#542');
    expect(change.subtitle).toContain('fix/tags → main');
  });

  it('gives the change a stable, filename-safe id, since it names the cache file', () => {
    const change = pullRequestToChange(data, target);
    expect(change.id).toBe('pr-acme-widgets-542');
    expect(change.id).toMatch(/^[A-Za-z0-9._-]+$/);
    // Same input, same id: the cache depends on it.
    expect(pullRequestToChange(data, target).id).toBe(change.id);
  });

  it('shows merged and draft state rather than a bare "open"', () => {
    expect(pullRequestToChange({ ...data, merged: true }, target).subtitle).toContain('merged');
    expect(pullRequestToChange({ ...data, draft: true }, target).subtitle).toContain('draft');
    expect(pullRequestToChange({ ...data, state: 'closed' }, target).subtitle).toContain('closed');
  });
});

describe('deciding which repository to ask about', () => {
  function repoWithRemote(url: string | null): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-explorer-pr-'));
    created.push(dir);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
    if (url) execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir, stdio: 'pipe' });
    return dir;
  }

  it('uses the origin remote of the repository being analysed', async () => {
    const dir = repoWithRemote('git@github.com:acme/widgets.git');
    expect(await resolvePullRequestTarget(dir, { number: 7 })).toEqual({ owner: 'acme', repo: 'widgets', number: 7 });
  });

  it('understands an https remote', async () => {
    const dir = repoWithRemote('https://github.com/acme/widgets.git');
    expect(await resolvePullRequestTarget(dir, { number: 7 })).toMatchObject({ owner: 'acme', repo: 'widgets' });
  });

  it('prefers explicitly given details, so another repository can be read', async () => {
    const dir = repoWithRemote('git@github.com:acme/widgets.git');
    expect(await resolvePullRequestTarget(dir, { number: 7, owner: 'other', repo: 'thing' })).toMatchObject({ owner: 'other', repo: 'thing' });
  });

  it('says there is no origin rather than failing obscurely', async () => {
    const dir = repoWithRemote(null);
    await expect(resolvePullRequestTarget(dir, { number: 7 })).rejects.toThrow(/no `origin` remote/);
  });

  it('rejects a number that is not a positive integer', async () => {
    const dir = repoWithRemote('git@github.com:acme/widgets.git');
    await expect(resolvePullRequestTarget(dir, { number: 0 })).rejects.toThrow(/positive integer/);
    await expect(resolvePullRequestTarget(dir, { number: Number.NaN })).rejects.toThrow(/positive integer/);
  });
});

describe('building a pull request change end to end', () => {
  it('resolves the target, fetches, and returns a change', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-explorer-pr-'));
    created.push(dir);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir, stdio: 'pipe' });

    const { impl, calls } = fakeFetch({ '/files': { body: files }, '/commits': { body: commits }, '/pulls/542': { body: pull } });
    const change = await buildPullRequestChange(dir, { number: 542 }, { fetchImpl: impl, token: 't' });
    expect(change.kind).toBe('pr');
    expect(change.id).toBe('pr-acme-widgets-542');
    expect(change.files).toHaveLength(3);
    // It asked the right repository, and nothing was written into the clone.
    expect(calls[0].url).toContain('/repos/acme/widgets/pulls/542');
    const refs = execFileSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: dir, encoding: 'utf8' }).trim();
    expect(refs).toBe('');
  });
});

describe('failures are reported with a status the client can act on', () => {
  it('does not report a missing remote as a server fault', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-explorer-pr-'));
    created.push(dir);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
    const error = await resolvePullRequestTarget(dir, { number: 1 }).then(
      () => null,
      (caught: unknown) => caught as GitHubError,
    );
    expect(error?.statusCode).toBe(400);
    expect(error?.kind).toBe('no-remote');
  });

  it('maps each kind to a sensible status', async () => {
    const cases: [number, number][] = [
      [404, 404],
      [401, 401],
      [403, 429],
    ];
    for (const [githubStatus, expected] of cases) {
      const impl = (async () => ({ ok: false, status: githubStatus, headers: headersWith({}), json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
      const error = await fetchPullRequest({ owner: 'a', repo: 'b', number: 1 }, { fetchImpl: impl }).then(
        () => null,
        (caught: unknown) => caught as GitHubError,
      );
      expect(error?.statusCode, `github ${githubStatus}`).toBe(expected);
    }
  });
});
