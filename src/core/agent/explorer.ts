import type { Explainer, ExplainerSection, ExplainerTarget, LlmMessage } from '../types.js';
import type { RepoContext } from '../service.js';
import { parseJsonLoose } from '../llm/json.js';
import { EXPLAINER_CONTRACT, explainerIsUsable, normalizeExplainer } from '../explain/schema.js';
import { agentSystemPrompt, agentUserPrompt, scopeRequirements, type AgentTaskLike } from '../chat/prompts.js';
import { runTool, toolNames, type ToolInvocation } from './tools.js';
import { log } from '../logger.js';
import { truncate } from '../util/text.js';

/**
 * The exploration loop.
 *
 * The model chooses what to inspect; deterministic tools answer. This is the
 * difference between "summarise these search results" and "understand this
 * system": the model can follow a call chain, discover an unexpected service,
 * and change its mind.
 *
 * The protocol is plain JSON rather than provider-native tool calling, so it
 * works identically against Ollama, OpenAI-compatible servers, and Anthropic.
 */

export interface AgentTask extends AgentTaskLike {
  target: ExplainerTarget;
  /** Grounded drill-down options the explainer should offer. */
  next?: Explainer['next'];
}

export interface AgentStep {
  index: number;
  thought?: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  failed?: boolean;
}

export interface ExploreOptions {
  maxSteps?: number;
  signal?: AbortSignal;
  onStep?: (step: AgentStep) => void;
  onStatus?: (message: string) => void;
  /** Observation characters retained across the whole run. */
  contextBudgetChars?: number;
}

export interface ExploreResult {
  explainer: Explainer;
  steps: AgentStep[];
  /** True when the agent ran out of budget and had to be forced to write. */
  truncated: boolean;
  usage: { prompt: number; completion: number };
}

const FINAL_TOOL_NAMES = new Set(['final', 'finish', 'done', 'submit', 'answer', 'final_answer', 'finalanswer', 'complete']);

/** Reading this many slices of one file means the investigation is stuck. */
const MAX_READS_PER_FILE = 5;

/** The section types an explainer of this scope must contain. */
const REQUIRED_TYPES: Record<string, ExplainerSection['type'][]> = {
  repo: ['prose', 'diagram', 'list', 'callout', 'steps'],
  component: ['prose', 'diagram', 'callout', 'steps', 'code', 'list'],
  module: ['prose', 'list', 'diagram', 'code', 'callout'],
  flow: ['prose', 'callout', 'steps', 'diagram', 'code'],
  change: ['prose', 'diagram', 'steps', 'code', 'callout'],
};

function missingSectionTypes(scope: string, explainer: Explainer): ExplainerSection['type'][] {
  const required = REQUIRED_TYPES[scope] ?? REQUIRED_TYPES.repo;
  const present = new Set(explainer.sections.map((section) => section.type));
  return required.filter((type) => !present.has(type));
}

export interface ExtractedAction {
  thought?: string;
  tool: string;
  args: Record<string, unknown>;
}

function asArgs(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    const parsed = parseJsonLoose<Record<string, unknown>>(value);
    if (parsed) return parsed;
  }
  return {};
}

/**
 * Pull a tool call out of whatever shape the model produced.
 *
 * We ask for `{tool, args}`, but models that were trained on provider tool-call
 * formats emit `{name, arguments}`, `{tool_calls:[{function:{…}}]}`, or a bare
 * `{"list_dir": {…}}`. All of them mean the same thing; rejecting them wastes a
 * whole turn of a slow local model.
 */
export function extractAction(value: Record<string, unknown>, knownTools: Set<string>): ExtractedAction | null {
  const thought = typeof value.thought === 'string' ? value.thought : typeof value.reasoning === 'string' ? value.reasoning : undefined;

  const fromNameAndArgs = (name: unknown, args: unknown, fallbackArgs?: unknown): ExtractedAction | null => {
    if (typeof name !== 'string' || !name) return null;
    return { thought, tool: name, args: { ...asArgs(args), ...asArgs(fallbackArgs) } };
  };

  const direct = fromNameAndArgs(value.tool ?? value.action ?? value.name ?? value.tool_name ?? value.function_name, value.args ?? value.arguments ?? value.parameters ?? value.input);
  if (direct) return direct;

  const calls = value.tool_calls ?? value.toolCalls;
  if (Array.isArray(calls) && calls.length > 0) {
    const first = calls[0] as Record<string, unknown>;
    const fn = (first.function ?? first) as Record<string, unknown>;
    const nested = fromNameAndArgs(fn.name ?? first.name, fn.arguments ?? first.arguments ?? first.args);
    if (nested) return nested;
  }

  const functionCall = value.function_call ?? value.functionCall;
  if (functionCall && typeof functionCall === 'object') {
    const fn = functionCall as Record<string, unknown>;
    const nested = fromNameAndArgs(fn.name, fn.arguments ?? fn.args);
    if (nested) return nested;
  }

  const action = value.action;
  if (action && typeof action === 'object') {
    const a = action as Record<string, unknown>;
    const nested = fromNameAndArgs(a.tool ?? a.name, a.args ?? a.arguments ?? a.parameters);
    if (nested) return nested;
  }

  // `{"list_dir": {"path": "src"}}` — a tool name used as the only key.
  const keys = Object.keys(value).filter((key) => key !== 'thought' && key !== 'reasoning');
  if (keys.length === 1 && knownTools.has(keys[0])) {
    return { thought, tool: keys[0], args: asArgs(value[keys[0]]) };
  }

  return null;
}

/** A bare explainer object (no protocol wrapper) is also a valid finish. */
function isExplainerShaped(value: Record<string, unknown>): boolean {
  return Array.isArray(value.sections) && typeof value.title === 'string';
}

/** Investigation budgets by scope: a directory needs far less reading than a whole system. */
const SCOPE_STEPS: Record<string, number> = { repo: 12, component: 10, module: 6, flow: 8, change: 10 };

export async function explore(ctx: RepoContext, task: AgentTask, options: ExploreOptions = {}): Promise<ExploreResult> {
  const maxSteps = options.maxSteps ?? SCOPE_STEPS[task.scope] ?? 10;
  const contextBudget = options.contextBudgetChars ?? 30_000;

  const messages: LlmMessage[] = [
    { role: 'system', content: agentSystemPrompt(task, maxSteps) },
    { role: 'user', content: agentUserPrompt(task) },
    { role: 'assistant', content: '{"thought":' },
  ];

  const steps: AgentStep[] = [];
  const executed = new Set<string>();
  let observationChars = 0;
  let consecutiveFailures = 0;
  let truncated = false;
  let nudgedThin = false;
  let gapFillAttempted = false;
  // Whether the model has started writing, and whether we have already asked it
  // to finish a truncated answer.
  let writing = false;
  let retriedTruncated = false;
  let nudgedPremature = false;
  const usage = { prompt: 0, completion: 0 };
  const sources: { path: string; startLine?: number; endLine?: number }[] = [];
  const readCounts = new Map<string, number>();
  const observationIndexes: number[] = [];
  const knownTools = new Set(toolNames());

  // Investigating before writing is the difference between an explanation and
  // a plausible-sounding guess, so we require it rather than asking for it.
  const minTools = task.scope === 'repo' || task.scope === 'component' || task.scope === 'change' ? 3 : 2;
  const minSections = 5;

  for (let index = 0; index < maxSteps + 2; index += 1) {
    if (options.signal?.aborted) throw new Error('Exploration cancelled.');

    // The final turn is reserved for writing, so stop tool use one step early.
    const mustWrite = index >= maxSteps || observationChars > contextBudget;
    if (mustWrite && !truncated) {
      truncated = true;
      messages.push({
        role: 'user',
        content: 'You are out of investigation budget. Emit the final explainer now as {"final": {...}} using only what you have verified. Do not request another tool.',
      });
    }

    options.onStatus?.(mustWrite ? 'Writing the explainer' : `Planning step ${index + 1}`);

    let raw: string;
    try {
      const result = await ctx.provider.complete({
        messages,
        json: true,
        temperature: mustWrite ? 0.25 : 0.15,
        // num_predict is a ceiling, not a target, so a generous cap costs
        // nothing on tool-call turns — but a tight one silently truncates the
        // explainer when the model decides to write during a planning turn.
        // A model that decides to write during a planning turn was previously
        // capped at 4000 tokens and silently truncated mid-JSON. Once we have
        // seen it start writing, keep the larger budget for the rest of the run.
        maxTokens: mustWrite || writing ? 14_000 : 4000,
        signal: options.signal,
      });
      raw = result.text;
      usage.prompt += result.usage?.prompt ?? 0;
      usage.completion += result.usage?.completion ?? 0;
    } catch (error) {
      log.warn('explorer model call failed', error instanceof Error ? error.message : error);
      throw error;
    }

    // The assistant prefill means the JSON we get back may be a fragment.
    const candidate = raw.trim().startsWith('{') ? raw : `{${raw}`;
    const parsed = parseJsonLoose<Record<string, unknown>>(candidate) ?? parseJsonLoose<Record<string, unknown>>(raw);

    if (!parsed) {
      consecutiveFailures += 1;
      log.debug(`the model did not return parseable JSON (attempt ${consecutiveFailures}). Raw start: ${raw.slice(0, 300)}`);
      if (consecutiveFailures >= 3) {
        // Same reasoning as the unrecognised-tool branch below: three unparseable
        // replies mean this model call is not going to produce a turn, but the
        // investigation so far is still worth writing up on a smaller context.
        // Throwing from here skipped that recovery and turned a recoverable run
        // into a static outline.
        log.warn('the model returned unparseable JSON three times; ending the investigation early', {
          scope: task.scope,
          steps: steps.length,
          rawStart: raw.slice(0, 200),
        });
        break;
      }
      messages.push({ role: 'assistant', content: candidate });
      messages.push({
        role: 'user',
        content: 'That was not valid JSON. Reply with exactly one JSON object, either {"thought":...,"tool":...,"args":{...}} or {"final":{...}}.',
      });
      continue;
    }

    // A turn is either a final answer or a tool call. Models express "final" in
    // several ways (the `final` key, a bare explainer object, or a tool literally
    // named `final`), and all of them must go through the same finalisation —
    // including the gap fill.
    const action = extractAction(parsed, knownTools);
    const toolName = action?.tool ?? null;
    const isFinalTool = Boolean(toolName && FINAL_TOOL_NAMES.has(toolName.toLowerCase()));

    const finalPayload: Record<string, unknown> | null = parsed.final
      ? (parsed.final as Record<string, unknown>)
      : isExplainerShaped(parsed)
        ? parsed
        : isFinalTool
          ? ((action?.args && typeof action.args === 'object' ? action.args : parsed) as Record<string, unknown>)
          : null;

    if (finalPayload) {
      writing = true;
      const unfinished = raw.trim().length > 0 && !raw.trimEnd().endsWith('}') && !raw.trimEnd().endsWith(']');

      // The JSON repair can salvage a cut-off answer, but the result is a
      // fragment — sometimes with no usable sections at all, which is how a
      // successful run ended up showing the static outline instead.
      if (unfinished && !retriedTruncated && !truncated) {
        retriedTruncated = true;
        log.debug(`the model's answer was cut off after ${raw.length} characters; asking for a complete, shorter one`);
        messages.push({ role: 'assistant', content: candidate });
        messages.push({
          role: 'user',
          content: `Your JSON was cut off mid-way (${raw.length} characters) before it closed. Emit the complete explainer again and finish the JSON. Keep it tighter this time: 6-9 sections, at most one code section, quiz questions under 30 words each.`,
        });
        continue;
      }

      if (steps.length < minTools && !nudgedPremature) {
        nudgedPremature = true;
        messages.push({ role: 'assistant', content: candidate });
        messages.push({
          role: 'user',
          content: `You have not investigated yet. Use at least ${minTools} tools before writing, so your claims are grounded: start with list_entrypoints/list_routes, then trace_calls or callers_of on the most important function, then read_file the file that matters most. Then emit the final explainer.`,
        });
        continue;
      }

      const payload = parseJsonLoose<Record<string, unknown>>(JSON.stringify(finalPayload)) ?? finalPayload;
      const explainer = normalizeExplainer(payload, {
        kind: task.target.kind,
        target: task.target,
        provider: ctx.providerId,
        model: ctx.modelName,
        sources,
        next: task.next ?? [],
        tokens: { prompt: usage.prompt, completion: usage.completion },
      });

      if (!explainerIsUsable(explainer)) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 2) {
          // A model that keeps emitting empty explainers is done for this run;
          // hand over to the compact write rather than abandoning the work.
          log.warn('the model produced no usable explainer sections twice; ending the investigation early', {
            scope: task.scope,
            steps: steps.length,
          });
          break;
        }
        messages.push({ role: 'assistant', content: candidate });
        messages.push({
          role: 'user',
          content: 'That explainer had no usable sections. Emit {"final": {...}} again with real "prose" and "list" sections.',
        });
        continue;
      }

      const contentSections = explainer.sections.filter((section) => section.type !== 'quiz').length;

      // Asking a model to regenerate everything rarely works; asking it for the
      // few sections it forgot almost always does. Two rounds: the missing set,
      // then (if a diagram is still absent) one focused request for a diagram.
      let current = explainer;
      const allSections = [...((payload.sections as unknown[]) ?? [])];
      for (let round = 0; round < 2 && !truncated; round += 1) {
        const stillMissing = missingSectionTypes(task.scope, current);
        if (stillMissing.length === 0) break;
        gapFillAttempted = true;
        const diagramOnly = stillMissing.length === 1 && stillMissing[0] === 'diagram';
        // Ground the diagram request in this repository's real names; a concrete
        // example is far harder for a small model to refuse than an abstract one.
        const topComponents = ctx.model.components
          .filter((component) => !component.ancillary)
          .slice(0, 4)
          .map((component) => component.name);
        const sampleRoutes = ctx.model.routes.slice(0, 3).map((route) => `${route.method} ${route.path}`);
        const diagramHint =
          topComponents.length >= 2
            ? ` Use these real components as actors: ${topComponents.join(', ')}.${sampleRoutes.length > 0 ? ` Real endpoints: ${sampleRoutes.join('; ')}.` : ''}`
            : '';

        messages.push({ role: 'assistant', content: candidate });
        messages.push({
          role: 'user',
          content: diagramOnly
            ? `Your explainer has no diagram, and a diagram is required. Reply with exactly this JSON shape and nothing else. Do NOT write null — fill in the values.${diagramHint}\n{"sections":[{"type":"diagram","title":"<short title>","caption":"<one line>","diagram":{"kind":"sequence","actors":[{"id":"caller","label":"<first component>"},{"id":"core","label":"<second component>"},{"id":"store","label":"<datastore component>"}],"steps":[{"from":"caller","to":"core","label":"<real endpoint>"},{"from":"core","to":"store","label":"<real query>"}],"example":"<concrete example with real values>"}}]}`
            : `Your explainer is good but incomplete. Missing section types: ${stillMissing.join(', ')}.\nReply with exactly {"sections": [ ... ]} containing ONLY those sections, in that order, grounded in what you already investigated. Do not repeat what you have already written. For a diagram, "deterministic" and "flow" are NOT valid kinds — use exactly one of: flow, layers, tree, compare, sequence, ui. Section shapes follow this contract:\n${EXPLAINER_CONTRACT}`,
        });

        let raw: unknown[] | null = null;
        try {
          const fill = await ctx.provider.complete({ messages, json: true, temperature: 0.3, maxTokens: 8000, signal: options.signal });
          usage.prompt += fill.usage?.prompt ?? 0;
          usage.completion += fill.usage?.completion ?? 0;
          const extra = parseJsonLoose<Record<string, unknown>>(fill.text);
          const nested = extra && typeof extra.final === 'object' && extra.final !== null ? (extra.final as Record<string, unknown>) : null;
          const nestedArgs =
            extra && typeof extra.args === 'object' && extra.args !== null
              ? (extra.args as Record<string, unknown>)
              : nested && typeof nested.args === 'object' && nested.args !== null
                ? (nested.args as Record<string, unknown>)
                : null;
          const candidateSections =
            (Array.isArray(extra?.sections) && extra?.sections) ||
            (nested && Array.isArray(nested.sections) && nested.sections) ||
            (nestedArgs && Array.isArray(nestedArgs.sections) && nestedArgs.sections) ||
            null;
          if (candidateSections) raw = candidateSections;
          if (!raw) log.debug(`gap-fill round ${round + 1} produced nothing usable: ${fill.text.slice(0, 300)}`);
        } catch (error) {
          log.warn('gap-fill attempt failed', error instanceof Error ? error.message : error);
        }

        // Models often resend everything; keep only what was missing. Sections
        // that fail validation are dropped, which is why the loop keeps going:
        // the next round asks again with a more concrete prompt.
        if (raw && raw.length > 0) {
          const allowed = new Set<string>(stillMissing);
          const filtered = raw.filter(
            (item) => item && typeof item === 'object' && allowed.has(String((item as Record<string, unknown>).type ?? '')),
          );
          if (filtered.length > 0) {
            allSections.push(...filtered);
            const merged = normalizeExplainer(
              { ...payload, sections: allSections },
              {
                kind: task.target.kind,
                target: task.target,
                provider: ctx.providerId,
                model: ctx.modelName,
                sources,
                next: task.next ?? [],
                tokens: { prompt: usage.prompt, completion: usage.completion },
              },
            );
            if (merged.sections.length > current.sections.length) current = merged;
          }
        }
      }

      if (current.sections.length > explainer.sections.length) {
        return { explainer: current, steps, truncated, usage };
      }

      // If we already asked for the missing pieces and got nothing usable, more
      // prompting will not help — return what we have.
      if (gapFillAttempted) return { explainer: current, steps, truncated, usage };

      if (contentSections < minSections && !nudgedThin && !truncated) {
        nudgedThin = true;
        messages.push({ role: 'assistant', content: candidate });
        messages.push({
          role: 'user',
          content: `That explainer is too thin (${contentSections} content sections). Re-read the required sections and emit {"final": {...}} again with all of them, in order.\n\n${scopeRequirements(task.scope)}`,
        });
        continue;
      }

      return { explainer, steps, truncated, usage };
    }

    if (!toolName) {
      consecutiveFailures += 1;
      log.debug(`unrecognised agent response: ${raw.slice(0, 400)}`);
      if (consecutiveFailures >= 3) {
        // Do not give up here. The model has stopped producing usable turns, but
        // everything it read is still worth writing up — and throwing from inside
        // the loop skipped the compact write path below entirely, which is why an
        // otherwise recoverable run ended as a static outline. Leaving the loop
        // hands over to a much smaller context, where the model answers reliably.
        log.warn('the model stopped producing usable turns; ending the investigation early', { scope: task.scope, steps: steps.length });
        break;
      }
      messages.push({ role: 'assistant', content: candidate });
      messages.push({
        role: 'user',
        content: `Reply with exactly one JSON object using either "tool" + "args", or "final". Example: {"thought": "why", "tool": "list_entrypoints", "args": {}}. Valid tools: ${toolNames().join(', ')}.`,
      });
      continue;
    }

    const args = action?.args ?? {};
    const invocation: ToolInvocation = { tool: toolName, args };
    const key = `${toolName}:${JSON.stringify(args)}`;

    if (executed.has(key)) {
      messages.push({ role: 'assistant', content: JSON.stringify({ thought: parsed.thought ?? '', tool: toolName, args }) });
      messages.push({ role: 'user', content: `You already ran that exact call. Its result will not change. Choose a different tool or emit {"final": {...}}.` });
      consecutiveFailures += 1;
      continue;
    }

    // Reading consecutive slices of one file is legitimate, but models do get
    // stuck re-reading the same file instead of widening the investigation.
    const fileKey = typeof args.path === 'string' ? args.path : null;
    if (toolName === 'read_file' && fileKey) {
      readCounts.set(fileKey, (readCounts.get(fileKey) ?? 0) + 1);
      if ((readCounts.get(fileKey) ?? 0) > MAX_READS_PER_FILE) {
        messages.push({ role: 'assistant', content: JSON.stringify({ thought: parsed.thought ?? '', tool: toolName, args }) });
        messages.push({
          role: 'user',
          content: `You have already read ${MAX_READS_PER_FILE} slices of ${fileKey}. Broaden the investigation: use callers_of, callees_of, search_code, find_hotspots, find_dead_code, git_log, or read a different file. Then emit {"final": {...}}.`,
        });
        continue;
      }
    }

    executed.add(key);
    consecutiveFailures = 0;

    const result = await runTool(ctx, invocation);
    steps.push({ index: steps.length + 1, thought: typeof parsed.thought === 'string' ? parsed.thought : undefined, tool: toolName, args, summary: result.summary, failed: result.failed });
    options.onStep?.(steps[steps.length - 1]);
    if (result.sources) sources.push(...result.sources);

    const remaining = maxSteps - steps.length;
    const observation = `Observation from ${toolName}:\n${truncate(result.text, 5000)}\n\n[Tool calls used: ${steps.length} of ${maxSteps}. ${remaining <= 2 ? 'Write the explainer next.' : 'Continue investigating or emit {"final": {...}}.'}]`;
    observationChars += observation.length;
    messages.push({ role: 'assistant', content: JSON.stringify({ thought: parsed.thought ?? '', tool: toolName, args }) });
    messages.push({ role: 'user', content: observation });
    observationIndexes.push(messages.length - 1);

    // Long local-model runs get slower as the prompt grows, and the earliest
    // observations matter least by now. Elide the oldest half once over budget.
    if (observationChars > contextBudget && observationIndexes.length > 4) {
      const dropCount = Math.floor(observationIndexes.length / 2);
      for (const index of observationIndexes.splice(0, dropCount)) {
        observationChars -= messages[index].content.length;
        messages[index] = {
          role: 'user',
          content: '[An earlier tool observation was elided to keep this investigation fast. Its conclusions are already reflected in your plan.]',
        };
      }
    }
  }

  // Last chance: some models investigate forever and never write. Rather than
  // discard everything they read, ask again with no option to use a tool — and on
  // a *compact* context. Replaying the whole transcript was the problem: tens of
  // thousands of characters of diff plus every observation is what made the model
  // return something unusable. What it needs to write is the seed and a note of
  // what it verified, not the raw evidence it already digested.
  const compactSeed = truncate(task.seed ?? '', 12_000, '\n… [context trimmed]');
  const investigated = steps.length > 0
    ? `\n\nWhat you verified during this investigation (${steps.length} tool calls):\n${steps
        .map((step, position) => `${position + 1}. ${step.tool} — ${truncate(step.summary ?? 'no summary', 240)}`)
        .join('\n')}`
    : '';
  // The demand must not contradict the scope's required sections. Asking for
  // "4-6 sections" while the change scope requires eight produced explainers that
  // met the letter of the request and skipped the structure the reader expects.
  const demand =
    'You must write the explainer now. Reply with exactly one JSON object: {"final": {...}}. Do not request a tool. ' +
    'Include every section the scope above lists as required, in order. Keep each one brief — a short paragraph rather ' +
    'than a long one — but do not omit any, and keep the whole answer short enough that it cannot be cut off.';

  try {
    options.onStatus?.('Writing the explainer');
    const finalAttempt = await ctx.provider.complete({
      messages: [
        { role: 'system', content: agentSystemPrompt(task, steps.length) },
        { role: 'user', content: `${compactSeed}${investigated}\n\n${demand}` },
      ],
      json: true,
      temperature: 0.25,
      maxTokens: 12_000,
      signal: options.signal,
    });
    const parsedFinal = parseJsonLoose<Record<string, unknown>>(finalAttempt.text);
    const payload = parsedFinal?.final ?? (parsedFinal && isExplainerShaped(parsedFinal) ? parsedFinal : null);
    if (!payload) {
      // Worth logging precisely: "the model did not return something usable" has
      // several very different causes, and knowing which one decides the fix.
      log.warn('final attempt produced no explainer payload', {
        scope: task.scope,
        responseChars: finalAttempt.text.length,
        finishReason: finalAttempt.finishReason ?? 'not reported',
        parsed: parsedFinal === null ? 'unparseable JSON' : `object with keys: ${Object.keys(parsedFinal).slice(0, 8).join(', ')}`,
        head: finalAttempt.text.slice(0, 400),
        tail: finalAttempt.text.slice(-200),
      });
    }
    if (payload && typeof payload === 'object') {
      const explainer = normalizeExplainer(payload as Record<string, unknown>, {
        kind: task.target.kind,
        target: task.target,
        provider: ctx.providerId,
        model: ctx.modelName,
        sources,
        next: task.next ?? [],
        tokens: { prompt: usage.prompt, completion: usage.completion },
      });
      // Usable is the floor, not the goal: a three-section answer from the terse
      // retry is worth keeping, but it should first be given the chance to be a
      // complete one on the bare retry below.
      if (explainerIsUsable(explainer) && explainer.sections.filter((section) => section.type !== 'quiz').length >= 4) {
        return { explainer, steps, truncated: true, usage };
      }
      log.warn('final attempt produced an unusable explainer', {
        scope: task.scope,
        sections: explainer.sections.length,
        types: explainer.sections.map((section) => section.type).join(','),
        hasTldr: Boolean(explainer.tldr),
      });
    }
    // Still nothing: one more go with nothing but the seed, which is the smallest
    // prompt that can still produce a grounded explainer.
    log.warn('compact final attempt produced nothing usable; retrying with the seed alone', { scope: task.scope });
    const bare = await ctx.provider.complete({
      messages: [
        { role: 'system', content: agentSystemPrompt(task, steps.length) },
        { role: 'user', content: `${compactSeed}\n\n${demand}` },
      ],
      json: true,
      temperature: 0.2,
      maxTokens: 12_000,
      signal: options.signal,
    });
    const bareParsed = parseJsonLoose<Record<string, unknown>>(bare.text);
    const barePayload = bareParsed?.final ?? (bareParsed && isExplainerShaped(bareParsed) ? bareParsed : null);
    if (barePayload && typeof barePayload === 'object') {
      const explainer = normalizeExplainer(barePayload as Record<string, unknown>, {
        kind: task.target.kind,
        target: task.target,
        provider: ctx.providerId,
        model: ctx.modelName,
        sources,
        next: task.next ?? [],
        tokens: { prompt: usage.prompt + (bare.usage?.prompt ?? 0), completion: usage.completion + (bare.usage?.completion ?? 0) },
      });
      if (explainerIsUsable(explainer)) return { explainer, steps, truncated: true, usage };
    }
    log.warn('bare final attempt produced no explainer payload', {
      scope: task.scope,
      responseChars: bare.text.length,
      finishReason: bare.finishReason ?? 'not reported',
      head: bare.text.slice(0, 300),
    });
  } catch (error) {
    log.warn('final explainer attempt failed', error instanceof Error ? error.message : error);
    throw error;
  }

  throw new Error('Exploration exceeded its budget without producing an explainer.');
}
