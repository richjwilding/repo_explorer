import type { CallEdge, CallKind, DeadCodeCandidate, FileEntry, Route, SymbolRecord } from '../types.js';
import { detectLanguage, type LanguageFamily } from './languages.js';
import { findBodyEnd } from './bodies.js';
import { packageName, resolveSpecifier, type RawImport } from './imports.js';

/**
 * Static call-graph construction.
 *
 * The goal is not compiler-grade accuracy — it is an honest, useful map of
 * "what runs when X happens". Everything unresolved is left explicitly
 * unresolved rather than guessed, and every edge keeps the line it came from
 * so the reader can check it.
 */

export interface CallGraphFile {
  path: string;
  text: string;
  entry: FileEntry;
  imports: RawImport[];
}

export interface BodyRange {
  start: number;
  end: number;
}

const KEYWORDS = new Set([
  'if', 'else', 'elif', 'for', 'foreach', 'while', 'switch', 'case', 'default', 'catch', 'finally', 'return',
  'typeof', 'sizeof', 'instanceof', 'new', 'delete', 'void', 'await', 'yield', 'do', 'try', 'throw', 'throws',
  'assert', 'echo', 'print', 'printf', 'println', 'puts', 'super', 'this', 'self', 'cls', 'match', 'when',
  'unless', 'def', 'class', 'struct', 'impl', 'fn', 'let', 'const', 'var', 'use', 'import', 'export', 'from',
  'as', 'in', 'of', 'break', 'continue', 'defer', 'go', 'select', 'range', 'lambda', 'raise', 'except', 'with',
  'pass', 'and', 'or', 'not', 'is', 'none', 'true', 'false', 'nil', 'null', 'undefined', 'require', 'include',
  'extends', 'implements', 'synchronized', 'lock', 'unlock', 'interface', 'enum', 'namespace', 'package',
  'public', 'private', 'protected', 'static', 'abstract', 'final', 'sealed', 'override', 'virtual', 'async',
  'isinstance', 'getattr', 'setattr', 'hasattr', 'isinstance', 'len', 'str', 'int', 'float', 'list', 'dict',
  'set', 'tuple', 'bool', 'bytes', 'type', 'open', 'enumerate', 'zip', 'sorted', 'sum', 'min', 'max', 'abs',
  'any', 'all', 'next', 'iter', 'repr', 'hash', 'input', 'format', 'range', 'map', 'filter', 'reduce', 'object',
  'describe', 'it', 'test', 'expect', 'assert_eq', 'assert_eq', 'todo', 'console', 'window', 'document', 'process',
  'math', 'print', 'panic', 'unwrap', 'clone', 'into', 'from', 'try_into', 'ok', 'err', 'some', 'none',
]);

const LIFECYCLE_NAMES = new Set([
  '__init__', '__repr__', '__str__', '__eq__', '__hash__', '__enter__', '__exit__', '__call__', '__len__',
  '__iter__', '__next__', 'setUp', 'tearDown', 'setup', 'teardown', 'beforeEach', 'afterEach', 'render',
  'componentDidMount', 'componentWillUnmount', 'main', 'new', 'init', 'configure', 'constructor',
]);

/* ------------------------------------------------------------------ *
 * Body extent
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Call extraction
 * ------------------------------------------------------------------ */

interface RawCall {
  name: string;
  receiver?: string;
  kind: CallKind;
  line: number;
}

export function extractCalls(bodyText: string, baseLine: number, family: LanguageFamily): RawCall[] {
  const calls: RawCall[] = [];
  const seen = new Set<string>();
  const push = (name: string, receiver: string | undefined, kind: CallKind, offsetInBody: number) => {
    if (!name || name.length < 2) return;
    if (KEYWORDS.has(name)) return;
    const line = baseLine + countNewlines(bodyText, offsetInBody);
    const key = `${receiver ?? ''}.${name}:${line}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push({ name, receiver, kind, line });
  };

  // `new Thing(` / `new Thing`
  for (const m of bodyText.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)/g)) {
    push(m[1], undefined, 'constructor', m.index ?? 0);
  }

  // `receiver.method(` including optional chaining.
  for (const m of bodyText.matchAll(/([A-Za-z_$][\w$]*)\s*\??\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    push(m[2], m[1], 'method', m.index ?? 0);
  }

  // Bare `name(` — exclude anything preceded by a dot or identifier char.
  for (const m of bodyText.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    push(m[2], undefined, 'call', (m.index ?? 0) + m[1].length);
  }

  if (family === 'js') {
    // Callbacks passed as values: `map(transform)` / `foo(handler)` are bare
    // calls already; also catch `.then(handler)` style via receiver.method.
    for (const m of bodyText.matchAll(/\.(?:map|filter|forEach|then|catch|reduce|some|every|find)\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
      push(m[1], undefined, 'callback', m.index ?? 0);
    }

    // JSX element usage. Writing `<DiagramView />` is how one component renders
    // another, but it is not a call expression, so the call graph used to miss
    // the primary composition mechanism of every React codebase. Everything
    // downstream read that absence as "nothing renders this" — components looked
    // unreachable, and `callers_of <Component>` returned nothing.
    //
    // The lookbehind keeps generics out: in `Map<SymbolRecord, string>` the `<`
    // follows an identifier character, whereas a JSX element never does.
    for (const m of bodyText.matchAll(/(?<![A-Za-z0-9_$.])<([A-Z][\w$]*)(?:\.([A-Z][\w$]*))?[\s/>]/g)) {
      const receiver = m[2] ? m[1] : undefined;
      const name = m[2] ?? m[1];
      push(name, receiver, 'jsx', m.index ?? 0);
    }
  }

  return calls;
}

function countNewlines(text: string, upTo: number): number {
  let n = 0;
  const limit = Math.min(upTo, text.length);
  for (let i = 0; i < limit; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

/* ------------------------------------------------------------------ *
 * Graph construction
 * ------------------------------------------------------------------ */

export interface CallGraphResult {
  symbols: SymbolRecord[];
  calls: CallEdge[];
  routes: Route[];
  deadCode: DeadCodeCandidate[];
}

export interface BuildCallGraphOptions {
  /** Entrypoint file paths from the entrypoint detector. */
  entrypointFiles: Set<string>;
}

export function buildCallGraph(files: CallGraphFile[], knownPaths: Set<string>, options: BuildCallGraphOptions): CallGraphResult {
  /* ---- 1. symbol records with body extents ---- */
  const symbols: SymbolRecord[] = [];
  const ranges = new Map<string, BodyRange>();
  const linesByPath = new Map<string, string[]>();

  for (const file of files) {
    if (!file.text) continue;
    const lines = file.text.split('\n');
    linesByPath.set(file.path, lines);
    const family = detectLanguage(file.path).family;
    const own = [...file.entry.symbols].sort((a, b) => a.line - b.line);

    for (let index = 0; index < own.length; index += 1) {
      const symbol = own[index];
      const start = Math.max(0, symbol.line - 1);
      const nextLine = own[index + 1]?.line;
      let end = findBodyEnd(lines, start, family);
      // A function's body must not swallow the next definition. A class body
      // legitimately *contains* the following definitions, so it is never clamped.
      const isContainer = ['class', 'struct', 'trait', 'interface', 'module', 'enum'].includes(symbol.kind);
      if (!isContainer && nextLine && end >= nextLine - 1) end = nextLine - 2;
      if (end < start) end = start;
      const record: SymbolRecord = {
        id: symbolId(file.path, symbol.name, symbol.line),
        path: file.path,
        name: symbol.name,
        kind: symbol.kind,
        exported: symbol.exported,
        line: symbol.line,
        endLine: end + 1,
        container: null,
        loc: end - start + 1,
        reachable: false,
        callerCount: 0,
        calleeCount: 0,
        entry: false,
      };
      symbols.push(record);
      ranges.set(record.id, { start, end });
    }
  }

  // Second pass: a symbol belongs to the innermost enclosing class/struct.
  // Doing this after body extents are known is far more accurate than
  // inferring containment from declaration order.
  const byPathForContainment = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    if (!byPathForContainment.has(symbol.path)) byPathForContainment.set(symbol.path, []);
    (byPathForContainment.get(symbol.path) as SymbolRecord[]).push(symbol);
  }
  for (const group of byPathForContainment.values()) {
    const containers = group.filter((s) => ['class', 'struct', 'trait', 'interface', 'module', 'enum'].includes(s.kind));
    if (containers.length === 0) continue;
    for (const symbol of group) {
      if (containers.includes(symbol)) continue;
      let best: SymbolRecord | null = null;
      for (const container of containers) {
        if (symbol.line > container.line && symbol.line <= container.endLine) {
          if (!best || container.line > best.line) best = container;
        }
      }
      if (best) symbol.container = best.name;
    }
  }

  const byPath = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    if (!byPath.has(symbol.path)) byPath.set(symbol.path, []);
    (byPath.get(symbol.path) as SymbolRecord[]).push(symbol);
  }

  /* ---- 2. resolution indices ---- */
  const byName = new Map<string, SymbolRecord>();
  const byPathAndName = new Map<string, SymbolRecord>();
  const methodsByContainer = new Map<string, Map<string, SymbolRecord>>();
  for (const symbol of symbols) {
    const scopedKey = `${symbol.path}\u0000${symbol.container ?? ''}\u0000${symbol.name}`;
    if (!byPathAndName.has(scopedKey)) byPathAndName.set(scopedKey, symbol);
    if (!byName.has(symbol.name)) byName.set(symbol.name, symbol);
    if (symbol.container) {
      const key = `${symbol.path}\u0000${symbol.container}`;
      if (!methodsByContainer.has(key)) methodsByContainer.set(key, new Map());
      const map = methodsByContainer.get(key) as Map<string, SymbolRecord>;
      if (!map.has(symbol.name)) map.set(symbol.name, symbol);
    }
  }

  const importIndex = new Map<string, Map<string, { path: string | null; remote: string; specifier: string }>>();
  for (const file of files) {
    const map = new Map<string, { path: string | null; remote: string; specifier: string }>();
    for (const raw of file.imports) {
      const resolved = resolveSpecifier(file.path, raw.specifier, knownPaths, []);
      for (const binding of raw.bindings) {
        if (!binding.local || binding.local === '*') continue;
        if (!map.has(binding.local)) map.set(binding.local, { path: resolved, remote: binding.remote, specifier: raw.specifier });
      }
    }
    importIndex.set(file.path, map);
  }

  const findMethod = (path: string, container: string | null, name: string): SymbolRecord | undefined => {
    if (container) {
      const direct = methodsByContainer.get(`${path}\u0000${container}`)?.get(name);
      if (direct) return direct;
    }
    return byPathAndName.get(`${path}\u0000\u0000${name}`) ?? byPath.get(path)?.find((s) => s.name === name);
  };

  /* ---- 3. walk bodies and emit edges ---- */
  const calls: CallEdge[] = [];
  const edgeKeys = new Set<string>();

  for (const symbol of symbols) {
    // Class-like bodies are covered by their own methods, which are separate
    // symbols. Scanning them here would double-count every call.
    if (['class', 'struct', 'trait', 'interface', 'enum', 'module'].includes(symbol.kind)) continue;
    const lines = linesByPath.get(symbol.path);
    if (!lines) continue;
    const range = ranges.get(symbol.id);
    if (!range) continue;
    const bodyText = lines.slice(range.start, range.end + 1).join('\n');
    const family = detectLanguage(symbol.path).family;
    const imports = importIndex.get(symbol.path) ?? new Map();
    const localSymbols = byPath.get(symbol.path) ?? [];

    for (const call of extractCalls(bodyText, symbol.line, family)) {
      // The definition's own signature line is not a call to itself.
      if (call.name === symbol.name && call.line === symbol.line) continue;
      const target = resolveCall(call, symbol, {
        imports,
        localSymbols,
        findMethod,
        byName,
        knownPaths,
      });

      const key = `${symbol.id}\u0000${target?.id ?? call.name}\u0000${call.line}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);

      calls.push({
        from: symbol.id,
        fromPath: symbol.path,
        fromLine: call.line,
        to: target?.id ?? null,
        toPath: target?.path ?? null,
        toName: call.name,
        kind: call.kind,
        resolved: Boolean(target),
        external: target ? undefined : externalFor(call, imports),
      });
      if (target) symbol.calleeCount += 1;
    }
  }

  for (const edge of calls) {
    if (!edge.to) continue;
    const target = symbols.find((s) => s.id === edge.to);
    if (target) target.callerCount += 1;
  }

  /* ---- 4. routes ---- */
  const routes = extractRoutes(files);

  /* ---- 5. reachability from entrypoints ---- */
  const roots = new Set<string>();
  for (const route of routes) if (route.handlerId) roots.add(route.handlerId);

  // For a file that bootstraps the program, the entry symbol is the exported
  // surface, a main-like name, or (failing both) the largest callable in the
  // file. Marking every top-level const as an entrypoint would make the
  // call graph meaningless.
  const byPathForRoots = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    if (!byPathForRoots.has(symbol.path)) byPathForRoots.set(symbol.path, []);
    (byPathForRoots.get(symbol.path) as SymbolRecord[]).push(symbol);
  }
  const MAIN_LIKE = /^(main|__main__|run|start|bootstrap|cli|entrypoint|app|create_app|handler|lambda_handler|server)$/i;
  for (const file of options.entrypointFiles) {
    const callables = (byPathForRoots.get(file) ?? []).filter((symbol) =>
      ['function', 'method', 'class', 'struct', 'trait'].includes(symbol.kind),
    );
    const chosen = callables.filter((symbol) => symbol.exported || MAIN_LIKE.test(symbol.name));
    if (chosen.length > 0) {
      for (const symbol of chosen) roots.add(symbol.id);
      continue;
    }
    const largest = [...callables].sort((a, b) => b.loc - a.loc)[0];
    if (largest) roots.add(largest.id);
  }

  for (const symbol of symbols) {
    if (MAIN_LIKE.test(symbol.name) && symbol.exported) roots.add(symbol.id);
    // A package's public surface is a legitimate entrypoint: it is how other
    // code (including code outside this repository) gets in.
    if (symbol.exported && /(^|\/)(__init__\.py|index\.(ts|tsx|js|jsx|mjs|cjs)|mod\.rs|lib\.rs)$/.test(symbol.path)) roots.add(symbol.id);
  }

  const outgoing = new Map<string, string[]>();
  for (const edge of calls) {
    if (!edge.to) continue;
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    (outgoing.get(edge.from) as string[]).push(edge.to);
  }
  // Reaching a class means reaching everything defined inside it.
  const membersOf = new Map<string, string[]>();
  for (const symbol of symbols) {
    if (!symbol.container) continue;
    const key = `${symbol.path}\u0000${symbol.container}`;
    if (!membersOf.has(key)) membersOf.set(key, []);
    (membersOf.get(key) as string[]).push(symbol.id);
  }
  const childrenOf = (id: string): string[] => {
    const symbol = byId.get(id);
    if (!symbol) return [];
    return [...(outgoing.get(id) ?? []), ...(membersOf.get(`${symbol.path}\u0000${symbol.name}`) ?? [])];
  };

  const byId = new Map(symbols.map((s) => [s.id, s]));
  const queue = [...roots];
  const visited = new Set<string>(queue);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const symbol = byId.get(current);
    if (symbol) {
      symbol.reachable = true;
      if (roots.has(current)) symbol.entry = true;
    }
    for (const next of childrenOf(current)) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }

  /* ---- 6. dead-code candidates ---- */
  // A symbol is only worth flagging if its whole file is unreachable through
  // the import graph. Without this, every helper called through a callback,
  // decorator, or dynamic dispatch looks dead, and the signal drowns.
  const importEdges = new Map<string, Set<string>>();
  for (const file of files) {
    const targets = new Set<string>();
    for (const target of (importIndex.get(file.path) ?? new Map()).values()) {
      if (target.path) targets.add(target.path);
    }
    importEdges.set(file.path, targets);
  }
  const reachableFiles = new Set<string>();
  const fileQueue = [...options.entrypointFiles];
  for (const route of routes) fileQueue.push(route.file);
  for (const symbol of symbols) if (symbol.reachable) fileQueue.push(symbol.path);
  for (const file of fileQueue) reachableFiles.add(file);
  for (let index = 0; index < fileQueue.length; index += 1) {
    for (const target of importEdges.get(fileQueue[index]) ?? []) {
      if (reachableFiles.has(target)) continue;
      reachableFiles.add(target);
      fileQueue.push(target);
    }
  }

  const deadCode: DeadCodeCandidate[] = [];
  for (const symbol of symbols) {
    if (symbol.entry || symbol.reachable || symbol.callerCount > 0) continue;
    if (reachableFiles.has(symbol.path)) continue;
    if (LIFECYCLE_NAMES.has(symbol.name)) continue;
    if (symbol.name.startsWith('__') && symbol.name.endsWith('__')) continue;
    if (!['function', 'method', 'class', 'struct', 'trait', 'interface', 'const', 'type', 'enum'].includes(symbol.kind)) continue;
    if (isTestOrFixture(symbol.path)) continue;
    if (symbol.path.endsWith('__init__.py') && symbol.loc < 40) continue;
    const significant = symbol.exported || symbol.loc >= 12;
    if (!significant) continue;
    deadCode.push({
      symbolId: symbol.id,
      path: symbol.path,
      name: symbol.name,
      kind: symbol.kind,
      loc: symbol.loc,
      reason: 'Nothing calls this, and no reachable file imports the module it lives in.',
    });
  }
  deadCode.sort((a, b) => b.loc - a.loc);

  return { symbols, calls, routes, deadCode: deadCode.slice(0, 60) };
}

function isTestOrFixture(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|specs|fixtures?|testdata)(\/|$)/.test(path) || /\.(test|spec)\./.test(path) || /_test\.|test_/.test(path);
}

interface ResolveContext {
  imports: Map<string, { path: string | null; remote: string; specifier: string }>;
  localSymbols: SymbolRecord[];
  findMethod: (path: string, container: string | null, name: string) => SymbolRecord | undefined;
  byName: Map<string, SymbolRecord>;
  knownPaths: Set<string>;
}

function resolveCall(call: RawCall, caller: SymbolRecord, ctx: ResolveContext): SymbolRecord | undefined {
  const { imports, localSymbols, findMethod, byName, knownPaths } = ctx;

  if (call.kind === 'constructor') {
    const localClass = localSymbols.find((s) => s.name === call.name && (s.kind === 'class' || s.kind === 'struct'));
    if (localClass) return localClass;
    const binding = imports.get(call.name);
    if (binding?.path && knownPaths.has(binding.path)) {
      return (
        findMethod(binding.path, null, call.name) ??
        // Imported default/named class: look for any class with that name.
        byName.get(call.name)
      );
    }
    return undefined;
  }

  if (call.receiver) {
    const receiver = call.receiver;
    // self.method() / this.method()
    if (receiver === 'self' || receiver === 'this' || receiver === 'cls') {
      const method = findMethod(caller.path, caller.container, call.name);
      if (method) return method;
      const local = localSymbols.find((s) => s.name === call.name);
      if (local) return local;
      return undefined;
    }

    // ClassName.staticMethod() or namespace.method()
    const binding = imports.get(receiver);
    if (binding?.path && knownPaths.has(binding.path)) {
      const direct = findMethod(binding.path, null, call.name) ?? findMethod(binding.path, receiver, call.name);
      if (direct) return direct;
      const inNamespace = findMethod(binding.path, binding.remote === 'default' ? receiver : binding.remote, call.name);
      if (inNamespace) return inNamespace;
    }
    const localNamed = localSymbols.find((s) => s.name === call.name);
    if (localNamed) return localNamed;
    const localContainer = localSymbols.find((s) => s.name === receiver && s.container === null);
    if (localContainer) {
      const method = findMethod(caller.path, localContainer.name, call.name);
      if (method) return method;
    }
    return undefined;
  }

  // Bare call: local definition first, then an imported binding.
  const local = localSymbols.find((s) => s.name === call.name);
  if (local) return local;
  const methodInContainer = findMethod(caller.path, caller.container, call.name);
  if (methodInContainer) return methodInContainer;

  const binding = imports.get(call.name);
  if (binding?.path && knownPaths.has(binding.path)) {
    if (binding.remote && binding.remote !== 'default' && binding.remote !== '*') {
      const named = findMethod(binding.path, null, binding.remote);
      if (named) return named;
    }
    const anyMatch = findMethod(binding.path, null, call.name);
    if (anyMatch) return anyMatch;
  }

  return undefined;
}

function externalFor(call: RawCall, imports: Map<string, { path: string | null; remote: string; specifier: string }>): string | undefined {
  const binding = imports.get(call.receiver ?? call.name);
  if (!binding) return undefined;
  if (binding.path !== null) return undefined;
  return packageName(binding.specifier);
}

function symbolId(path: string, name: string, line: number): string {
  return `${path}#${name}@${line}`;
}

/* ------------------------------------------------------------------ *
 * Route extraction
 * ------------------------------------------------------------------ */

interface RoutePattern {
  framework: string;
  families: LanguageFamily[];
  re: RegExp;
  /** Groups: 1 = method (optional), 2 = path. */
  methodGroup: number;
  pathGroup: number;
}

const ROUTE_PATTERNS: RoutePattern[] = [
  // Express / Fastify / Koa: app.get('/x', handler)
  { framework: 'express/fastify', families: ['js'], re: /\b(?:app|router|server|fastify|api)\s*\.\s*(get|post|put|patch|delete|all|options|head|use)\s*\(\s*["'`]([^"'`]+)["'`]/gi, methodGroup: 1, pathGroup: 2 },
  // FastAPI / Flask decorators
  { framework: 'fastapi/flask', families: ['python'], re: /@\s*(?:app|router|api|blueprint|bp)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*["']([^"']+)["']/gi, methodGroup: 1, pathGroup: 2 },
  { framework: 'flask', families: ['python'], re: /@\s*(?:app|bp|blueprint)\s*\.\s*route\s*\(\s*["']([^"']+)["'][^)]*methods\s*=\s*\[([^\]]*)\]/gi, methodGroup: 2, pathGroup: 1 },
  // Django
  { framework: 'django', families: ['python'], re: /\b(?:re_)?path\s*\(\s*[r]?["']([^"']*)["']\s*,\s*(?:views?\.)?([A-Za-z_][\w.]*)/g, methodGroup: 0, pathGroup: 1 },
  // Gin / Echo / Fiber
  { framework: 'gin/echo/fiber', families: ['go'], re: /\b([A-Za-z_][\w]*)\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any)\s*\(\s*["`]([^"`]+)["`]/g, methodGroup: 2, pathGroup: 3 },
  // Spring
  { framework: 'spring', families: ['jvm'], re: /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g, methodGroup: 1, pathGroup: 2 },
  // ASP.NET
  { framework: 'aspnet', families: ['dotnet'], re: /\[\s*(HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch|Route)\s*\(\s*["']([^"']+)["']/g, methodGroup: 1, pathGroup: 2 },
  // Rails
  { framework: 'rails', families: ['ruby'], re: /^\s*(get|post|put|patch|delete)\s+["']([^"']+)["']/gim, methodGroup: 1, pathGroup: 2 },
  // Actix / Axum
  { framework: 'actix/axum', families: ['rust'], re: /#\[\s*(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g, methodGroup: 1, pathGroup: 2 },
  { framework: 'axum', families: ['rust'], re: /\.route\s*\(\s*["']([^"']+)["']\s*,\s*(get|post|put|patch|delete)\s*\(/g, methodGroup: 2, pathGroup: 1 },
  // gRPC service definitions
  { framework: 'grpc', families: ['data', 'other'], re: /\brpc\s+([A-Za-z_]\w*)\s*\(\s*([\w.]+)\s*\)\s*returns\s*\(\s*([\w.]+)\s*\)/g, methodGroup: 0, pathGroup: 1 },
];

const METHOD_NORMALISE: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
  RequestMapping: 'ANY',
  HttpGet: 'GET',
  HttpPost: 'POST',
  HttpPut: 'PUT',
  HttpDelete: 'DELETE',
  HttpPatch: 'PATCH',
  Route: 'ANY',
  Any: 'ANY',
};

function normaliseMethod(raw: string | undefined): string {
  if (!raw) return 'ANY';
  const trimmed = raw.trim();
  return METHOD_NORMALISE[trimmed] ?? trimmed.toUpperCase();
}

/** Next identifier after a match — the most likely handler name. */
function handlerAfter(text: string, index: number): string | null {
  const window = text.slice(index, index + 400);
  const match = window.match(/[,(\s]\s*(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$.]*)\s*(?:[),]|=>)/);
  if (!match) return null;
  const candidate = match[1];
  if (KEYWORDS.has(candidate)) return null;
  return candidate;
}

/** For decorators, the handler is the function defined after the whole decorator. */
function handlerFromDecorator(lines: string[], endLineIndex: number): { name: string; line: number } | null {
  for (let i = endLineIndex + 1; i < Math.min(lines.length, endLineIndex + 12); i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('@') || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const match =
      trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/) ??
      trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/) ??
      trimmed.match(/^function\s+([A-Za-z_$][\w$]*)/) ??
      trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function|\()/) ??
      trimmed.match(/^(?:public|private|protected|internal|static|async|\s)*([A-Z]\w*)\s*\(/);
    if (match) return { name: match[1], line: i + 1 };
    return null;
  }
  return null;
}

export function extractRoutes(files: CallGraphFile[]): Route[] {
  const routes: Route[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (!file.text) continue;
    if (file.entry.isNoise) continue;
    const family = detectLanguage(file.path).family;
    const lines = file.text.split('\n');

    // Next.js / SvelteKit / Remix file-based routing.
    const fileRoute = fileSystemRoute(file.path);
    if (fileRoute) {
      const symbol = file.entry.symbols.find((s) => s.exported) ?? file.entry.symbols[0];
      const route: Route = {
        id: `${fileRoute.method}:${fileRoute.path}:${file.path}`,
        method: fileRoute.method,
        path: fileRoute.path,
        framework: 'file-based routing',
        file: file.path,
        line: symbol?.line ?? 1,
        handler: symbol?.name ?? null,
        handlerId: symbol ? symbolId(file.path, symbol.name, symbol.line) : null,
      };
      if (!seen.has(route.id)) {
        seen.add(route.id);
        routes.push(route);
      }
    }

    for (const pattern of ROUTE_PATTERNS) {
      if (!pattern.families.includes(family)) continue;
      for (const match of file.text.matchAll(pattern.re)) {
        const path = match[pattern.pathGroup];
        if (!path || path.length > 200) continue;
        const method = pattern.methodGroup === 0 ? 'ANY' : normaliseMethod(match[pattern.methodGroup]);
        const lineIndex = lineIndexAt(file.text, match.index ?? 0);
        const isDecorator = pattern.re.source.startsWith('@') || pattern.re.source.startsWith('#\\[') || pattern.re.source.startsWith('\\[');
        const fromDecorator = isDecorator
          ? handlerFromDecorator(lines, decoratorEndLineIndex(file.text, match.index ?? 0, (match.index ?? 0) + match[0].length))
          : null;
        const handlerName = fromDecorator?.name ?? handlerAfter(file.text, (match.index ?? 0) + match[0].length);
        const handlerLine = fromDecorator?.line ?? lineIndex + 1;
        const symbol = handlerName
          ? file.entry.symbols.find((s) => s.name === handlerName) ?? file.entry.symbols.find((s) => s.line >= handlerLine - 1 && s.line <= handlerLine + 2)
          : undefined;
        const id = `${method}:${path}:${file.path}:${handlerName ?? ''}`;
        if (seen.has(id)) continue;
        seen.add(id);
        routes.push({
          id,
          method,
          path: path.startsWith('/') || path === '' ? path : `/${path}`,
          framework: pattern.framework,
          file: file.path,
          line: lineIndex + 1,
          handler: handlerName,
          handlerId: symbol ? symbolId(file.path, symbol.name, symbol.line) : null,
        });
      }
    }
  }

  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function fileSystemRoute(path: string): { method: string; path: string } | null {
  // Next.js App Router: app/**/route.ts exporting GET/POST/...
  const appRoute = path.match(/(?:^|\/)app\/(.+)\/route\.(ts|js|tsx|jsx|mts)$/);
  if (appRoute) return { method: 'ANY', path: `/${appRoute[1].replace(/\(.*?\)\//g, '')}` };
  // Next.js Pages Router: pages/api/**/*.ts
  const pagesApi = path.match(/(?:^|\/)pages\/api\/(.+)\.(ts|js|tsx|jsx)$/);
  if (pagesApi) return { method: 'ANY', path: `/api/${pagesApi[1].replace(/\/index$/, '')}` };
  // SvelteKit: src/routes/**/+server.ts
  const sveltekit = path.match(/(?:^|\/)routes\/(.+)\/\+server\.(ts|js)$/);
  if (sveltekit) return { method: 'ANY', path: `/${sveltekit[1]}` };
  // Remix: app/routes/foo.tsx
  const remix = path.match(/(?:^|\/)routes\/(.+)\.(tsx|ts|jsx|js)$/);
  if (remix && path.includes('routes/')) return { method: 'ANY', path: `/${remix[1]}` };
  return null;
}

/**
 * Line index where a decorator's parenthesis closes. Multi-line decorators are
 * common (`@router.post(\n "/x",\n status_code=201,\n)`), and the handler is
 * defined after the whole call, not after the first matched line.
 */
function decoratorEndLineIndex(text: string, startIndex: number, fallbackIndex: number): number {
  let depth = 0;
  let opened = false;
  for (let i = startIndex; i < Math.min(text.length, startIndex + 4000); i += 1) {
    const ch = text[i];
    if (ch === '(') {
      depth += 1;
      opened = true;
    } else if (ch === ')') {
      depth -= 1;
      if (opened && depth <= 0) return lineIndexAt(text, i);
    }
  }
  return lineIndexAt(text, fallbackIndex);
}

function lineIndexAt(text: string, index: number): number {
  let n = 0;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

export { packageName };
