import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server/index.js';
import { MockProvider } from '../src/core/llm/mock.js';
import { createFixtureRepo, createTempHome, type FixtureRepo } from './helpers/fixtureRepo.js';

let fixture: FixtureRepo;
let server: RunningServer;
let repoId = '';
let cleanupHome: () => void;
let exportDir = '';
let homeDir = '';

/** Collect a Server-Sent Events response into an array of parsed events. */
async function collectSse(url: string, body: unknown): Promise<Record<string, unknown>[]> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const text = await response.text();
  const events: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    events.push(JSON.parse(payload) as Record<string, unknown>);
  }
  return events;
}

async function getJson<T>(pathname: string): Promise<T> {
  const response = await fetch(`${server.url}${pathname}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/**
 * Credentials the developer's shell happens to export.
 *
 * A test asserting "no credential is configured" can only mean that if the
 * environment has none — and `credentialSource` reads `process.env` directly, so
 * a key exported in a terminal made this fail for reasons that had nothing to do
 * with the code under test. Cleared here and put back afterwards.
 */
const SAVED_ENV: Record<string, string | undefined> = {};
const CREDENTIAL_ENV_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'REPO_EXPLORER_OPENAI_API_KEY',
  'REPO_EXPLORER_ANTHROPIC_API_KEY',
  'REPO_EXPLORER_GITHUB_TOKEN',
];

beforeAll(async () => {
  process.env.REPO_EXPLORER_LOG = 'silent';
  // Hermetic: never pick up a .env that happens to sit in the project directory.
  process.env.REPO_EXPLORER_DOTENV = '0';
  for (const name of CREDENTIAL_ENV_VARS) {
    SAVED_ENV[name] = process.env[name];
    delete process.env[name];
  }
  fixture = createFixtureRepo();
  const temp = createTempHome();
  homeDir = temp.home;
  cleanupHome = temp.cleanup;
  exportDir = `${temp.home}/exports`;
  server = await startServer({
    config: {
      port: 0,
      host: '127.0.0.1',
      home: temp.home,
      dataDir: `${temp.home}/data`,
      cacheDir: `${temp.home}/cache`,
      exportDir,
      provider: 'mock',
      openBrowser: false,
      ollamaUrl: 'http://127.0.0.1:9',
      openaiBaseUrl: 'http://127.0.0.1:9/v1',
      openaiApiKey: null,
      anthropicApiKey: null,
    },
    logger: true,
  });
}, 90_000);

afterAll(async () => {
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await server?.close();
  fixture?.cleanup();
  cleanupHome?.();
});

describe('server API', () => {
  it('reports health and provider status', async () => {
    const health = await getJson<{ ok: boolean }>('/api/health');
    expect(health.ok).toBe(true);

    const providers = await getJson<{ providers: { id: string; available: boolean }[] }>('/api/providers');
    expect(providers.providers.some((provider) => provider.id === 'mock' && provider.available)).toBe(true);
  }, 30_000);

  it('opens a repository and streams progress, model and completion', async () => {
    const events = await collectSse(`${server.url}/api/repos/open`, { path: fixture.root, force: true });
    const progress = events.filter((event) => event.type === 'progress');
    expect(progress.length).toBeGreaterThan(3);
    expect(Number(progress[0].pct)).toBeLessThan(Number((progress[progress.length - 1] as { pct: number }).pct));

    const modelEvent = events.find((event) => event.type === 'model');
    expect(modelEvent).toBeDefined();
    const model = modelEvent?.model as { components: { name: string }[]; routes: unknown[] };
    expect(model.components.length).toBeGreaterThan(0);
    expect(model.routes.length).toBeGreaterThan(0);

    repoId = String((events.find((event) => event.type === 'done') as { repoId: string }).repoId);
    expect(repoId).toBeTruthy();
    expect(events.some((event) => event.type === 'done')).toBe(true);
  }, 60_000);

  it('serves the client model with heavy fields stripped', async () => {
    const data = await getJson<{ model: Record<string, unknown>; repo: { name: string } }>(`/api/repos/${repoId}/model`);
    expect(data.model.symbols).toBeUndefined();
    expect(data.model.calls).toBeUndefined();
    expect(data.model.files).toBeUndefined();
    expect(Array.isArray(data.model.components)).toBe(true);
    expect((data.model.components as { fileCount: number }[])[0].fileCount).toBeGreaterThan(0);
  }, 30_000);

  it('lists directories, reads files and rejects path escapes', async () => {
    const listing = await getJson<{ entries: { name: string; type: string }[] }>(`/api/repos/${repoId}/files?path=apps/api/src`);
    expect(listing.entries.some((entry) => entry.name === 'normalise.ts')).toBe(true);

    const file = await getJson<{ content: string; language: string; symbols: { name: string }[] }>(
      `/api/repos/${repoId}/file?path=${encodeURIComponent('apps/api/src/normalise.ts')}`,
    );
    expect(file.content).toContain('normaliseDocument');
    expect(file.symbols.length).toBeGreaterThan(0);

    const escape = await fetch(`${server.url}/api/repos/${repoId}/file?path=${encodeURIComponent('../../etc/passwd')}`);
    expect(escape.status).toBe(403);
  }, 30_000);

  it('searches symbols and text', async () => {
    const symbols = await getJson<{ symbols: { id: string; name: string; callerCount: number }[] }>(`/api/repos/${repoId}/symbols?q=normalise`);
    expect(symbols.symbols.some((symbol) => symbol.name === 'normaliseDocument')).toBe(true);

    const search = await getJson<{ hits: { path: string }[] }>(`/api/repos/${repoId}/search?q=slugify`);
    expect(search.hits.length).toBeGreaterThan(0);

    const target = symbols.symbols.find((symbol) => symbol.name === 'normaliseDocument');
    expect(target).toBeDefined();
    const detail = await getJson<{ symbol: { name: string; callers: unknown[] } }>(
      `/api/repos/${repoId}/symbol?id=${encodeURIComponent(target?.id ?? '')}`,
    );
    expect(detail.symbol.name).toBe('normaliseDocument');
    expect(Array.isArray(detail.symbol.callers)).toBe(true);
  }, 30_000);

  it('returns starter questions', async () => {
    const data = await getJson<{ suggestions: string[] }>(`/api/repos/${repoId}/suggestions`);
    expect(data.suggestions.length).toBeGreaterThan(2);
  }, 30_000);

  it('generates and exports an explainer', async () => {
    const events = await collectSse(`${server.url}/api/repos/${repoId}/explain`, {
      kind: 'repo-overview',
      id: 'root',
      staticOnly: true,
    });
    const explainerEvent = events.find((event) => event.type === 'explainer');
    expect(explainerEvent).toBeDefined();
    const explainer = explainerEvent?.explainer as { title: string; sections: unknown[]; degraded: boolean };
    expect(explainer.sections.length).toBeGreaterThan(1);
    expect(explainer.degraded).toBe(true);

    // The cached explainer can be fetched without regenerating.
    const cached = await getJson<{ explainer: { title: string } }>(
      `/api/repos/${repoId}/explainer?kind=repo-overview&id=root`,
    );
    expect(cached.explainer.title).toBe(explainer.title);

    const exportEvents = await collectSse(`${server.url}/api/repos/${repoId}/explain/export`, {
      kind: 'repo-overview',
      id: 'root',
      children: 0,
    });
    const exported = exportEvents.find((event) => event.type === 'done') as {
      path: string;
      filename: string;
      included: string[];
    };
    expect(exported.filename).toMatch(/^\d{4}-\d{2}-\d{2}-explanation-/);
    expect(fs.existsSync(exported.path)).toBe(true);
    expect(exported.path.startsWith(exportDir)).toBe(true);
    expect(exported.included).toEqual([]);
    const html = fs.readFileSync(exported.path, 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('white-space: pre-wrap');
  }, 60_000);

  it('exports the deeper explainers inside the same file so the links work', async () => {
    const ctx = server.service.context(repoId);
    if (!ctx) return;

    const cached = await getJson<{ explainer: { next: { id: string; label: string; kind: string }[] } }>(
      `/api/repos/${repoId}/explainer?kind=repo-overview&id=root`,
    );
    expect(cached.explainer.next.length).toBeGreaterThan(0);

    const events = await collectSse(`${server.url}/api/repos/${repoId}/explain/export`, {
      kind: 'repo-overview',
      id: 'root',
      children: 2,
    });
    const done = events.find((event) => event.type === 'done') as {
      path: string;
      included: string[];
      skipped: string[];
    };
    expect(done.included.length).toBeGreaterThan(0);
    expect(done.included.length + done.skipped.length).toBeLessThanOrEqual(2);

    const html = fs.readFileSync(done.path, 'utf8');
    // The navigation is now real anchors, and the targets exist in the file.
    expect(html).toContain('class="next-link" href="#go-0"');
    expect(html).toContain('id="go-0"');
    expect(html).toContain('class="child"');
    expect(html).toContain('Back to the top');
    // Section ids must not collide between the parent and its children.
    expect(html).toContain('id="go-0-s1"');
  }, 120_000);

  it('streams live agent steps while generating an explainer', async () => {
    const ctx = server.service.context(repoId);
    expect(ctx).toBeDefined();
    if (!ctx) return;

    const original = { provider: ctx.provider, providerId: ctx.providerId, modelName: ctx.modelName };
    const replies = [
      JSON.stringify({ thought: 'Endpoints first.', tool: 'list_routes', args: {} }),
      JSON.stringify({ thought: 'Entrypoints next.', tool: 'list_entrypoints', args: {} }),
      JSON.stringify({ thought: 'Read the routes.', tool: 'read_file', args: { path: 'apps/api/src/routes.ts' } }),
      JSON.stringify({
        final: {
          title: 'Streamed explainer',
          subtitle: 'from a scripted provider',
          tldr: 'Documents flow from the API into Postgres.',
          sections: [
            { type: 'prose', title: 'What it does', markdown: 'It ingests documents.', level: 'narrow' },
            { type: 'prose', title: 'Background', markdown: 'Document ingestion.', level: 'deep' },
            { type: 'diagram', title: 'Flow', diagram: { kind: 'flow', nodes: [{ id: 'a', label: 'API' }, { id: 'b', label: 'DB' }], edges: [{ from: 'a', to: 'b' }] } },
            { type: 'list', title: 'Components', items: [{ term: 'api', detail: 'HTTP service.' }] },
            { type: 'callout', title: 'Edges', variant: 'edge', markdown: 'No retries.' },
          ],
          quiz: [{ question: 'Where do documents go?', options: ['Postgres', 'S3'], answer: 0, explanation: 'createPool uses pg.' }],
          next: [],
          sources: [],
        },
      }),
    ];
    const queue = [...replies];
    ctx.provider = new MockProvider(() => queue.shift() ?? '{}', { id: 'scripted', label: 'Scripted' });
    ctx.providerId = 'scripted';
    ctx.modelName = 'scripted-1';

    try {
      const events = await collectSse(`${server.url}/api/repos/${repoId}/explain`, {
        kind: 'repo-overview',
        id: 'root',
        refresh: true,
      });
      const steps = events.filter((event) => event.type === 'step');
      expect(steps.length).toBeGreaterThanOrEqual(3);
      expect(steps.map((step) => step.tool)).toEqual(['list_routes', 'list_entrypoints', 'read_file']);
      expect(String(steps[0].summary)).toContain('list_routes');
      const explainer = events.find((event) => event.type === 'explainer')?.explainer as { title: string; provider: string };
      expect(explainer.title).toBe('Streamed explainer');
      expect(explainer.provider).toBe('scripted');
    } finally {
      ctx.provider = original.provider;
      ctx.providerId = original.providerId;
      ctx.modelName = original.modelName;
    }
  }, 60_000);

  it('streams a chat answer with citations and persists the session', async () => {
    const events = await collectSse(`${server.url}/api/repos/${repoId}/chat`, {
      question: 'How does a document get from the API into the database?',
    });
    const tokens = events.filter((event) => event.type === 'token');
    expect(tokens.length).toBeGreaterThan(0);
    const done = events.find((event) => event.type === 'done');
    expect(done).toBeDefined();

    const chats = await getJson<{ chats: { id: string; title: string; turns: number }[] }>(`/api/repos/${repoId}/chats`);
    expect(chats.chats.length).toBeGreaterThan(0);
    expect(chats.chats[0].turns).toBeGreaterThanOrEqual(2);

    const session = await getJson<{ chat: { turns: { role: string; content: string }[] } }>(
      `/api/repos/${repoId}/chat?id=${encodeURIComponent(chats.chats[0].id)}`,
    );
    expect(session.chat.turns[0].role).toBe('user');
    expect(session.chat.turns[1].role).toBe('assistant');
  }, 60_000);

  it('always sends something in a chat stream, even when the model returns nothing', async () => {
    const ctx = server.service.context(repoId);
    expect(ctx).toBeDefined();
    if (!ctx) return;

    const original = { provider: ctx.provider, providerId: ctx.providerId, modelName: ctx.modelName };
    // A provider that produces no output at all: the case that left the UI
    // showing "thinking" forever.
    const silent = {
      id: 'silent',
      label: 'Silent',
      local: true,
      status: async () => ({ id: 'silent', label: 'Silent', available: true, detail: '', models: ['silent'], local: true }),
      complete: async () => ({ text: '', model: 'silent', provider: 'silent' }),
      stream: async function* () {
        /* yields nothing */
      },
    };
    ctx.provider = silent as never;
    ctx.providerId = 'silent';
    ctx.modelName = 'silent';

    try {
      const events = await collectSse(`${server.url}/api/repos/${repoId}/chat`, { question: 'What does retrieval do?' });
      const tokens = events.filter((event) => event.type === 'token');
      expect(tokens.length).toBeGreaterThan(0);
      const text = tokens.map((event) => String(event.delta)).join('');
      expect(text).toMatch(/could not get an answer|empty answer/i);
      expect(events.some((event) => event.type === 'done')).toBe(true);
    } finally {
      ctx.provider = original.provider;
      ctx.providerId = original.providerId;
      ctx.modelName = original.modelName;
    }
  }, 60_000);

  it('serves a cached explainer without regenerating it', async () => {
    // The UI relies on this on open, so the reader is not asked to generate an
    // explainer that already exists.
    const response = await fetch(`${server.url}/api/repos/${repoId}/explainer?kind=repo-overview&id=root`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { explainer: { title: string; kind: string } };
    expect(body.explainer.kind).toBe('repo-overview');
    expect(body.explainer.title.length).toBeGreaterThan(0);
  }, 30_000);

  it('lists history and explains a commit', async () => {
    if (!fixture.hasGit) return;
    const history = await getJson<{ commits: { sha: string; subject: string }[]; branches: unknown[] }>(
      `/api/repos/${repoId}/history?limit=5`,
    );
    expect(history.commits.length).toBeGreaterThan(0);

    const events = await collectSse(`${server.url}/api/repos/${repoId}/change/explain`, {
      kind: 'commit',
      sha: history.commits[0].sha,
      staticOnly: true,
    });
    const change = events.find((event) => event.type === 'change')?.change as { files: unknown[]; stats: { additions: number } };
    expect(change.files.length).toBeGreaterThan(0);
    expect(change.stats.additions).toBeGreaterThan(0);

    const explainer = events.find((event) => event.type === 'explainer')?.explainer as { kind: string; sections: unknown[] };
    expect(explainer.kind).toBe('change');
    expect(explainer.sections.length).toBeGreaterThan(0);
  }, 60_000);

  it('compares a branch against the base it was asked for, and says so when they are the same', async () => {
    if (!fixture.hasGit) return;
    const history = await getJson<{ branches: { name: string; current: boolean }[] }>(`/api/repos/${repoId}/history?limit=5`);
    const current = history.branches.find((branch) => branch.current)?.name;
    if (!current) return;

    // A branch compared with itself is the degenerate case that used to reach the
    // model and come back as an explainer about nothing.
    const response = await fetch(`${server.url}/api/repos/${repoId}/change`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'branch', branch: current, base: current }),
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as {
      change: { files: unknown[]; subtitle?: string; compare?: { mode: string; baseRef: string; note?: string } };
    };
    expect(body.change.files).toEqual([]);
    expect(body.change.compare?.baseRef).toBe(current);
    expect(body.change.subtitle).toContain('Same commit');
    expect(body.change.compare?.note).toContain('point at the same commit');
  }, 60_000);

  it('explains an empty comparison without asking the model', async () => {
    if (!fixture.hasGit) return;
    const history = await getJson<{ branches: { name: string; current: boolean }[] }>(`/api/repos/${repoId}/history?limit=5`);
    const current = history.branches.find((branch) => branch.current)?.name;
    if (!current) return;

    const events = await collectSse(`${server.url}/api/repos/${repoId}/change/explain`, {
      kind: 'branch',
      branch: current,
      base: current,
    });
    const explainer = events.find((event) => event.type === 'explainer')?.explainer as {
      tldr: string;
      model: string;
      sections: { type: string }[];
    };
    expect(explainer.model).toBe('static-analysis');
    expect(explainer.tldr).toContain('point at the same commit');
    expect(explainer.sections.some((section) => section.type === 'callout')).toBe(true);
  }, 60_000);

  it('rejects an unknown branch comparison mode', async () => {
    const response = await fetch(`${server.url}/api/repos/${repoId}/change`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'branch', branch: 'main', compare: 'sideways' }),
    });
    expect(response.status).toBe(400);
  }, 30_000);

  it('writes credentials to .env, never to config.json, and never echoes them', async () => {
    const before = await getJson<{ settings: { credentials: { openai: string } }; configPath: string }>('/api/settings');
    expect(before.settings.credentials.openai).toBe('none');
    expect(before.configPath).toContain('config.json');

    const secret = 'sk-this-must-not-be-returned';
    const response = await fetch(`${server.url}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        openaiBaseUrl: 'http://127.0.0.1:9/v1',
        openaiApiKey: secret,
        model: 'test-model',
      }),
    });
    expect(response.ok).toBe(true);
    const raw = await response.text();
    expect(raw).not.toContain(secret);

    const after = JSON.parse(raw) as {
      activeProviderId: string;
      selectedProviderId: string;
      secretsStored: Record<string, string>;
      settings: { credentials: { openai: string }; model: string | null; openaiBaseUrl: string };
      configPath: string;
    };
    expect(after.selectedProviderId).toBe('openai');
    expect(after.activeProviderId).toBe('mock');
    expect(after.settings.openaiBaseUrl).toBe('http://127.0.0.1:9/v1');
    expect(after.settings.credentials.openai).toBe('dotenv');
    expect(after.secretsStored.openaiApiKey).toBe('dotenv');

    // The secret lives in .env with private permissions...
    const envFile = `${homeDir}/.env`;
    expect(fs.existsSync(envFile)).toBe(true);
    expect(fs.readFileSync(envFile, 'utf8')).toContain(secret);
    expect(fs.statSync(envFile).mode & 0o077).toBe(0);

    // ...and never in config.json.
    const configFile = JSON.parse(fs.readFileSync(after.configPath, 'utf8')) as Record<string, unknown>;
    expect(configFile.openaiApiKey).toBeUndefined();
    expect(configFile.provider).toBe('openai');
    expect(configFile.model).toBe('test-model');
    expect(fs.statSync(after.configPath).mode & 0o077).toBe(0);

    // Clearing a value removes the line rather than leaving an empty key.
    const cleared = await fetch(`${server.url}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'mock', openaiApiKey: '' }),
    }).then((result) => result.json() as Promise<{ selectedProviderId: string; settings: { credentials: { openai: string } } }>);
    expect(cleared.selectedProviderId).toBe('mock');
    expect(cleared.settings.credentials.openai).toBe('none');
    expect(fs.readFileSync(envFile, 'utf8')).not.toContain(secret);
  }, 60_000);

  it('says why there is no history, rather than showing an empty list', async () => {
    // Not a git repository at all.
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-explorer-nogit-'));
    fs.writeFileSync(path.join(plain, 'index.ts'), 'export const x = 1;\n');
    try {
      const opened = await collectSse(`${server.url}/api/repos/open`, { path: plain, force: true });
      const plainId = String((opened.find((event) => event.type === 'done') as { repoId: string }).repoId);
      const history = await getJson<{ commits: unknown[]; reason: string }>(`/api/repos/${plainId}/history`);
      expect(history.commits).toEqual([]);
      expect(history.reason).toBe('not-a-repo');
      await fetch(`${server.url}/api/repos/${plainId}`, { method: 'DELETE' });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }

    // A git repository with no commits yet.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-explorer-freshgit-'));
    fs.writeFileSync(path.join(fresh, 'index.ts'), 'export const x = 1;\n');
    try {
      execFileSync('git', ['init', '-q'], { cwd: fresh, stdio: 'pipe' });
      const opened = await collectSse(`${server.url}/api/repos/open`, { path: fresh, force: true });
      const freshId = String((opened.find((event) => event.type === 'done') as { repoId: string }).repoId);
      const history = await getJson<{ commits: unknown[]; reason: string }>(`/api/repos/${freshId}/history`);
      expect(history.reason).toBe('no-commits');
      await fetch(`${server.url}/api/repos/${freshId}`, { method: 'DELETE' });
    } catch {
      /* git unavailable in this environment */
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }

    // The fixture is a real repository, so its history reads normally.
    const real = await getJson<{ commits: unknown[]; reason: string }>(`/api/repos/${repoId}/history`);
    expect(real.reason).toBe('ok');
    expect(real.commits.length).toBeGreaterThan(0);
  }, 120_000);

  it('returns 404 for a repository that is not open', async () => {
    const response = await fetch(`${server.url}/api/repos/not-a-real-repo/model`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not open');
  }, 30_000);

  it('rejects a bad change spec with a 400', async () => {
    const response = await fetch(`${server.url}/api/repos/${repoId}/change`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'commit' }),
    });
    expect(response.status).toBe(400);
  }, 30_000);

  it('forgets a repository on request', async () => {
    const response = await fetch(`${server.url}/api/repos/${repoId}`, { method: 'DELETE' });
    expect(response.ok).toBe(true);
    const listing = await getJson<{ repos: { repo: { id: string } }[] }>('/api/repos');
    expect(listing.repos.some((record) => record.repo.id === repoId)).toBe(false);
  }, 30_000);
});
