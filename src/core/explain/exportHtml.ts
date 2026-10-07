import { marked } from 'marked';
import type { Diagram, Explainer, ExplainerSection, QuizQuestion, RepoModel } from '../types.js';
import { escapeHtml } from '../util/text.js';
import { mermaidSvgKey } from './mermaidKey.js';
import { isoDate, slugify } from '../util/id.js';

/**
 * Renders an explainer as a single self-contained HTML file.
 *
 * This mirrors the "explain-diff-html" convention: one long page with a table
 * of contents, real HTML/CSS diagrams (never ASCII art), and an interactive
 * multiple-choice quiz. The file is written outside the analysed repository so
 * it never ends up in version control by accident.
 */

marked.setOptions({ gfm: true, breaks: false });

function renderMarkdown(markdown: string): string {
  // Escape raw HTML so model output can never inject markup, then let marked
  // handle the markdown subset we actually use.
  const safe = markdown.replace(/</g, '&lt;');
  try {
    return marked.parse(safe, { async: false }) as string;
  } catch {
    return `<p>${escapeHtml(markdown)}</p>`;
  }
}

function toneClass(tone?: string): string {
  return tone ? ` tone-${tone}` : '';
}

/* ------------------------------------------------------------------ *
 * Diagrams
 * ------------------------------------------------------------------ */

function renderDiagram(diagram: Diagram, svgs: Record<string, string> = {}): string {
  switch (diagram.kind) {
    case 'flow': {
      const edges = diagram.edges;
      const arrowFor = (from: string, to: string) => edges.find((e) => e.from === from && e.to === to);
      const reverseFor = (from: string, to: string) => edges.find((e) => e.from === to && e.to === from);
      const nodes = diagram.nodes.map((node, index) => {
        const next = diagram.nodes[index + 1];
        const forward = next ? arrowFor(node.id, next.id) : undefined;
        const backward = next ? (forward ? undefined : reverseFor(node.id, next.id)) : undefined;
        const arrow = forward || backward;
        return `${nodeHtml(node)}${arrow ? arrowHtml(arrow.label, Boolean(arrow.dashed), Boolean(backward)) : next ? '<div class="flow-arrow muted">·</div>' : ''}`;
      });
      const otherEdges = edges.filter(
        (e) => !diagram.nodes.some((n, i) => diagram.nodes[i + 1] && ((n.id === e.from && diagram.nodes[i + 1].id === e.to) || (n.id === e.to && diagram.nodes[i + 1].id === e.from))),
      );
      return `<div class="diagram diagram-flow ${diagram.direction === 'vertical' ? 'vertical' : ''}">${nodes.join('')}</div>${
        otherEdges.length > 0
          ? `<ul class="edge-list">${otherEdges
              .map((e) => `<li><code>${escapeHtml(labelFor(diagram, e.from))}</code> → <code>${escapeHtml(labelFor(diagram, e.to))}</code>${e.label ? ` — ${escapeHtml(e.label)}` : ''}</li>`)
              .join('')}</ul>`
          : ''
      }${diagram.example ? `<p class="diagram-example"><strong>Example:</strong> ${escapeHtml(diagram.example)}</p>` : ''}`;
    }
    case 'layers':
      return `<div class="diagram diagram-layers">${diagram.layers
        .map(
          (layer) => `<div class="layer">
  <div class="layer-head"><span class="layer-label">${escapeHtml(layer.label)}</span>${layer.hint ? `<span class="layer-hint">${escapeHtml(layer.hint)}</span>` : ''}</div>
  <div class="layer-items">${layer.items
    .map((item) => `<span class="pill${toneClass(item.tone)}"${item.sub ? ` title="${escapeHtml(item.sub)}"` : ''}>${escapeHtml(item.label)}</span>`)
    .join('')}</div>
</div>`,
        )
        .join('')}</div>`;
    case 'tree': {
      const render = (node: NonNullable<Extract<Diagram, { kind: 'tree' }>['root']>): string =>
        `<li><span class="tree-label${toneClass(node.tone)}">${escapeHtml(node.label)}</span>${
          node.sub ? ` <span class="tree-sub">${escapeHtml(node.sub)}</span>` : ''
        }${node.children && node.children.length > 0 ? `<ul>${node.children.map(render).join('')}</ul>` : ''}</li>`;
      return `<div class="diagram diagram-tree"><ul class="tree">${render(diagram.root)}</ul></div>`;
    }
    case 'compare':
      return `<div class="diagram diagram-compare">
  <div class="compare-side${toneClass(diagram.left.tone ?? 'danger')}"><h4>${escapeHtml(diagram.left.title)}</h4><ul>${diagram.left.items
        .map((i) => `<li>${escapeHtml(i)}</li>`)
        .join('')}</ul></div>
  <div class="compare-side${toneClass(diagram.right.tone ?? 'success')}"><h4>${escapeHtml(diagram.right.title)}</h4><ul>${diagram.right.items
        .map((i) => `<li>${escapeHtml(i)}</li>`)
        .join('')}</ul></div>
</div>`;
    case 'sequence':
      return `<div class="diagram diagram-sequence">
  <div class="actors">${diagram.actors.map((a) => `<span class="pill${toneClass(a.tone)}">${escapeHtml(a.label)}</span>`).join('')}</div>
  <ol class="sequence-steps">${diagram.steps
    .map((s) => `<li><span class="seq-route">${escapeHtml(labelForActors(diagram, s.from))} → ${escapeHtml(labelForActors(diagram, s.to))}</span><span class="seq-label">${escapeHtml(s.label)}</span></li>`)
    .join('')}</ol>
  ${diagram.example ? `<p class="diagram-example"><strong>Example:</strong> ${escapeHtml(diagram.example)}</p>` : ''}
</div>`;
    case 'mermaid': {
      // The browser rendered this to SVG and sent it along, which keeps the
      // exported file small, offline and readable without JavaScript. Without an
      // SVG the source is shown rather than an empty box.
      const svg = svgs[mermaidSvgKey(diagram.code)];
      const caption = diagram.caption ? `<p class="caption">${escapeHtml(diagram.caption)}</p>` : '';
      if (svg) return `<div class="diagram diagram-mermaid"><div class="mermaid-svg">${svg}</div>${caption}</div>`;
      return `<div class="diagram diagram-mermaid"><pre class="mermaid-source">${escapeHtml(
        diagram.code,
      )}</pre>${caption}<p class="caption">Open this explainer in Repo Explorer to see it drawn.</p></div>`;
    }
    case 'ui':
      return `<div class="diagram diagram-ui"><div class="ui-frame"><div class="ui-titlebar">${escapeHtml(diagram.title)}</div>${diagram.regions
        .map((r) => `<div class="ui-region${toneClass(r.tone)}"><strong>${escapeHtml(r.label)}</strong><span>${escapeHtml(r.detail)}</span></div>`)
        .join('')}</div></div>`;
  }
}

function nodeHtml(node: Extract<Diagram, { kind: 'flow' }>['nodes'][number]): string {
  return `<div class="flow-node${toneClass(node.tone)}"><span class="flow-label">${escapeHtml(node.label)}</span>${
    node.sub ? `<span class="flow-sub">${escapeHtml(node.sub)}</span>` : ''
  }</div>`;
}

function arrowHtml(label: string | undefined, dashed: boolean, reverse: boolean): string {
  return `<div class="flow-arrow${dashed ? ' dashed' : ''}">${reverse ? '←' : '→'}${label ? `<span class="arrow-label">${escapeHtml(label)}</span>` : ''}</div>`;
}

function labelFor(diagram: Extract<Diagram, { kind: 'flow' }>, id: string): string {
  return diagram.nodes.find((n) => n.id === id)?.label ?? id;
}

function labelForActors(diagram: Extract<Diagram, { kind: 'sequence' }>, id: string): string {
  return diagram.actors.find((a) => a.id === id)?.label ?? id;
}

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

function renderSection(section: ExplainerSection, prefix = '', svgs: Record<string, string> = {}): string {
  switch (section.type) {
    case 'prose':
      return `<section class="card" id="${prefix}${section.id}">
  <h3>${escapeHtml(section.title)}${section.level === 'deep' ? ' <span class="badge">background</span>' : ''}</h3>
  <div class="prose">${renderMarkdown(section.markdown)}</div>
</section>`;
    case 'callout':
      return `<section class="callout callout-${section.variant}" id="${prefix}${section.id}">
  <h4>${escapeHtml(section.title)}</h4>
  <div class="prose">${renderMarkdown(section.markdown)}</div>
</section>`;
    case 'diagram':
      return `<section class="card" id="${prefix}${section.id}">
  <h3>${escapeHtml(section.title)}</h3>
  ${renderDiagram(section.diagram, svgs)}
  ${section.caption ? `<p class="caption">${escapeHtml(section.caption)}</p>` : ''}
</section>`;
    case 'code': {
      const lines = section.code.split('\n');
      const highlights = new Set(section.highlights ?? []);
      const body = section.code.includes('\n')
        ? `<pre class="code"><code>${lines
            .map((line, index) => `<span class="code-line${highlights.has(index + 1) ? ' highlighted' : ''}">${escapeHtml(line)}</span>`)
            .join('\n')}</code></pre>`
        : `<pre class="code"><code>${escapeHtml(section.code)}</code></pre>`;
      return `<section class="card" id="${prefix}${section.id}">
  <h3>${escapeHtml(section.title)}</h3>
  ${body}
  ${section.file ? `<p class="caption"><code>${escapeHtml(section.file)}</code>${section.startLine ? ` from line ${section.startLine}` : ''}</p>` : ''}
  ${section.caption ? `<p class="caption">${escapeHtml(section.caption)}</p>` : ''}
</section>`;
    }
    case 'list':
      return `<section class="card" id="${prefix}${section.id}">
  <h3>${escapeHtml(section.title)}</h3>
  <dl class="term-list">${section.items.map((item) => `<dt>${renderMarkdown(item.term)}</dt><dd>${renderMarkdown(item.detail)}</dd>`).join('')}</dl>
</section>`;
    case 'steps':
      return `<section class="card" id="${prefix}${section.id}">
  <h3>${escapeHtml(section.title)}</h3>
  <ol class="steps">${section.steps.map((step) => `<li><strong>${renderMarkdown(step.label)}</strong><div class="prose">${renderMarkdown(step.detail)}</div></li>`).join('')}</ol>
</section>`;
    case 'table':
      return `<section class="card" id="${prefix}${section.id}">
  <h3>${escapeHtml(section.title)}</h3>
  <div class="table-wrap"><table><thead><tr>${section.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
  <tbody>${section.rows.map((row) => `<tr>${row.map((cell) => `<td>${renderMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
</section>`;
    case 'quiz':
      return renderQuiz(section.title, section.questions, `${prefix}${section.id}`);
  }
}

function renderQuiz(title: string, questions: QuizQuestion[], id: string): string {
  return `<section class="card quiz" id="${id}">
  <h3>${escapeHtml(title)}</h3>
  <p class="caption">Pick an answer to see whether you were right. Nothing is scored or sent anywhere.</p>
  ${questions
    .map(
      (question, questionIndex) => `<div class="quiz-question" data-answer="${question.answer}" data-explanation="${escapeHtml(
        question.explanation,
      )}">
  <p class="quiz-prompt"><span class="quiz-number">Q${questionIndex + 1}</span> ${escapeHtml(question.question)}</p>
  <div class="quiz-options">${question.options
    .map((option, optionIndex) => `<button type="button" class="quiz-option" data-index="${optionIndex}">${escapeHtml(option)}</button>`)
    .join('')}</div>
  <p class="quiz-feedback" hidden></p>
</div>`,
    )
    .join('')}
</section>`;
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export interface ExportMeta {
  repoName: string;
  repoPath: string;
  branch?: string | null;
  head?: string | null;
  generatedAt: string;
  provider: string;
  model: string;
}

/** A child explainer embedded in the same file, reachable from "Where to go next". */
export interface EmbeddedExplainer {
  explainer: Explainer;
  /** Label shown in navigation; defaults to the child's title. */
  label?: string;
}

function childAnchor(index: number): string {
  return `go-${index}`;
}

function renderChild(child: EmbeddedExplainer, index: number, svgs: Record<string, string> = {}): string {
  const prefix = `${childAnchor(index)}-`;
  const { explainer } = child;
  const body = explainer.sections.map((section) => renderSection(section, prefix, svgs)).join('\n');
  return `<section class="child" id="${childAnchor(index)}">
  <header class="child-head">
    <p class="eyebrow">${escapeHtml(explainer.kind.replace(/-/g, ' '))} · deeper</p>
    <h2>${escapeHtml(child.label ?? explainer.title)}</h2>
    ${explainer.subtitle ? `<p class="subtitle">${escapeHtml(explainer.subtitle)}</p>` : ''}
    ${explainer.tldr ? `<div class="tldr">${renderMarkdown(explainer.tldr)}</div>` : ''}
    <p class="meta">Generated ${escapeHtml(new Date(explainer.generatedAt).toLocaleString())} by ${escapeHtml(
      explainer.provider,
    )} (${escapeHtml(explainer.model)})${explainer.degraded ? ' · static analysis only' : ''}</p>
    <p class="backlink"><a href="#top">&uarr; Back to the top</a></p>
  </header>
  ${body}
</section>`;
}

function renderNextSection(explainer: Explainer, children: EmbeddedExplainer[]): string {
  if (explainer.next.length === 0) return '';
  const included = new Map(explainer.next.slice(0, children.length).map((item, index) => [index, item]));

  const linked = children
    .map((child, index) => {
      const item = included.get(index);
      const label = child.label ?? item?.label ?? child.explainer.title;
      const hint = item?.hint ?? child.explainer.subtitle ?? '';
      return `<li><a class="next-link" href="#${childAnchor(index)}"><span class="next-label">${escapeHtml(
        label,
      )}</span>${hint ? `<span class="next-hint">${escapeHtml(hint)}</span>` : ''}</a></li>`;
    })
    .join('');

  const missing = explainer.next.slice(children.length);

  return `<section class="card" id="next">
  <h3>Where to go next</h3>
  ${
    children.length > 0
      ? `<p class="caption">These are written out in full below, in this same file.</p><ul class="next-list">${linked}</ul>`
      : '<p class="caption">No deeper explainers were included in this export.</p>'
  }
  ${
    missing.length > 0
      ? `<p class="caption muted">Not included here: ${missing
          .map((item) => escapeHtml(item.label))
          .join(', ')}. Regenerate this export with deeper detail, or open the target in Repo Explorer, to get them.</p>`
      : ''
  }
</section>`;
}

export function renderExplainerHtml(
  explainer: Explainer,
  meta: ExportMeta,
  children: EmbeddedExplainer[] = [],
  svgs: Record<string, string> = {},
): string {
  // Quizzes are rendered after all the content, so keep them out of the main run.
  const topSections = explainer.sections.filter((section) => section.type !== 'quiz');
  const quizSections = explainer.sections.filter((section) => section.type === 'quiz' && section.questions.length > 0);
  const toc = [...topSections, ...quizSections]
    .map((section) => `<li><a href="#${section.id}">${escapeHtml(section.title)}</a></li>`)
    .join('');

  const childToc =
    children.length > 0
      ? `<li class="toc-group">Deeper<ol>${children
          .map((child, index) => `<li><a href="#${childAnchor(index)}">${escapeHtml(child.label ?? child.explainer.title)}</a></li>`)
          .join('')}</ol></li>`
      : '';

  const body = topSections.map((section) => renderSection(section, '', svgs)).join('\n');
  const quiz = quizSections.map((section) => renderSection(section, '', svgs)).join('\n');

  const next = renderNextSection(explainer, children);

  const sources =
    explainer.sources.length > 0
      ? `<section class="card"><h3>Sources</h3><ul class="sources">${explainer.sources
          .map(
            (source) =>
              `<li><code>${escapeHtml(source.path)}</code>${
                source.startLine ? `<span class="line-range">lines ${source.startLine}${source.endLine && source.endLine !== source.startLine ? `–${source.endLine}` : ''}</span>` : ''
              }</li>`,
          )
          .join('')}</ul></section>`
      : '';

  const childrenHtml =
    children.length > 0
      ? `<div class="children-intro" id="deeper">
  <h2>Deeper</h2>
  <p class="caption">Each of these was generated by reading the code for that part of the system, grounded in the explanation above.</p>
  <ul class="next-list">${children
    .map(
      (child, index) =>
        `<li><a class="next-link" href="#${childAnchor(index)}"><span class="next-label">${escapeHtml(
          child.label ?? child.explainer.title,
        )}</span><span class="next-hint">${escapeHtml(child.explainer.subtitle ?? '')}</span></a></li>`,
    )
    .join('')}</ul>
</div>
${children.map((child, index) => renderChild(child, index, svgs)).join('\n')}`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(explainer.title)} — ${escapeHtml(meta.repoName)}</title>
<style>${STYLES}</style>
</head>
<body id="top">
<header class="page-header">
  <p class="eyebrow">${escapeHtml(explainer.kind.replace(/-/g, ' '))} explainer · ${escapeHtml(meta.repoName)}${
    meta.branch ? ` · ${escapeHtml(meta.branch)}${meta.head ? ` @ ${escapeHtml(meta.head)}` : ''}` : ''
  }</p>
  <h1>${escapeHtml(explainer.title)}</h1>
  <p class="subtitle">${escapeHtml(explainer.subtitle)}</p>
  <p class="tldr">${renderMarkdown(explainer.tldr)}</p>
  <p class="meta">Generated ${escapeHtml(new Date(meta.generatedAt).toLocaleString())} by ${escapeHtml(meta.provider)} (${escapeHtml(
    meta.model,
  )})· <code>${escapeHtml(meta.repoPath)}</code></p>
  ${explainer.degraded ? '<p class="notice">This explainer was produced by static analysis only, without a language model.</p>' : ''}
</header>

<nav class="toc">
  <h2>Contents</h2>
  <ol>${toc}${childToc}</ol>
</nav>

<main>
${body}
${quiz}
${next}
${sources}
${childrenHtml}
</main>

<footer class="page-footer">
  <p>Generated by Repo Explorer. Read critically: every claim here should be traceable to the code.</p>
</footer>

<script>${SCRIPT}</script>
</body>
</html>`;
}

const STYLES = `
:root {
  --bg: #fbfaf8; --panel: #ffffff; --ink: #1c1b19; --muted: #6b6760;
  --line: #e5e1da; --accent: #2f5d8a; --accent-soft: #eef4fa;
  --ok: #1f7a4d; --ok-soft: #ecf7f1; --warn: #8a5a1a; --warn-soft: #fdf3e4;
  --danger: #a33a2c; --danger-soft: #fdeeea; --code-bg: #f6f4f1;
  --radius: 12px; --maxw: 60rem;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 17px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.page-header, .toc, main, .page-footer { max-width: var(--maxw); margin: 0 auto; padding: 0 1.25rem; }
.page-header { padding-top: 3rem; padding-bottom: 1rem; }
.eyebrow { text-transform: uppercase; letter-spacing: .09em; font-size: .72rem; color: var(--muted); margin: 0 0 .6rem; }
h1 { font-size: clamp(1.7rem, 3.4vw, 2.5rem); line-height: 1.15; margin: 0 0 .4rem; letter-spacing: -.015em; }
.subtitle { color: var(--muted); margin: 0 0 1.2rem; font-size: 1.05rem; }
.tldr { background: var(--accent-soft); border-left: 3px solid var(--accent); padding: .9rem 1.1rem; border-radius: 0 var(--radius) var(--radius) 0; margin: 0 0 1rem; }
.tldr p { margin: 0; }
.meta { font-size: .82rem; color: var(--muted); }
.notice { font-size: .85rem; color: var(--warn); background: var(--warn-soft); padding: .5rem .8rem; border-radius: 8px; }
.toc { padding-bottom: 1rem; }
.toc h2 { font-size: .78rem; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); margin: 1.5rem 0 .5rem; }
.toc ol { margin: 0; padding-left: 1.2rem; columns: 2; column-gap: 2rem; }
@media (max-width: 640px) { .toc ol { columns: 1; } }
.toc a { color: var(--accent); text-decoration: none; }
.toc a:hover { text-decoration: underline; }
main { padding-bottom: 2rem; }
.card, .callout { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 1.4rem 1.5rem; margin: 0 0 1.25rem; }
.card h3 { margin: 0 0 .8rem; font-size: 1.2rem; letter-spacing: -.01em; }
.card h4, .callout h4 { margin: 0 0 .5rem; font-size: 1rem; }
.callout { border-left: 4px solid var(--accent); background: var(--accent-soft); }
.callout-concept { border-color: var(--accent); background: var(--accent-soft); }
.callout-tip { border-color: var(--ok); background: var(--ok-soft); }
.callout-warning { border-color: var(--warn); background: var(--warn-soft); }
.callout-edge { border-color: var(--danger); background: var(--danger-soft); }
.prose > :first-child { margin-top: 0; }
.prose > :last-child { margin-bottom: 0; }
.prose h1, .prose h2, .prose h3 { font-size: 1.05rem; margin: 1.2rem 0 .5rem; }
.prose ul, .prose ol { padding-left: 1.3rem; }
.prose code { background: var(--code-bg); padding: .12em .38em; border-radius: 5px; font-size: .88em; }
.prose blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid var(--line); color: var(--muted); }
.badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .07em; background: var(--accent-soft); color: var(--accent); padding: .15rem .45rem; border-radius: 999px; vertical-align: middle; }
pre.code {
  background: var(--code-bg); border: 1px solid var(--line); border-radius: 10px;
  padding: 1rem 1.1rem; overflow-x: auto; margin: 0 0 .6rem;
  font: 13.5px/1.6 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  white-space: pre-wrap; word-break: break-word; tab-size: 2;
}
pre.code code { white-space: pre-wrap; }
.code-line { display: block; }
.code-line.highlighted { background: rgba(47, 93, 138, .13); border-radius: 4px; }
.caption { font-size: .82rem; color: var(--muted); margin: .3rem 0 0; }
.diagram { margin: .8rem 0 .4rem; }
.diagram-flow { display: flex; flex-wrap: wrap; align-items: stretch; gap: .35rem; }
.diagram-flow.vertical { flex-direction: column; align-items: stretch; }
.flow-node { flex: 1 1 9rem; min-width: 8rem; background: var(--accent-soft); border: 1px solid var(--line); border-top: 3px solid var(--accent); border-radius: 10px; padding: .6rem .7rem; display: flex; flex-direction: column; gap: .2rem; }
.flow-node.tone-muted { background: #f2f1ee; border-top-color: #a9a49c; }
.flow-node.tone-accent { background: #f4eefb; border-top-color: #7b52ab; }
.flow-node.tone-success { background: var(--ok-soft); border-top-color: var(--ok); }
.flow-node.tone-danger { background: var(--danger-soft); border-top-color: var(--danger); }
.flow-label { font-weight: 600; font-size: .92rem; }
.flow-sub { font-size: .76rem; color: var(--muted); }
.flow-arrow { align-self: center; color: var(--muted); font-size: .95rem; display: flex; flex-direction: column; align-items: center; min-width: 1.4rem; }
.flow-arrow.dashed { opacity: .6; }
.arrow-label { font-size: .65rem; max-width: 7rem; text-align: center; }
.diagram-flow.vertical .flow-arrow { transform: rotate(90deg); }
.edge-list { list-style: none; margin: .6rem 0 0; padding: 0; font-size: .82rem; color: var(--muted); }
.edge-list code { background: var(--code-bg); padding: .1em .35em; border-radius: 4px; }
.layer { border: 1px solid var(--line); border-radius: 10px; margin-bottom: .5rem; overflow: hidden; }
.layer-head { display: flex; justify-content: space-between; gap: 1rem; background: var(--code-bg); padding: .45rem .7rem; border-bottom: 1px solid var(--line); }
.layer-label { font-weight: 600; font-size: .9rem; }
.layer-hint { font-size: .78rem; color: var(--muted); }
.layer-items { display: flex; flex-wrap: wrap; gap: .4rem; padding: .6rem .7rem; }
.pill { background: var(--accent-soft); border: 1px solid var(--line); border-radius: 999px; padding: .2rem .65rem; font-size: .82rem; }
.pill.tone-muted { background: #f2f1ee; }
.pill.tone-accent { background: #f4eefb; }
.pill.tone-success { background: var(--ok-soft); }
.pill.tone-danger { background: var(--danger-soft); }
.tree, .tree ul { list-style: none; margin: 0; padding-left: 1rem; }
.tree li { position: relative; padding: .18rem 0 .18rem .9rem; border-left: 1px solid var(--line); }
.tree > li { border-left: none; padding-left: 0; }
.tree-label { font-weight: 600; font-size: .9rem; }
.tree-label.tone-muted { color: var(--muted); font-weight: 500; }
.tree-sub { color: var(--muted); font-size: .78rem; }
.diagram-compare { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; }
@media (max-width: 640px) { .diagram-compare { grid-template-columns: 1fr; } }
.compare-side { border: 1px solid var(--line); border-radius: 10px; padding: .8rem .9rem; background: var(--danger-soft); }
.compare-side.tone-success { background: var(--ok-soft); }
.compare-side h4 { margin: 0 0 .4rem; font-size: .9rem; }
.compare-side ul { margin: 0; padding-left: 1.1rem; font-size: .88rem; }
.diagram-sequence .actors { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: .7rem; }
.sequence-steps { margin: 0; padding-left: 1.3rem; }
.sequence-steps li { margin-bottom: .5rem; }
.seq-route { display: block; font-family: ui-monospace, Menlo, monospace; font-size: .76rem; color: var(--accent); }
.seq-label { font-size: .9rem; }
.diagram-ui .ui-frame { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.ui-titlebar { background: var(--code-bg); padding: .4rem .7rem; font-size: .82rem; color: var(--muted); border-bottom: 1px solid var(--line); }
.ui-region { padding: .6rem .8rem; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: .15rem; }
.ui-region:last-child { border-bottom: none; }
.ui-region strong { font-size: .9rem; }
.ui-region span { font-size: .82rem; color: var(--muted); }
.diagram-example { font-size: .84rem; color: var(--muted); margin: .6rem 0 0; }
.term-list { margin: 0; }
.term-list dt { font-weight: 600; margin-top: .75rem; }
.term-list dt:first-child { margin-top: 0; }
.term-list dd { margin: .15rem 0 0; color: #33312e; }
.steps { margin: 0; padding-left: 1.3rem; }
.steps li { margin-bottom: .8rem; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .88rem; }
th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: .74rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.sources { list-style: none; margin: 0; padding: 0; font-size: .85rem; }
.sources li { padding: .2rem 0; }
.sources code { background: var(--code-bg); padding: .1em .35em; border-radius: 4px; }
.line-range { color: var(--muted); margin-left: .5rem; font-size: .8rem; }
.quiz-question { border-top: 1px solid var(--line); padding-top: 1rem; margin-top: 1rem; }
.quiz-question:first-of-type { border-top: none; margin-top: .5rem; padding-top: 0; }
.quiz-prompt { font-weight: 600; margin: 0 0 .6rem; }
.quiz-number { color: var(--muted); margin-right: .4rem; font-weight: 500; }
.quiz-options { display: grid; gap: .4rem; }
.quiz-option { text-align: left; background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: .55rem .75rem; font: inherit; font-size: .9rem; cursor: pointer; transition: background .12s, border-color .12s; }
.quiz-option:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-soft); }
.quiz-option:disabled { cursor: default; opacity: .95; }
.quiz-option.correct { background: var(--ok-soft); border-color: var(--ok); font-weight: 600; }
.quiz-option.incorrect { background: var(--danger-soft); border-color: var(--danger); }
.quiz-feedback { margin: .7rem 0 0; padding: .6rem .8rem; border-radius: 8px; background: var(--code-bg); font-size: .88rem; }
.page-footer { padding-bottom: 3rem; color: var(--muted); font-size: .82rem; }
.next-list { list-style: none; margin: .6rem 0 0; padding: 0; display: grid; gap: .5rem; }
.next-link { display: grid; gap: .15rem; text-decoration: none; border: 1px solid var(--line); border-radius: 10px;
  padding: .7rem .9rem; background: var(--panel); transition: border-color .12s, background .12s; }
.next-link:hover { border-color: var(--accent); background: var(--accent-soft); }
.next-label { font-weight: 600; color: var(--accent); }
.next-hint { font-size: .84rem; color: var(--muted); }
.toc-group > ol { margin: .3rem 0 0; padding-left: 1.1rem; }
.children-intro { margin: 3rem 0 1rem; border-top: 2px solid var(--line); padding-top: 1.5rem; }
.children-intro h2 { font-size: 1.5rem; letter-spacing: -.02em; margin: 0 0 .3rem; }
.child { margin: 0 0 3rem; padding-top: .5rem; }
.child-head { border-left: 4px solid var(--accent); padding-left: 1rem; margin-bottom: 1.2rem; }
.child-head h2 { font-size: clamp(1.3rem, 2.4vw, 1.8rem); letter-spacing: -.02em; margin: .2rem 0 .3rem; }
.backlink { font-size: .8rem; margin: .6rem 0 0; }
.backlink a { color: var(--muted); text-decoration: none; }
.backlink a:hover { color: var(--accent); text-decoration: underline; }
@media print { .toc { display: none; } .card, .callout { break-inside: avoid; } .child { break-before: page; } body { background: #fff; } }
`;

const SCRIPT = `
document.addEventListener('click', function (event) {
  var button = event.target.closest('.quiz-option');
  if (!button || button.disabled) return;
  var question = button.closest('.quiz-question');
  if (!question) return;
  var answer = Number(question.getAttribute('data-answer'));
  var chosen = Number(button.getAttribute('data-index'));
  var explanation = question.getAttribute('data-explanation') || '';
  var options = Array.prototype.slice.call(question.querySelectorAll('.quiz-option'));
  options.forEach(function (option) {
    option.disabled = true;
    if (Number(option.getAttribute('data-index')) === answer) option.classList.add('correct');
  });
  if (chosen !== answer) button.classList.add('incorrect');
  var feedback = question.querySelector('.quiz-feedback');
  if (!feedback) return;
  feedback.hidden = false;
  feedback.textContent = (chosen === answer ? 'Correct. ' : 'Not quite. ') + explanation;
  feedback.style.background = chosen === answer ? 'var(--ok-soft)' : 'var(--danger-soft)';
});
`;

/** Build the file contents and a stable, date-prefixed filename. */
export function explainerFileName(explainer: Explainer, withChildren = false): string {
  return `${isoDate()}-explanation-${slugify(`${explainer.kind}-${explainer.target.label}${withChildren ? ' with drilldowns' : ''}`, 60)}.html`;
}

export function exportExplainer(
  explainer: Explainer,
  model: RepoModel,
  children: EmbeddedExplainer[] = [],
  svgs: Record<string, string> = {},
): { filename: string; html: string } {
  const meta: ExportMeta = {
    repoName: model.repo.slug ?? model.repo.name,
    repoPath: model.repo.path,
    branch: model.git.branch,
    head: model.git.headShort,
    generatedAt: explainer.generatedAt,
    provider: explainer.provider,
    model: explainer.model,
  };
  return { filename: explainerFileName(explainer, children.length > 0), html: renderExplainerHtml(explainer, meta, children, svgs) };
}
