import type { LlmMessage } from '../types.js';
import type { RepoContext } from '../service.js';
import type { AgentStep } from '../agent/explorer.js';
import { extractAction } from '../agent/explorer.js';
import { runTool, toolCatalogue, toolNames } from '../agent/tools.js';
import { parseJsonLoose } from '../llm/json.js';
import { log } from '../logger.js';

/**
 * A question worth investigating, as opposed to a question worth looking up.
 *
 * Chat used to be a single retrieval pass followed by one completion, so a
 * question whose answer spans two files — "where is this validated, and what
 * happens if it fails?" — could only be answered from whatever chunks happened
 * to rank highest. Questions like that need the call graph, and the call graph
 * only helps if something can follow it. So the question gets the same tools the
 * explainer agent has.
 *
 * This is deliberately smaller than the explainer agent: no writing phase, a
 * hard cap of a few tool calls, and an explicit "answer without investigating"
 * exit so a simple lookup still costs one model call.
 */
export interface InvestigateOptions {
  question: string;
  history: LlmMessage[];
  /** Retrieved context, so simple questions can be answered without any tool call. */
  seed: string;
  /** Files the retrieval ranked highest — the agent is told where it already has context. */
  seedFiles: string[];
  /** The assembled user turn: the question, plus the excerpts already retrieved. */
  seedText: string;
  maxSteps?: number;
  contextBudgetChars?: number;
  signal?: AbortSignal;
  onStep?: (step: AgentStep) => void;
  onStatus?: (message: string) => void;
}

export interface Investigation {
  /** Tool observations, in order, to be handed to the answering call. */
  observations: string[];
  steps: AgentStep[];
  /** True when the model decided the excerpts it already had were enough. */
  immediate: boolean;
}

const DEFAULT_MAX_STEPS = 4;
const DEFAULT_CONTEXT_BUDGET = 18_000;
const MAX_OBSERVATION_CHARS = 6000;

/**
 * Words that mean "I have enough to answer". Models reach for these instead of a
 * real tool when they are ready to stop, and treating one as a tool name would
 * burn a turn and confuse the loop.
 */
const STOP_WORDS = new Set(['done', 'finish', 'finished', 'answer', 'stop', 'none', 'no_more', 'enough']);

export function shouldInvestigate(question: string): boolean {
  const q = question.trim();
  if (q.length > 220) return true;
  // A question that names more than one thing, or asks about behaviour over
  // time, is the kind that needs following rather than matching.
  return (
    /\b(why|how|what happens|when|where|trace|follow|flow|across|between|depend|call|calls|called)\b/i.test(q) &&
    q.split(/\s+/).length >= 5
  );
}

export async function investigate(ctx: RepoContext, options: InvestigateOptions): Promise<Investigation> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const contextBudget = options.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET;
  const knownTools = new Set(toolNames());

  const messages: LlmMessage[] = [
    { role: 'system', content: investigationPrompt(ctx, options.seedFiles, maxSteps) },
    { role: 'user', content: options.seedText },
    { role: 'assistant', content: '{"thought":' },
  ];

  const observations: string[] = [];
  const steps: AgentStep[] = [];
  const executed = new Set<string>();
  let observationChars = 0;
  let consecutiveFailures = 0;

  for (let index = 0; index < maxSteps; index += 1) {
    if (options.signal?.aborted) throw new Error('Investigation cancelled.');
    // Status is announced once, not per iteration: the model usually ends with
    // {"done": true}, so numbering every iteration advertised a final step that
    // never happened. The step events carry the real progress.
    if (index === 0) options.onStatus?.(`Investigating, up to ${maxSteps} lookups`);

    let raw: string;
    try {
      const result = await ctx.provider.complete({
        messages,
        json: true,
        temperature: 0.15,
        maxTokens: 1500,
        signal: options.signal,
      });
      raw = result.text;
    } catch (error) {
      // An investigation failure must not cost the reader their answer: the
      // retrieved excerpts are still there to answer from.
      log.warn('chat investigation call failed', error instanceof Error ? error.message : error);
      break;
    }

    const candidate = raw.trim().startsWith('{') ? raw : `{${raw}`;
    const parsed = parseJsonLoose<Record<string, unknown>>(candidate) ?? parseJsonLoose<Record<string, unknown>>(raw);
    if (!parsed) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 2) break;
      messages.push({ role: 'assistant', content: candidate });
      messages.push({ role: 'user', content: 'That was not valid JSON. Reply with one JSON object only.' });
      continue;
    }

    const action = extractAction(parsed, knownTools);
    const tool = action?.tool ?? '';
    const stopRequested =
      parsed.done === true ||
      parsed.answer !== undefined ||
      parsed.final !== undefined ||
      STOP_WORDS.has(tool.toLowerCase()) ||
      (!action && !parsed.thought);

    if (stopRequested || !action) {
      return { observations, steps, immediate: steps.length === 0 };
    }

    const key = `${action.tool}:${JSON.stringify(action.args)}`;
    if (executed.has(key)) {
      messages.push({ role: 'assistant', content: candidate });
      messages.push({
        role: 'user',
        content: 'You already made that exact call — the answer would be identical. Either use a different tool or reply {"done": true}.',
      });
      continue;
    }
    executed.add(key);

    const result = await runTool(ctx, { tool: action.tool, args: action.args });
    const text = result.text.slice(0, MAX_OBSERVATION_CHARS);
    observationChars += text.length;
    observations.push(`### ${result.summary}\n${text}`);
    steps.push({
      index: index + 1,
      thought: action.thought,
      tool: action.tool,
      args: action.args,
      summary: result.summary,
      failed: result.failed,
    });
    options.onStep?.(steps[steps.length - 1]);

    messages.push({ role: 'assistant', content: candidate });
    messages.push({
      role: 'user',
      content: `Observation for ${action.tool}:\n\n${text}${
        observationChars > contextBudget
          ? '\n\n(You are out of investigation budget. Reply {"done": true} now.)'
          : ''
      }`,
    });

    if (observationChars > contextBudget) {
      return { observations, steps, immediate: false };
    }
  }

  return { observations, steps, immediate: steps.length === 0 };
}

function investigationPrompt(ctx: RepoContext, seedFiles: string[], budget: number): string {
  const already = seedFiles.length
    ? `\nYou have ALREADY been given excerpts from: ${seedFiles.slice(0, 10).join(', ')}. Do not look these up again ` +
      'unless you need a different part of the file than the excerpt shows.\n'
    : '';

  return `You are investigating a repository to answer one question. You are not writing anything yet — you are
deciding what evidence is needed and going to get it.

You have static-analysis tools over this repository: a resolved call graph, an import graph, HTTP route detection,
symbol search, git history and a search index. They read real code.

The question has already been answered as well as a keyword search could answer it: the most relevant excerpts are
below. Your job is to decide whether that is *enough*. If it is, reply {"done": true} and answer nothing else. If the
answer needs something a keyword search cannot show — who calls a function, what happens when this fails, what the
code does on the other side of a boundary, whether anything tests this — call a tool.

Rules:
1. Prefer following the call graph over guessing from directory names or from the excerpts alone.
2. At most ${budget} tool calls. Most questions need one or two, and many need none.
3. Never repeat a call you have already made; the answer will be identical.
4. Do not answer the question in this phase. Evidence only.
${already}
Repository: ${ctx.model.repo.slug ?? ctx.model.repo.name} — ${ctx.model.stats.fileCount.toLocaleString()} files,
${ctx.model.stats.loc.toLocaleString()} lines.${ctx.model.stack.primaryLanguage ? ` Primary language: ${ctx.model.stack.primaryLanguage}.` : ''}

## Response protocol

Reply with EXACTLY ONE JSON object and nothing else.

To call a tool:
  {"thought": "<what you need and why>", "tool": "<tool name>", "args": { ... }}

To stop:
  {"done": true}

## Available tools

${toolCatalogue()}`;
}
