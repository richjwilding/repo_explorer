import type {
  Diagram,
  DiagramTreeNode,
  Explainer,
  ExplainerKind,
  ExplainerSection,
  ExplainerTarget,
  QuizQuestion,
} from '../types.js';
import { slugify } from '../util/id.js';
import { truncate } from '../util/text.js';
import { log } from '../logger.js';

export const EXPLAINER_VERSION = 1;

/** The JSON contract we ask models to emit. Kept as a string so it can be embedded in prompts. */
export const EXPLAINER_CONTRACT = `{
  "title": string,                       // short, concrete title
  "subtitle": string,                    // one line of positioning
  "tldr": string,                        // 2-4 sentences a busy CTO could read alone
  "sections": [ Section, ... ],          // 6-14 sections, ordered for a reader new to the code
  "quiz": [ QuizQuestion, ... ],         // exactly 5 questions, medium difficulty
  "next": [ { "label": string, "hint": string } ],  // 2-6 things worth exploring next
  "sources": [ { "path": string, "startLine": number, "endLine": number } ]
}

Section is one of:
  { "type": "prose",   "title": string, "markdown": string, "level": "deep" | "narrow" }
  { "type": "callout", "title": string, "variant": "concept" | "warning" | "edge" | "tip", "markdown": string }
  { "type": "diagram", "title": string, "caption": string, "diagram": Diagram }
  { "type": "code",    "title": string, "language": string, "file": string, "startLine": number, "code": string, "caption": string, "highlights": number[] }
  { "type": "list",    "title": string, "items": [ { "term": string, "detail": string } ] }
  { "type": "steps",   "title": string, "steps": [ { "label": string, "detail": string } ] }
  { "type": "table",   "title": string, "headers": string[], "rows": string[][] }

Diagram is one of:
  { "kind": "flow", "direction": "horizontal" | "vertical",
    "nodes": [ { "id": string, "label": string, "sub": string, "tone": "primary"|"accent"|"muted"|"danger"|"success" } ],
    "edges": [ { "from": id, "to": id, "label": string, "dashed": boolean } ],
    "example": string }
  { "kind": "layers",
    "layers": [ { "label": string, "hint": string, "items": [ { "label": string, "sub": string, "tone": Tone } ] } ] }
  { "kind": "tree", "root": TreeNode }         // TreeNode = { label, sub, tone, children: TreeNode[] }
  { "kind": "compare", "left": { "title": string, "items": string[], "tone": Tone },
                       "right": { "title": string, "items": string[], "tone": Tone } }
  { "kind": "sequence", "actors": [ { "id": string, "label": string, "tone": Tone } ],
    "steps": [ { "from": id, "to": id, "label": string } ], "example": string }
  { "kind": "ui", "title": string, "regions": [ { "id": string, "label": string, "detail": string, "tone": Tone } ] }

QuizQuestion = { "question": string, "options": [string, string, string, string], "answer": 0-3, "explanation": string }`;

export interface NormalizeContext {
  kind: ExplainerKind;
  target: ExplainerTarget;
  provider: string;
  model: string;
  sources: { path: string; startLine?: number; endLine?: number }[];
  next: { id: string; label: string; kind: ExplainerKind; hint: string }[];
  degraded?: boolean;
  tokens?: { prompt: number; completion: number };
}

const TONES = new Set(['primary', 'accent', 'muted', 'danger', 'success']);
type Tone = 'primary' | 'accent' | 'muted' | 'danger' | 'success';

const FILE_LABEL = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|scala|cs|fs|php|swift|c|cc|cpp|h|hpp|sql|sh|bash|zsh|ps1|css|scss|less|html|vue|svelte|astro|json|jsonc|ya?ml|toml|ini|tf|tfvars|md|mdx|rst|txt|proto|graphql|gql)$/i;

/**
 * Turn a filename into the responsibility it holds.
 *
 * A diagram node labelled `generate.ts` tells the reader where something lives,
 * not what it does — and at component or system level that is the wrong unit.
 * The filename is kept, moved into the subtitle where it is still useful.
 */
function humaniseStem(label: string): string {
  const stem = label.replace(/\.[^.]+$/, '').trim();
  const words = stem
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[-_.\s]+/)
    .filter(Boolean);
  return words.map((word, index) => (index === 0 ? word : word.toLowerCase())).join(' ');
}

function humaniseNodeLabel(label: string, sub?: string): { label: string; sub?: string } {
  if (!FILE_LABEL.test(label.trim())) return sub === undefined ? { label } : { label, sub };
  const humanised = humaniseStem(label);
  const where = sub ? `${label} — ${sub}` : label;
  return { label: humanised || label, sub: where };
}

/**
 * The same treatment for Mermaid source, where labels are inline.
 *
 * Only quoted strings that are exactly a filename are rewritten, so message
 * text, ids and directives are untouched.
 */
export function humaniseMermaidLabels(code: string): string {
  return code.replace(/(["'])([^"'\n]{1,200})\1/g, (match: string, quote: string, label: string) => {
    // Labels are often two lines: a filename, then what it does. Only the
    // filename needs replacing, and the description is left intact.
    const segments = label.split('\\n');
    const first = segments[0].trim();
    if (!FILE_LABEL.test(first)) return match;
    const humanised = humaniseStem(first);
    if (!humanised) return match;
    if (segments.length === 1) return `${quote}${humanised}${quote}`;
    return `${quote}${humanised}\\n${segments.slice(1).join('\\n')}${quote}`;
  });
}

/**
 * Models frequently reference diagram nodes by label rather than by id. Both are
 * unambiguous to a human, so accept either instead of silently dropping half the
 * diagram.
 */
function resolveNodeRef(value: string, nodes: { id: string; label: string }[]): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (nodes.some((node) => node.id === raw)) return raw;
  const lower = raw.toLowerCase();
  const byLabel = nodes.find((node) => node.label.toLowerCase() === lower);
  if (byLabel) return byLabel.id;
  const bySlug = nodes.find(
    (node) => node.id.toLowerCase() === lower || node.label.toLowerCase().replace(/[^a-z0-9]+/g, '-') === lower,
  );
  if (bySlug) return bySlug.id;
  const partial = nodes.find((node) => lower.length > 3 && node.label.toLowerCase().includes(lower));
  return partial?.id ?? null;
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function asTone(value: unknown): Tone | undefined {
  const tone = asString(value, '');
  return TONES.has(tone) ? (tone as Tone) : undefined;
}

interface DiagramNodeLike {
  id: string;
  label: string;
  sub?: string;
  tone?: Tone;
}

function mapNodes(raw: unknown, limit: number): DiagramNodeLike[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, limit)
    .map((node, index) => {
      const n = node as Record<string, unknown>;
      const id = asString(n.id) || `n${index}`;
      const original = truncate(asString(n.label, id), 60, '…');
      const originalSub = n.sub ? truncate(asString(n.sub), 120, '…') : undefined;
      const humanised = humaniseNodeLabel(original, originalSub);
      return { id, label: humanised.label, sub: humanised.sub, tone: asTone(n.tone) };
    })
    .filter((node) => node.label.length > 0);
}

function normalizeDiagram(raw: unknown): Diagram | null {
  if (!raw || typeof raw !== 'object') return null;
  const diagram = raw as Record<string, unknown>;
  const kind = asString(diagram.kind, '');

  if (kind === 'flow') {
    const nodes = mapNodes(diagram.nodes, 14);
    if (nodes.length < 2) return null;
    const edges = (Array.isArray(diagram.edges) ? diagram.edges : [])
      .slice(0, 24)
      .map((edge) => {
        const e = edge as Record<string, unknown>;
        const from = resolveNodeRef(asString(e.from), nodes);
        const to = resolveNodeRef(asString(e.to), nodes);
        if (!from || !to || from === to) return null;
        const label = e.label ? truncate(asString(e.label), 40, '…') : undefined;
        const dashed = Boolean(e.dashed) || undefined;
        const mapped: { from: string; to: string; label?: string; dashed?: boolean } = { from, to };
        if (label) mapped.label = label;
        if (dashed) mapped.dashed = dashed;
        return mapped;
      })
      .filter((edge): edge is { from: string; to: string; label?: string; dashed?: boolean } => edge !== null);

    return {
      kind: 'flow',
      direction: asString(diagram.direction) === 'vertical' ? 'vertical' : 'horizontal',
      nodes,
      edges: edges.length > 0 ? edges : nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id })),
      example: diagram.example ? truncate(asString(diagram.example), 200, '…') : undefined,
    };
  }

  if (kind === 'layers') {
    const layers = (Array.isArray(diagram.layers) ? diagram.layers : []).slice(0, 8).map((layer) => {
      const l = layer as Record<string, unknown>;
      const items = (Array.isArray(l.items) ? l.items : []).slice(0, 10).map((item) => {
        const i = item as Record<string, unknown>;
        const humanised = humaniseNodeLabel(truncate(asString(i.label), 70, '…'), i.sub ? truncate(asString(i.sub), 140, '…') : undefined);
        return { label: humanised.label, sub: humanised.sub, tone: asTone(i.tone) };
      });
      return {
        label: truncate(asString(l.label), 60, '…'),
        hint: l.hint ? truncate(asString(l.hint), 160, '…') : undefined,
        items,
      };
    });
    return layers.length > 0 ? { kind: 'layers', layers } : null;
  }

  if (kind === 'tree') {
    const build = (node: unknown, depth: number): DiagramTreeNode | null => {
      if (!node || typeof node !== 'object' || depth > 4) return null;
      const n = node as Record<string, unknown>;
      const children = (Array.isArray(n.children) ? n.children : [])
        .slice(0, 12)
        .map((child) => build(child, depth + 1))
        .filter((child): child is DiagramTreeNode => child !== null);
      const rawLabel = truncate(asString(n.label), 70, '…');
      if (!rawLabel) return null;
      const humanised = humaniseNodeLabel(rawLabel, n.sub ? truncate(asString(n.sub), 140, '…') : undefined);
      const label = humanised.label;
      const result: DiagramTreeNode = { label, tone: asTone(n.tone) };
      const sub = humanised.sub;
      if (sub) result.sub = sub;
      if (children.length > 0) result.children = children;
      return result;
    };
    const root = build(diagram.root, 0);
    return root ? { kind: 'tree', root } : null;
  }

  if (kind === 'compare') {
    const side = (value: unknown, fallbackTitle: string) => {
      const s = (value ?? {}) as Record<string, unknown>;
      return {
        title: truncate(asString(s.title, fallbackTitle), 60, '…'),
        items: (Array.isArray(s.items) ? s.items : []).slice(0, 10).map((item) => truncate(asString(item), 220, '…')),
        tone: asTone(s.tone),
      };
    };
    return { kind: 'compare', left: side(diagram.left, 'Before'), right: side(diagram.right, 'After') };
  }

  if (kind === 'sequence') {
    const actors = mapNodes(diagram.actors, 8);
    const steps = (Array.isArray(diagram.steps) ? diagram.steps : [])
      .slice(0, 16)
      .map((step) => {
        const s = step as Record<string, unknown>;
        const from = resolveNodeRef(asString(s.from), actors);
        const to = resolveNodeRef(asString(s.to), actors);
        if (!from || !to) return null;
        return { from, to, label: truncate(asString(s.label), 140, '…') };
      })
      .filter((step): step is { from: string; to: string; label: string } => step !== null);
    if (actors.length < 2 || steps.length === 0) return null;
    return {
      kind: 'sequence',
      actors,
      steps,
      example: diagram.example ? truncate(asString(diagram.example), 200, '…') : undefined,
    };
  }

  if (kind === 'mermaid') {
    const code = asString(diagram.code).trim();
    if (!code) return null;
    const first = code.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
    const diagramType = first.split(/[\s{]/)[0].toLowerCase();
    const SUPPORTED = new Set([
      'flowchart', 'graph', 'sequencediagram', 'classdiagram', 'statediagram', 'statediagram-v2',
      'erdiagram', 'journey', 'gitgraph', 'mindmap', 'timeline', 'quadrantchart', 'c4context',
      'block-beta', 'pie', 'xychart-beta', 'sankey-beta',
    ]);
    if (!SUPPORTED.has(diagramType)) {
      log.debug(`dropped a mermaid diagram with an unsupported type "${diagramType}"`);
      return null;
    }
    return {
      kind: 'mermaid',
      diagramType,
      // A node labelled "generate.ts" says where code lives, not what it does.
      code: truncate(humaniseMermaidLabels(code), 6000, '\n%% [truncated]'),
      caption: diagram.caption ? truncate(asString(diagram.caption), 300, '…') : undefined,
    };
  }

  if (kind === 'ui') {
    const regions = (Array.isArray(diagram.regions) ? diagram.regions : [])
      .slice(0, 10)
      .map((region, index) => {
        const r = region as Record<string, unknown>;
        return {
          id: asString(r.id) || `r${index}`,
          label: truncate(asString(r.label), 50, '…'),
          detail: truncate(asString(r.detail), 260, '…'),
          tone: asTone(r.tone),
        };
      })
      .filter((region) => region.label.length > 0);
    return regions.length > 0
      ? { kind: 'ui', title: truncate(asString(diagram.title, 'Interface'), 60, '…'), regions }
      : null;
  }

  return null;
}

function normalizeQuiz(raw: unknown): QuizQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 8)
    .map((item, index) => {
      const q = item as Record<string, unknown>;
      const options = (Array.isArray(q.options) ? q.options : []).slice(0, 6).map((o) => truncate(asString(o), 400, '…'));
      if (options.length < 2) return null;
      let answer = typeof q.answer === 'number' ? q.answer : Number.parseInt(asString(q.answer, '0'), 10);
      if (!Number.isFinite(answer) || answer < 0 || answer >= options.length) answer = 0;
      return {
        id: `q${index + 1}`,
        question: truncate(asString(q.question), 600, '…'),
        options,
        answer,
        explanation: truncate(asString(q.explanation), 900, '…'),
      } satisfies QuizQuestion;
    })
    .filter((q): q is QuizQuestion => q !== null && q.question.length > 0);
}

/**
 * Drop a leading file-count from a section title.
 *
 * "Seven files, four responsibilities" leads with the wrong unit — the reader
 * asked what the parts do, not how many files there are. The rest of the title
 * is kept, and a title that is only a count is left alone rather than invented.
 */
export function cleanSectionTitle(title: string): string {
  // The count is often a word ("Seven files, four responsibilities").
  const match = title.match(/^\s*(?:the\s+)?(?:\d+|[a-z]+)\s+(?:sub-)?files?\b\s*(?:,|—|–|-|:|\.)\s*(.+)$/i);
  if (!match) return title;
  const rest = match[1].trim();
  return rest.length >= 8 ? rest[0].toUpperCase() + rest.slice(1) : title;
}

function normalizeSections(raw: unknown): ExplainerSection[] {
  if (!Array.isArray(raw)) return [];
  const sections: ExplainerSection[] = [];
  const seen = new Set<string>();
  raw.slice(0, 26).forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const section = item as Record<string, unknown>;
    const type = asString(section.type, '');
    const title = cleanSectionTitle(truncate(asString(section.title, `Section ${index + 1}`), 140, '…'));
    const id = `s${index + 1}`;
    const dedupeKey = `${type}:${title.toLowerCase()}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    if (type === 'prose') {
      const markdown = truncate(asString(section.markdown), 14_000, '\n… [truncated]');
      if (!markdown.trim()) return;
      sections.push({
        type: 'prose',
        id,
        title,
        markdown,
        level: asString(section.level) === 'deep' ? 'deep' : 'narrow',
        collapsible: asString(section.level) === 'deep',
      });
    } else if (type === 'callout') {
      const markdown = truncate(asString(section.markdown), 3000, '…');
      if (!markdown.trim()) return;
      const variant = asString(section.variant, 'concept');
      sections.push({
        type: 'callout',
        id,
        title,
        variant: ['concept', 'warning', 'edge', 'tip'].includes(variant) ? (variant as 'concept') : 'concept',
        markdown,
      });
    } else if (type === 'diagram') {
      const diagram = normalizeDiagram(section.diagram);
      if (!diagram) {
        // Silent drops are impossible to debug later; say why.
        log.debug(
          `dropped an unusable diagram section ("${title}"): ${truncate(JSON.stringify(section.diagram ?? null), 260, '…')}`,
        );
        return;
      }
      sections.push({ type: 'diagram', id, title, caption: section.caption ? truncate(asString(section.caption), 300, '…') : undefined, diagram });
    } else if (type === 'code') {
      const code = truncate(asString(section.code), 12_000, '\n… [truncated]');
      if (!code.trim()) return;
      sections.push({
        type: 'code',
        id,
        title,
        language: asString(section.language, 'plaintext') || 'plaintext',
        file: section.file ? asString(section.file) : undefined,
        startLine: typeof section.startLine === 'number' ? section.startLine : undefined,
        code,
        caption: section.caption ? truncate(asString(section.caption), 400, '…') : undefined,
        highlights: Array.isArray(section.highlights) ? section.highlights.filter((h) => typeof h === 'number').slice(0, 40) as number[] : undefined,
      });
    } else if (type === 'list') {
      const items = (Array.isArray(section.items) ? section.items : [])
        .slice(0, 16)
        .map((entry) => {
          const e = entry as Record<string, unknown>;
          return { term: truncate(asString(e.term), 120, '…'), detail: truncate(asString(e.detail), 700, '…') };
        })
        .filter((e) => e.term);
      if (items.length === 0) return;
      sections.push({ type: 'list', id, title, items });
    } else if (type === 'steps') {
      const steps = (Array.isArray(section.steps) ? section.steps : [])
        .slice(0, 14)
        .map((entry) => {
          const e = entry as Record<string, unknown>;
          return { label: truncate(asString(e.label), 120, '…'), detail: truncate(asString(e.detail), 800, '…') };
        })
        .filter((e) => e.label);
      if (steps.length === 0) return;
      sections.push({ type: 'steps', id, title, steps });
    } else if (type === 'table') {
      const headers = (Array.isArray(section.headers) ? section.headers : []).slice(0, 8).map((h) => truncate(asString(h), 60, '…'));
      const rows = (Array.isArray(section.rows) ? section.rows : [])
        .slice(0, 20)
        .map((row) => (Array.isArray(row) ? row.slice(0, headers.length || 8).map((cell) => truncate(asString(cell), 240, '…')) : []));
      if (headers.length === 0 || rows.length === 0) return;
      sections.push({ type: 'table', id, title, headers, rows });
    }
  });
  return sections;
}

/**
 * Turn loose model output into a valid Explainer. Any unusable section is
 * dropped rather than failing the whole request.
 */
export function normalizeExplainer(raw: unknown, ctx: NormalizeContext): Explainer {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const title = truncate(asString(obj.title, ctx.target.label), 160, '…');
  const subtitle = truncate(asString(obj.subtitle, ''), 240, '…');
  const tldr = truncate(asString(obj.tldr, ''), 1200, '…');
  const sections = normalizeSections(obj.sections);

  // A quiz may arrive as its own top-level field or as a section.
  let quiz = normalizeQuiz(obj.quiz ?? obj.questions);
  if (quiz.length === 0) {
    const quizSection = sections.find((s) => s.type === 'quiz');
    if (quizSection && quizSection.type === 'quiz') quiz = quizSection.questions;
  }
  if (quiz.length > 0) {
    sections.push({ type: 'quiz', id: 'quiz', title: 'Check your understanding', questions: quiz });
  }

  const modelNext = Array.isArray(obj.next)
    ? obj.next
        .slice(0, 8)
        .map((item) => {
          const n = item as Record<string, unknown>;
          return { label: truncate(asString(n.label), 120, '…'), hint: truncate(asString(n.hint), 300, '…') };
        })
        .filter((n) => n.label)
    : [];

  const next = [...ctx.next];
  const known = new Set(next.map((n) => n.label.toLowerCase()));
  for (const suggestion of modelNext) {
    if (next.length >= 8) break;
    if (known.has(suggestion.label.toLowerCase())) continue;
    next.push({ id: `llm:${slugify(suggestion.label)}`, label: suggestion.label, kind: 'module', hint: suggestion.hint });
  }

  const sources = Array.isArray(obj.sources)
    ? obj.sources
        .slice(0, 30)
        .map((item) => {
          const s = item as Record<string, unknown>;
          return { path: asString(s.path), startLine: typeof s.startLine === 'number' ? s.startLine : undefined, endLine: typeof s.endLine === 'number' ? s.endLine : undefined };
        })
        .filter((s) => s.path)
    : [];

  return {
    id: `${ctx.kind}:${ctx.target.id}`,
    version: EXPLAINER_VERSION,
    kind: ctx.kind,
    target: ctx.target,
    title,
    subtitle,
    tldr,
    sections,
    next,
    sources: sources.length > 0 ? sources : ctx.sources,
    model: ctx.model,
    provider: ctx.provider,
    generatedAt: new Date().toISOString(),
    degraded: ctx.degraded,
    tokens: ctx.tokens,
  };
}

export function explainerIsUsable(explainer: Explainer): boolean {
  const hasContent = explainer.sections.some((s) => s.type !== 'quiz');
  return Boolean(explainer.tldr) && hasContent;
}
