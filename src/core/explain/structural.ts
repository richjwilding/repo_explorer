import type { Change, Component, DataFlow, Explainer, ExplainerSection, ModuleNode, QuizQuestion, RepoModel } from '../types.js';
import { EXPLAINER_VERSION } from './schema.js';
import { pluralize, topN } from '../util/text.js';

/**
 * Structural fallback explainers.
 *
 * This is a safety net, not a knowledge source: if the language model is
 * unreachable or returns something unusable, the reader still gets an accurate
 * outline of the shape of the code, built purely from static analysis. It is
 * deliberately small — the real explanation comes from the agent.
 */

type Tone = 'primary' | 'accent' | 'muted' | 'danger' | 'success';

function toneForKind(kind: Component['kind']): Tone {
  switch (kind) {
    case 'api':
    case 'service':
      return 'primary';
    case 'ui':
    case 'app':
    case 'library':
      return 'accent';
    case 'data':
      return 'success';
    default:
      return 'muted';
  }
}

function firstSentence(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const match = cleaned.match(/^(.*?[.!?])(\s|$)/);
  return (match ? match[1] : cleaned).slice(0, 400);
}

function make(
  kind: Explainer['kind'],
  target: Explainer['target'],
  title: string,
  subtitle: string,
  tldr: string,
  sections: ExplainerSection[],
  next: Explainer['next'],
  sources: Explainer['sources'],
): Explainer {
  return {
    id: `${kind}:${target.id}`,
    version: EXPLAINER_VERSION,
    kind,
    target,
    title,
    subtitle,
    tldr,
    sections,
    next,
    sources,
    model: 'static-analysis',
    provider: 'none',
    generatedAt: new Date().toISOString(),
    degraded: true,
  };
}

function callout(
  id: string,
  title: string,
  markdown: string,
  variant: 'concept' | 'warning' | 'edge' | 'tip' = 'warning',
): ExplainerSection {
  return { type: 'callout', id, variant, title, markdown };
}

function entrySources(model: RepoModel, limit = 10): { path: string }[] {
  return model.entrypoints.slice(0, limit).map((entry) => ({ path: entry.path }));
}

/* ------------------------------------------------------------------ *
 * Repo
 * ------------------------------------------------------------------ */

/**
 * A short, factual quiz derived entirely from the analysis.
 *
 * Used only to fill in when a model returns a good explainer but forgets the
 * quiz — the quiz is part of the reading experience and should not silently
 * disappear because a model got tired.
 */
export function buildStaticQuiz(model: RepoModel): ExplainerSection | null {
  const questions: QuizQuestion[] = [];

  const httpComponents = topN(
    model.components.filter((component) => component.kind === 'api' || component.kind === 'service'),
    1,
    (component) => component.importance,
  );
  if (httpComponents.length > 0 && model.components.length >= 4) {
    const answer = httpComponents[0];
    const options = [answer, ...model.components.filter((component) => component.id !== answer.id).slice(0, 3)].map((component) => component.name);
    questions.push({
      id: 'sq1',
      question: 'Which component handles inbound requests?',
      options,
      answer: 0,
      explanation: `${answer.name} was detected as an HTTP-serving component: ${answer.oneLiner}`,
    });
  }

  // Quiz questions about a test fixture endpoint are technically true and
  // practically useless, so real service routes win.
  const isTestFile = (filePath: string) => /(^|\/)(tests?|__tests__|spec|specs)(\/|$)/.test(filePath) || /\.(test|spec)\./.test(filePath);
  const sourceRoutes = model.routes.filter((route) => !isTestFile(route.file));
  if (sourceRoutes.length > 0) {
    const route = sourceRoutes[Math.min(2, sourceRoutes.length - 1)];
    const wrong = model.files
      .filter((file) => file.category === 'source' && !isTestFile(file.path) && file.path !== route.file)
      .slice(0, 3)
      .map((file) => file.path);
    if (wrong.length === 3) {
      questions.push({
        id: 'sq2',
        question: `Which file defines the ${route.method} ${route.path} endpoint?`,
        options: [route.file, ...wrong],
        answer: 0,
        explanation: `Detected from a ${route.framework} route declaration at line ${route.line}.`,
      });
    }
  }

  const mostDepended = topN(
    model.components,
    1,
    (component) => model.components.filter((other) => other.dependsOn.includes(component.id)).length,
  )[0];
  if (mostDepended && model.components.length >= 4) {
    const dependents = model.components.filter((other) => other.dependsOn.includes(mostDepended.id)).length;
    if (dependents > 0) {
      const options = [mostDepended, ...model.components.filter((component) => component.id !== mostDepended.id).slice(0, 3)].map(
        (component) => component.name,
      );
      questions.push({
        id: 'sq3',
        question: 'Which component is depended on by the most other components?',
        options,
        answer: 0,
        explanation: `${mostDepended.name} is imported by ${dependents} other component(s), so changes there have the widest blast radius.`,
      });
    }
  }

  if (model.hotspots.length >= 4) {
    const hotspot = model.hotspots[0];
    const wrong = model.hotspots.slice(1, 4).map((spot) => spot.path);
    questions.push({
      id: 'sq4',
      question: 'Which file has been changed most often, weighted by its size?',
      options: [hotspot.path, ...wrong],
      answer: 0,
      explanation: `${hotspot.path} has been touched by ${hotspot.commits} commits across ${hotspot.loc.toLocaleString()} lines.`,
    });
  }

  // Distractors are drawn from the same category as the answer and from other
  // languages' ecosystems, so the question tests knowledge rather than vibes.
  const distractors = ['Apache Cassandra', 'HashiCorp Vault', 'Adobe Experience Manager'];
  const reference = model.dependencies.find((dependency) => dependency.kind === 'package' && dependency.category !== 'dependency');
  if (reference) {
    questions.push({
      id: 'sq5',
      question: `Which of these does the code actually import or configure?`,
      options: [reference.name, ...distractors],
      answer: 0,
      explanation: `${reference.name} is referenced in ${reference.evidence.length} file(s), including ${reference.evidence[0]}.`,
    });
  }

  if (questions.length === 0) return null;
  return { type: 'quiz', id: 'quiz', title: 'Check your understanding', questions: questions.slice(0, 5) };
}

export function structuralRepoExplainer(model: RepoModel): Explainer {
  const main = topN(model.components.filter((component) => !component.ancillary), 8, (component) => component.importance);
  const serviceNames = model.dependencies
    .filter((dependency) => ['database', 'cache', 'queue', 'storage', 'search'].includes(dependency.category))
    .slice(0, 6)
    .map((dependency) => dependency.name);
  const codeHotspots = model.hotspots.filter((hotspot) => /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|cs|swift|c|cpp)$/.test(hotspot.path));

  const sections: ExplainerSection[] = [
    {
      type: 'prose',
      id: 's1',
      title: 'What this repository is',
      level: 'narrow',
      markdown: [
        model.readme ? firstSentence(model.readme.replace(/^#.*$/m, '')) : '',
        `${model.repo.name} holds ${pluralize(model.stats.fileCount, 'file')} and roughly ${model.stats.loc.toLocaleString()} lines of ${model.stack.primaryLanguage ?? 'code'}, across ${pluralize(
          model.stats.componentCount,
          'component',
        )}.`,
        model.git.isRepo ? `The current branch is \`${model.git.branch ?? 'detached'}\` with ${pluralize(model.git.commitCount, 'commit')} of history.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    },
    {
      type: 'diagram',
      id: 'd1',
      title: 'Top-level components',
      caption: 'Supporting tooling and test infrastructure are hidden at this level; open a component to see inside it.',
      diagram: {
        kind: 'flow',
        nodes: main.map((component) => ({
          id: component.id,
          label: component.name,
          sub: `${component.kind} · ${component.loc.toLocaleString()} LOC`,
          tone: toneForKind(component.kind),
        })),
        edges: main.flatMap((component) =>
          component.dependsOn.filter((dep) => main.some((other) => other.id === dep)).slice(0, 2).map((dep) => ({ from: component.id, to: dep })),
        ),
      },
    },
    {
      type: 'list',
      id: 'l1',
      title: 'Components',
      items: main.map((component) => ({
        term: `${component.name} (${component.kind})`,
        detail: `${component.oneLiner}${component.keyFiles[0] ? ` Start at \`${component.keyFiles[0]}\`.` : ''}`,
      })),
    },
  ];

  if (model.routes.length > 0) {
    sections.push({
      type: 'list',
      id: 'l2',
      title: `Endpoints (${model.routes.length} detected)`,
      items: model.routes.slice(0, 15).map((route) => ({
        term: `${route.method} ${route.path}`,
        detail: `${route.handler ?? 'unknown handler'} — \`${route.file}:${route.line}\``,
      })),
    });
  }

  sections.push(
    callout(
      'c-complexity',
      'Where the complexity actually lives',
      [
        codeHotspots.length > 0
          ? `The most-changed files are ${codeHotspots
              .slice(0, 3)
              .map((hotspot) => `\`${hotspot.path}\` (${hotspot.commits} commits)`)
              .join(', ')}. High churn plus high size is where a new leader should look first.`
          : '',
        model.deadCode.length > 5
          ? `${model.deadCode.length} definitions appear unreachable from any detected entrypoint — worth confirming before assuming anything is safe to delete.`
          : '',
        serviceNames.length > 0 ? `The system depends on ${serviceNames.join(', ')}. These boundaries are where outages originate.` : '',
      ]
        .filter(Boolean)
        .join('\n\n') || 'Static analysis alone did not single out a hotspot.',
      'warning',
    ),
  );

  return make(
    'repo-overview',
    { kind: 'repo-overview', id: 'root', label: model.repo.name, level: 0 },
    `Understanding ${model.repo.name}`,
    `${model.stats.fileCount.toLocaleString()} files · ${model.stats.loc.toLocaleString()} lines · ${model.stats.componentCount} components`,
    firstSentence(model.readme ?? '') || `${model.repo.name} is composed of ${pluralize(main.length, 'main component')}.`,
    sections,
    main.slice(0, 6).map((component) => ({ id: component.id, label: component.name, kind: 'component' as const, hint: component.oneLiner.slice(0, 120) })),
    entrySources(model),
  );
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export function structuralComponentExplainer(model: RepoModel, component: Component): Explainer {
  const modules = model.modules.filter((module) => component.moduleIds.includes(module.id) && module.id !== component.path);
  const symbols = model.symbols.filter((symbol) => component.files.includes(symbol.path));
  const internal = symbols.filter((symbol) => symbol.callerCount > 0);
  const entrySymbols = symbols.filter((symbol) => symbol.entry);

  const sections: ExplainerSection[] = [
    {
      type: 'prose',
      id: 's1',
      title: 'Responsibility',
      level: 'narrow',
      markdown: `${component.oneLiner}\n\nIt contains ${pluralize(component.files.length, 'file')} and about ${component.loc.toLocaleString()} lines, with ${pluralize(
        internal.length,
        'internally called definition',
      )}.`,
    },
    {
      type: 'list',
      id: 'l1',
      title: 'Key files',
      items: component.keyFiles.slice(0, 8).map((file) => {
        const fileSymbols = symbols.filter((symbol) => symbol.path === file);
        const exported = fileSymbols.filter((symbol) => symbol.exported).map((symbol) => symbol.name);
        const entry = fileSymbols.find((symbol) => symbol.entry);
        return {
          term: file,
          detail: [
            `${pluralize(fileSymbols.length, 'definition')}.`,
            exported.length > 0 ? `Exports ${exported.slice(0, 4).join(', ')}.` : '',
            entry ? `Entrypoint: \`${entry.name}\` (line ${entry.line}).` : '',
          ]
            .filter(Boolean)
            .join(' '),
        };
      }),
    },
  ];

  if (modules.length > 0) {
    sections.push({
      type: 'diagram',
      id: 'd1',
      title: 'Internal structure',
      diagram: {
        kind: 'tree',
        root: {
          label: component.name,
          sub: component.kind,
          tone: toneForKind(component.kind),
          children: modules
            .filter((module) => !modules.some((other) => module.id.startsWith(`${other.id}/`)))
            .slice(0, 10)
            .map((module) => ({ label: module.name, sub: `${module.totalFiles} files · ${module.totalLoc.toLocaleString()} LOC`, tone: module.ancillary ? 'muted' : undefined })),
        },
      },
    });
  }

  const hubs = topN(internal, 6, (symbol) => symbol.callerCount);
  sections.push(
    callout(
      'c-sharp-edges',
      'Sharp edges',
      [
        hubs.length > 0
          ? `The most-called internal functions are ${hubs
              .map((hub) => `\`${hub.name}\` (${hub.callerCount} callers)`)
              .join(', ')}. Changes there ripple furthest.`
          : '',
        component.dependsOn.length > 3 ? `It depends on ${pluralize(component.dependsOn.length, 'other component')}, so it is a coordination point.` : '',
        model.files.some((file) => component.files.includes(file.path) && file.category === 'test')
          ? 'It has test files of its own.'
          : '**No test files live inside this component**, so its behaviour is specified only by its implementation.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      'edge',
    ),
  );

  if (entrySymbols.length > 0) {
    sections.push({
      type: 'list',
      id: 'l2',
      title: 'Entrypoints here',
      items: entrySymbols.slice(0, 10).map((symbol) => ({ term: `${symbol.name} (${symbol.kind})`, detail: `\`${symbol.path}:${symbol.line}\`` })),
    });
  }

  return make(
    'component',
    { kind: 'component', id: component.id, label: component.name, level: 1 },
    component.name,
    `${component.kind} · ${component.path || '.'}`,
    component.oneLiner,
    sections,
    modules.slice(0, 6).map((module) => ({ id: module.id, label: module.name, kind: 'module' as const, hint: `${module.totalFiles} files` })),
    component.keyFiles.slice(0, 8).map((path) => ({ path })),
  );
}

/* ------------------------------------------------------------------ *
 * Module
 * ------------------------------------------------------------------ */

export function structuralModuleExplainer(model: RepoModel, module: ModuleNode): Explainer {
  const files = model.files.filter((file) => module.ownFiles.includes(file.path));
  const parent = model.components.find((component) => component.path !== '' && (module.id === component.path || module.id.startsWith(`${component.path}/`)));
  const symbols = model.symbols.filter((symbol) => module.ownFiles.includes(symbol.path));

  return make(
    'module',
    { kind: 'module', id: module.id, label: module.id, level: module.depth + 1 },
    module.id,
    `${module.totalFiles} files · ${module.totalLoc.toLocaleString()} LOC`,
    `A directory of ${pluralize(module.totalFiles, 'file')} (${module.totalLoc.toLocaleString()} lines)${parent ? ` inside ${parent.name}` : ''}.`,
    [
      {
        type: 'prose',
        id: 's1',
        title: 'Contents',
        level: 'narrow',
        markdown: `${module.ownFiles.length} files live directly here${parent ? `, as part of **${parent.name}**` : ''}. ${
          symbols.length > 0 ? `They define ${pluralize(symbols.length, 'symbol')}, of which ${symbols.filter((symbol) => symbol.exported).length} are exported.` : ''
        }`,
      },
      {
        type: 'list',
        id: 'l1',
        title: 'Files',
        items: files.slice(0, 20).map((file) => ({
          term: file.path,
          detail: `${file.lines} lines · ${file.category}${file.symbols.length > 0 ? ` · ${file.symbols.slice(0, 4).map((symbol) => symbol.name).join(', ')}` : ''}`,
        })),
      },
      ...(symbols.length > 0
        ? [
            {
              type: 'list' as const,
              id: 'l2',
              title: 'Definitions',
              items: symbols.slice(0, 24).map((symbol) => ({
                term: `${symbol.name} (${symbol.kind})`,
                detail: `line ${symbol.line} · ${symbol.exported ? 'exported' : 'internal'} · ${symbol.callerCount} caller(s)`,
              })),
            },
          ]
        : []),
    ],
    [],
    files.slice(0, 10).map((file) => ({ path: file.path })),
  );
}

/* ------------------------------------------------------------------ *
 * Flow
 * ------------------------------------------------------------------ */

export function structuralFlowExplainer(model: RepoModel, flow: DataFlow): Explainer {
  return make(
    'flow',
    { kind: 'flow', id: flow.id, label: flow.name, level: 1 },
    flow.name,
    flow.path.map((id) => model.components.find((component) => component.id === id)?.name ?? id).join(' → '),
    flow.summary,
    [
      { type: 'prose', id: 's1', title: 'Overview', level: 'narrow', markdown: flow.summary },
      {
        type: 'steps',
        id: 'st1',
        title: 'The hops',
        steps: flow.steps.map((step, index) => ({
          label: `${index + 1}. ${model.components.find((component) => component.id === step.nodeId)?.name ?? step.nodeId}`,
          detail: step.description,
        })),
      },
      {
        type: 'list',
        id: 'l1',
        title: 'Evidence',
        items: flow.evidence.map((file) => ({ term: file, detail: 'Part of this flow, inferred from entrypoints and imports.' })),
      },
    ],
    [],
    flow.evidence.map((path) => ({ path })),
  );
}

/* ------------------------------------------------------------------ *
 * Change
 * ------------------------------------------------------------------ */

/**
 * What to say when a comparison turned up no differences.
 *
 * This used to go to the model, which dutifully wrote an explainer saying that
 * nothing had changed — technically true, and useless. The interesting part is
 * *which* comparison was empty and what the reader can do about it, which we know
 * without asking anyone.
 */
export function emptyChangeExplainer(change: Change): Explainer {
  const comparison = change.compare;
  const baseRef = comparison?.baseRef ?? change.base;
  const sameTip = comparison?.mode === 'against-tip' && change.subtitle?.startsWith('Same commit');

  const summary = comparison
    ? comparison.mode === 'since-diverged'
      ? `${change.head} has no commits since it diverged from ${baseRef}, so the diff between them is empty.`
      : sameTip
        ? `${change.head} and ${baseRef} point at the same commit, so there is nothing to compare.`
        : `Nothing differs between the current tip of ${change.head} and the current tip of ${baseRef}.`
    : 'This change is empty: no files differ between the two sides of the comparison.';

  const advice = sameTip
    ? `Pick a different branch to compare against, or switch the comparison to "this branch's own commits" if you meant to look at the history it shares with ${baseRef}.`
    : comparison?.mode === 'since-diverged'
      ? `If you were expecting work here, check that the branch name is the one you meant, and that its commits have not already been merged into ${baseRef}. Comparing the two branch tips shows the difference that remains either way.`
      : `If you were expecting work here, check that the branch name is the one you meant.`;

  return make(
    'change',
    { kind: 'change', id: change.id, label: change.title, level: 0 },
    change.title,
    change.subtitle ?? 'No differences',
    summary,
    [
      callout('c-empty', 'Nothing to explain', `${summary}\n\n${advice}`, 'edge'),
      {
        type: 'table',
        id: 't-refs',
        title: 'What was compared',
        headers: ['Side', 'Ref'],
        rows: [
          ['Base', comparison ? `${baseRef} (${comparison.mode === 'since-diverged' ? 'merge base' : 'branch tip'})` : change.base],
          ['Head', change.head],
        ],
      },
    ],
    [],
    [],
  );
}

export function structuralChangeExplainer(model: RepoModel, change: Change): Explainer {
  const topDirs = new Map<string, number>();
  for (const file of change.files) {
    const dir = file.path.includes('/') ? file.path.split('/').slice(0, 2).join('/') : file.path;
    topDirs.set(dir, (topDirs.get(dir) ?? 0) + file.additions + file.deletions);
  }

  return make(
    'change',
    { kind: 'change', id: change.id, label: change.title, level: 0 },
    change.title,
    `${change.kind} · +${change.stats.additions}/-${change.stats.deletions} across ${pluralize(change.stats.files, 'file')}`,
    `A ${change.kind} touching ${pluralize(change.stats.files, 'file')} (+${change.stats.additions}/-${change.stats.deletions}).`,
    [
      {
        type: 'table',
        id: 't1',
        title: 'Changed files',
        headers: ['File', 'Status', 'Lines', 'Type'],
        rows: change.files.slice(0, 25).map((file) => [file.path, file.status, `+${file.additions}/-${file.deletions}`, file.binary ? 'binary' : 'text']),
      },
      {
        type: 'list',
        id: 'l1',
        title: 'Concentration of change',
        items: [...topDirs.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([dir, churn]) => ({
            term: dir,
            detail: `${churn} lines changed${model.components.find((component) => component.path === dir) ? ` — ${model.components.find((component) => component.path === dir)?.oneLiner}` : ''}`,
          })),
      },
      callout(
        'c-review',
        'Reviewer checklist',
        [
          change.files.some((file) => /test|spec/i.test(file.path)) ? 'Tests were updated.' : '**No tests were changed.** Ask how the new behaviour is verified.',
          change.stats.deletions > change.stats.additions * 1.5 ? 'This change removes more than it adds — usually a simplification worth understanding.' : '',
        ]
          .filter(Boolean)
          .join('\n\n') || 'Nothing structurally unusual stands out from the diff statistics alone.',
        'edge',
      ),
    ],
    [],
    change.files.slice(0, 12).map((file) => ({ path: file.path })),
  );
}
