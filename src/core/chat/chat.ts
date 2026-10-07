import type { ChatSession, ChatTurn, Citation, LlmMessage } from '../types.js';
import type { RepoContext } from '../service.js';
import { buildChatMessages, titlePromptMessages } from './prompts.js';
import { retrieve, type RetrievalResult } from './retrieval.js';
import { investigate, shouldInvestigate, type Investigation } from './agent.js';
import type { AgentStep } from '../agent/explorer.js';
import { buildRepoDigest } from '../explain/digest.js';
import { log } from '../logger.js';
import { uid } from '../util/id.js';

export interface AskOptions {
  question: string;
  sessionId?: string;
  signal?: AbortSignal;
  onToken?: (delta: string) => void;
  onCitations?: (citations: Citation[]) => void;
  onStatus?: (message: string) => void;
  /** Progress through the investigation, for the visible trace. */
  onStep?: (step: AgentStep) => void;
  /** Override the automatic retrieval (used when the user pins files). */
  focusFiles?: string[];
  /**
   * Force investigation on or off. Left unset, a question that asks about
   * behaviour across the codebase is investigated and a plain lookup is not.
   */
  investigate?: boolean;
}

export interface AskResult {
  answer: string;
  citations: Citation[];
  session: ChatSession;
  retrieval: RetrievalResult;
  /** Tool calls the agent made before answering, if any. */
  steps: AgentStep[];
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

  // A question about behaviour gets followed through the call graph; a question
  // that names something specific is answered from the excerpts, which is both
  // faster and less likely to wander.
  const wantsInvestigation = options.investigate ?? shouldInvestigate(question);
  let investigation: Investigation = { observations: [], steps: [], immediate: true };
  if (wantsInvestigation) {
    options.onStatus?.('Deciding what to look at');
    investigation = await investigate(ctx, {
      question,
      history,
      seed: retrieval.context,
      seedFiles: retrieval.files,
      signal: options.signal,
      onStatus: options.onStatus,
      onStep: options.onStep,
      seedText:
        `# Question\n\n${question}\n\n---\n\n` +
        `The keyword search already found these excerpts:\n\n${retrieval.context || '(nothing relevant found)'}`,
    });
  }

  const messages = buildChatMessages({
    model: ctx.model,
    digest: buildRepoDigest(ctx.model, { maxChars: 5000 }),
    retrieved: retrieval.context,
    history,
    question,
    observations: investigation.observations,
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

  const citations = resolveCitations(ctx, answer, retrieval, investigation.steps);
  options.onCitations?.(citations);

  const now = new Date().toISOString();
  session.turns.push({ role: 'user', content: question, createdAt: now });
  session.turns.push({ role: 'assistant', content: answer, citations, createdAt: now });
  session.updatedAt = now;
  if (!session.title || session.title === 'New conversation') {
    session.title = await deriveTitle(ctx, question, answer, options.signal);
  }
  await ctx.store.writeChat(ctx.model.repo.id, session);

  return { answer, citations, session, retrieval, steps: investigation.steps };
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
 * The line ranges the agent actually looked at, as citable ranges.
 *
 * `read_file` is the only tool that reports precise ranges; the others report
 * the file they answered from, which is still worth offering the reader.
 */
function citationsFromSteps(steps: AgentStep[]): Citation[] {
  const out: Citation[] = [];
  for (const step of steps) {
    const args = step.args as { path?: unknown; startLine?: unknown; endLine?: unknown };
    if (typeof args?.path !== 'string') continue;
    const startLine = typeof args.startLine === 'number' ? args.startLine : 1;
    const endLine = typeof args.endLine === 'number' ? args.endLine : startLine + 40;
    out.push({ path: args.path, startLine, endLine, snippet: '' });
  }
  return out;
}

/**
 * Turn `[path:12-30]` markers in the answer into structured citations.
 *
 * Only paths that exist in the analysis are kept, so the UI never links to a
 * file that isn't there. The evidence the agent gathered counts too: without it
 * a citation to something the agent read from the call graph — which is exactly
 * the case keyword search could not have reached — would be discarded and the
 * reader would lose the reference.
 */
export function resolveCitations(
  ctx: RepoContext,
  answer: string,
  retrieval: RetrievalResult,
  steps: AgentStep[] = [],
): Citation[] {
  const known = new Map(ctx.model.files.map((f) => [f.path, f]));
  const byPath = new Map<string, Citation[]>();
  for (const citation of [...retrieval.citations, ...citationsFromSteps(steps)]) {
    if (!byPath.has(citation.path)) byPath.set(citation.path, []);
    (byPath.get(citation.path) as Citation[]).push(citation);
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
    const overlapping = (byPath.get(normalised) ?? []).find((c) => c.startLine <= endLine && c.endLine >= startLine);
    found.set(key, {
      path: normalised,
      startLine,
      endLine,
      snippet: overlapping?.snippet ?? '',
    });
  }

  if (found.size === 0) {
    // The model answered without inline citations: fall back to the ranges it
    // actually consulted. A file the agent went and read for this question is
    // better evidence than a keyword match, so those come first.
    for (const citation of [...citationsFromSteps(steps), ...retrieval.citations].slice(0, 4)) {
      const key = `${citation.path}:${citation.startLine}-${citation.endLine}`;
      if (!found.has(key)) found.set(key, citation);
    }
  }

  return [...found.values()].slice(0, 12);
}

/**
 * A readable session title from the question, cut at a word boundary.
 *
 * The previous version truncated to a character count and dropped the ellipsis,
 * so a title ended mid-word — "…what actually happens betwee".
 */
function shortenQuestion(question: string): string {
  const clean = question.replace(/\s+/g, ' ').trim();
  if (clean.length <= 60) return clean;
  const clipped = clean.slice(0, 60);
  const boundary = clipped.lastIndexOf(' ');
  return `${(boundary > 30 ? clipped.slice(0, boundary) : clipped).replace(/[,;:.]+$/, '')}…`;
}

async function deriveTitle(ctx: RepoContext, question: string, answer: string, signal?: AbortSignal): Promise<string> {
  const fallback = shortenQuestion(question);
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
      // Making the investigation visible is the point: the reader can see which
      // files were consulted before deciding how much to trust the answer.
      onStep: (step) => onEvent({ type: 'step', step }),
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
