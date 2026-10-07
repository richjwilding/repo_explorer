import path from 'node:path';
import type { Route, SymbolRecord } from '../types.js';
import type { RepoContext } from '../service.js';
import { readTextFileSync } from '../util/fs.js';
import { listCommits } from '../util/git.js';
import { buildComponentDigest, formatFileTree } from '../explain/digest.js';
import { truncate } from '../util/text.js';

/**
 * The explorer's tool set.
 *
 * These are deliberately narrow, cheap, and deterministic: the language model
 * decides *what to look at*, and real static-analysis code decides *what is
 * there*. Nothing here writes to disk or leaves the machine.
 */

export interface ToolInvocation {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  /** Text handed back to the model as an observation. */
  text: string;
  /** One-line description shown in the UI progress log. */
  summary: string;
  /** Where the evidence came from, for citation. */
  sources?: { path: string; startLine?: number; endLine?: number }[];
  /** True when the tool could not answer (bad args, unknown symbol). */
  failed?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  args: string;
  run(ctx: RepoContext, args: Record<string, unknown>): Promise<ToolResult>;
}

const MAX_OBSERVATION_CHARS = 5000;

function arg<T>(args: Record<string, unknown>, key: string, fallback: T): T {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  return value as T;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function bound(text: string, limit = MAX_OBSERVATION_CHARS): string {
  return truncate(text, limit, '\n… [observation truncated]');
}

function isTestPath(filePath: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|specs)(\/|$)/.test(filePath) || /\.(test|spec)\./.test(filePath);
}

/* ------------------------------------------------------------------ *
 * Symbol helpers
 * ------------------------------------------------------------------ */

function findSymbols(ctx: RepoContext, query: string, limit = 8): SymbolRecord[] {
  const needle = query.trim();
  if (!needle) return [];
  const lower = needle.toLowerCase();
  const exact = ctx.model.symbols.filter((symbol) => symbol.name === needle);
  const scoped = ctx.model.symbols.filter((symbol) => needle.includes('.') && `${symbol.container ?? ''}.${symbol.name}` === needle);
  const partial = ctx.model.symbols.filter((symbol) => symbol.name.toLowerCase().includes(lower));
  const byId = new Map<string, SymbolRecord>();
  for (const symbol of [...exact, ...scoped, ...partial]) byId.set(symbol.id, symbol);
  // Prefer non-test definitions, then exported, then bigger bodies.
  return [...byId.values()]
    .sort((a, b) => {
      const test = Number(isTestPath(a.path)) - Number(isTestPath(b.path));
      if (test !== 0) return test;
      const exported = Number(b.exported) - Number(a.exported);
      if (exported !== 0) return exported;
      return b.loc - a.loc;
    })
    .slice(0, limit);
}

function describeSymbol(symbol: SymbolRecord): string {
  const container = symbol.container ? `${symbol.container}.` : '';
  return `${container}${symbol.name} (${symbol.kind}) — ${symbol.path}:${symbol.line}-${symbol.endLine} · ${symbol.loc} lines · ${
    symbol.exported ? 'exported' : 'internal'
  } · ${symbol.callerCount} caller(s), ${symbol.calleeCount} callee(s)${symbol.entry ? ' · ENTRYPOINT' : symbol.reachable ? ' · reachable' : ''}`;
}

/** A short list of plausible symbol names, offered when a lookup fails. */
function suggestSymbols(ctx: RepoContext, limit = 8): string {
  const candidates = ctx.model.symbols
    .filter((symbol) => (symbol.entry || symbol.exported) && symbol.kind !== 'const')
    .sort((a, b) => b.callerCount - a.callerCount || b.loc - a.loc)
    .slice(0, limit)
    .map((symbol) => `${symbol.name} (${symbol.path}:${symbol.line})`);
  return candidates.length > 0 ? ` Perhaps you meant one of: ${candidates.join(', ')}.` : '';
}

function resolveOne(ctx: RepoContext, query: string): SymbolRecord | undefined {
  if (query.includes('#')) {
    const direct = ctx.model.symbols.find((symbol) => symbol.id === query);
    if (direct) return direct;
  }
  // Accept a file path as well as a name: agents naturally try both.
  if (query.includes('/') || /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|cs|swift|c|cpp|h|hpp)$/.test(query)) {
    const normalised = query.replace(/^[./]+/, '');
    const inFile = ctx.model.symbols.filter((symbol) => symbol.path === normalised || symbol.path.endsWith(`/${normalised}`));
    if (inFile.length > 0) {
      return (
        inFile.find((symbol) => symbol.entry) ??
        inFile.find((symbol) => symbol.exported && symbol.callerCount + symbol.calleeCount > 0) ??
        [...inFile].sort((a, b) => b.loc - a.loc)[0]
      );
    }
  }
  return findSymbols(ctx, query, 1)[0];
}

/* ------------------------------------------------------------------ *
 * Tool implementations
 * ------------------------------------------------------------------ */

const tools: ToolSpec[] = [
  {
    name: 'list_dir',
    description: 'List the files and sub-directories of a directory in the repository.',
    args: '{ "path": "services/ops-dashboard" }  // "" or "." for the repository root',
    async run(ctx, args) {
      const dir = (str(args, 'path') ?? '').replace(/^\.\/?$/, '').replace(/^\/+|\/+$/g, '');
      const prefix = dir ? `${dir}/` : '';
      const dirs = new Map<string, number>();
      const files: string[] = [];
      for (const file of ctx.model.files) {
        if (file.isNoise) continue;
        if (prefix && !file.path.startsWith(prefix)) continue;
        const rest = file.path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) files.push(`${rest} (${file.lines} lines, ${file.language}, ${file.category})`);
        else dirs.set(`${prefix}${rest.slice(0, slash)}`, (dirs.get(`${prefix}${rest.slice(0, slash)}`) ?? 0) + 1);
      }
      const lines = [
        `Directory: \`${dir || '.'}\``,
        ...[...dirs.entries()].sort().map(([name, count]) => `  [dir]  ${name}/ (${count} files)`),
        ...files.sort().map((file) => `  [file] ${file}`),
      ];
      return { text: bound(lines.join('\n')), summary: `listed ${dir || '/'} (${files.length} files, ${dirs.size} dirs)` };
    },
  },
  {
    name: 'read_file',
    description: 'Read a slice of a file with line numbers. Use this to read the actual code before making claims about it.',
    args: '{ "path": "services/ops-dashboard/app/main.py", "startLine": 120, "endLine": 220 }',
    async run(ctx, args) {
      const filePath = str(args, 'path');
      if (!filePath) return { text: 'Error: "path" is required.', summary: 'read_file failed', failed: true };
      const normalised = filePath.replace(/^\.\//, '');
      const resolved = path.resolve(ctx.root, normalised);
      if (!resolved.startsWith(path.resolve(ctx.root))) {
        return { text: 'Error: path escapes the repository root.', summary: 'read_file blocked', failed: true };
      }
      const content = readTextFileSync(resolved, 600_000);
      if (content === null) return { text: `Error: ${normalised} is missing, binary, or unreadable.`, summary: `read_file failed (${normalised})`, failed: true };
      const lines = content.split('\n');
      const start = Math.max(1, num(args, 'startLine', 1));
      const end = Math.min(lines.length, num(args, 'endLine', start + 220));
      const numbered = lines
        .slice(start - 1, end)
        .map((line, index) => `${String(start + index).padStart(5)} | ${line}`)
        .join('\n');
      return {
        text: bound(`File: ${normalised} (lines ${start}-${end} of ${lines.length})\n${numbered}`),
        summary: `read ${normalised}:${start}-${end}`,
        sources: [{ path: normalised, startLine: start, endLine: end }],
      };
    },
  },
  {
    name: 'search_code',
    description: 'Full-text / symbol search across the repository (BM25 over parsed code chunks).',
    args: '{ "query": "reindex heal sweep", "limit": 8 }',
    async run(ctx, args) {
      const query = str(args, 'query');
      if (!query) return { text: 'Error: "query" is required.', summary: 'search_code failed', failed: true };
      const limit = Math.min(num(args, 'limit', 8), 20);
      const hits = ctx.index.search(query, limit);
      if (hits.length === 0) return { text: `No matches for "${query}".`, summary: `searched "${query}" (no hits)` };
      const text = hits
        .map((hit) => `— ${hit.chunk.path}:${hit.chunk.startLine}-${hit.chunk.endLine}${hit.chunk.symbol ? ` (${hit.chunk.symbol})` : ''}\n${truncate(hit.chunk.text, 900)}`)
        .join('\n\n');
      return {
        text: bound(`Search results for "${query}":\n\n${text}`),
        summary: `searched "${query}" (${hits.length} hits)`,
        sources: hits.map((hit) => ({ path: hit.chunk.path, startLine: hit.chunk.startLine, endLine: hit.chunk.endLine })),
      };
    },
  },
  {
    name: 'find_symbol',
    description: 'Find definitions by name (exact or partial). Returns location, container, and how often it is called.',
    args: '{ "name": "require_admin_token" }',
    async run(ctx, args) {
      const name = str(args, 'name');
      if (!name) return { text: 'Error: "name" is required.', summary: 'find_symbol failed', failed: true };
      const matches = findSymbols(ctx, name, num(args, 'limit', 8));
      if (matches.length === 0) return { text: `No definition matches "${name}".${suggestSymbols(ctx)}`, summary: `find_symbol "${name}" (no match)` };
      return {
        text: bound(matches.map(describeSymbol).join('\n')),
        summary: `find_symbol "${name}" (${matches.length})`,
        sources: matches.map((symbol) => ({ path: symbol.path, startLine: symbol.line, endLine: symbol.endLine })),
      };
    },
  },
  {
    name: 'callers_of',
    description: 'List the functions that call a given function. Use this to establish whether something is load-bearing.',
    args: '{ "symbol": "resolve_tenant" }',
    async run(ctx, args) {
      const query = str(args, 'symbol') ?? str(args, 'name');
      if (!query) return { text: 'Error: "symbol" is required.', summary: 'callers_of failed', failed: true };
      const symbol = resolveOne(ctx, query);
      if (!symbol) return { text: `No definition matches "${query}".${suggestSymbols(ctx)}`, summary: `callers_of "${query}" (no match)` };
      const byId = new Map(ctx.model.symbols.map((s) => [s.id, s]));
      const ids = new Set(expandToMethods(ctx, symbol).map((item) => item.id));
      const callers = ctx.model.calls.filter((call) => call.to !== null && ids.has(call.to));
      if (callers.length === 0) {
        return { text: `${symbol.name} has no resolved callers inside this repository.`, summary: `callers_of ${symbol.name} (0)`, sources: [{ path: symbol.path, startLine: symbol.line }] };
      }
      const lines = callers.slice(0, 40).map((call) => {
        const caller = byId.get(call.from);
        return `- ${caller ? `${caller.container ? `${caller.container}.` : ''}${caller.name}` : call.from} at ${call.fromPath}:${call.fromLine}${isTestPath(call.fromPath) ? ' [test]' : ''}`;
      });
      return {
        text: bound(`Callers of ${symbol.name} (${callers.length}):\n${lines.join('\n')}`),
        summary: `callers_of ${symbol.name} (${callers.length})`,
        sources: callers.slice(0, 10).map((call) => ({ path: call.fromPath, startLine: call.fromLine })),
      };
    },
  },
  {
    name: 'callees_of',
    description: 'List what a function calls: resolved internal definitions and external libraries.',
    args: '{ "symbol": "handle_reindex" }',
    async run(ctx, args) {
      const query = str(args, 'symbol') ?? str(args, 'name');
      if (!query) return { text: 'Error: "symbol" is required.', summary: 'callees_of failed', failed: true };
      const symbol = resolveOne(ctx, query);
      if (!symbol) return { text: `No definition matches "${query}".${suggestSymbols(ctx)}`, summary: `callees_of "${query}" (no match)` };
      const ids = new Set(expandToMethods(ctx, symbol).map((item) => item.id));
      const internal: string[] = [];
      const external = new Set<string>();
      const unresolved = new Set<string>();
      for (const call of ctx.model.calls.filter((edge) => ids.has(edge.from))) {
        if (call.to) internal.push(`${call.toName} (${call.toPath}:${ctx.model.symbols.find((s) => s.id === call.to)?.line ?? '?'})`);
        else if (call.external) external.add(call.external);
        else unresolved.add(call.toName);
      }
      const lines = [
        internal.length > 0 ? `Internal calls:\n${[...new Set(internal)].slice(0, 30).map((line) => `- ${line}`).join('\n')}` : 'No resolved internal calls.',
        external.size > 0 ? `External packages: ${[...external].slice(0, 20).join(', ')}` : '',
        unresolved.size > 0 ? `Unresolved names (built-ins, dynamic dispatch, or third-party): ${[...unresolved].slice(0, 30).join(', ')}` : '',
      ].filter(Boolean);
      return { text: bound(`${symbol.name} calls:\n\n${lines.join('\n\n')}`), summary: `callees_of ${symbol.name}`, sources: [{ path: symbol.path, startLine: symbol.line, endLine: symbol.endLine }] };
    },
  },
  {
    name: 'trace_calls',
    description: 'Expand the call graph outward from a function, depth-first. Use this to follow an execution path end to end.',
    args: '{ "symbol": "create_app", "depth": 3 }',
    async run(ctx, args) {
      const query = str(args, 'symbol') ?? str(args, 'name');
      if (!query) return { text: 'Error: "symbol" is required.', summary: 'trace_calls failed', failed: true };
      const root = resolveOne(ctx, query);
      if (!root) return { text: `No definition matches "${query}".${suggestSymbols(ctx)}`, summary: `trace_calls "${query}" (no match)` };
      const depthLimit = Math.min(num(args, 'depth', 3), 5);
      const byId = new Map(ctx.model.symbols.map((s) => [s.id, s]));
      const seeds = expandToMethods(ctx, root).map((item) => item.id);
      const outgoing = new Map<string, string[]>();
      for (const call of ctx.model.calls) {
        if (!call.to) continue;
        if (!outgoing.has(call.from)) outgoing.set(call.from, []);
        (outgoing.get(call.from) as string[]).push(call.to);
      }
      const lines: string[] = [];
      const seen = new Set<string>();
      const walk = (id: string, depth: number, indent: string) => {
        if (depth > depthLimit || lines.length > 120) return;
        const symbol = byId.get(id);
        if (!symbol) return;
        if (seen.has(id)) {
          lines.push(`${indent}- ${symbol.name} … (already shown)`);
          return;
        }
        seen.add(id);
        lines.push(`${indent}- ${symbol.name} (${symbol.path}:${symbol.line})${isTestPath(symbol.path) ? ' [test]' : ''}`);
        for (const next of [...new Set(outgoing.get(id) ?? [])].slice(0, 6)) walk(next, depth + 1, `${indent}  `);
      };
      for (const seed of seeds) walk(seed, 0, '');
      return {
        text: bound(`Call tree from ${root.name} (depth ≤ ${depthLimit}):\n${lines.join('\n')}`),
        summary: `trace_calls ${root.name} (depth ${depthLimit})`,
        sources: [{ path: root.path, startLine: root.line }],
      };
    },
  },
  {
    name: 'list_routes',
    description: 'List the HTTP/RPC endpoints detected in the repository, with their handler functions.',
    args: '{ "filter": "admin" }  // optional substring filter on the path',
    async run(ctx, args) {
      const filter = str(args, 'filter')?.toLowerCase();
      const routes = ctx.model.routes.filter((route: Route) => !filter || route.path.toLowerCase().includes(filter));
      if (routes.length === 0) return { text: filter ? `No routes matching "${filter}".` : 'No HTTP routes were detected.', summary: 'list_routes (0)' };
      const text = routes
        .slice(0, 60)
        .map((route) => `- ${route.method} ${route.path} → ${route.handler ?? 'unknown'} (${route.file}:${route.line}, ${route.framework})`)
        .join('\n');
      return { text: bound(`Detected endpoints (${routes.length}):\n${text}`), summary: `list_routes (${routes.length})`, sources: routes.slice(0, 12).map((route) => ({ path: route.file, startLine: route.line })) };
    },
  },
  {
    name: 'list_entrypoints',
    description: 'List the detected entrypoints: servers, CLIs, workers, and library entry modules.',
    args: '{}',
    async run(ctx) {
      const text = ctx.model.entrypoints
        .slice(0, 40)
        .map((entry) => `- ${entry.kind}: ${entry.path} — ${entry.reason}`)
        .join('\n');
      return { text: bound(`Entrypoints:\n${text}`), summary: `list_entrypoints (${ctx.model.entrypoints.length})`, sources: ctx.model.entrypoints.slice(0, 10).map((entry) => ({ path: entry.path })) };
    },
  },
  {
    name: 'component_summary',
    description: 'Get a structured summary of one component (its role, directories, dependencies, and exported symbols).',
    args: '{ "name": "ops-dashboard" }',
    async run(ctx, args) {
      const name = (str(args, 'name') ?? str(args, 'path') ?? '').toLowerCase();
      if (!name) return { text: 'Error: "name" is required.', summary: 'component_summary failed', failed: true };
      const component =
        ctx.model.components.find((c) => c.id === name) ??
        ctx.model.components.find((c) => c.name.toLowerCase() === name) ??
        ctx.model.components.find((c) => c.path.toLowerCase() === name) ??
        ctx.model.components.find((c) => c.name.toLowerCase().includes(name) || c.path.toLowerCase().includes(name));
      if (!component) {
        return { text: `No component matches "${name}". Known components: ${ctx.model.components.map((c) => c.name).join(', ')}`, summary: `component_summary "${name}" (no match)`, failed: true };
      }
      return {
        text: bound(buildComponentDigest(ctx.model, component)),
        summary: `component_summary ${component.name}`,
        sources: component.keyFiles.slice(0, 6).map((filePath) => ({ path: filePath })),
      };
    },
  },
  {
    name: 'find_hotspots',
    description: 'List the files with the highest historical churn weighted by size — where change and complexity meet.',
    args: '{ "limit": 12 }',
    async run(ctx, args) {
      const limit = Math.min(num(args, 'limit', 12), 30);
      const hotspots = ctx.model.hotspots.slice(0, limit);
      if (hotspots.length === 0) return { text: 'No churn data available (shallow clone or not a git repository).', summary: 'find_hotspots (none)' };
      const text = hotspots.map((spot) => `- ${spot.path} — ${spot.commits} commits, ${spot.loc.toLocaleString()} lines${spot.components.length ? ` (${spot.components.join(', ')})` : ''}`).join('\n');
      return { text: bound(`Hotspots:\n${text}`), summary: `find_hotspots (${hotspots.length})`, sources: hotspots.slice(0, 8).map((spot) => ({ path: spot.path })) };
    },
  },
  {
    name: 'find_dead_code',
    description: 'List definitions that no resolved call reaches from any entrypoint. Treat as a question to investigate, not proof.',
    args: '{ "limit": 15 }',
    async run(ctx, args) {
      const limit = Math.min(num(args, 'limit', 15), 40);
      const candidates = ctx.model.deadCode.slice(0, limit);
      if (candidates.length === 0) return { text: 'No unreachable definitions stood out.', summary: 'find_dead_code (none)' };
      const text = candidates.map((item) => `- ${item.name} (${item.kind}, ${item.loc} lines) — ${item.path} — ${item.reason}`).join('\n');
      return { text: bound(`Possibly unreachable definitions:\n${text}`), summary: `find_dead_code (${candidates.length})`, sources: candidates.slice(0, 8).map((item) => ({ path: item.path })) };
    },
  },
  {
    name: 'list_dependencies',
    description:
      'List what this system depends on outside itself: packages imported by the code, container images from configuration, environment variables, and connection-string schemes. Names are the exact identifiers found.',
    args: '{ "category": "database" }  // optional category filter',
    async run(ctx, args) {
      const filter = str(args, 'category')?.toLowerCase();
      const dependencies = ctx.model.dependencies.filter((dependency) => !filter || dependency.category === filter);
      if (dependencies.length === 0) {
        return { text: filter ? `No dependencies in category "${filter}".` : 'No external dependencies were found.', summary: 'list_dependencies (0)' };
      }
      const text = dependencies
        .slice(0, 80)
        .map((dependency) => {
          const label = dependency.label ? ` (${dependency.label})` : '';
          return `- ${dependency.name}${label} — ${dependency.kind}, ${dependency.category}, ${dependency.references} reference(s), e.g. ${dependency.evidence.slice(0, 3).join(', ')}`;
        })
        .join('\n');
      const categories = [...new Set(dependencies.map((dependency) => dependency.category))].sort();
      return {
        text: bound(
          `External dependencies (${dependencies.length}). Categories present: ${categories.join(', ')}.\nUse these exact names; do not substitute a different product.\n${text}`,
        ),
        summary: `list_dependencies (${dependencies.length})`,
        sources: dependencies.flatMap((dependency) => dependency.evidence.slice(0, 1).map((file) => ({ path: file }))).slice(0, 10),
      };
    },
  },
  {
    name: 'list_files',
    description: 'Show a trimmed file tree for orientation.',
    args: '{ "maxEntries": 120 }',
    async run(ctx, args) {
      const maxEntries = Math.min(num(args, 'maxEntries', 120), 400);
      return { text: bound(formatFileTree(ctx.model, maxEntries)), summary: 'list_files' };
    },
  },
  {
    name: 'git_log',
    description: 'Recent commit history, optionally limited to one file or directory.',
    args: '{ "path": "services/permission-sync/app/internal.py", "limit": 10 }',
    async run(ctx, args) {
      const filePath = str(args, 'path');
      const limit = Math.min(num(args, 'limit', 12), 40);
      const commits = await listCommits(ctx.root, { limit, path: filePath });
      if (commits.length === 0) return { text: `No commits found${filePath ? ` for ${filePath}` : ''}.`, summary: 'git_log (none)' };
      const text = commits.map((commit) => `- ${commit.short} ${commit.date?.slice(0, 10)} ${commit.author}: ${commit.subject}`).join('\n');
      return { text: bound(`Recent commits${filePath ? ` touching ${filePath}` : ''}:\n${text}`), summary: `git_log ${filePath ?? '(all)'} (${commits.length})` };
    },
  },
  {
    name: 'read_readme',
    description: 'Read the repository README, or the list of documentation files if no path is given.',
    args: '{ "path": "docs/architecture.md" }',
    async run(ctx, args) {
      const filePath = str(args, 'path');
      if (!filePath) {
        if (ctx.model.readme) {
          return { text: bound(`README:\n\n${ctx.model.readme}`), summary: 'read_readme', sources: [{ path: 'README.md' }] };
        }
        const docs = ctx.model.docs.map((doc) => `- ${doc.path} — ${doc.title}`).join('\n');
        return { text: bound(`No root README. Documentation files:\n${docs || 'none'}`), summary: 'read_readme (index)' };
      }
      const resolved = path.resolve(ctx.root, filePath.replace(/^\.\//, ''));
      if (!resolved.startsWith(path.resolve(ctx.root))) return { text: 'Error: path escapes the repository root.', summary: 'read_readme blocked', failed: true };
      const content = readTextFileSync(resolved, 200_000);
      if (content === null) return { text: `Error: ${filePath} not readable.`, summary: `read_readme failed (${filePath})`, failed: true };
      return { text: bound(`File: ${filePath}\n\n${content}`), summary: `read_readme ${filePath}`, sources: [{ path: filePath, startLine: 1, endLine: content.split('\n').length }] };
    },
  },
  {
    name: 'find_callers_in_tests',
    description: 'Find test files that exercise a given symbol, which reveals intended behaviour and edge cases.',
    args: '{ "symbol": "normalize_chunk" }',
    async run(ctx, args) {
      const query = str(args, 'symbol') ?? str(args, 'name');
      if (!query) return { text: 'Error: "symbol" is required.', summary: 'find_callers_in_tests failed', failed: true };
      const symbol = resolveOne(ctx, query);
      const calls = ctx.model.calls.filter((call) => (symbol ? call.to === symbol.id : call.toName === query) && isTestPath(call.fromPath));
      const files = [...new Set(calls.map((call) => call.fromPath))];
      if (files.length === 0) return { text: `No tests call "${query}" directly.`, summary: `find_callers_in_tests "${query}" (none)` };
      return {
        text: bound(`Tests exercising ${query}:\n${files.slice(0, 20).map((filePath) => `- ${filePath}`).join('\n')}`),
        summary: `find_callers_in_tests "${query}" (${files.length} files)`,
        sources: files.slice(0, 8).map((filePath) => ({ path: filePath })),
      };
    },
  },
];

export const TOOLS: ToolSpec[] = tools;

export function toolCatalogue(): string {
  return tools.map((tool) => `- ${tool.name}: ${tool.description}\n    args: ${tool.args}`).join('\n');
}

/** Expand a class-like symbol to include its own methods. */
function expandToMethods(ctx: RepoContext, symbol: SymbolRecord): SymbolRecord[] {
  if (!['class', 'struct', 'trait', 'interface', 'module', 'enum'].includes(symbol.kind)) return [symbol];
  const methods = ctx.model.symbols.filter((candidate) => candidate.path === symbol.path && candidate.container === symbol.name);
  return [symbol, ...methods];
}

export function toolNames(): string[] {
  return tools.map((tool) => tool.name);
}

export async function runTool(ctx: RepoContext, invocation: ToolInvocation): Promise<ToolResult> {
  const spec = tools.find((tool) => tool.name === invocation.tool);
  if (!spec) {
    return {
      text: `Unknown tool "${invocation.tool}". Available tools: ${toolNames().join(', ')}.`,
      summary: `unknown tool ${invocation.tool}`,
      failed: true,
    };
  }
  try {
    return await spec.run(ctx, invocation.args ?? {});
  } catch (error) {
    return {
      text: `Tool ${invocation.tool} failed: ${error instanceof Error ? error.message : String(error)}`,
      summary: `${invocation.tool} failed`,
      failed: true,
    };
  }
}

export { arg, bound };
