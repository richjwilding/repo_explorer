import type { FastifyInstance } from 'fastify';
import type { Change, ChangeFile } from '../../core/types.js';
import type { ChangeSpec } from '../../core/util/git.js';
import type { RouteDeps } from './repos.js';
import { withSse } from '../sse.js';
import { changeExplainer } from '../../core/explain/generate.js';

/** Keep responses bounded: large diffs are truncated per file and in total. */
function trimChange(change: Change, maxTotalPatchChars = 3_000_000): Change {
  let used = 0;
  const files: ChangeFile[] = change.files.map((file) => {
    if (!file.patch) return file;
    if (used >= maxTotalPatchChars) return { ...file, patch: '… [patch omitted for size — open the file in your editor]' };
    const remaining = maxTotalPatchChars - used;
    if (file.patch.length <= remaining) {
      used += file.patch.length;
      return file;
    }
    const patch = `${file.patch.slice(0, remaining)}\n… [patch truncated]`;
    used = maxTotalPatchChars;
    return { ...file, patch };
  });
  return { ...change, files };
}

function parseSpec(body: Record<string, unknown>): ChangeSpec {
  const kind = String(body.kind ?? 'commit');
  if (kind === 'working') return { kind: 'working' };
  if (kind === 'commit') {
    if (!body.sha) throw Object.assign(new Error('kind=commit requires "sha"'), { statusCode: 400 });
    return { kind: 'commit', sha: String(body.sha) };
  }
  if (kind === 'range') {
    if (!body.base || !body.head) throw Object.assign(new Error('kind=range requires "base" and "head"'), { statusCode: 400 });
    return { kind: 'range', base: String(body.base), head: String(body.head), label: body.label ? String(body.label) : undefined };
  }
  if (kind === 'branch') {
    if (!body.branch) throw Object.assign(new Error('kind=branch requires "branch"'), { statusCode: 400 });
    return { kind: 'branch', branch: String(body.branch), base: body.base ? String(body.base) : undefined };
  }
  throw Object.assign(new Error(`Unknown change kind: ${kind}`), { statusCode: 400 });
}

export async function registerChangeRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { service, store } = deps;

  /** Build (or fetch cached) a change and return it, diff included. */
  app.post('/api/repos/:repoId/change', async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const ctx = service.context(repoId);
    if (!ctx) {
      reply.code(404);
      return { error: 'Repository is not open.' };
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const spec = parseSpec(body);
    const change = await service.change(ctx, spec, { refresh: Boolean(body.refresh) });
    return { change: trimChange(change) };
  });

  /** Load a change and immediately stream its explainer. */
  app.post('/api/repos/:repoId/change/explain', async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const ctx = service.context(repoId);
    if (!ctx) {
      reply.code(404);
      return { error: 'Repository is not open.' };
    }

    await withSse(reply, async (emit) => {
      emit.send({ type: 'status', message: 'Loading the change' });
      const spec = parseSpec(body);
      const change = await service.change(ctx, spec, { refresh: Boolean(body.refresh) });
      emit.send({ type: 'change', change: trimChange(change) });
      emit.send({ type: 'status', message: 'Reading the surrounding code' });
      const explainer = await changeExplainer(ctx, change, {
        refresh: Boolean(body.refresh),
        staticOnly: Boolean(body.staticOnly),
        onStatus: (message) => emit.send({ type: 'status', message }),
        onStep: (step) => emit.send({ type: 'step', ...step }),
      });
      emit.send({ type: 'explainer', explainer });
      emit.send({ type: 'done' });
    });
    return reply;
  });

  app.get('/api/repos/:repoId/change', async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const query = request.query as { id?: string };
    const ctx = service.context(repoId);
    if (!ctx || !query.id) {
      reply.code(404);
      return { error: 'Repository is not open, or no id was provided.' };
    }
    const change = await store.readChange(ctx.model.repo.id, query.id);
    if (!change) {
      reply.code(404);
      return { error: 'No cached change with that id.' };
    }
    return { change: trimChange(change) };
  });
}
