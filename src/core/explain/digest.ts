import type { Component, RepoModel } from '../types.js';
import { truncate } from '../util/text.js';

/**
 * Compact, token-efficient summaries of the analysis. These are the grounding
 * context that every prompt starts with, so they must be accurate, dense, and
 * bounded in size.
 */

export function buildRepoDigest(model: RepoModel, options: { maxChars?: number; includeFiles?: boolean } = {}): string {
  const maxChars = options.maxChars ?? 9000;
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

  if (model.entrypoints.length > 0) {
    parts.push('\n## Entrypoints');
    for (const entrypoint of model.entrypoints.slice(0, 14)) {
      parts.push(`- \`${entrypoint.path}\` — ${entrypoint.kind} (${entrypoint.reason})`);
    }
  }

  if (model.routes.length > 0) {
    parts.push(`\n## HTTP / RPC endpoints (${model.routes.length} detected)`);
    for (const route of model.routes.slice(0, 30)) {
      parts.push(
        `- \`${route.method} ${route.path}\` → ${route.handler ?? 'unknown handler'} (${route.file}:${route.line}, ${route.framework})`,
      );
    }
    if (model.routes.length > 30) parts.push(`- …and ${model.routes.length - 30} more.`);
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
