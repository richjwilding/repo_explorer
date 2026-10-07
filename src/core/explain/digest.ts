import type { Component, RepoModel } from '../types.js';
import { describeDataModel } from '../analysis/contracts.js';
import { describeGaps } from '../analysis/gaps.js';
import { describeOperations } from '../analysis/ops.js';
import { truncate } from '../util/text.js';

/**
 * Compact, token-efficient summaries of the analysis. These are the grounding
 * context that every prompt starts with, so they must be accurate, dense, and
 * bounded in size.
 */

export function buildRepoDigest(model: RepoModel, options: { maxChars?: number; includeFiles?: boolean } = {}): string {
  const maxChars = options.maxChars ?? 20_000;
  const parts: string[] = [];

  parts.push(`# Repository: ${model.repo.slug ?? model.repo.name}`);
  parts.push(
    `Path: ${model.repo.path}` +
      (model.git.branch ? ` · branch ${model.git.branch}${model.git.headShort ? ` @ ${model.git.headShort}` : ''}` : '') +
      (model.git.isRepo ? ` · ${model.git.commitCount.toLocaleString()} commits` : ' · not a git repository'),
  );
  parts.push(
    `Size: ${model.stats.fileCount.toLocaleString()} files · ${model.stats.loc.toLocaleString()} LOC · ` +
      `${model.stats.componentCount} components · ${model.stats.moduleCount} directories`,
  );

  if (model.stack.primaryLanguage || model.stack.frameworks.length > 0) {
    const stackBits = [
      model.stack.primaryLanguage ? `primary language ${model.stack.primaryLanguage}` : null,
      model.stack.frameworks.length > 0 ? `frameworks/libraries: ${model.stack.frameworks.join(', ')}` : null,
      model.stack.runtimes.length > 0 ? `runtimes: ${model.stack.runtimes.join(', ')}` : null,
      model.stack.packageManagers.length > 0 ? `package managers: ${model.stack.packageManagers.join(', ')}` : null,
      model.stack.testFrameworks.length > 0 ? `tests: ${model.stack.testFrameworks.join(', ')}` : null,
      model.stack.ci.length > 0 ? `CI: ${model.stack.ci.join(', ')}` : null,
    ].filter((x): x is string => Boolean(x));
    parts.push(`\n## Stack\n- ${stackBits.join('\n- ')}`);
  }

  const components = [...model.components].sort((a, b) => b.importance - a.importance);
  parts.push('\n## Components (most important first)');
  for (const component of components.slice(0, 18)) {
    parts.push(
      `- **${component.name}** (${component.kind})${component.ancillary ? ' [ancillary]' : ''} — ${component.oneLiner} ` +
        `Loc: ${component.loc.toLocaleString()}. Path: \`${component.path || '.'}\`. ` +
        (component.dependsOn.length > 0 ? `Depends on: ${component.dependsOn.slice(0, 5).join(', ')}. ` : '') +
        (component.keyFiles.length > 0 ? `Key files: ${component.keyFiles.slice(0, 4).map((f) => `\`${f}\``).join(', ')}.` : ''),
    );
  }
  if (components.length > 18) parts.push(`- …and ${components.length - 18} smaller components.`);

  const tests = model.tests;
  if (tests.summary.sourceFiles > 0 && tests.summary.testFiles > 0) {
    parts.push(
      `\n## Testing\n- ${tests.summary.testFiles} test files, ${tests.summary.testLoc.toLocaleString()} lines. ` +
        `${tests.summary.percentReferenced}% of source files are reached by a test.`,
    );
    const worst = tests.components.filter((component) => component.percent < 50).slice(0, 6);
    if (worst.length > 0) {
      parts.push(`- Least covered components: ${worst.map((component) => `${component.name} ${component.percent}%`).join(', ')}`);
    }
    if (tests.riskyGaps.length > 0) {
      parts.push(`- Untested files with the most churn: ${tests.riskyGaps.slice(0, 5).map((gap) => `\`${gap.path}\``).join(', ')}`);
    }
  } else if (tests.summary.sourceFiles > 0) {
    parts.push('\n## Testing\n- No test files were detected. Treat every correctness claim as unverified.');
  }

  // How the project is built, verified and shipped. Placed before the code
  // structure because it is the first thing a reader needs and the one thing
  // that cannot be worked out by reading source.
  const opsLines = describeOperations(model.ops);
  if (opsLines.length > 0) {
    parts.push('\n## How it is built, verified and run');
    for (const line of opsLines) parts.push(`- ${line}`);
    const scripts = model.ops.scripts.filter((script) => script.category !== 'other');
    if (scripts.length > 0) {
      parts.push(
        `- Scripts: ${scripts.slice(0, 8).map((script) => `\`${script.name}\``).join(', ')}` +
          `${scripts.length > 8 ? ` (+${scripts.length - 8} more)` : ''}`,
      );
    }
  }

  const coupling = model.coupling;
  if (coupling.totalCommits >= 5 && (coupling.pairs.length > 0 || coupling.components.length > 0)) {
    parts.push('\n## Coupling and ownership (from git history)');
    const cross = coupling.pairs.filter((pair) => pair.crossComponent).slice(0, 6);
    if (cross.length > 0) {
      parts.push('Files in different components that change together — dependencies the import graph does not show:');
      for (const pair of cross) {
        parts.push(`- \`${pair.a}\` and \`${pair.b}\` (${pair.together} commits together, confidence ${pair.confidence})`);
      }
    }
    const same = coupling.pairs.filter((pair) => !pair.crossComponent).slice(0, 4);
    if (same.length > 0) {
      parts.push(`Within the same component: ${same.map((pair) => `\`${pair.a}\` + \`${pair.b}\` (${pair.confidence})`).join(', ')}`);
    }
    const busiest = coupling.components.slice(0, 6);
    if (busiest.length > 0) {
      parts.push(
        `Ownership by component: ${busiest
          .map((component) => `${component.name} — ${component.authors} author(s), ${Math.round(component.topAuthorShare * 100)}% from ${component.topAuthor}`)
          .join('; ')}.`,
      );
    }
    if (coupling.singleOwner.length > 0) {
      parts.push(
        `Key-person risk: ${coupling.singleOwner
          .slice(0, 5)
          .map((component) => `${component.name} (${Math.round(component.topAuthorShare * 100)}% ${component.topAuthor})`)
          .join(', ')}.`,
      );
    }
  }

  if (model.hotspots.length > 0) {
    parts.push('\n## Hotspots (historical churn × size)');
    for (const hotspot of model.hotspots.slice(0, 12)) {
      parts.push(`- \`${hotspot.path}\` — ${hotspot.commits} commits touching it, ${hotspot.loc.toLocaleString()} lines`);
    }
  }

  if (model.dependencies.length > 0) {
    parts.push(
      '\n## External dependencies (exact identifiers found in imports, container images, environment variables and connection strings — use these exact names)',
    );
    const shown = model.dependencies.slice(0, 30);
    for (const dependency of shown) {
      const label = dependency.label ? ` — ${dependency.label}` : '';
      parts.push(
        `- ${dependency.name}${label} (${dependency.kind}, ${dependency.category}) · seen in ${dependency.evidence
          .slice(0, 2)
          .map((file) => `\`${file}\``)
          .join(', ')}`,
      );
    }
    if (model.dependencies.length > shown.length) parts.push(`- …and ${model.dependencies.length - shown.length} more.`);
  }

  const complexity = model.complexity;
  if (complexity.symbols.length > 0) {
    const summary = complexity.summary;
    parts.push('\n## Complexity (measured, not inferred from size)');
    parts.push(
      `${summary.functionsAnalysed.toLocaleString()} definitions measured: mean ${summary.meanBranches} decision points, ` +
        `mean nesting depth ${summary.meanDepth}, deepest ${summary.deepest}. ` +
        `${summary.deepFunctions} nest ${4}+ levels deep; ${summary.branchyFunctions} carry ${10}+ decision points.`,
    );
    parts.push('Hardest to change safely (difficulty weighted by how many callers depend on it):');
    for (const symbol of complexity.symbols.slice(0, 10)) {
      parts.push(
        `- \`${symbol.name}\` — ${symbol.branches} decision points, depth ${symbol.maxDepth}, ${symbol.callers} caller(s)` +
          `${symbol.reachable ? '' : ', unreachable'} (${symbol.path}:${symbol.line})`,
      );
    }
  }

  const dataLines = describeDataModel(model.dataModel);
  if (dataLines.length > 0) {
    parts.push('\n## Data model');
    for (const line of dataLines) parts.push(`- ${line}`);
    const withFields = model.dataModel.schemas.filter((schema) => schema.fields.length > 0).slice(0, 8);
    for (const schema of withFields) {
      parts.push(
        `- \`${schema.name}\` (${schema.kind}): ${schema.fields.slice(0, 12).map((field) => `${field.name}: ${field.type}${field.optional ? '?' : ''}`).join(', ')}` +
          `${schema.fields.length > 12 ? ` (+${schema.fields.length - 12} more)` : ''}`,
      );
    }
  }

  // Placed early: what is missing is as important as what is present, and it is
  // the one thing a reader cannot discover by browsing.
  const gapLines = describeGaps(model.gaps);
  if (gapLines.length > 0) {
    parts.push('\n## What is absent');
    for (const line of gapLines) parts.push(`- ${line}`);
  }

  const conventions = model.conventions;
  if (conventions.rules.length > 0) {
    parts.push('\n## Conventions the code follows (inferred from this repository, not from general practice)');
    for (const rule of conventions.rules.slice(0, 12)) {
      parts.push(`- ${rule.rule} ${rule.basis}`);
      for (const violation of rule.violations.slice(0, 4)) {
        parts.push(`  - exception: \`${violation.path}\` — ${violation.detail}`);
      }
    }
    if (conventions.weakPatterns.length > 0) {
      parts.push(`Patterns too mixed to call a convention: ${conventions.weakPatterns.slice(0, 4).join(' ')}`);
    }
  }

  if (model.entrypoints.length > 0) {
    parts.push('\n## Entrypoints');
    for (const entrypoint of model.entrypoints.slice(0, 14)) {
      parts.push(`- \`${entrypoint.path}\` — ${entrypoint.kind} (${entrypoint.reason})`);
    }
  }

  if (model.routes.length > 0) {
    parts.push(`\n## HTTP / RPC endpoints (${model.routes.length} detected)`);
    for (const route of model.routes.slice(0, 15)) {
      parts.push(
        `- \`${route.method} ${route.path}\` → ${route.handler ?? 'unknown handler'} (${route.file}:${route.line}, ${route.framework})`,
      );
    }
    if (model.routes.length > 15) parts.push(`- …and ${model.routes.length - 15} more.`);
  }

  if (model.symbols.length > 0) {
    const hubs = [...model.symbols]
      .filter((symbol) => !/(^|\/)(tests?|__tests__|spec)(\/|$)/.test(symbol.path))
      .sort((a, b) => b.callerCount - a.callerCount)
      .slice(0, 10)
      .filter((symbol) => symbol.callerCount > 0);
    parts.push(`\n## Call graph\n${model.symbols.length.toLocaleString()} definitions, ${model.calls.length.toLocaleString()} call edges (${model.calls.filter((c) => c.resolved).length.toLocaleString()} resolved to a definition in this repository).`);
    if (hubs.length > 0) {
      parts.push('Most-called internal functions (the true choke points):');
      for (const hub of hubs) parts.push(`- \`${hub.name}\` — ${hub.callerCount} callers, in ${hub.path}:${hub.line}`);
    }
    if (model.deadCode.length > 0) {
      parts.push(
        `${model.deadCode.length} definitions look unreachable from any entrypoint, e.g. ${model.deadCode
          .slice(0, 5)
          .map((d) => `\`${d.name}\` (${d.path})`)
          .join(', ')}.`,
      );
    }
  }

  if (model.dataFlows.length > 0) {
    parts.push('\n## Known data flows');
    for (const flow of model.dataFlows) {
      parts.push(`- ${flow.name}: ${flow.summary}`);
    }
  }

  if (model.concepts.length > 0) {
    parts.push('\n## Recurring domain concepts');
    parts.push(`- ${model.concepts.slice(0, 12).map((c) => c.name).join(', ')}`);
  }

  if (options.includeFiles) {
    parts.push('\n## File tree (trimmed)');
    parts.push(formatFileTree(model, 160));
  }

  if (model.readme) {
    parts.push('\n## README excerpt');
    parts.push(truncate(model.readme, 2500));
  }

  return truncate(parts.join('\n'), maxChars, '\n… [digest truncated]');
}

export function formatFileTree(model: RepoModel, maxEntries = 200): string {
  const byDir = new Map<string, string[]>();
  for (const file of model.files) {
    if (file.isNoise) continue;
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.';
    if (!byDir.has(dir)) byDir.set(dir, []);
    (byDir.get(dir) as string[]).push(file.path.split('/').pop() as string);
  }
  const dirs = [...byDir.keys()].sort();
  const lines: string[] = [];
  for (const dir of dirs) {
    if (lines.length > maxEntries) break;
    const files = (byDir.get(dir) as string[]).sort().slice(0, 12);
    const extra = (byDir.get(dir) as string[]).length - files.length;
    lines.push(`${dir}/: ${files.join(', ')}${extra > 0 ? ` (+${extra} more)` : ''}`);
  }
  return lines.join('\n');
}

export function buildComponentDigest(model: RepoModel, component: Component): string {
  const modules = model.modules.filter((m) => component.moduleIds.includes(m.id)).slice(0, 30);
  const lines: string[] = [];
  lines.push(`# Component: ${component.name} (${component.kind})`);
  lines.push(`Path: \`${component.path || '.'}\``);
  lines.push(`Summary: ${component.oneLiner}`);
  lines.push(`Size: ${component.files.length} files · ${component.loc.toLocaleString()} LOC`);
  if (component.ancillary) lines.push('This component is considered ancillary (supporting code rather than core product logic).');
  if (component.keyFiles.length > 0) lines.push(`\nKey files:\n${component.keyFiles.map((f) => `- \`${f}\``).join('\n')}`);
  if (modules.length > 1) {
    lines.push(
      `\nSub-directories:\n${modules
        .filter((m) => m.id !== component.path)
        .slice(0, 20)
        .map((m) => `- \`${m.id}\` — ${m.totalFiles} files, ${m.totalLoc.toLocaleString()} LOC`)
        .join('\n')}`,
    );
  }
  if (component.dependsOn.length > 0) lines.push(`\nDepends on components: ${component.dependsOn.join(', ')}`);
  const dependents = model.components.filter((c) => c.dependsOn.includes(component.id)).map((c) => c.name);
  if (dependents.length > 0) lines.push(`Used by components: ${dependents.join(', ')}`);
  if (component.externalDeps.length > 0) lines.push(`External packages: ${component.externalDeps.slice(0, 30).join(', ')}`);

  const coverage = model.tests.components.find((entry) => entry.id === component.id);
  if (coverage) {
    lines.push(
      `\nTest coverage: ${coverage.percent}% of this component's ${coverage.sourceFiles} source files are reached by a test ` +
        `(${coverage.referenced} files).`,
    );
    const gaps = model.tests.untested.filter((file) => file.component === component.name).slice(0, 8);
    if (gaps.length > 0) lines.push(`Files in this component no test reaches:\n${gaps.map((file) => `- \`${file.path}\` (${file.loc} lines)`).join('\n')}`);
  }

  // Configuration this component needs, and any infrastructure it owns.
  const ownedConfig = model.ops.envVars
    .filter((entry) => entry.files.some((file) => component.files.includes(file)))
    .filter((entry) => !entry.testOnly)
    .map((entry) => entry.name);
  if (ownedConfig.length > 0) lines.push(`Environment variables used here: ${ownedConfig.slice(0, 15).join(', ')}`);
  const ownedInfra = model.ops.infra.filter((file) => component.files.includes(file.path));
  for (const file of ownedInfra.slice(0, 4)) {
    lines.push(`Infrastructure \`${file.path}\` (${file.format}): ${file.resources.slice(0, 8).map((r) => r.kind).join(', ') || 'no resources parsed'}`);
  }
  const ownedContainers = model.ops.containers.filter((file) => component.files.includes(file.path));
  for (const container of ownedContainers.slice(0, 2)) {
    lines.push(
      `Dockerfile \`${container.path}\`: exposes ${container.exposedPorts.join(', ') || 'no ports'}; ` +
        `starts with \`${container.entrypoint ?? container.cmd ?? 'unstated'}\`${container.runsAsRoot ? '; runs as root' : ''}.`,
    );
  }

  const broken = model.conventions.rules.flatMap((rule) =>
    rule.violations.filter((violation) => component.files.includes(violation.path)).map((violation) => `${rule.rule} — ${violation.detail}`),
  );
  if (broken.length > 0) {
    lines.push(`\nConventions this component breaks:\n${broken.slice(0, 6).map((entry) => `- ${entry}`).join('\n')}`);
  }

  const hardest = model.complexity.symbols.filter((symbol) => component.files.includes(symbol.path)).slice(0, 5);
  if (hardest.length > 0) {
    lines.push(
      `\nHardest to change here: ${hardest
        .map((symbol) => `\`${symbol.name}\` (${symbol.branches} decision points, depth ${symbol.maxDepth}, ${symbol.callers} callers)`)
        .join(', ')}.`,
    );
  }

  const ownership = model.coupling.components.find((entry) => entry.id === component.id);
  if (ownership && ownership.commits > 0) {
    lines.push(
      `\nOwnership: ${ownership.commits} commits from ${ownership.authors} author(s); ` +
        `${Math.round(ownership.topAuthorShare * 100)}% from ${ownership.topAuthor} (bus factor ${ownership.busFactor}).`,
    );
  }
  const couples = model.coupling.pairs.filter((pair) => component.files.includes(pair.a) || component.files.includes(pair.b)).slice(0, 6);
  if (couples.length > 0) {
    lines.push('Files that change alongside this component:');
    for (const pair of couples) {
      const other = component.files.includes(pair.a) ? pair.b : pair.a;
      lines.push(`- \`${other}\` (${pair.together} commits together, confidence ${pair.confidence})${pair.crossComponent ? ' — a different component' : ''}`);
    }
  }

  const symbols = model.files
    .filter((f) => component.files.includes(f.path))
    .flatMap((f) => f.symbols.filter((s) => s.exported).map((s) => `${s.name} (${s.kind}) in ${f.path}`))
    .slice(0, 40);
  if (symbols.length > 0) lines.push(`\nExported symbols:\n${symbols.map((s) => `- ${s}`).join('\n')}`);

  return truncate(lines.join('\n'), 7000, '\n… [truncated]');
}

export function buildModuleDigest(model: RepoModel, moduleId: string): string {
  const module = model.modules.find((m) => m.id === moduleId);
  if (!module) return '';
  const component = model.components.find((c) => c.path !== '' && (moduleId === c.path || moduleId.startsWith(`${c.path}/`)));
  const lines: string[] = [];
  lines.push(`# Directory: \`${moduleId || '.'}\``);
  lines.push(`${module.totalFiles} files · ${module.totalLoc.toLocaleString()} LOC · languages: ${module.languages.join(', ') || 'n/a'}`);
  if (component) lines.push(`Part of component: ${component.name} (${component.kind}) — ${component.oneLiner}`);
  lines.push(`\nFiles directly in this directory:\n${module.ownFiles.slice(0, 40).map((f) => `- \`${f}\``).join('\n')}`);
  if (module.children.length > 0) {
    lines.push(
      `\nSub-directories:\n${module.children
        .slice(0, 25)
        .map((child) => {
          const node = model.modules.find((m) => m.id === child);
          return `- \`${child}\` — ${node?.totalFiles ?? 0} files, ${(node?.totalLoc ?? 0).toLocaleString()} LOC`;
        })
        .join('\n')}`,
    );
  }
  const symbols = model.files
    .filter((f) => module.ownFiles.includes(f.path))
    .flatMap((f) => f.symbols.slice(0, 20).map((s) => `${s.name} (${s.kind})${s.exported ? ' [exported]' : ''} — ${f.path}:${s.line}`));
  if (symbols.length > 0) lines.push(`\nSymbols:\n${symbols.slice(0, 60).map((s) => `- ${s}`).join('\n')}`);
  return truncate(lines.join('\n'), 6000, '\n… [truncated]');
}
