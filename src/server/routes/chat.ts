import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './repos.js';
import { withSse } from '../sse.js';
import { askRepo, suggestedQuestions } from '../../core/chat/chat.js';

export async function registerChatRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { service, store } = deps;

  app.get('/api/repos/:repoId/chats', async (request) => {
    const { repoId } = request.params as { repoId: string };
    const ctx = service.context(repoId);
    if (!ctx) return { chats: [] };
    const sessions = await store.listChats(ctx.model.repo.id);
    return {
      chats: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        turns: session.turns.length,
        preview: session.turns.find((t) => t.role === 'assistant')?.content.slice(0, 160) ?? '',
      })),
    };
  });

  app.get('/api/repos/:repoId/chat', async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const query = request.query as { id?: string };
    const ctx = service.context(repoId);
    if (!ctx) {
      reply.code(404);
      return { error: 'Repository is not open.' };
    }
    if (query.id) {
      const session = await store.readChat(ctx.model.repo.id, query.id);
      if (!session) {
        reply.code(404);
        return { error: 'No such conversation.' };
      }
      return { chat: session };
    }
    const sessions = await store.listChats(ctx.model.repo.id);
    return { chat: sessions[0] ?? null };
  });

  app.delete('/api/repos/:repoId/chat', async (request) => {
    const { repoId } = request.params as { repoId: string };
    const query = request.query as { id?: string };
    const ctx = service.context(repoId);
    if (ctx && query.id) await store.deleteChat(ctx.model.repo.id, query.id);
    return { ok: true };
  });

  /** Streamed question answering with citations. */
  app.post('/api/repos/:repoId/chat', async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const body = (request.body ?? {}) as { question?: string; sessionId?: string; focusFiles?: string[] };
    const ctx = service.context(repoId);
    if (!ctx) {
      reply.code(404);
      return { error: 'Repository is not open.' };
    }
    const question = (body.question ?? '').trim();
    if (!question) {
      reply.code(400);
      return { error: 'A "question" is required.' };
    }

    await withSse(reply, async (emit) => {
      // No status here: askRepo emits it as its first action, and emitting it
      // twice made the progress line flicker between identical messages.
      const result = await askRepo(ctx, {
        question,
        sessionId: body.sessionId,
        focusFiles: body.focusFiles,
        onToken: (delta) => emit.send({ type: 'token', delta }),
        onStatus: (message) => emit.send({ type: 'status', message }),
        onCitations: (citations) => emit.send({ type: 'citations', citations }),
        onStep: (step) => emit.send({ type: 'step', step }),
      });
      emit.send({ type: 'done', sessionId: result.session.id, title: result.session.title, steps: result.steps });
    });
    return reply;
  });

  app.get('/api/repos/:repoId/questions', async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const ctx = service.context(repoId);
    if (!ctx) {
      reply.code(404);
      return { error: 'Repository is not open.' };
    }
    return { suggestions: suggestedQuestions(ctx) };
  });
}
