import type { Change, Component, Explainer, ExplainerKind, ExplainerTarget, NextRelation } from '../types.js';
import type { RepoContext } from '../service.js';
import { buildRepoDigest } from './digest.js';
import { changeSeed } from '../chat/prompts.js';
import { explore, type AgentStep, type AgentTask } from '../agent/explorer.js';
import {
  buildStaticQuiz,
  structuralChangeExplainer,
  structuralComponentExplainer,
  structuralFlowExplainer,
  structuralModuleExplainer,
  structuralRepoExplainer,
} from './structural.js';
import { EXPLAINER_VERSION } from './schema.js';
import { buildFreshnessIndex, recordScope } from './staleness.js';
import { log } from '../logger.js';
import { truncate } from '../util/text.js';
import { listCommits } from '../util/git.js';

export interface ExplainerOptions {
  refresh?: boolean;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
  /** Fires for every tool call the agent makes, for live progress in the UI. */
  onStep?: (step: AgentStep) => void;
  /** Skip the agent and emit the structural outline only. */
  staticOnly?: boolean;
  maxSteps?: number;
}

/* ------------------------------------------------------------------ *
 * Public entry points
 * ------------------------------------------------------------------ */

export async function repoExplainer(ctx: RepoContext, options: ExplainerOptions = {}): Promise<Explainer> {
  const target: ExplainerTarget = { kind: 'repo-overview', id: 'root', label: ctx.model.repo.name, level: 0 };
  const main = ctx.model.components.filter((component) => !component.ancillary);
  return getOrCreate(
    ctx,
    target,
    options,
    async () => structuralRepoExplainer(ctx.model),
    async () => ({
      scope: 'repo',
      target,
      goal: `Produce the top-level explainer for ${ctx.model.repo.name}: what the system is, how it is shaped, and how a reader should orient themselves in it. Do not attempt to explain every component in detail — this is the map, not the territory.`,
      seed: buildRepoDigest(ctx.model, { maxChars: 9000, includeFiles: false }),
      nextOptions: main.slice(0, 8).map((component) => ({ label: component.name, hint: component.oneLiner.slice(0, 90) })),
      siblingNames: ctx.model.components.map((component) => component.name),
      extraInstructions:
        'Start by listing the routes and entrypoints, then trace at least one path with trace_calls so your data-flow diagram is real rather than plausible. Check find_hotspots — churn reveals where the team\'s pain actually is.',
    }),
  );
}

/** Resolve a component reference given as an id, a name, or a path. */
export function resolveComponent(ctx: RepoContext, key: string) {
  const needle = key.trim().toLowerCase();
  const components = ctx.model.components;
  return (
    components.find((candidate) => candidate.id === key) ??
    components.find((candidate) => candidate.path.toLowerCase() === needle) ??
    components.find((candidate) => candidate.name.toLowerCase() === needle) ??
    components.find((candidate) => candidate.path.toLowerCase().endsWith(`/${needle}`)) ??
    components.find((candidate) => candidate.name.toLowerCase().includes(needle)) ??
    components.find((candidate) => `${candidate.name} ${candidate.oneLiner}`.toLowerCase().includes(needle))
  );
}

/** Resolve a directory reference given as a module id or a path fragment. */
export function resolveModule(ctx: RepoContext, key: string) {
  const needle = key.replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
  const modules = ctx.model.modules;
  return (
    modules.find((candidate) => candidate.id === needle) ??
    modules.find((candidate) => candidate.id.toLowerCase() === needle) ??
    modules.find((candidate) => candidate.id.toLowerCase().endsWith(`/${needle}`)) ??
    modules.find((candidate) => candidate.id.toLowerCase().includes(needle))
  );
}

export async function componentExplainer(ctx: RepoContext, componentId: string, options: ExplainerOptions = {}): Promise<Explainer> {
  const component = resolveComponent(ctx, componentId);
  if (!component) throw new Error(`Unknown component: ${componentId}. Known components: ${ctx.model.components.map((candidate) => candidate.name).join(', ')}`);
  const target: ExplainerTarget = { kind: 'component', id: component.id, label: component.name, level: 1 };
  const children = ctx.model.modules.filter((module) => component.moduleIds.includes(module.id) && module.id !== component.path);
  const dependents = ctx.model.components.filter((candidate) => candidate.dependsOn.includes(component.id));

  return getOrCreate(
    ctx,
    target,
    options,
    async () => structuralComponentExplainer(ctx.model, component),
    async () => ({
      scope: 'component',
      target,
      goal: `Produce the explainer for the "${component.name}" component: its responsibility, its internal structure, its public surface, and how a change would flow through it.`,
      seed: [
        buildRepoDigest(ctx.model, { maxChars: 4200 }),
        `## The component under study\nName: ${component.name}\nKind: ${component.kind}\nPath: \`${component.path || '.'}\`\nSize: ${component.files.length} files, ${component.loc.toLocaleString()} lines\nIts own summary: ${component.oneLiner}`,
        component.keyFiles.length > 0 ? `Key files: ${component.keyFiles.map((file) => `\`${file}\``).join(', ')}` : '',
        `It depends on: ${component.dependsOn.join(', ') || 'nothing'}`,
        `It is used by: ${dependents.map((candidate) => candidate.name).join(', ') || 'nothing'}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      nextOptions: children.slice(0, 6).map((module) => ({ label: module.name, hint: `${module.totalFiles} files · ${module.totalLoc.toLocaleString()} LOC` })),
      siblingNames: [...component.dependsOn, ...dependents.map((candidate) => candidate.name), component.name],
      extraInstructions:
        'Call component_summary for this exact component first — it gives you the exported symbols and sub-directories. Then read the two or three most important files. Use callers_of on the most-called internal functions to judge the blast radius of changes.',
    }),
  );
}

export async function moduleExplainer(ctx: RepoContext, moduleId: string, options: ExplainerOptions = {}): Promise<Explainer> {
  const module = resolveModule(ctx, moduleId);
  if (!module) throw new Error(`Unknown directory: ${moduleId}`);
  const target: ExplainerTarget = { kind: 'module', id: module.id, label: module.id, level: module.depth + 1 };
  const parent = ctx.model.components.find(
    (component) => component.path !== '' && (moduleId === component.path || moduleId.startsWith(`${component.path}/`)),
  );

  return getOrCreate(
    ctx,
    target,
    options,
    async () => structuralModuleExplainer(ctx.model, module),
    async () => ({
      scope: 'module',
      target,
      goal: `Produce the explainer for the directory \`${moduleId || '.'}\`: what each file in it is for, and how they fit together.`,
      seed: [
        buildRepoDigest(ctx.model, { maxChars: 2600 }),
        `## The directory under study\nPath: \`${moduleId || '.'}\`\nFiles directly inside: ${module.ownFiles.length}\nTotal including sub-directories: ${module.totalFiles} files, ${module.totalLoc.toLocaleString()} lines`,
        parent ? `Part of component: ${parent.name} (${parent.kind}) — ${parent.oneLiner}` : '',
        module.ownFiles.length > 0 ? `Files: ${module.ownFiles.slice(0, 30).map((file) => `\`${file}\``).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      nextOptions: ctx.model.modules
        .filter((candidate) => candidate.parent === moduleId)
        .slice(0, 6)
        .map((child) => ({ label: child.name, hint: `${child.totalFiles} files` })),
      siblingNames: module.ownFiles.map((file) => file.split('/').pop() as string),
      extraInstructions:
        'List the directory, then read the two largest or most central files. Skip generated, vendored, and test-only files unless they define the contract.',
    }),
  );
}

export async function flowExplainer(ctx: RepoContext, flowId: string, options: ExplainerOptions = {}): Promise<Explainer> {
  const flow =
    ctx.model.dataFlows.find((candidate) => candidate.id === flowId) ??
    ctx.model.dataFlows.find((candidate) => candidate.name.toLowerCase() === flowId.trim().toLowerCase()) ??
    ctx.model.dataFlows.find((candidate) => candidate.name.toLowerCase().includes(flowId.trim().toLowerCase()));
  if (!flow) throw new Error(`Unknown flow: ${flowId}. Known flows: ${ctx.model.dataFlows.map((candidate) => candidate.name).join(', ')}`);
  const target: ExplainerTarget = { kind: 'flow', id: flow.id, label: flow.name, level: 1 };
  const componentNames = flow.path.map((id) => ctx.model.components.find((component) => component.id === id)?.name ?? id);

  return getOrCreate(
    ctx,
    target,
    options,
    async () => structuralFlowExplainer(ctx.model, flow),
    async () => ({
      scope: 'flow',
      target,
      goal: `Produce an explainer that lets the reader trace ${flow.name} end to end: entry, each hop, and the final store or response.`,
      seed: [
        buildRepoDigest(ctx.model, { maxChars: 3600 }),
        `## Flow inferred by static analysis\nName: ${flow.name}\nSummary: ${flow.summary}\nComponents on the path: ${componentNames.join(' → ')}\nEvidence files: ${flow.evidence.join(', ') || 'none identified'}`,
        'Treat this inferred path as a hypothesis: verify or correct it with the call graph.',
      ].join('\n\n'),
      nextOptions: flow.path
        .map((id) => ctx.model.components.find((component) => component.id === id))
        .filter((component): component is NonNullable<typeof component> => Boolean(component))
        .slice(0, 5)
        .map((component) => ({ label: component.name, hint: component.oneLiner.slice(0, 90) })),
      siblingNames: componentNames,
      extraInstructions:
        'Start from the route or entrypoint that triggers this flow, then use trace_calls and read_file to follow it. Your "steps" section must name the real function at each hop. If the inferred path is wrong, say so and describe the real one.',
    }),
  );
}

export async function changeExplainer(ctx: RepoContext, change: Change, options: ExplainerOptions = {}): Promise<Explainer> {
  const target: ExplainerTarget = { kind: 'change', id: change.id, label: change.title, level: 0 };
  return getOrCreate(
    ctx,
    target,
    options,
    async () => structuralChangeExplainer(ctx.model, change),
    async () => {
      const { diff } = await buildChangeContext(change);
      const history = await buildChangeHistory(ctx, change);
      return {
        scope: 'change',
        target,
        goal: `Explain this change (${change.kind}: ${change.title}) so that a reader who knows the surrounding system only loosely understands what changed, why, and what could break.`,
        seed: [buildRepoDigest(ctx.model, { maxChars: 4200 }), changeSeed(change, diff, history)].join('\n\n'),
        nextOptions: [],
        siblingNames: change.files.slice(0, 20).map((file) => file.path),
        extraInstructions:
          'The diff is in your context already. Use read_file to see the surrounding code in the post-change file, and callers_of on any function whose signature or behaviour changed — that is where the risk is. Use git_log on the touched files to understand whether this is a fix, a rewrite, or a first version.',
      };
    },
  );
}

export async function explainerFor(ctx: RepoContext, kind: ExplainerKind, id: string, options: ExplainerOptions = {}): Promise<Explainer> {
  switch (kind) {
    case 'repo-overview':
      return repoExplainer(ctx, options);
    case 'component':
      return componentExplainer(ctx, id, options);
    case 'module':
      return moduleExplainer(ctx, id, options);
    case 'flow':
      return flowExplainer(ctx, id, options);
    case 'change': {
      const change = await ctx.store.readChange(ctx.model.repo.id, id);
      if (!change) throw new Error(`Unknown change: ${id}. Load it first via /api/repos/${ctx.model.repo.id}/change.`);
      return changeExplainer(ctx, change, options);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Cache-aware generation
 * ------------------------------------------------------------------ */

async function getOrCreate(
  ctx: RepoContext,
  target: ExplainerTarget,
  options: ExplainerOptions,
  buildStructural: () => Promise<Explainer>,
  buildTask: () => Promise<AgentTask>,
): Promise<Explainer> {
  const id = `${target.kind}:${target.id}`;
  if (!options.refresh) {
    const cached = await ctx.store.readExplainer(ctx.model.repo.id, id);
    // Only an unreadable shape forces a rewrite. An explainer whose analysis is
    // newer, or whose files have changed since, is served and *flagged* as stale
    // — regenerating it costs minutes and tokens, and is the reader's call.
    if (cached && cached.version === EXPLAINER_VERSION) {
      // Cached explainers can carry drill-down targets written before the
      // resolution rules changed, so they are pruned on read as well.
      pruneNext(ctx, cached);
      options.onStatus?.('Using the cached explainer');
      return cached;
    }
  }

  if (options.staticOnly || ctx.provider.id === 'mock') {
    const fallback = await buildStructural();
    await recordScopeIfPossible(ctx, fallback);
    await ctx.store.writeExplainer(ctx.model.repo.id, fallback);
    return fallback;
  }

  options.onStatus?.('Planning the investigation');
  try {
    const task = await buildTask();
    const result = await explore(ctx, { ...task, next: nextFromTarget(ctx, target) }, {
      maxSteps: options.maxSteps,
      signal: options.signal,
      onStatus: options.onStatus,
      onStep: options.onStep,
    });
    ensureQuiz(ctx, result.explainer);
    pruneNext(ctx, result.explainer);
    await recordScopeIfPossible(ctx, result.explainer);
    await ctx.store.writeExplainer(ctx.model.repo.id, result.explainer);
    options.onStatus?.('Done');
    return result.explainer;
  } catch (error) {
    log.warn(`explainer generation failed for ${id}:`, error instanceof Error ? error.message : error);
    options.onStatus?.(`Falling back to the structural outline (${error instanceof Error ? error.message : String(error)})`);
    const fallback = await buildStructural();
    await ctx.store.writeExplainer(ctx.model.repo.id, fallback);
    return fallback;
  }
}

/**
 * The quiz is part of the reading experience, so it should not vanish because a
 * model ran out of steam. When the model omits it, add a short purely factual
 * quiz derived from the analysis. Never applied to the static fallback.
 */
function ensureQuiz(ctx: RepoContext, explainer: Explainer): void {
  if (explainer.degraded) return;
  if (explainer.sections.some((section) => section.type === 'quiz' && section.questions.length > 0)) return;
  if (explainer.kind === 'change') return;
  const quiz = buildStaticQuiz(ctx.model);
  if (quiz) explainer.sections.push(quiz);
}

/**
 * Keep only drill-down targets that actually resolve.
 *
 * A model is free to suggest its own "next" entries, and it does so in whatever
 * shape it likes — including file paths where a directory is expected. Rather
 * than offering a card that fails when clicked, resolve each one or drop it;
 * a file path becomes its parent directory, which is what the reader meant.
 */
export function pruneNext(ctx: RepoContext, explainer: Explainer): void {
  // What is on screen, so a suggestion can be classified as depth or sideways.
  const currentPath =
    explainer.target.kind === 'component'
      ? ctx.model.components.find((component) => component.id === explainer.target.id)?.path ?? ''
      : explainer.target.kind === 'module'
        ? explainer.target.id
        : '';
  const relationFor = (path: string, fallback: NextRelation): NextRelation => {
    if (!currentPath || !path) return fallback;
    // Inside what is on screen.
    if (path === currentPath || path.startsWith(`${currentPath}/`)) return 'child';
    // What contains it.
    if (currentPath.startsWith(`${path}/`)) return 'parent';
    return fallback === 'child' ? 'related' : fallback;
  };

  const resolved: (Explainer['next'][number] | null)[] = explainer.next.map((item) => {
    if (item.kind === 'component') {
        const component = resolveComponent(ctx, item.id) ?? resolveComponent(ctx, item.label);
        return component
          ? { ...item, id: component.id, label: item.label || component.name, relation: relationFor(component.path, item.relation ?? 'child') }
          : null;
      }
    if (item.kind === 'module') {
      const direct = resolveModule(ctx, item.id) ?? resolveModule(ctx, item.label);
      if (direct) return { ...item, id: direct.id, label: item.label || direct.id, relation: relationFor(direct.id, item.relation ?? 'child') };
      // A file path: use the directory that contains it.
      const parent = item.label.includes('/') ? item.label.slice(0, item.label.lastIndexOf('/')) : '';
      const viaParent = parent ? resolveModule(ctx, parent) : undefined;
      return viaParent
        ? { ...item, id: viaParent.id, label: viaParent.id, relation: relationFor(viaParent.id, item.relation ?? 'child') }
        : null;
    }
    if (item.kind === 'flow') {
      const flow = ctx.model.dataFlows.find(
        (candidate) => candidate.id === item.id || candidate.name.toLowerCase() === item.label.toLowerCase(),
      );
      return flow ? { ...item, id: flow.id, label: item.label || flow.name, relation: 'related' as const } : null;
    }
    if (item.kind === 'repo-overview') return { ...item, relation: 'related' as const };
    return null;
  });

  // A model is free to suggest the thing it is currently explaining, or the same
  // target twice. Keep one entry per target, never the target itself, children
  // before cross-references.
  const targetId = explainer.target.id;
  const targetPath =
    explainer.target.kind === 'component'
      ? ctx.model.components.find((component) => component.id === targetId)?.path
      : explainer.target.kind === 'module'
        ? targetId
        : undefined;
  const seen = new Set<string>();
  explainer.next = resolved
    .filter((item): item is Explainer['next'][number] => item !== null)
    .filter((item) => {
      if (item.id === targetId) return false;
      if (targetPath && item.kind === 'module' && item.id === targetPath) return false;
      if (targetPath && item.kind === 'component' && ctx.model.components.find((c) => c.id === item.id)?.path === targetPath) return false;
      const key = `${item.kind}\u0000${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const rank = (relation: NextRelation | undefined) => (relation === 'child' ? 0 : relation === 'parent' ? 1 : 2);
      return rank(a.relation) - rank(b.relation);
    })
    .slice(0, 8);
}

/**
 * Record what the explainer was written against. Failure here is not fatal: the
 * explainer is still worth showing, it just cannot be checked for freshness.
 */
async function recordScopeIfPossible(ctx: RepoContext, explainer: Explainer): Promise<void> {
  try {
    const index = await buildFreshnessIndex(ctx, { refresh: true });
    recordScope(ctx, explainer, index);
  } catch (error) {
    log.debug('could not record explainer scope', error instanceof Error ? error.message : error);
  }
}

/** A short, distinguishing hint for a drill-down target. */
function componentHint(component: Component): string {
  const where = component.keyFiles[0] ?? component.path;
  return `${component.kind} · ${component.loc.toLocaleString()} lines · ${where}`;
}

function nextFromTarget(ctx: RepoContext, target: ExplainerTarget): Explainer['next'] {
  if (target.kind === 'repo-overview') {
    return ctx.model.components
      .filter((component) => !component.ancillary)
      .slice(0, 7)
      .map((component) => ({ id: component.id, label: component.name, kind: 'component' as const, hint: componentHint(component), relation: 'child' as const }));
  }
  if (target.kind === 'component') {
    const component = ctx.model.components.find((candidate) => candidate.id === target.id);
    if (!component) return [];
    const modules = ctx.model.modules.filter((module) => component.moduleIds.includes(module.id) && module.id !== component.path);
    const dependents = ctx.model.components.filter((candidate) => candidate.dependsOn.includes(component.id));

    // The containing scope is always offered, so zooming out never depends on
    // the model thinking to suggest it.
    const parentPath = component.path.includes('/') ? component.path.slice(0, component.path.lastIndexOf('/')) : '';
    const parentModule = parentPath ? resolveModule(ctx, parentPath) : undefined;

    return [
      ...(parentModule
        ? [
            {
              id: parentModule.id,
              label: parentModule.id,
              kind: 'module' as const,
              hint: 'the directory that contains this one',
              relation: 'parent' as const,
            },
          ]
        : []),
      // Sub-directories are genuinely deeper.
      ...modules.slice(0, 5).map((module) => ({
        id: module.id,
        label: module.name,
        kind: 'module' as const,
        hint: `${module.totalFiles} files · ${module.totalLoc.toLocaleString()} LOC`,
        relation: 'child' as const,
      })),
      // Components that use this one are sideways, and are labelled as such.
      ...dependents.slice(0, 3).map((candidate) => ({
        id: candidate.id,
        label: candidate.name,
        kind: 'component' as const,
        hint: componentHint(candidate),
        relation: 'related' as const,
      })),
    ];
  }
  if (target.kind === 'module') {
    const parent = ctx.model.modules.find((module) => module.id === target.id)?.parent;
    return [
      ...(parent
        ? [{ id: parent, label: parent || '.', kind: 'module' as const, hint: 'the directory that contains this one', relation: 'parent' as const }]
        : []),
      ...ctx.model.modules
        .filter((module) => module.parent === target.id)
        .slice(0, 6)
        .map((module) => ({ id: module.id, label: module.name, kind: 'module' as const, hint: `${module.totalFiles} files`, relation: 'child' as const })),
    ];
  }
  if (target.kind === 'flow') {
    const flow = ctx.model.dataFlows.find((candidate) => candidate.id === target.id);
    return (
      flow?.path
        .map((id) => ctx.model.components.find((component) => component.id === id))
        .filter((component): component is NonNullable<typeof component> => Boolean(component))
        .slice(0, 5)
        .map((component) => ({ id: component.id, label: component.name, kind: 'component' as const, hint: componentHint(component), relation: 'related' as const })) ?? []
    );
  }
  return [];
}

/* ------------------------------------------------------------------ *
 * Change context assembly
 * ------------------------------------------------------------------ */


const MAX_TOTAL_DIFF_CHARS = 110_000;

async function buildChangeContext(change: Change): Promise<{ diff: string }> {
  const diffParts: string[] = [];
  let used = 0;
  const ranked = [...change.files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
  for (const file of ranked) {
    if (!file.patch) continue;
    if (used + file.patch.length > MAX_TOTAL_DIFF_CHARS) {
      const remaining = MAX_TOTAL_DIFF_CHARS - used;
      if (remaining < 2000) break;
      diffParts.push(truncate(file.patch, remaining, '\n… [diff truncated]'));
      used = MAX_TOTAL_DIFF_CHARS;
      break;
    }
    diffParts.push(file.patch);
    used += file.patch.length;
  }
  if (ranked.length > diffParts.length) diffParts.push(`\n… ${ranked.length - diffParts.length} further file diff(s) omitted for length.`);
  return { diff: diffParts.join('\n') };
}

async function buildChangeHistory(ctx: RepoContext, change: Change): Promise<string> {
  const parts: string[] = [];
  for (const file of change.files.slice(0, 3)) {
    const commits = await listCommits(ctx.root, { limit: 6, path: file.path });
    if (commits.length === 0) continue;
    parts.push(`- ${file.path}\n${commits.map((commit) => `  - ${commit.short} (${commit.date?.slice(0, 10)}) ${commit.subject}`).join('\n')}`);
  }
  return parts.join('\n');
}
