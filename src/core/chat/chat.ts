import type { ChatSession, ChatTurn, Citation, LlmMessage } from '../types.js';
import type { RepoContext } from '../service.js';
import { buildChatMessages, titlePromptMessages } from './prompts.js';
import { retrieve, type RetrievalResult } from './retrieval.js';
import { buildRepoDigest } from '../explain/digest.js';
import { log } from '../logger.js';
import { truncate } from '../util/text.js';
import { uid } from '../util/id.js';

export interface AskOptions {
  question: string;
  sessionId?: string;
  signal?: AbortSignal;
  onToken?: (delta: string) => void;
  onCitations?: (citations: Citation[]) => void;
  onStatus?: (message: string) => void;
  /** Override the automatic retrieval (used when the user pins files). */
  focusFiles?: string[];
}

export interface AskResult {
  answer: string;
  citations: Citation[];
  session: ChatSession;
  retrieval: RetrievalResult;
}

const MAX_HISTORY_TURNS = 8;

export async function askRepo(ctx: RepoContext, options: AskOptions): Promise<AskResult> {
  const question = options.question.trim();
  if (!question) throw new Error('A question is required.');

  const session = await loadOrCreateSession(ctx, options.sessionId);
  const history: LlmMessage[] = session.turns
    .slice(-MAX_HISTORY_TURNS * 2)
    .map((turn) => ({ role: turn.role, content: turn.content }));

  options.onStatus?.('Searching the repository');
  // Tighter than the global ceiling: a local model answers better from a few
  // highly relevant chunks than from a huge pile of loosely related ones, and
  // the prompt is re-read on every follow-up turn.
  const retrieval = retrieve(ctx.model, ctx.index, question, {
    maxChars: Math.min(ctx.cfg.maxContextChars, 24_000),
    topK: 12,
    focusFiles: options.focusFiles,
  });

  const messages = buildChatMessages({
    model: ctx.model,
    digest: buildRepoDigest(ctx.model, { maxChars: 5000 }),
    retrieved: retrieval.context,
    history,
    question,
  });

  let answer = '';
  let streamError: string | null = null;
  try {
    for await (const chunk of ctx.provider.stream({
      messages,
      temperature: 0.25,
      maxTokens: 2500,
      signal: options.signal,
    })) {
      if (chunk.delta) {
        answer += chunk.delta;
        options.onToken?.(chunk.delta);
      }
    }
  } catch (error) {
    streamError = error instanceof Error ? error.message : String(error);
    log.warn('chat generation failed', streamError);
  }

  // If nothing was streamed, the reader must still see why. Emitting the
  // explanation as a token keeps the UI simple and means a failure can never
  // leave the bubble saying "thinking" forever.
  if (!answer.trim()) {
    answer = streamError
      ? `I could not get an answer from the language model.\n\n**${streamError}**\n\nThe most relevant places to look for this are:\n${retrieval.files
          .slice(0, 5)
          .map((file) => `- \`${file}\``)
          .join('\n')}`
      : `The model returned an empty answer. The most relevant places to look are:\n${retrieval.files
          .slice(0, 5)
          .map((file) => `- \`${file}\``)
          .join('\n')}`;
    options.onToken?.(answer);
  }

  const citations = resolveCitations(ctx, answer, retrieval);
  options.onCitations?.(citations);

  const now = new Date().toISOString();
  session.turns.push({ role: 'user', content: question, createdAt: now });
  session.turns.push({ role: 'assistant', content: answer, citations, createdAt: now });
  session.updatedAt = now;
  if (!session.title || session.title === 'New conversation') {
    session.title = await deriveTitle(ctx, question, answer, options.signal);
  }
  await ctx.store.writeChat(ctx.model.repo.id, session);

  return { answer, citations, session, retrieval };
}

async function loadOrCreateSession(ctx: RepoContext, sessionId: string | undefined): Promise<ChatSession> {
  if (sessionId) {
    const existing = await ctx.store.readChat(ctx.model.repo.id, sessionId);
    if (existing) return existing;
  }
  const now = new Date().toISOString();
  return {
    id: uid('chat-'),
    repoId: ctx.model.repo.id,
    title: 'New conversation',
    createdAt: now,
    updatedAt: now,
    turns: [],
  };
}

/**
 * Turn `[path:12-30]` markers in the answer into structured citations.
 * Only paths that exist in the analysis are kept, so the UI never links to a
 * file that isn't there.
 */
export function resolveCitations(ctx: RepoContext, answer: string, retrieval: RetrievalResult): Citation[] {
  const known = new Map(ctx.model.files.map((f) => [f.path, f]));
  const retrievedByPath = new Map<string, Citation[]>();
  for (const citation of retrieval.citations) {
    if (!retrievedByPath.has(citation.path)) retrievedByPath.set(citation.path, []);
    (retrievedByPath.get(citation.path) as Citation[]).push(citation);
  }

  const found = new Map<string, Citation>();
  const pattern = /`?\[?([A-Za-z0-9_./@+-]+\.[A-Za-z0-9]+):(\d+)(?:\s*[-–]\s*(\d+))?\]?`?/g;
  for (const match of answer.matchAll(pattern)) {
    const [, filePath, startRaw, endRaw] = match;
    const normalised = filePath.replace(/^\.\//, '');
    const entry = known.get(normalised);
    if (!entry) continue;
    const startLine = Number.parseInt(startRaw, 10);
    const endLine = endRaw ? Number.parseInt(endRaw, 10) : Math.min(startLine + 12, entry.lines);
    const key = `${normalised}:${startLine}-${endLine}`;
    if (found.has(key)) continue;
    const overlapping = (retrievedByPath.get(normalised) ?? []).find((c) => c.startLine <= endLine && c.endLine >= startLine);
    found.set(key, {
      path: normalised,
      startLine,
      endLine,
      snippet: overlapping?.snippet ?? '',
    });
  }

  if (found.size === 0) {
    // The model answered without inline citations: fall back to the most
    // relevant retrieved ranges so the reader still has somewhere to look.
    for (const citation of retrieval.citations.slice(0, 4)) {
      const key = `${citation.path}:${citation.startLine}-${citation.endLine}`;
      if (!found.has(key)) found.set(key, citation);
    }
  }

  return [...found.values()].slice(0, 12);
}

async function deriveTitle(ctx: RepoContext, question: string, answer: string, signal?: AbortSignal): Promise<string> {
  const fallback = truncate(question.replace(/\s+/g, ' '), 60, '');
  try {
    const result = await ctx.provider.complete({
      messages: titlePromptMessages(question, answer),
      temperature: 0.2,
      maxTokens: 32,
      signal,
    });
    const title = result.text.trim().replace(/^["'#\s]+|["'.\s]+$/g, '');
    if (title && title.length >= 3 && title.length <= 80) return title;
  } catch {
    /* fall back to the question text */
  }
  return fallback;
}

export async function streamAnswer(
  ctx: RepoContext,
  options: AskOptions & { onEvent: (event: Record<string, unknown>) => void },
): Promise<void> {
  const { onEvent } = options;
  try {
    onEvent({ type: 'status', message: 'Searching the repository' });
    const result = await askRepo(ctx, {
      ...options,
      onToken: (delta) => onEvent({ type: 'token', delta }),
      onStatus: (message) => onEvent({ type: 'status', message }),
    });
    onEvent({ type: 'citations', citations: result.citations });
    onEvent({ type: 'done', sessionId: result.session.id, title: result.session.title });
  } catch (error) {
    onEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

/** Starter questions derived from the analysis — useful before a model runs. */
export function suggestedQuestions(ctx: RepoContext): string[] {
  const suggestions: string[] = [];
  const entrypoint = ctx.model.entrypoints.find((e) => e.kind === 'http-server') ?? ctx.model.entrypoints[0];
  const top = [...ctx.model.components].filter((c) => !c.ancillary).sort((a, b) => b.importance - a.importance);

  if (entrypoint) suggestions.push(`Walk me through what happens when a request hits \`${entrypoint.path}\`.`);
  if (top[0]) suggestions.push(`What is ${top[0].name} responsible for, and who depends on it?`);
  const datastore = ctx.model.dependencies.find((dependency) =>
    ['database', 'cache', 'queue', 'storage', 'search'].includes(dependency.category),
  );
  if (datastore) {
    suggestions.push(`Where is ${datastore.name} used, and what happens if it is unavailable?`);
  }
  const biggest = [...ctx.model.components].sort((a, b) => b.loc - a.loc)[0];
  if (biggest && biggest.id !== top[0]?.id) suggestions.push(`Why is ${biggest.name} so large, and how is it organised?`);
  suggestions.push('What are the riskiest parts of this codebase to change, and why?');
  suggestions.push('How is testing organised here, and what is actually covered?');
  if (ctx.model.concepts[0]) suggestions.push(`What does "${ctx.model.concepts[0].name}" mean in this codebase?`);

  return suggestions.slice(0, 6);
}

export type { ChatTurn };
