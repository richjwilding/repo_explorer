import type { LlmMessage } from '../types.js';
import type { Change, RepoModel } from '../types.js';
import { EXPLAINER_CONTRACT } from '../explain/schema.js';
import { toolCatalogue } from '../agent/tools.js';

/**
 * Prompt construction.
 *
 * The audience is deliberately explicit everywhere: a senior engineering
 * leader who is new to *this* repository. They can read code, so we never dumb
 * things down, but we never assume they know the local conventions,
 * vocabulary, or history either.
 */

export const AUDIENCE = `The reader is an engineering manager or CTO who is new to this repository.
They are technically strong — assume they can read code, understand distributed systems, and know the
standard vocabulary of software engineering. What they lack is local knowledge: this codebase's
vocabulary, conventions, history, and the reasoning behind its structure. They have limited time.
Never explain what a loop or an HTTP request is; always explain why this system is shaped the way it is.`;

export const STYLE_GUIDE = `Write in the clear, unhurried style of a good technical book (think Martin Kleppmann):
plain words, concrete examples, smooth transitions between sections, no filler, no marketing language,
no "let's dive in". Prefer short paragraphs. Use **bold** sparingly for the first mention of a real concept.
Never use emoji. Never pad. If something is uncertain or a guess, say so explicitly and say what evidence
would settle it.`;

export const JSON_RULES = `Return a single JSON object and absolutely nothing else — no markdown fences, no commentary before or after.
Every string must be valid JSON (escape newlines as \\n). Keep prose inside "markdown" fields; the app renders
a safe subset of markdown there (headings, bold, italics, inline code, lists, blockquotes, links).`;

export const DIAGRAM_RULES = `Never draw a diagram with ASCII art. Two formats are available, and the Mermaid one is
usually the most legible — use it by default for anything involving more than a handful of boxes.

**Mermaid** — rendered to SVG by a real graph engine, so branching, merging and ordering come out legible:
  { "type": "diagram", "title": "…", "diagram": { "kind": "mermaid", "code": "<mermaid source>" } }
  - Use \`flowchart LR\` (or \`flowchart TD\`) for the shape of a system: components and what talks to what.
  - Use \`sequenceDiagram\` for anything end to end: a request, a job, a reconciliation. This is the clearest
    possible view of an ordered exchange, so prefer it over anything else for a lifecycle.
  - Rules: short alphanumeric node ids with the real name as the label, e.g. \`retrieval["retrieval service"]\`.
    Quote any label containing punctuation. Reference every edge endpoint by a declared id.
    At most 12 nodes and 12 steps. No \`classDef\`, \`style\`, \`click\` or \`%%{init}%%\` directives — the app themes it.
  - Always name real things from the tool output, never placeholders like "Service A".
  - Choose the node granularity to match the level: subsystems at repository level, responsibilities or
    sub-directories inside a component, and files only when explaining one directory. A diagram of a file list at
    component or repository level is a failure — say what the parts *do*.

**Structured** — rendered as HTML/CSS blocks; good for small, non-graph shapes:
 - "layers" for stacked responsibilities of one component
 - "tree" for ownership or folder structure
 - "compare" for before/after or two competing approaches
 - "ui" for the regions of a user interface
 - "flow" and "sequence" also exist as structured forms; use them only when there are 3-5 elements and no branching.
Every node id referenced by an edge must exist. A diagram that needs a legend to be understood has failed.`;

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */

export function chatSystemPrompt(model: RepoModel): string {
  return `You are a senior engineer who has just spent a week reading this repository and is now briefing a colleague.

${AUDIENCE}

${STYLE_GUIDE}

How to answer:
1. Lead with the direct answer in one or two sentences. Then give the detail that justifies it.
2. Ground every factual claim in the provided code excerpts. Cite as [path:startLine-endLine] immediately after the claim.
   Only cite files and line ranges that appear in the excerpts below. Never invent a path or a line number.
3. If the excerpts do not contain the answer, say so plainly. Name the files or directories the reader should look at next
   and why. Do not guess and present it as fact.
4. When code is the clearest explanation, include a short excerpt (under ~15 lines) in a fenced block and explain it.
5. If the question touches a trade-off or a risk (coupling, missing tests, unclear ownership, operational cost), say so —
   that is exactly what this reader needs to know.
6. Keep answers under roughly 400 words unless the question genuinely demands more.
7. Use the exact names the excerpts use. Never swap in a more familiar product for the one that is really there
   (OpenSearch is not Elasticsearch, MariaDB is not MySQL). If a name is not in the excerpts, do not assert it.

Repository context:
${model.repo.slug ?? model.repo.name} — ${model.stats.fileCount.toLocaleString()} files, ${model.stats.loc.toLocaleString()} lines.
${model.stack.primaryLanguage ? `Primary language: ${model.stack.primaryLanguage}.` : ''}${
    model.stack.frameworks.length > 0 ? ` Main frameworks: ${model.stack.frameworks.join(', ')}.` : ''
  }`;
}

export interface ChatPromptInput {
  model: RepoModel;
  digest: string;
  retrieved: string;
  history: LlmMessage[];
  question: string;
}

export function buildChatMessages(input: ChatPromptInput): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: 'system', content: chatSystemPrompt(input.model) }];
  messages.push({
    role: 'user',
    content: `Structural map of the repository, derived by static analysis (call graph, imports, routes, churn):\n\n${input.digest}\n\n---\n\nUse the map for orientation only. The code excerpts that follow are the source of truth.`,
  });
  messages.push({ role: 'assistant', content: 'Understood. I have the structural map.' });

  for (const turn of input.history.slice(-8)) {
    if (turn.role === 'system') continue;
    messages.push(turn);
  }

  messages.push({
    role: 'user',
    content: `Relevant code retrieved for this question:\n\n${input.retrieved || '(no relevant code found)'}\n\n---\n\nQuestion: ${input.question}`,
  });
  return messages;
}

export function titlePromptMessages(question: string, answer: string): LlmMessage[] {
  return [
    {
      role: 'system',
      content: 'Summarise the conversation as a title of at most six words. Reply with the title only — no quotes, no punctuation at the end.',
    },
    { role: 'user', content: `Question: ${question.slice(0, 500)}\n\nAnswer: ${answer.slice(0, 800)}` },
  ];
}

/* ------------------------------------------------------------------ *
 * Explainer section requirements
 * ------------------------------------------------------------------ */

export type ExplainerScope = 'repo' | 'component' | 'module' | 'flow' | 'change';

export function scopeRequirements(scope: ExplainerScope): string {
  switch (scope) {
    case 'repo':
      return `This is the top-level explainer for the whole repository — the reader's first five minutes.
Deliberately obscure ancillary concerns: test harnesses, build tooling, deployment manifests, generated code and
one-off scripts belong in a single "supporting infrastructure" note unless they are genuinely load-bearing.
Show the spine of the system, not every organ. Never enumerate individual files at this level — the reader wants
subsystems and what flows between them.
Required sections, in this order:
 1. prose (narrow, level "narrow") — "What this system does and who it serves". Two or three paragraphs.
 2. prose (level "deep", skip-able background) — the domain, the vocabulary the code uses, and the technical ancestors of the design.
 3. diagram — the shape of the system with only the top-level components. Use a Mermaid \`flowchart\` here:
    it is the single most important picture in the document, and a real graph reads better than boxes in a row.
 4. diagram — one realistic request or job end to end. Use a Mermaid \`sequenceDiagram\` with real payload
    values, so the reader can follow a single piece of data from entry to storage.
 5. list — the key components, each with a one-line responsibility and its directory path.
 6. callout (warning) — where the complexity actually lives, and what surprised you while reading. Use the call-graph
    hubs and churn hotspots you found.
 7. steps — an ordered "how to get oriented in your first hour" list naming real files to open.`;
    case 'component':
      return `This explainer covers one component of the system. Explain its responsibility, its public surface, and how it
relates to the components around it. Then walk through its internals at a level that lets the reader predict where a change
would go.
Required sections, in this order:
 1. prose (narrow) — what this component is responsible for, and what it is deliberately not responsible for.
 2. diagram (flow or layers) — its internal structure, using real file and directory names as labels.
 3. callout (concept) — the single most important idea a reader must hold in their head to work here.
 4. steps — the path a typical operation takes through this component, ending at whatever it calls outside itself.
 5. code — the one or two files that matter most, with a short walkthrough. Copy real code you have read.
 6. list — the interfaces it exposes and the components it depends on.
 7. callout (edge or warning) — the sharp edges: coupling, hidden state, ordering requirements, missing tests.`;
    case 'flow':
      return `This explainer follows one end-to-end data flow. The reader must be able to trace a single piece of data from
where it enters to where it is stored or returned. Use one concrete example throughout — a real request body, a real job
payload — and keep referring back to it. Verify the path with the call graph rather than assuming it.
Required sections, in this order:
 1. prose (narrow) — what triggers this flow and what the caller gets back.
 2. callout (concept) — the invariant that holds along the whole flow.
 3. steps — each hop, naming the file and the function that performs it.
 4. diagram — the same hops as a Mermaid \`sequenceDiagram\` with real payload values.
 5. callout (warning or edge) — where this flow can fail, retry, or lose data.
 6. code — the one function that does the most important work.`;
    case 'change':
      return `This explainer covers one specific change (commit, branch, or pull request) — the reader must finish it
understanding what changed, why it was needed, and what could break.
Required sections, in this order:
 1. prose (level "deep", skip-able) — "Background": the domain, the part of the system involved, and the vocabulary a
    newcomer needs. Assume the reader may know nothing about this area.
 2. prose (narrow) — "The narrow background": the specific code paths this change touches, and what they did before.
 3. prose (narrow) — "Intuition": the essence of the change in plain language, with a concrete toy example using small data.
 4. diagram (flow or sequence) — before and/or after behaviour using that toy example.
 5. diagram with "kind": "compare" — old behaviour versus new behaviour, in terms the reader can act on.
 6. steps — a grouped, high-level walkthrough of the changed code. Group related changes; do not narrate every line.
 7. code — the most important hunk, verbatim from the diff, with "file" and "startLine" pointing into the new file.
 8. callout (edge or warning) — what could break, what is not covered, or what a reviewer should double-check.
If the change is mechanical (a rename, a dependency bump, formatting), say so plainly — a short honest explainer beats a padded one.`;
    case 'module':
    default:
      return `This explainer covers a single directory. Be concrete and small in scope: the reader has already read the
higher-level explanation and now wants to know what is in this folder and why.
Required sections, in this order:
 1. prose (narrow) — what this directory is for, in two or three sentences.
 2. list — every file worth knowing about, with a one-line purpose (skip noise, tests and generated files unless they matter).
 3. diagram (tree) — how the folder is organised and what belongs where.
 4. code — the most instructive file, with a short walkthrough.
 5. callout (edge or tip) — traps, conventions, or things that look wrong but are deliberate.`;
  }
}

/* ------------------------------------------------------------------ *
 * Agent prompts
 * ------------------------------------------------------------------ */

export interface AgentTaskLike {
  scope: ExplainerScope;
  goal: string;
  seed: string;
  nextOptions: { label: string; hint: string }[];
  siblingNames: string[];
  extraInstructions?: string;
}

export function agentSystemPrompt(task: AgentTaskLike, budget: number): string {
  const next =
    task.nextOptions.length > 0
      ? `\nThings the reader can drill into next (use these names, and add at most two of your own):\n${task.nextOptions
          .map((option) => ` - ${option.label}${option.hint ? ` (${option.hint})` : ''}`)
          .join('\n')}`
      : '';
  const siblings = task.siblingNames.length > 0 ? `\nNames to stay consistent with: ${task.siblingNames.slice(0, 30).join(', ')}.` : '';

  return `You are a staff engineer investigating an unfamiliar codebase and then writing an explainer for an engineering leader.

${AUDIENCE}

${STYLE_GUIDE}

You work in two phases.

PHASE 1 — INVESTIGATE. You have real static-analysis tools over this repository. They read real code: an import
graph, a resolved call graph, HTTP route detection, git churn history, and a search index. Use them. Never state
something you have not verified with a tool. Prefer following the call graph over guessing from directory names.
Investigate the *spine* of the subject: what runs, what calls what, where data enters and leaves, what has churned.

PHASE 2 — WRITE. When you understand the subject, emit the final explainer as JSON.

Describe responsibilities, boundaries and behaviour — not inventories. A list of file names is not an explanation.
Pick the unit that matches the level you are writing at: subsystems at repository level, responsibilities or
internal units inside a component, and individual files only when you are explaining a single directory. Never
title a section by counting files ("the seven files and what flows between them"); title it by the concept it
explains.

${DIAGRAM_RULES}

${JSON_RULES}

The final explainer JSON must have exactly this shape:
${EXPLAINER_CONTRACT}

${scopeRequirements(task.scope)}
${siblings}${next}
${task.extraInstructions ? `\n${task.extraInstructions}\n` : ''}
## Response protocol

Reply with EXACTLY ONE JSON object per turn, and nothing else.

To use a tool:
  {"thought": "<what you want to learn and why, one or two sentences>", "tool": "<tool name>", "args": { ... }}

To finish:
  {"final": { ...the complete explainer object... }}

There is no tool called "final". "final" is a key in the response object, never a value of "tool".

## Available tools

${toolCatalogue()}

## Rules

1. Investigate before writing. A reader will check your claims against the code.
2. Never repeat a tool call you have already made — the answer will be identical.
3. You have a budget of ${budget} tool calls. Use them where they change what you would write.
4. Keep "thought" short: it is a working note, not the explainer.
5. Every "code" section must be copied verbatim from code you have actually read with a tool, with the correct "file" and "startLine".
6. Five quiz questions, medium difficulty — they should require understanding the substance, not trivia or gotchas.
7. The "tldr" must stand alone: if the reader reads only that, they should still be able to hold a sensible conversation about this subject.
8. When your budget is nearly spent, stop investigating and write the explainer with what you have.
9. Use names exactly as the tool output gives them. Never substitute a more familiar product for the one that
   is actually there — if the code says OpenSearch, do not write Elasticsearch; if it says MariaDB, do not write
   MySQL. Never name a technology that did not appear in a tool observation. This applies to the quiz too.`;
}

export function agentUserPrompt(task: AgentTaskLike): string {
  return `# Your task

${task.goal}

---

${task.seed}

---

Begin. Investigate first, then write the explainer.`;
}

/** Seed block for a change, used as the agent's starting context. */
export function changeSeed(change: Change, diff: string, history: string): string {
  const commits = change.commits
    .slice(0, 25)
    .map((commit) => `- ${commit.short} ${commit.subject} — ${commit.author}, ${commit.date?.slice(0, 10)}`)
    .join('\n');

  return `## The change

Kind: ${change.kind}
Title: ${change.title}
${change.subtitle ? `Subtitle: ${change.subtitle}` : ''}
Base: ${change.base} → Head: ${change.head}
Stats: ${change.stats.files} files changed, +${change.stats.additions} / -${change.stats.deletions}
${change.author ? `Author: ${change.author}` : ''}

${change.body ? `### Description\n${change.body.slice(0, 6000)}\n` : ''}
${commits ? `### Commits\n${commits}\n` : ''}
### Changed files
${change.files
  .slice(0, 60)
  .map((file) => `- ${file.status} ${file.path} (+${file.additions}/-${file.deletions})${file.oldPath ? ` (was ${file.oldPath})` : ''}`)
  .join('\n')}

${history ? `### History of the touched files\n${history.slice(0, 3000)}\n` : ''}
### Diff

\`\`\`diff
${diff.slice(0, 80_000)}
\`\`\``;
}
