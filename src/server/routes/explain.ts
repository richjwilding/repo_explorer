import type { FastifyInstance } from 'fastify';
import type { ExplainerKind } from '../../core/types.js';
import type { RouteDeps } from './repos.js';
import { withSse } from '../sse.js';
import { explainerFor, pruneNext } from '../../core/explain/generate.js';
import { exportExplainer, type EmbeddedExplainer } from '../../core/explain/exportHtml.js';
import { stalenessFor } from '../../core/explain/staleness.js';
import { sanitiseSvg } from '../../core/explain/mermaidKey.js';

const KINDS: ExplainerKind[] = ['repo-overview', 'component', 'module', 'flow', 'change'];

/** How many deeper explainers a single export embeds by default. */
const DEFAULT_CHILD_EXPLAINERS = 3;

function parseKind(raw: unknown): ExplainerKind {
  const kind = String(raw ?? 'repo-overview') as ExplainerKind;
  if (!KINDS.includes(kind)) throw Object.assign(new Error(`Unknown explainer kind: ${raw}`), { statusCode: 400 });
  return kind;
}

export async function registerExplainRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { service, store, cfg } = deps;

  app.get('/api/repos/:repoId/explainers', async (request) => {
    const { repoId } = request.params as { repoId: string };
    const ctx = service.context(repoId);
    if (!ctx) return { explainers: [] };
    const listed = await store.listExplainers(ctx.model.repo.id);
    // Freshness is computed from one pass over the file stats, so listing stays cheap.
    const withFreshness = [];
    for (const entry of listed) {
      const explainer = await store.readExplainer(ctx.model.repo.id, entry.id);
      const staleness = explainer ? await stalenessFor(ctx, explainer) : null;
      withFreshness.push({ ...entry, stale: staleness?.stale ?? false, freshness: staleness?.summary ?? '' });
    }
    return { explainers: withFreshness };
  });

  /** Return a cached explainer without triggering generation. */
  app.get('/api/repos/:repoId/explainer', async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const query = request.query as { kind?: string; id?: string };
    const ctx = service.context(repoId);
    if (!ctx) {
      reply.code(404);
      return { error: 'Repository is not open.' };
    }
    const kind = parseKind(query.kind);
    const id = query.id ?? 'root';
    const explainer = await store.readExplainer(ctx.model.repo.id, `${kind}:${id}`);
    if (!explainer) {
      reply.code(404);
      return { error: 'No cached explainer for that target yet.', kind, id };
    }
    // Read paths must apply the same resolution rules as generation, otherwise a
    // cache written before those rules existed offers targets that fail on click.
    pruneNext(ctx, explainer);
    // Reported, never acted on: the reader decides whether to regenerate.
    const staleness = await stalenessFor(ctx, explainer);
    return { explainer, staleness };
  });

  /** Generate (or return cached) an explainer, streaming progress. */
  app.post('/api/repos/:repoId/explain', async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const body = (request.body ?? {}) as { kind?: string; id?: string; refresh?: boolean; staticOnly?: boolean };
    const ctx = service.context(repoId);
    if (!ctx) {
      reply.code(404);
      return { error: 'Repository is not open.' };
    }
    const kind = parseKind(body.kind);
    const id = body.id ?? 'root';

    await withSse(reply, async (emit) => {
      emit.send({ type: 'status', message: 'Preparing explainer' });
      // Agent steps are forwarded so the UI can show the investigation live.
      const explainer = await explainerFor(ctx, kind, id, {
        refresh: body.refresh,
        staticOnly: body.staticOnly,
        onStatus: (message) => emit.send({ type: 'status', message }),
        onStep: (step) => emit.send({ type: 'step', ...step }),
      });
      emit.send({ type: 'explainer', explainer, staleness: await stalenessFor(ctx, explainer) });
      emit.send({ type: 'done' });
    });
    return reply;
  });

  /**
   * Write a standalone HTML file outside the repository and return its path.
   *
   * By default this also generates the *next* explainers and embeds them in the
   * same file, so "Where to go next" actually takes the reader somewhere. Those
   * are served from cache when the reader has already drilled into them in the
   * app, which makes repeat exports instant.
   */
  app.post('/api/repos/:repoId/explain/export', async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const body = (request.body ?? {}) as {
      kind?: string;
      id?: string;
      refresh?: boolean;
      children?: number;
      /** Mermaid SVGs rendered by the browser, keyed by mermaidSvgKey(). */
      svgs?: Record<string, string>;
    };
    const ctx = service.context(repoId);
    if (!ctx) {
      reply.code(404);
      return { error: 'Repository is not open.' };
    }
    const kind = parseKind(body.kind);
    const id = body.id ?? 'root';
    const maxChildren = Math.max(0, Math.min(typeof body.children === 'number' ? body.children : DEFAULT_CHILD_EXPLAINERS, 8));

    await withSse(reply, async (emit) => {
      emit.send({ type: 'status', message: 'Preparing the explainer' });
      const explainer = await explainerFor(ctx, kind, id, {
        refresh: body.refresh,
        onStatus: (message) => emit.send({ type: 'status', message }),
        onStep: (step) => emit.send({ type: 'step', ...step }),
      });

      const embedded: EmbeddedExplainer[] = [];
      const skipped: string[] = [];
      const targets = explainer.next.slice(0, maxChildren);

      for (let index = 0; index < targets.length; index += 1) {
        const item = targets[index];
        emit.send({ type: 'status', message: `Going deeper: ${item.label} (${index + 1} of ${targets.length})` });
        const options = {
          onStatus: (message: string) => emit.send({ type: 'status', message: `${item.label} — ${message}` }),
          onStep: (step: unknown) => emit.send({ type: 'step', ...(step as Record<string, unknown>) }),
        };
        // Model-suggested targets carry a synthetic id; their label is the key.
        for (const key of [item.id, item.label]) {
          try {
            const child = await explainerFor(ctx, item.kind, key, options);
            embedded.push({ explainer: child, label: item.label });
            break;
          } catch {
            /* try the next key, then give up on this target */
          }
        }
        if (!embedded.some((entry) => entry.label === item.label)) skipped.push(item.label);
      }

      emit.send({ type: 'status', message: 'Writing the HTML file' });
      const svgs: Record<string, string> = {};
      for (const [key, value] of Object.entries(body.svgs ?? {})) {
        const clean = sanitiseSvg(value);
        if (clean) svgs[key] = clean;
      }
      const { filename, html } = exportExplainer(explainer, ctx.model, embedded, svgs);
      const written = await store.writeExport(filename, html);
      emit.send({
        type: 'done',
        ok: true,
        path: written,
        filename,
        exportDir: cfg.exportDir,
        title: explainer.title,
        included: embedded.map((entry) => entry.label ?? entry.explainer.title),
        skipped,
        sizeBytes: html.length,
      });
    });
    return reply;
  });
}
