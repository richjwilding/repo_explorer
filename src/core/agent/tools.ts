import path from 'node:path';
import type { Route, SymbolRecord } from '../types.js';
import type { RepoContext } from '../service.js';
import { readTextFileSync } from '../util/fs.js';
import { listCommits } from '../util/git.js';
import { buildComponentDigest, formatFileTree } from '../explain/digest.js';
import { truncate } from '../util/text.js';
import { describeDataModel } from '../analysis/contracts.js';
import { describeOperations } from '../analysis/ops.js';

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
    name: 'test_coverage',
    description:
      'Which source files and components the tests actually reach, derived from the import and call graphs. Use it before claiming anything is tested, untested or covered.',
    args: '{ "component": "core/analysis" }  // optional: restrict to one component',
    async run(ctx, args) {
      const tests = ctx.model.tests;
      const filter = (str(args, 'component') ?? str(args, 'path') ?? '').toLowerCase();
      const summary = tests.summary;

      const lines = [
        `${summary.testFiles} test files, ${summary.testLoc.toLocaleString()} lines of test code, against ${summary.sourceFiles} source files.`,
        `${summary.percentReferenced}% of source files are referenced by a test (${summary.referenced} of ${summary.sourceFiles}).`,
      ];

      const components = filter ? tests.components.filter((component) => component.name.toLowerCase().includes(filter) || component.id.includes(filter)) : tests.components;
      if (components.length > 0) {
        lines.push('', filter ? `Components matching "${filter}":` : 'By component, least covered first:');
        for (const component of components.slice(0, 20)) {
          lines.push(`- ${component.name}: ${component.percent}% (${component.referenced} of ${component.sourceFiles} source files)`);
        }
      }

      if (filter && components.length === 0) {
        lines.push('', `No component matches "${filter}". Known: ${tests.components.map((c) => c.name).join(', ')}`);
      }

      const untested = filter ? tests.untested.filter((file) => (file.component ?? '').toLowerCase().includes(filter)) : tests.untested;
      if (untested.length > 0) {
        lines.push('', 'Source files no test reaches, largest first:');
        for (const file of untested.slice(0, 15)) {
          lines.push(`- ${file.path} (${file.loc} lines${file.symbols ? `, ${file.symbols} definitions` : ''})${file.component ? ` — ${file.component}` : ''}`);
        }
      }

      if (tests.riskyGaps.length > 0 && !filter) {
        lines.push('', 'Untested files with the most churn — the riskiest gaps:');
        for (const gap of tests.riskyGaps.slice(0, 8)) {
          lines.push(`- ${gap.path} — ${gap.churn} commits, ${gap.loc} lines`);
        }
      }

      if (tests.testsReachingNothing.length > 0) {
        lines.push('', 'Tests that reach no source file at all (they may only exercise a library or a fixture):');
        for (const test of tests.testsReachingNothing.slice(0, 8)) lines.push(`- ${test.path}`);
      }

      return {
        text: bound(`Test coverage derived from the call and import graphs. This measures whether a test reaches a file, not whether it asserts anything useful.

${lines.join('\n')}`),
        summary: `test_coverage (${summary.percentReferenced}% referenced)`,
        sources: untested.slice(0, 6).map((file) => ({ path: file.path })),
      };
    },
  },
  {
    name: 'find_hotspots',
    description:
      'The files where measured complexity and historical churn meet — decision points and control-flow nesting, not line count. Where a new leader should look first.',
    args: '{ "limit": 12 }',
    async run(ctx, args) {
      const limit = Math.min(num(args, 'limit', 12), 30);
      const hotspots = ctx.model.hotspots.slice(0, limit);
      if (hotspots.length === 0) return { text: 'No churn data available (shallow clone or not a git repository).', summary: 'find_hotspots (none)' };
      const text = hotspots
        .map(
          (spot) =>
            `- ${spot.path} — ${spot.commits} commits, ${spot.branches} decision points, nesting depth ${spot.maxDepth}` +
            `${spot.measured ? '' : ' [no function bodies to measure; ranked by size]'}${spot.components.length ? ` (${spot.components.join(', ')})` : ''}`,
        )
        .join('\n');
      return { text: bound(`Hotspots:\n${text}`), summary: `find_hotspots (${hotspots.length})`, sources: hotspots.slice(0, 8).map((spot) => ({ path: spot.path })) };
    },
  },
  {
    name: 'find_complexity',
    description:
      'The hardest definitions to change safely: decision points and control-flow nesting per function, weighted by how many callers depend on it. Use it to answer "where is this codebase difficult", "which function should we split" or "what is risky to touch". Nesting depth counts control-flow blocks only — an indented object literal is not complexity.',
    args: '{ "path": "src/core/analysis", "limit": 15 }  // both optional',
    async run(ctx, args) {
      const report = ctx.model.complexity;
      const filter = (str(args, 'path') ?? str(args, 'component') ?? '').toLowerCase();
      const limit = Math.min(num(args, 'limit', 15), 40);
      if (report.symbols.length === 0) {
        return { text: 'No function bodies could be measured, so complexity is unavailable for this repository.', summary: 'find_complexity (none)' };
      }

      const symbols = filter
        ? report.symbols.filter((symbol) => symbol.path.toLowerCase().includes(filter) || symbol.name.toLowerCase().includes(filter))
        : report.symbols;
      const summary = report.summary;
      const lines = [
        `${summary.functionsAnalysed.toLocaleString()} definitions measured. Mean ${summary.meanBranches} decision points and nesting depth ${summary.meanDepth}. ` +
          `Deepest nesting ${summary.deepest}; most decision points ${summary.mostBranches}.`,
        `${summary.deepFunctions} function(s) nest ${4}+ levels deep and ${summary.branchyFunctions} carry ${10}+ decision points.`,
        '',
        'Hardest to change safely — difficulty weighted by the number of callers that depend on it:',
      ];
      for (const symbol of symbols.slice(0, limit)) {
        lines.push(
          `- ${symbol.name} (${symbol.kind}) — ${symbol.branches} decision points, depth ${symbol.maxDepth}, ` +
            `${symbol.callers} caller(s)${symbol.reachable ? '' : ', unreachable'} — ${symbol.path}:${symbol.line}`,
        );
      }
      if (filter && symbols.length === 0) lines.push(`Nothing matches "${filter}".`);
      lines.push('', 'Files ranked by complexity rather than size:');
      const files = filter ? report.files.filter((file) => file.path.toLowerCase().includes(filter)) : report.files;
      for (const file of files.slice(0, 10)) {
        lines.push(`- ${file.path} — ${file.branches} decision points across ${file.symbols} definitions, depth ${file.maxDepth}`);
      }

      return { text: bound(`Complexity:\n${lines.join('\n')}`), summary: `find_complexity (${symbols.length})` };
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
    name: 'operational_surface',
    description:
      'How the project is built, verified, shipped and run: CI jobs and the commands they run, Dockerfile stages and ports, compose services, infrastructure manifests, package scripts and the environment variables that must be set. Use it for any question about deployment, operations, environment configuration or what verifies a change.',
    args: '{ "section": "ci" | "containers" | "compose" | "infra" | "scripts" | "env" | "summary" }  // optional',
    async run(ctx, args) {
      const ops = ctx.model.ops;
      const section = (str(args, 'section') ?? '').toLowerCase();
      const lines: string[] = [];

      const want = (name: string) => !section || section === name || section === 'all';

      if (want('summary') || !section) {
        lines.push('## Summary');
        const described = describeOperations(ops);
        if (described.length === 0) lines.push('No CI definitions, containers, infrastructure or scripts were found.');
        for (const line of described) lines.push(`- ${line}`);
      }

      if (want('ci') && ops.ci.length > 0) {
        lines.push('', '## CI');
        for (const workflow of ops.ci) {
          lines.push(`${workflow.path} (${workflow.name}) — triggers: ${workflow.triggers.join(', ') || 'none declared'}${workflow.gating ? ' [runs on push/PR and has commands, so it gates merges]' : ''}`);
          for (const job of workflow.jobs) {
            lines.push(`  job "${job.id}"${job.runner ? ` on ${job.runner}` : ''}${job.needs.length > 0 ? ` needs ${job.needs.join(', ')}` : ''}`);
            for (const command of job.commands.slice(0, 12)) lines.push(`    $ ${command}`);
            for (const action of job.actions.slice(0, 8)) lines.push(`    uses ${action}`);
          }
        }
      } else if (want('ci') && section === 'ci') {
        lines.push('No CI definitions were found in this repository, so nothing automatically verifies a change.');
      }

      if (want('containers') && ops.containers.length > 0) {
        lines.push('', '## Containers');
        for (const container of ops.containers) {
          lines.push(`${container.path}: ${container.multiStage ? `${container.stages.length}-stage build` : 'single stage'}`);
          for (const stage of container.stages) lines.push(`  stage ${stage.name} from ${stage.base} (line ${stage.line})`);
          if (container.exposedPorts.length > 0) lines.push(`  exposes ${container.exposedPorts.join(', ')}`);
          if (container.entrypoint) lines.push(`  entrypoint: ${container.entrypoint}`);
          if (container.cmd) lines.push(`  cmd: ${container.cmd}`);
          if (container.workdir) lines.push(`  workdir: ${container.workdir}`);
          lines.push(`  user: ${container.user ?? 'not set — runs as root'}`);
          if (container.buildArgs.length > 0) lines.push(`  build args: ${container.buildArgs.join(', ')}`);
          if (!container.healthcheck) lines.push('  no HEALTHCHECK declared');
          if (!container.cachesDependencies) lines.push('  dependencies are installed after the source is copied, so every source change rebuilds them');
        }
      }

      if (want('compose') && ops.compose.length > 0) {
        lines.push('', '## Compose');
        for (const file of ops.compose) {
          lines.push(file.path);
          for (const service of file.services) {
            lines.push(
              `  ${service.name}: ${service.image ?? 'built locally'}${service.build ? ` from ${service.build}` : ''}` +
                (service.ports.length > 0 ? `, ports ${service.ports.join(' ')}` : '') +
                (service.dependsOn.length > 0 ? `, depends on ${service.dependsOn.join(', ')}` : '') +
                (service.environment.length > 0 ? `, env ${service.environment.join(', ')}` : ''),
            );
          }
        }
      }

      if (want('infra') && ops.infra.length > 0) {
        lines.push('', '## Infrastructure');
        for (const file of ops.infra) {
          const counts = new Map<string, number>();
          for (const resource of file.resources) counts.set(resource.kind, (counts.get(resource.kind) ?? 0) + 1);
          lines.push(`${file.path} (${file.format}): ${[...counts.entries()].map(([kind, count]) => `${count}× ${kind}`).join(', ') || 'nothing parsed'}`);
          if (file.images.length > 0) lines.push(`  images: ${file.images.join(', ')}`);
        }
      }

      if (want('scripts')) {
        lines.push('', '## Scripts');
        if (ops.scripts.length === 0) lines.push('No package or build scripts were found.');
        for (const script of ops.scripts.slice(0, 40)) lines.push(`${script.manifest} → ${script.name} (${script.category}): ${script.command}`);
      }

      if (want('env')) {
        lines.push('', '## Environment variables');
        const real = ops.envVars.filter((entry) => !entry.testOnly);
        if (real.length === 0) lines.push('None declared outside tests.');
        for (const entry of real.slice(0, 40)) lines.push(`${entry.name} — declared in ${entry.files.slice(0, 3).join(', ')}`);
      }

      if (ops.warnings.length > 0) lines.push('', `Note: ${ops.warnings.join(' ')}`);
      const text = lines.join('\n') || 'Nothing operational was found for that section.';
      const counts = `${ops.ci.length} CI, ${ops.containers.length} container(s), ${ops.infra.length} infra file(s)`;
      return {
        text: bound(`Operational surface (${counts}):\n${text}`),
        summary: `operational_surface (${section || 'all'})`,
      };
    },
  },
  {
    name: 'change_coupling',
    description:
      'Which files change together in git history, and who owns each component. Reveals dependencies the import graph does not show (two files that must always move as a pair, especially across components) and key-person risk. Use it for questions about change risk, blast radius, ownership or maintenance.',
    args: '{ "path": "src/core/analysis" }  // optional: only pairs touching this path',
    async run(ctx, args) {
      const coupling = ctx.model.coupling;
      const filter = (str(args, 'path') ?? str(args, 'component') ?? '').toLowerCase();
      if (coupling.totalCommits < 5) {
        return {
          text: `Not enough history to measure coupling: ${coupling.totalCommits} commit(s) reachable.`,
          summary: 'change_coupling (too little history)',
        };
      }

      const lines: string[] = [`${coupling.totalCommits} commits of history analysed.`];

      const pairs = filter
        ? coupling.pairs.filter((pair) => pair.a.toLowerCase().includes(filter) || pair.b.toLowerCase().includes(filter))
        : coupling.pairs;
      const cross = pairs.filter((pair) => pair.crossComponent);
      const same = pairs.filter((pair) => !pair.crossComponent);

      if (cross.length > 0) {
        lines.push('', 'Files in different components that change together — the import graph does not show these:');
        for (const pair of cross.slice(0, 12)) {
          lines.push(`- ${pair.a} + ${pair.b} — ${pair.together} commits together, confidence ${pair.confidence}`);
        }
      }
      if (same.length > 0) {
        lines.push('', 'Files that change together within one component:');
        for (const pair of same.slice(0, 10)) {
          lines.push(`- ${pair.a} + ${pair.b} — ${pair.together} commits together, confidence ${pair.confidence}`);
        }
      }
      if (pairs.length === 0) lines.push('', filter ? `No coupled pairs involve "${filter}".` : 'No file pairs change together often enough to be notable.');

      const components = filter
        ? coupling.components.filter((component) => component.name.toLowerCase().includes(filter) || component.id.includes(filter))
        : coupling.components;
      if (components.length > 0) {
        lines.push('', 'Ownership by component (bus factor = authors covering half the commits):');
        for (const component of components.slice(0, 16)) {
          lines.push(
            `- ${component.name}: ${component.commits} commits, ${component.authors} author(s), ` +
              `${Math.round(component.topAuthorShare * 100)}% from ${component.topAuthor}, bus factor ${component.busFactor}`,
          );
        }
      }

      if (!filter && coupling.singleOwner.length > 0) {
        lines.push('', 'Key-person risk — one person wrote almost all of the history for:');
        for (const component of coupling.singleOwner.slice(0, 8)) {
          lines.push(`- ${component.name} (${Math.round(component.topAuthorShare * 100)}% ${component.topAuthor}, ${component.commits} commits)`);
        }
      }

      if (filter && pairs.length === 0 && components.length === 0) lines.push('', `Nothing in the history matches "${filter}".`);
      if (coupling.warnings.length > 0) lines.push('', `Note: ${coupling.warnings.join(' ')}`);

      return {
        text: bound(`Change coupling and ownership:\n${lines.join('\n')}`),
        summary: `change_coupling (${pairs.length} pairs)`,
      };
    },
  },
  {
    name: 'list_conventions',
    description:
      'The conventions this codebase actually follows, inferred by measuring its own majority behaviour, and the files that break them. Covers dependency direction between components, file and test naming, where tests live, and whether one file owns configuration or logging. Use it to answer "how should I write code here" and "is this file doing something unusual".',
    args: '{ "rule": "layering" }  // optional: filter rules by id or text',
    async run(ctx, args) {
      const report = ctx.model.conventions;
      const filter = (str(args, 'rule') ?? '').toLowerCase();
      if (report.rules.length === 0) {
        return {
          text: 'No conventions were strongly enough supported to state as rules. That usually means the repository is small, very new, or deliberately inconsistent.',
          summary: 'list_conventions (none)',
        };
      }

      const rules = filter ? report.rules.filter((rule) => rule.id.includes(filter) || rule.rule.toLowerCase().includes(filter)) : report.rules;
      const lines: string[] = [
        `${report.summary.derived} convention(s) inferred from this repository, with ${report.summary.violations} exception(s).`,
        'Each rule is what the code mostly does, not what is generally considered good practice.',
        '',
      ];
      for (const rule of rules) {
        lines.push(`${rule.rule} (${rule.basis})`);
        for (const violation of rule.violations) {
          lines.push(`  exception: ${violation.path}${violation.line ? `:${violation.line}` : ''} — ${violation.detail}`);
        }
        if (rule.violations.length === 0) lines.push('  no exceptions.');
      }
      if (filter && rules.length === 0) lines.push(`No rule matches "${filter}". Known: ${report.rules.map((rule) => rule.id).join(', ')}`);
      if (!filter && report.weakPatterns.length > 0) {
        lines.push('', 'Patterns too mixed to call a convention — worth knowing, but there is no rule to break:');
        for (const pattern of report.weakPatterns) lines.push(`- ${pattern}`);
      }

      return { text: bound(`Conventions:\n${lines.join('\n')}`), summary: `list_conventions (${rules.length} rules)` };
    },
  },
  {
    name: 'data_model',
    description:
      'The shape of the data: SQL tables with their columns, keys and foreign keys, ORM models, GraphQL and protobuf types, OpenAPI schemas and enums, read from the files that declare them. Use it for any question about what the system stores, how the entities relate, or what an API accepts and returns.',
    args: '{ "name": "users" }  // optional: one schema by name',
    async run(ctx, args) {
      const model = ctx.model.dataModel;
      const filter = (str(args, 'name') ?? str(args, 'schema') ?? '').toLowerCase();
      if (model.schemas.length === 0 && model.apiSpecs.length === 0) {
        return {
          text: 'No schema, migration or API definition was found in the repository. The data model may be defined elsewhere, or the system may not have one.',
          summary: 'data_model (none)',
        };
      }

      const lines: string[] = [];
      for (const line of describeDataModel(model)) lines.push(`- ${line}`);

      const schemas = filter ? model.schemas.filter((schema) => schema.name.toLowerCase().includes(filter)) : model.schemas;
      if (filter && schemas.length === 0) {
        lines.push('', `No schema matches "${filter}". Known: ${model.schemas.map((schema) => schema.name).join(', ')}`);
      }
      for (const schema of schemas.slice(0, 24)) {
        lines.push('', `${schema.name} (${schema.kind}${schema.source ? `, ${schema.source}` : ''}) — ${schema.path}:${schema.line}`);
        for (const field of schema.fields.slice(0, 20)) {
          lines.push(`  ${field.name}: ${field.type}${field.optional ? '?' : ''}${field.note ? ` (${field.note})` : ''}`);
        }
        if (schema.primaryKey.length > 0) lines.push(`  primary key: ${schema.primaryKey.join(', ')}`);
        for (const key of schema.foreignKeys.slice(0, 10)) lines.push(`  foreign key: ${key.column} -> ${key.references}`);
        for (const operation of schema.operations.slice(0, 12)) lines.push(`  ${operation.kind}: ${operation.name}`);
      }
      if (model.migrations.length > 0) {
        lines.push('', 'Schema files in the order they would apply:');
        for (const migration of model.migrations.slice(0, 15)) {
          lines.push(
            `- ${migration.path} — ${migration.statements} statement(s)` +
              (migration.creates.length > 0 ? `, creates ${migration.creates.join(', ')}` : '') +
              (migration.alters.length > 0 ? `, alters ${migration.alters.join(', ')}` : ''),
          );
        }
      }
      if (model.warnings.length > 0) lines.push('', `Note: ${model.warnings.join(' ')}`);

      return { text: bound(`Data model:\n${lines.join('\n')}`), summary: `data_model (${schemas.length} schema(s))` };
    },
  },
  {
    name: 'find_gaps',
    description:
      'What the repository does not state about itself: no CI, no tests reaching the most complex code, no deployment definition, a database with no schema, unpinned dependencies, no licence, no observability. Each finding names the facts it is derived from. Use it for due diligence, onboarding risk, or any question about what is missing or unverified.',
    args: '{}',
    async run(ctx) {
      const report = ctx.model.gaps;
      if (report.summary.checked === 0) {
        return { text: 'The repository is too small or too unusual for absences to mean anything.', summary: 'find_gaps (nothing checked)' };
      }
      const lines = [`${report.summary.met} of ${report.summary.checked} things a repository of this kind usually states are present.`, ''];
      for (const gap of report.gaps) {
        lines.push(`ABSENT [${gap.weight}] ${gap.title}`);
        lines.push(`  ${gap.detail}`);
        for (const item of gap.evidence.slice(0, 5)) lines.push(`  evidence: ${item}`);
        if (gap.paths.length > 0) lines.push(`  look at: ${gap.paths.slice(0, 5).join(', ')}`);
      }
      if (report.gaps.length === 0) lines.push('Nothing notable is absent.');
      lines.push('', `Present: ${report.met.map((item) => item.title).join('; ')}.`);
      return { text: bound(`What is absent:\n${lines.join('\n')}`), summary: `find_gaps (${report.gaps.length} absent)` };
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
