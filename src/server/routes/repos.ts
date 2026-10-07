import type { FastifyInstance } from 'fastify';
import { configFilePath, type AppConfig } from '../../core/config.js';
import type { Store } from '../../core/store.js';
import type { RepoContext, RepoService } from '../../core/service.js';
import { toClientModel, toSymbolSummary, listDirectory } from '../clientModel.js';
import { suggestedQuestions } from '../../core/chat/chat.js';
import { buildFreshnessIndex, checkAnalysisStaleness } from '../../core/explain/staleness.js';
import { withSse } from '../sse.js';
import { listProviderStatuses } from '../../core/llm/registry.js';
import { readTextFileSync } from '../../core/util/fs.js';
import { languageForHighlight } from '../../core/analysis/languages.js';
import { listBranches, listCommits, runGit } from '../../core/util/git.js';
import path from 'node:path';

export interface RouteDeps {
  cfg: AppConfig;
  store: Store;
  service: RepoService;
}

function requireContext(deps: RouteDeps, repoId: string): RepoContext {
  const ctx = deps.service.context(repoId);
  if (!ctx) {
    const error = new Error(`Repository ${repoId} is not open. Open it first.`) as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }
  return ctx;
}

export async function registerRepoRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { service, cfg } = deps;

  app.get('/api/health', async () => ({
    ok: true,
    version: '0.1.0',
    dataDir: cfg.dataDir,
    exportDir: cfg.exportDir,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/api/providers', async () => ({ providers: await listProviderStatuses(cfg) }));

  app.post('/api/providers/select', async (request) => {
    const body = (request.body ?? {}) as { id?: string };
    await service.setProvider(body.id ?? null);
    const providers = await listProviderStatuses(cfg, { refresh: true });
    const active = providers.find((provider) => provider.id === (body.id ?? '')) ?? null;
    return { ok: true, providers, active };
  });

  /** Current settings, with secrets reduced to whether they are present. */
  app.get('/api/settings', async () => ({
    activeProviderId: await service.activeProviderId(),
    selectedProviderId: service.selectedProviderId(),
    secretStorage: service.secretStorageInfo(),
    settings: {
      provider: cfg.provider,
      model: cfg.model,
      openaiBaseUrl: cfg.openaiBaseUrl,
      ollamaUrl: cfg.ollamaUrl,
      ollamaNumCtx: cfg.ollamaNumCtx,
      credentials: service.credentialStates(),
    },
    configPath: configFilePath(cfg.home),
  }));

  /**
   * Apply model settings typed into the app. Secrets are written to
   * `~/.repo-explorer/config.json` and never echoed back.
   */
  app.post('/api/settings', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { shadowed, activeProviderId, selectedProviderId, secretsStored, secretStorage } = await service.configure(body);
    const providers = await listProviderStatuses(cfg, { refresh: true });
    // Report the provider actually selected, not merely the first available one.
    const active = providers.find((provider) => provider.id === activeProviderId) ?? null;
    return {
      ok: true,
      providers,
      active,
      activeProviderId,
      selectedProviderId,
      secretsStored,
      secretStorage,
      // Env vars beat the config file, so say so rather than looking broken.
      shadowed,
      settings: {
        provider: cfg.provider,
        model: cfg.model,
        openaiBaseUrl: cfg.openaiBaseUrl,
        ollamaUrl: cfg.ollamaUrl,
        ollamaNumCtx: cfg.ollamaNumCtx,
        credentials: service.credentialStates(),
      },
      configPath: configFilePath(cfg.home),
    };
  });

  app.get('/api/repos', async () => ({ repos: await service.listRepos() }));

  app.delete('/api/repos/:repoId', async (request) => {
    const { repoId } = request.params as { repoId: string };
    await service.forget(repoId);
    return { ok: true };
  });

  /** Open (analyse or re-hydrate) a repository, streaming progress. */
  app.post('/api/repos/open', async (request, reply) => {
    const body = (request.body ?? {}) as { path?: string; force?: boolean; repoId?: string };
    const target = body.path ?? body.repoId;
    if (!target) {
      reply.code(400);
      return { error: 'Provide a "path" (or "repoId") to open.' };
    }

    await withSse(reply, async (emit) => {
      emit.send({ type: 'status', message: 'Reading repository', pct: 1 });
      const ctx = await service.open(target, {
        force: body.force,
        onProgress: (message, pct) => emit.send({ type: 'progress', message, pct }),
      });
      emit.send({ type: 'model', repo: ctx.model.repo, model: toClientModel(ctx.model), providerId: ctx.providerId, modelName: ctx.modelName });
      emit.send({ type: 'done', repoId: ctx.model.repo.id });
    });
    return reply;
  });

  app.post('/api/repos/:repoId/analyze', async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const ctx = requireContext(deps, repoId);
    await withSse(reply, async (emit) => {
      const model = await service.analyze(ctx.root, {
        force: true,
        onProgress: (message, pct) => emit.send({ type: 'progress', message, pct }),
      });
      emit.send({ type: 'model', repo: model.repo, model: toClientModel(model) });
      emit.send({ type: 'done', repoId: model.repo.id });
    });
    return reply;
  });

  app.get('/api/repos/:repoId/model', async (request) => {
    const { repoId } = request.params as { repoId: string };
    const ctx = requireContext(deps, repoId);
    // `stale` covers HEAD moving; `analysis` covers working-tree edits, which do
    // not move HEAD and would otherwise go unnoticed.
    const index = await buildFreshnessIndex(ctx);
    return {
      repo: ctx.model.repo,
      model: toClientModel(ctx.model),
      providerId: ctx.providerId,
      modelName: ctx.modelName,
      stale: await service.isStale(ctx),
      analysis: await checkAnalysisStaleness(ctx, index),
    };
  });

  app.get('/api/repos/:repoId/files', async (request) => {
    const { repoId } = request.params as { repoId: string };
    const query = request.query as { path?: string };
    const ctx = requireContext(deps, repoId);
    const dir = (query.path ?? '').replace(/^\/+|\/+$/g, '');
    return { path: dir, entries: listDirectory(ctx.model, dir) };
  });

  app.get('/api/repos/:repoId/file', async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const query = request.query as { path?: string };
    const ctx = requireContext(deps, repoId);
    if (!query.path) {
      reply.code(400);
      return { error: 'A "path" query parameter is required.' };
    }
    const normalised = query.path.replace(/^\.\//, '');
    const resolved = path.resolve(ctx.root, normalised);
    if (!resolved.startsWith(path.resolve(ctx.root))) {
      reply.code(403);
      return { error: 'Path escapes the repository root.' };
    }
    const content = readTextFileSync(resolved, 800_000);
    if (content === null) {
      reply.code(404);
      return { error: 'File not found, binary, or unreadable.' };
    }
    const entry = ctx.model.files.find((f) => f.path === normalised);
    const chunks = ctx.index.chunksForFile(normalised).map((chunk) => ({
      id: chunk.id,
      symbol: chunk.symbol,
      kind: chunk.kind,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    }));
    return {
      path: normalised,
      language: languageForHighlight(normalised),
      url: `https://github.com/${ctx.model.repo.slug ?? ''}`,
      content,
      lines: content.split('\n').length,
      fileLines: entry?.lines ?? content.split('\n').length,
      symbols: entry?.symbols ?? [],
      chunks,
    };
  });

  app.get('/api/repos/:repoId/search', async (request) => {
    const { repoId } = request.params as { repoId: string };
    const query = request.query as { q?: string; limit?: string };
    const ctx = requireContext(deps, repoId);
    const q = (query.q ?? '').trim();
    if (q.length < 2) return { query: q, hits: [] };
    const limit = Math.min(Number.parseInt(query.limit ?? '20', 10) || 20, 50);
    const hits = ctx.index.search(q, limit).map((hit) => ({
      path: hit.chunk.path,
      symbol: hit.chunk.symbol,
      kind: hit.chunk.kind,
      startLine: hit.chunk.startLine,
      endLine: hit.chunk.endLine,
      score: hit.score,
      preview: hit.chunk.text.split('\n').slice(0, 4).join('\n'),
    }));
    return { query: q, hits };
  });

  app.get('/api/repos/:repoId/suggestions', async (request) => {
    const { repoId } = request.params as { repoId: string };
    const ctx = requireContext(deps, repoId);
    return { suggestions: suggestedQuestions(ctx) };
  });

  /** Symbol search, used by the file explorer's "jump to symbol" box. */
  app.get('/api/repos/:repoId/symbols', async (request) => {
    const { repoId } = request.params as { repoId: string };
    const query = request.query as { q?: string; path?: string; limit?: string };
    const ctx = requireContext(deps, repoId);
    const limit = Math.min(Number.parseInt(query.limit ?? '40', 10) || 40, 200);
    const needle = (query.q ?? '').trim().toLowerCase();
    let candidates = ctx.model.symbols;
    if (query.path) candidates = candidates.filter((symbol) => symbol.path === query.path);
    if (needle) {
      candidates = candidates.filter(
        (symbol) =>
          symbol.name.toLowerCase().includes(needle) ||
          (symbol.container ?? '').toLowerCase().includes(needle) ||
          symbol.path.toLowerCase().includes(needle),
      );
    }
    return {
      symbols: candidates
        .slice()
        .sort((a, b) => b.callerCount - a.callerCount || b.loc - a.loc)
        .slice(0, limit)
        .map(toSymbolSummary),
    };
  });

  app.get('/api/repos/:repoId/symbol', async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const query = request.query as { id?: string };
    const ctx = requireContext(deps, repoId);
    if (!query.id) {
      reply.code(400);
      return { error: 'An "id" query parameter is required.' };
    }
    const symbol = ctx.model.symbols.find((candidate) => candidate.id === query.id);
    if (!symbol) {
      reply.code(404);
      return { error: 'No such symbol.' };
    }
    const byId = new Map(ctx.model.symbols.map((candidate) => [candidate.id, candidate]));
    const callers = ctx.model.calls
      .filter((call) => call.to === symbol.id)
      .slice(0, 60)
      .map((call) => {
        const caller = byId.get(call.from);
        return { name: caller?.name ?? call.from, path: call.fromPath, line: call.fromLine, container: caller?.container ?? null };
      });
    const callees = ctx.model.calls
      .filter((call) => call.from === symbol.id)
      .slice(0, 60)
      .map((call) => {
        const target = call.to ? byId.get(call.to) : undefined;
        return { name: call.toName, path: target?.path ?? call.toPath, line: target?.line ?? null, external: !call.to };
      });
    return { symbol: { ...toSymbolSummary(symbol), callers, callees } };
  });

  app.get('/api/repos/:repoId/history', async (request) => {
    const { repoId } = request.params as { repoId: string };
    const query = request.query as { limit?: string };
    const ctx = requireContext(deps, repoId);
    const limit = Math.min(Number.parseInt(query.limit ?? '50', 10) || 50, 200);
    const [commits, branches] = await Promise.all([listCommits(ctx.root, { limit }), listBranches(ctx.root)]);

    // An empty list means four different things, and telling them apart is the
    // difference between "nothing here yet" and "this is broken".
    let reason: 'ok' | 'not-a-repo' | 'no-commits' | 'unreadable' = 'ok';
    let detail: string | null = null;
    if (!ctx.model.git.isRepo) {
      reason = 'not-a-repo';
    } else if (commits.length === 0) {
      const probe = await runGit(['log', '-1', '--format=%H'], ctx.root, { timeoutMs: 10_000 });
      if (probe.code === 0 && probe.stdout.trim()) {
        reason = 'unreadable';
        detail = probe.stderr.trim() || 'git log returned no commits even though HEAD resolves.';
      } else if (/does not have any commits|unknown revision|bad revision/i.test(probe.stderr)) {
        reason = 'no-commits';
      } else {
        reason = 'unreadable';
        detail = probe.stderr.trim() || null;
      }
    }

    return { commits, branches, git: ctx.model.git, reason, detail };
  });
}
