import path from 'node:path';
import fs from 'node:fs';
import type {
  Component,
  ComponentKind,
  ConceptHint,
  DataFlow,
  Entrypoint,
  EntrypointKind,
  ExternalDependency,
  FileChurn,
  FileEntry,
  GraphEdge,
  GraphNode,
  Hotspot,
  ImportEdge,
  ModuleNode,
  ModuleSignals,
  RepoModel,
  StackInfo,
  SymbolInfo,
} from '../types.js';
import { readTextFile, isHardIgnored, walkRepo } from '../util/fs.js';
import { gitSummary, gitVisibleFiles, isGitRepo, makeRepoRef } from '../util/git.js';
import { classifyFile, detectLanguage, isNoiseFile, isParsable } from './languages.js';
import { extractFileFacts, normalizePath, packageName, resolveSpecifier, type RawImport } from './imports.js';
import { buildCallGraph } from './callgraph.js';
import {
  buildStack,
  createDependencyAccumulator,
  dependencyNameFromSpecifier,
  extractContainerImages,
  extractEnvKeys,
  extractUrlSchemes,
  normaliseManifestDependency,
  readManifests,
  type ManifestInfo,
} from './stack.js';
import { countLines, firstLines, jaccard, splitIdentifier, tokenize, topN, unique } from '../util/text.js';
import { shortHash, slugify } from '../util/id.js';

export const ANALYSIS_VERSION = 9;

export interface AnalyzeOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  onProgress?: (message: string, pct: number) => void;
}

interface PassFile {
  path: string;
  absPath: string;
  size: number;
  text: string | null;
  entry: FileEntry;
  rawImports: RawImport[];
  containerImages: string[];
  envKeys: string[];
  urlSchemes: string[];
}

const ANCILARY_DIR_NAMES = new Set([
  'test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'fixtures', 'mocks', '__mocks__',
  'fixture', 'testdata', 'test-data', 'examples', 'example', 'samples', 'demo', 'demos',
  'docs', 'doc', 'documentation', 'website', 'site', 'benchmark', 'benchmarks', 'perf',
  'scripts', 'tools', 'tooling', 'hack', 'migrations', 'seeds', 'deploy', 'deployment',
  'infra', 'infrastructure', 'ops', 'k8s', 'kubernetes', 'helm', 'terraform', 'charts',
  'generated', '__generated__', 'assets', 'static', 'public', 'i18n', 'locales', 'vendor',
]);

const ANCILLARY_PATH_RE = /(^|\/)(\.github|\.gitlab|\.circleci|\.vscode|\.idea|ci|deploy|charts)(\/|$)/;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, Math.max(1, items.length))).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function estimateLines(size: number): number {
  // Cap the estimate: an unread 40 MB minified bundle is not a million-line
  // source file, and letting it dominate LOC totals destroys the analysis.
  return Math.min(25_000, Math.max(1, Math.round(size / 38)));
}

function dirOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

function allAncestors(p: string): string[] {
  const parts = p.split('/').filter(Boolean);
  const out: string[] = [''];
  let acc = '';
  for (let i = 0; i < parts.length - 1; i += 1) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    out.push(acc);
  }
  return out;
}

function isAncillaryPath(p: string): boolean {
  if (ANCILLARY_PATH_RE.test(p)) return true;
  return p.split('/').slice(0, -1).some((seg) => ANCILARY_DIR_NAMES.has(seg.toLowerCase()));
}

/* ------------------------------------------------------------------ *
 * Main entry point
 * ------------------------------------------------------------------ */

export async function analyzeRepo(rootInput: string, options: AnalyzeOptions = {}): Promise<RepoModel> {
  const root = path.resolve(rootInput);
  const maxFiles = options.maxFiles ?? 20_000;
  const maxFileBytes = options.maxFileBytes ?? 400_000;
  const progress = options.onProgress ?? (() => {});
  const warnings: string[] = [];

  if (!fs.existsSync(root)) throw new Error(`Path does not exist: ${root}`);
  if (!fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);

  progress('Reading repository layout', 2);
  const isRepo = await isGitRepo(root);
  let paths: string[] | null = null;
  if (isRepo) paths = await gitVisibleFiles(root);
  if (!paths || paths.length === 0) {
    if (isRepo) warnings.push('git returned no files; falling back to a filesystem walk.');
    paths = walkRepo(root, { maxFiles }).map((e) => e.path);
  }
  if (paths.length >= maxFiles) warnings.push(`File list truncated at ${maxFiles.toLocaleString()} files.`);

  const beforeFilter = paths.length;
  paths = paths.filter((p) => !isHardIgnored(p));
  const removed = beforeFilter - paths.length;
  if (removed > 0) {
    warnings.push(`${removed.toLocaleString()} file(s) under vendored or generated directories (node_modules, dist, build, …) were excluded.`);
  }

  progress('Reading manifests and git metadata', 8);
  const [repoRef, git] = await Promise.all([makeRepoRef(root), gitSummary(root)]);
  const manifests = readManifests(root, paths);

  progress(`Analysing ${paths.length.toLocaleString()} files`, 15);
  const pass = await readAndParseFiles(root, paths, maxFiles, maxFileBytes, (done, total) => {
    progress(`Analysing files (${done.toLocaleString()}/${total.toLocaleString()})`, 15 + Math.round((done / total) * 55));
  });

  const aliasRoots = detectAliasRoots(root, paths, manifests);
  const ownRoots = detectOwnRoots(paths, manifests);
  const knownPaths = new Set(pass.map((f) => f.path));

  progress('Resolving dependencies', 74);
  const imports = resolveImports(pass, knownPaths, aliasRoots);

  progress('Building module tree', 80);
  const modules = buildModules(pass);

  progress('Identifying components', 85);
  const components = deriveComponents(root, pass, modules, manifests);

  const externalDepsByComponent = attachExternalDeps(components, pass);

  progress('Inferring entrypoints and dependencies', 86);
  const entrypoints = detectEntrypoints(pass, manifests, components);
  const dependencies = buildDependencies(pass, imports, manifests, ownRoots);

  progress('Tracing the call graph', 90);
  const callGraph = buildCallGraph(
    pass
      .filter((file) => file.text !== null)
      .map((file) => ({ path: file.path, text: file.text as string, entry: file.entry, imports: file.rawImports })),
    knownPaths,
    { entrypointFiles: new Set(entrypoints.map((entrypoint) => entrypoint.path)) },
  );
  // Route handlers are entrypoints too, even when the file looks unremarkable.
  for (const route of callGraph.routes) {
    if (!route.handlerId) continue;
    const symbol = callGraph.symbols.find((candidate) => candidate.id === route.handlerId);
    if (!symbol) continue;
    const existing = entrypoints.find((entrypoint) => entrypoint.path === route.file);
    if (!existing) {
      entrypoints.push({
        path: route.file,
        kind: 'http-server',
        reason: `${route.method} ${route.path} (${route.framework})`,
        component: components.find((component) => component.files.includes(route.file))?.id,
      });
    }
  }

  // Text is no longer needed: the call graph and index have everything derived.
  for (const file of pass) file.text = null;

  progress('Scoring architecture', 93);
  const edges = componentEdges(components, imports);
  scoreImportance(components, edges, entrypoints, root, externalDepsByComponent);

  const graph = buildGraph(components, modules);

  const languages = aggregateLanguages(pass);
  const stack: StackInfo = buildStack(paths, languages, manifests);

  const concepts = extractConcepts(pass);
  const dataFlows = inferFlows(components, edges, entrypoints, dependencies);
  const hotspots = computeHotspots(pass, components, git.churn);

  const readmePath = paths.find((p) => /^readme(\.md|\.mdx|\.rst|\.txt)?$/i.test(p.split('/').pop() ?? ''));
  let readme: string | null = null;
  if (readmePath) {
    const readmeText = await readTextFile(path.join(root, readmePath), 200_000);
    if (readmeText) readme = firstLines(readmeText, 160, 12_000);
  }
  const docs = extractDocs(pass);

  const sourceFiles = pass.filter((f) => f.entry.category === 'source');
  const counted = pass.filter((f) => !f.entry.isNoise && f.entry.category !== 'asset' && f.entry.category !== 'generated');
  const stats = {
    fileCount: pass.length,
    sourceFileCount: sourceFiles.length,
    loc: counted.reduce((sum, f) => sum + f.entry.lines, 0),
    testLoc: pass.filter((f) => f.entry.category === 'test').reduce((sum, f) => sum + f.entry.lines, 0),
    docCount: pass.filter((f) => f.entry.category === 'docs').length,
    moduleCount: modules.length,
    componentCount: components.length,
    maxDepth: modules.reduce((max, m) => Math.max(max, m.depth), 0),
  };

  if (pass.length === 0) warnings.push('No files were analysed. Is this an empty directory?');

  progress('Done', 100);

  return {
    version: ANALYSIS_VERSION,
    repo: repoRef,
    generatedAt: new Date().toISOString(),
    stats,
    stack,
    git,
    files: pass.map((f) => f.entry),
    imports,
    modules,
    components,
    graph,
    entrypoints,
    dependencies,
    dataFlows,
    concepts,
    symbols: callGraph.symbols,
    calls: callGraph.calls,
    routes: callGraph.routes,
    deadCode: callGraph.deadCode,
    hotspots,
    readme,
    docs,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * File reading + parsing
 * ------------------------------------------------------------------ */

async function readAndParseFiles(
  root: string,
  paths: string[],
  maxFiles: number,
  maxFileBytes: number,
  onTick: (done: number, total: number) => void,
): Promise<PassFile[]> {
  const limited = paths.slice(0, maxFiles);
  let done = 0;
  const result = await mapLimit(limited, 24, async (rel) => {
    const abs = path.join(root, rel);
    let size = 0;
    let mtimeMs = 0;
    try {
      const stat = fs.statSync(abs);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      return null;
    }
    const language = detectLanguage(rel);
    const category = classifyFile(rel);
    const noise = isNoiseFile(rel);
    // Configuration files carry evidence too (container images, env keys,
    // connection strings), so the text is read for anything that is not noise.
    const readable = !noise && size <= maxFileBytes * 2;
    const text = readable ? await readTextFile(abs, maxFileBytes) : null;

    const facts = text && isParsable(language.id) ? extractFileFacts(text, rel) : { imports: [] as RawImport[], symbols: [] as SymbolInfo[] };
    const containerImages = text ? extractContainerImages(text, rel).map((entry) => entry.name) : [];
    const envKeys = text ? extractEnvKeys(text, rel).map((entry) => entry.name) : [];
    const urlSchemes = text ? extractUrlSchemes(text, rel).map((entry) => entry.name) : [];

    const entry: FileEntry = {
      path: rel,
      size,
      mtimeMs,
      ...(text && !noise ? { hash: shortHash(text, 16) } : {}),
      lines: text ? countLines(text) : estimateLines(size),
      language: language.id,
      category,
      isBinary: text === null && size > 0,
      isNoise: noise,
      symbols: facts.symbols.slice(0, 120),
    };

    done += 1;
    if (done % 200 === 0 || done === limited.length) onTick(done, limited.length);

    return { path: rel, absPath: abs, size, text, entry, rawImports: facts.imports, containerImages, envKeys, urlSchemes } satisfies PassFile;
  });

  return result.filter((x): x is PassFile => x !== null);
}

function detectAliasRoots(root: string, paths: string[], manifests: ManifestInfo[]): string[] {
  const roots = new Set<string>();
  for (const candidate of ['src', 'app', 'lib', 'packages']) {
    if (fs.existsSync(path.join(root, candidate))) roots.add(candidate);
  }
  // tsconfig `baseUrl` / `paths` aliases with a leading `@/`.
  const tsconfig = paths.find((p) => p === 'tsconfig.json' || p.endsWith('/tsconfig.json'));
  if (tsconfig) {
    const text = fs.existsSync(path.join(root, tsconfig)) ? fs.readFileSync(path.join(root, tsconfig), 'utf8') : '';
    if (/["']@\*["']\s*:\s*\[\s*["']\.?\/?(src|app)\//.test(text)) roots.add('src');
  }
  // Every directory that owns a manifest is a package root for its own code.
  // Without this, `from app.config import Settings` inside a service looks like
  // an external dependency called `app`.
  for (const manifest of manifests) {
    const dir = dirOf(manifest.path);
    if (dir) roots.add(dir);
  }
  return [...roots].filter(Boolean);
}

function resolveImports(pass: PassFile[], knownPaths: Set<string>, aliasRoots: string[]): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const file of pass) {
    if (!file.text) continue;
    for (const raw of file.rawImports) {
      const to = resolveSpecifier(file.path, raw.specifier, knownPaths, aliasRoots);
      edges.push({ from: file.path, to, specifier: raw.specifier, kind: raw.kind });
    }
  }
  return edges;
}

/* ------------------------------------------------------------------ *
 * Modules
 * ------------------------------------------------------------------ */

function buildModules(pass: PassFile[]): ModuleNode[] {
  const map = new Map<string, ModuleNode & { directLoc: number; directFiles: number; langCounts: Map<string, number> }>();
  const ensure = (id: string): ModuleNode & { directLoc: number; directFiles: number; langCounts: Map<string, number> } => {
    const existing = map.get(id);
    if (existing) return existing;
    const name = id === '' ? '(root)' : (id.split('/').pop() as string);
    const node = {
      id,
      name,
      depth: id === '' ? 0 : id.split('/').length,
      parent: id === '' ? null : dirOf(id),
      children: [] as string[],
      fileCount: 0,
      loc: 0,
      languages: [] as string[],
      ownFiles: [] as string[],
      totalLoc: 0,
      totalFiles: 0,
      ancillary: isAncillaryPath(id),
      signals: emptySignals(),
      directLoc: 0,
      directFiles: 0,
      langCounts: new Map<string, number>(),
    };
    map.set(id, node);
    return node;
  };

  ensure('');
  for (const file of pass) {
    for (const ancestor of allAncestors(file.path)) ensure(ancestor);
    const dir = dirOf(file.path);
    const node = ensure(dir);
    node.ownFiles.push(file.path);
    node.directFiles += 1;
    if (!file.entry.isNoise && file.entry.category !== 'asset' && file.entry.category !== 'generated') {
      node.directLoc += file.entry.lines;
      node.langCounts.set(file.entry.language, (node.langCounts.get(file.entry.language) ?? 0) + file.entry.lines);
    }
    if (file.entry.category === 'test') node.signals.hasTests = true;
    if (file.entry.category === 'config') node.signals.configFiles.push(file.path);
    if (file.entry.category === 'docs') node.signals.docsFiles.push(file.path);
  }

  // Wire parents/children.
  for (const node of map.values()) {
    if (node.parent !== null) {
      const parent = map.get(node.parent);
      if (parent && !parent.children.includes(node.id)) parent.children.push(node.id);
    }
    node.children.sort((a, b) => a.localeCompare(b));
  }

  // Post-order totals.
  const computeTotals = (id: string): { loc: number; files: number } => {
    const node = map.get(id) as ReturnType<typeof ensure>;
    let loc = node.directLoc;
    let files = node.directFiles;
    for (const child of node.children) {
      const childTotals = computeTotals(child);
      loc += childTotals.loc;
      files += childTotals.files;
    }
    node.totalLoc = loc;
    node.totalFiles = files;
    node.loc = loc;
    node.fileCount = files;
    node.languages = [...node.langCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([lang]) => lang);
    return { loc, files };
  };
  computeTotals('');
  for (const node of [...map.values()].sort((a, b) => b.depth - a.depth)) computeTotals(node.id);

  const nodes = [...map.values()]
    .filter((n) => n.id === '' || n.totalFiles > 0)
    .map(({ directLoc: _directLoc, directFiles: _directFiles, langCounts: _langCounts, ...node }) => node);

  return nodes.sort((a, b) => a.id.localeCompare(b.id));
}

function emptySignals(): ModuleSignals {
  return { entrypoints: [], hasTests: false, manifestFiles: [], configFiles: [], docsFiles: [], internalDeps: [], externalDeps: [], roles: [] };
}

/* ------------------------------------------------------------------ *
 * Components
 * ------------------------------------------------------------------ */

interface WorkspaceRoot {
  path: string;
  name: string;
}

const MANIFEST_BASENAMES = new Set([
  'package.json', 'pyproject.toml', 'setup.py', 'go.mod', 'cargo.toml', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'composer.json', 'gemfile', 'requirements.txt', 'pipfile',
]);

function detectWorkspaceRoots(root: string, paths: string[], manifests: ManifestInfo[]): WorkspaceRoot[] {
  const roots = new Map<string, string>();

  const addPatternRoots = (patterns: string[]) => {
    for (const pattern of patterns) {
      const cleaned = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
      if (cleaned.endsWith('/*')) {
        const parent = cleaned.slice(0, -2);
        const prefix = parent ? `${parent}/` : '';
        for (const p of paths) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          const seg = rest.split('/')[0];
          if (seg) roots.set(`${prefix}${seg}`, seg);
        }
      } else if (cleaned.endsWith('/**')) {
        addPatternRoots([`${cleaned.slice(0, -3)}/*`]);
      } else if (cleaned && paths.some((p) => p.startsWith(`${cleaned}/`))) {
        roots.set(cleaned, cleaned.split('/').pop() as string);
      }
    }
  };

  for (const manifest of manifests) {
    if (manifest.kind !== 'node') continue;
    const workspaces = (manifest.raw?.workspaces ?? null) as unknown;
    if (Array.isArray(workspaces)) addPatternRoots(workspaces as string[]);
    else if (workspaces && typeof workspaces === 'object' && Array.isArray((workspaces as { packages?: string[] }).packages)) {
      addPatternRoots((workspaces as { packages: string[] }).packages);
    }
  }

  // pnpm workspaces list packages under a `packages:` key in pnpm-workspace.yaml.
  const pnpmWorkspacePath = path.join(root, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmWorkspacePath)) {
    try {
      const text = fs.readFileSync(pnpmWorkspacePath, 'utf8');
      const inPackages = text.split('\n').filter((line) => /^\s*-\s+/.test(line)).map((line) => line.replace(/^\s*-\s+/, '').replace(/^['"]|['"]$/g, ''));
      addPatternRoots(inPackages);
    } catch {
      /* ignore unreadable workspace file */
    }
  }

  // A directory with its own build manifest or container definition is an
  // independently deployable unit. Treating those as component roots is what
  // turns one giant "services" blob into the actual microservices.
  const manifestDirs = new Set<string>();
  for (const manifest of manifests) {
    const dir = dirOf(manifest.path);
    if (!dir) continue;
    const base = (manifest.path.split('/').pop() ?? '').toLowerCase();
    if (base === 'dockerfile' || base.startsWith('dockerfile.') || MANIFEST_BASENAMES.has(base) || /\.(cs|fs)proj$/.test(base)) {
      manifestDirs.add(dir);
    }
  }
  for (const dir of manifestDirs) {
    const base = path.basename(dir);
    // Skip wrapper directories that merely re-export a workspace list.
    if (base === 'node_modules') continue;
    roots.set(dir, base);
  }

  return [...roots.entries()].map(([p, name]) => ({ path: p, name }));
}

/**
 * Refine component anchors by descending through containers.
 *
 * A single-package project has one source root that holds the entire system, so
 * anchoring on it produces one meaningless "component" — the whole repository as
 * a single box in the shape diagram. A directory that owns no manifest and
 * contains several substantial child directories is a container, not a unit, so
 * its children are the components. Applied at most twice, and abandoned if it
 * would shatter the repository into noise.
 */
function refineComponentAnchors(anchors: string[], sourcePaths: string[], manifestDirs: Set<string>): string[] {
  const MIN_CHILDREN = 3;
  const MIN_FILES_PER_CHILD = 2;
  const MAX_ANCHORS = 24;

  const childDirs = (anchor: string): string[] => {
    const prefix = anchor ? `${anchor}/` : '';
    const found = new Set<string>();
    for (const filePath of sourcePaths) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) continue;
      found.add(`${prefix}${rest.slice(0, slash)}`);
    }
    return [...found];
  };
  const countIn = (dir: string): number => {
    const prefix = `${dir}/`;
    let total = 0;
    for (const filePath of sourcePaths) if (filePath.startsWith(prefix)) total += 1;
    return total;
  };

  let current = anchors;
  for (let pass = 0; pass < 2; pass += 1) {
    const next: string[] = [];
    let changed = false;
    for (const anchor of current) {
      const children = childDirs(anchor).filter((child) => countIn(child) >= MIN_FILES_PER_CHILD);
      if (!manifestDirs.has(anchor) && children.length >= MIN_CHILDREN) {
        next.push(...children);
        changed = true;
      } else {
        next.push(anchor);
      }
    }
    if (!changed) break;
    current = unique(next);
  }

  return current.length > MAX_ANCHORS ? anchors : current;
}

function deriveComponents(root: string, pass: PassFile[], modules: ModuleNode[], manifests: ManifestInfo[]): Component[] {
  const sourceFiles = pass.filter((f) => f.entry.category === 'source' || f.entry.category === 'config' || f.entry.category === 'test');
  const paths = pass.map((f) => f.path);

  const workspaceRoots = detectWorkspaceRoots(root, paths, manifests);
  const anchorPaths: string[] = workspaceRoots.map((w) => w.path);

  if (anchorPaths.length === 0) {
    // Fall back to depth-1 directories that contain source files.
    const dirs = new Set<string>();
    for (const f of sourceFiles) {
      const first = f.path.split('/')[0];
      if (f.path.includes('/')) dirs.add(first);
    }
    for (const d of [...dirs].sort()) {
      const module = modules.find((m) => m.id === d);
      if (!module || module.totalFiles === 0) continue;
      anchorPaths.push(d);
    }
  }

  // Deepest anchors first: a nested service claims its own files before the
  // umbrella directory swallows them.
  // Descend through directories that are really containers (see above).
  const manifestDirs = new Set(manifests.map((manifest) => dirOf(manifest.path)).filter(Boolean));
  const sourcePaths = sourceFiles.filter((file) => file.entry.category === 'source').map((file) => file.path);
  const refinedAnchors = refineComponentAnchors(anchorPaths, sourcePaths, manifestDirs);

  const sortedAnchors = refinedAnchors.sort((a, b) => b.split('/').length - a.split('/').length);
  const assigned = new Map<string, string>(); // file path -> component path
  const components: Component[] = [];

  const claim = (componentPath: string, name: string, kind?: ComponentKind) => {
    const belongs = (filePath: string) => {
      if (componentPath === '') return !filePath.includes('/');
      return filePath === componentPath || filePath.startsWith(`${componentPath}/`);
    };
    const files = paths.filter((p) => belongs(p) && !assigned.has(p));
    for (const f of files) assigned.set(f, componentPath);
    if (files.length === 0) return;

    const fileEntries = files
      .map((p) => pass.find((f) => f.path === p))
      .filter((f): f is PassFile => Boolean(f));
    // Lockfiles and generated output must not make a directory look substantial.
    const countable = fileEntries.filter((f) => !f.entry.isNoise && f.entry.category !== 'asset' && f.entry.category !== 'generated');
    const loc = countable.reduce((sum, f) => sum + f.entry.lines, 0);
    const sourceLoc = countable.filter((f) => f.entry.category === 'source').reduce((sum, f) => sum + f.entry.lines, 0);
    const moduleIds = modules
      .filter((m) => m.id !== componentPath && (componentPath === '' ? !m.id.includes('/') : m.id.startsWith(`${componentPath}/`)))
      .sort((a, b) => b.totalLoc - a.totalLoc)
      .slice(0, 200)
      .map((m) => m.id);
    const keyFiles = pickKeyFiles(fileEntries, componentPath);

    const resolvedKind = kind ?? inferComponentKind(componentPath, name, fileEntries, manifests);
    const displayName = componentDisplayName(componentPath, name);
    components.push({
      id: slugify(componentPath || 'root'),
      name: displayName,
      kind: resolvedKind,
      path: componentPath,
      oneLiner: describeComponent(resolvedKind, fileEntries),
      moduleIds: moduleIds.length > 0 ? moduleIds : [componentPath],
      files,
      keyFiles,
      dependsOn: [],
      externalDeps: [],
      loc,
      importance: 0,
      ancillary:
        sourceLoc === 0 ||
        resolvedKind === 'docs' ||
        resolvedKind === 'test' ||
        (resolvedKind === 'tooling' && loc < 1500) ||
        isAncillaryPath(componentPath),
    });
  };

  for (const anchor of sortedAnchors) {
    const name = anchor.split('/').pop() as string;
    claim(anchor, name);
  }

  // Anything left over lives at the repository root.
  const leftovers = paths.filter((p) => !assigned.has(p));
  if (leftovers.length > 0) {
    const fileEntries = leftovers.map((p) => pass.find((f) => f.path === p)).filter((f): f is PassFile => Boolean(f));
    const hasSource = fileEntries.some((f) => f.entry.category === 'source');
    if (hasSource || components.length === 0) claim('', 'Root');
  }

  // Drop empty components and de-duplicate names.
  const seen = new Map<string, number>();
  for (const component of components) {
    const count = seen.get(component.name) ?? 0;
    seen.set(component.name, count + 1);
    if (count > 0) component.name = `${component.name} (${count + 1})`;
  }

  return components.sort((a, b) => b.loc - a.loc);
}

function pickKeyFiles(files: PassFile[], componentPath: string): string[] {
  const scored = files
    .filter((f) => f.entry.category !== 'test' && !f.entry.isNoise)
    .map((f) => {
      let score = Math.min(f.entry.lines, 600) / 600;
      const base = f.path.split('/').pop()?.toLowerCase() ?? '';
      if (/^(index|main|app|server|cli|mod|__init__|program)\./.test(base)) score += 1.2;
      if (f.entry.symbols.some((s) => s.exported)) score += 0.4;
      if (f.entry.symbols.length > 3) score += 0.3;
      if (componentPath && dirOf(f.path) === componentPath) score += 0.3;
      return { path: f.path, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map((s) => s.path);
}

const SOURCE_ROOT_NAMES = new Set(['src', 'lib', 'source', 'app', 'internal', 'pkg', 'core']);

/**
 * Name a component for what a reader would call it.
 *
 * `src/server` is "server", and `src/core/analysis` is "core/analysis" — keeping
 * the parent only where the leaf alone would be ambiguous among its siblings.
 */
function componentDisplayName(componentPath: string, fallback: string): string {
  const parts = componentPath.split('/').filter(Boolean);
  if (parts.length === 0) return 'Root';
  if (SOURCE_ROOT_NAMES.has(parts[0])) {
    const rest = parts.slice(1);
    if (rest.length === 1) return rest[0];
    if (rest.length > 1) return rest.join('/');
  }
  return fallback || parts[parts.length - 1];
}

function inferComponentKind(componentPath: string, name: string, files: PassFile[], manifests: ManifestInfo[]): ComponentKind {
  const lower = `${componentPath}/${name}`.toLowerCase();
  const base = name.toLowerCase();
  if (/(^|\/)(docs?|documentation|website|site|guide|handbook)(\/|$)/.test(lower)) return 'docs';
  if (/(^|\/)(tests?|__tests__|spec|e2e)(\/|$)/.test(lower)) return 'test';
  if (/(^|\/)(scripts?|tools?|tooling|hack|dev-tools)(\/|$)/.test(lower)) return 'tooling';
  if (/(^|\/)(infra|infrastructure|terraform|deploy|deployment|k8s|kubernetes|helm|charts|ops)(\/|$)/.test(lower)) return 'infra';
  if (/(^|\/)(migrations?|seeds?|schema|db|database)(\/|$)/.test(lower)) return 'data';
  if (/(^|\/)(examples?|samples?|demos?|playground)(\/|$)/.test(lower)) return 'docs';

  // Classify from import specifiers and manifest dependencies rather than
  // scanning raw text: a stray mention of "react" in a comment is not a UI.
  const specifiers = new Set<string>();
  for (const file of files) for (const raw of file.rawImports) specifiers.add(raw.specifier);
  const manifest = manifests.find((m) => dirOf(m.path) === componentPath);
  const deps = manifest ? [...manifest.dependencies, ...manifest.devDependencies] : [];
  const imports = [...specifiers, ...deps];
  const matches = (re: RegExp) => imports.some((spec) => re.test(spec));

  const hasDesktop = matches(/^(electron|@tauri-apps\/)/);
  const hasHttp = matches(/^(express|fastify|koa|@nestjs\/|@hapi\/|@koa\/|flask|fastapi|django|starlette|aiohttp|gin-gonic\/gin|labstack\/echo|gofiber\/fiber|actix-web|axum|rocket|org\.springframework|javalin|com\.sun\.net\.httpserver)/);
  const hasUi = matches(/^(react|react-dom|vue|@vue\/|svelte|@angular\/|solid-js|preact|@builder\.io\/)/);
  const hasCli = matches(/^(commander|yargs|@oclif\/|meow|minimist|click|argparse|typer|fire|cobra|clap)/);
  const hasWorker = matches(/^(bull|bullmq|@nestjs\/bull|celery|kombu|ioredis|kafkajs|kafka-python|aiokafka|@aws-sdk\/client-sqs|sidekiq|resque)/);
  const isLib = Boolean(manifest?.entryHints.length) || files.some((file) => file.entry.symbols.some((symbol) => symbol.exported));

  const sourceCount = files.filter((file) => file.entry.category === 'source').length;
  if (sourceCount === 0) {
    const docCount = files.filter((file) => file.entry.category === 'docs').length;
    return docCount > files.length / 2 ? 'docs' : 'tooling';
  }

  const sawShebang = files.some((file) => file.entry.path.endsWith('.sh') || file.entry.path.endsWith('.bash'));
  const sawServerBootstrap = files.some((file) => /createServer\s*\(|\.listen\s*\(\s*(?:port|PORT|\d)|uvicorn\.run|FastAPI\(|Flask\(__name__\)|http\.ListenAndServe/.test(file.text ?? ''));

  if (hasDesktop) return 'app';
  if (hasHttp || sawServerBootstrap) return 'api';
  if (hasUi) return 'ui';
  if (hasCli || (sawShebang && !isLib)) return 'cli';
  if (hasWorker) return 'service';
  if (/(^|\/)(server|backend|api|service|services)(\/|$)/.test(lower)) return 'service';
  if (isLib) return 'library';
  if (base === 'src' || base === 'lib' || base === 'core') return 'library';
  return 'unknown';
}

function describeComponent(kind: ComponentKind, files: PassFile[]): string {
  const sourceFiles = files.filter((f) => f.entry.category === 'source');
  const langs = unique(sourceFiles.map((f) => detectLanguage(f.path).label)).slice(0, 3);
  const langText = langs.length > 0 ? langs.join(' + ') : 'mixed';
  // Name what is actually in here. Six components all described as "reusable
  // code" is worse than useless when choosing what to look at.
  const named = unique(
    sourceFiles
      .filter((file) => dirOf(file.path) !== '')
      .map((file) => (file.path.split('/').pop() ?? '').replace(/\.[^.]+$/, ''))
      .filter(
        (name) =>
          name.length > 2 &&
          !['index', 'main', 'types', 'util', 'utils', '__init__', 'conftest', 'setup', 'mod'].includes(name),
      ),
  )
    .slice(0, 4)
    .join(', ');
  const testFiles = files.filter((f) => f.entry.category === 'test').length;
  const shape =
    sourceFiles.length > 0
      ? named
        ? `Contains ${named} among ${sourceFiles.length} source files.`
        : `${sourceFiles.length} source files.`
      : testFiles > 0
        ? `${testFiles} test files.`
        : kind === 'docs'
          ? `Documentation only (${files.length} files).`
          : `Configuration and documentation (${files.length} files).`;
  const base: Record<ComponentKind, string> = {
    api: `HTTP service handling requests, written in ${langText}.`,
    service: `Long-running service that processes work in the background (${langText}).`,
    ui: `User interface built with ${langText}.`,
    app: `Application shell and entry point (${langText}).`,
    cli: `Command-line interface written in ${langText}.`,
    library: `Reusable ${langText} code consumed by other parts of the system.`,
    data: `Data layer: schema, migrations, and persistence helpers (${langText}).`,
    infra: 'Infrastructure-as-code and deployment configuration.',
    tooling: `Developer tooling and automation scripts (${langText}).`,
    docs: 'Documentation and written guidance.',
    test: 'Test suites and fixtures.',
    unknown: `Supporting module (${langText}).`,
  };
  return `${base[kind]} ${shape}`;
}

function attachExternalDeps(components: Component[], pass: PassFile[]): Map<string, Set<string>> {
  const fileToComponent = new Map<string, string>();
  for (const component of components) for (const file of component.files) fileToComponent.set(file, component.id);
  const byComponent = new Map<string, Set<string>>();
  for (const component of components) byComponent.set(component.id, new Set());

  for (const file of pass) {
    const componentId = fileToComponent.get(file.path);
    if (!componentId) continue;
    const set = byComponent.get(componentId) as Set<string>;
    for (const raw of file.rawImports) {
      if (raw.specifier.startsWith('.') || raw.specifier.startsWith('/')) continue;
      set.add(packageName(raw.specifier));
    }
  }

  for (const component of components) {
    const set = byComponent.get(component.id) as Set<string>;
    component.externalDeps = [...set].sort().slice(0, 40);
  }
  return byComponent;
}

function componentEdges(components: Component[], imports: ImportEdge[]): GraphEdge[] {
  const fileToComponent = new Map<string, string>();
  for (const component of components) for (const file of component.files) fileToComponent.set(file, component.id);

  const weights = new Map<string, number>();
  for (const edge of imports) {
    if (!edge.to) continue;
    const from = fileToComponent.get(edge.from);
    const to = fileToComponent.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }

  const edges: GraphEdge[] = [];
  for (const [key, weight] of weights) {
    const [from, to] = key.split('\u0000');
    edges.push({ from, to, kind: 'depends', weight });
  }
  for (const component of components) {
    component.dependsOn = edges.filter((e) => e.from === component.id).sort((a, b) => b.weight - a.weight).map((e) => e.to);
  }
  return edges;
}

function scoreImportance(
  components: Component[],
  edges: GraphEdge[],
  entrypoints: Entrypoint[],
  root: string,
  externalDepsByComponent: Map<string, Set<string>>,
): void {
  const fanIn = new Map<string, number>();
  for (const edge of edges) fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + edge.weight);

  const entryCount = new Map<string, number>();
  for (const ep of entrypoints) {
    if (!ep.component) continue;
    entryCount.set(ep.component, (entryCount.get(ep.component) ?? 0) + 1);
  }

  const readmeText = readReadme(root).toLowerCase();

  let maxRaw = 1;
  const raw = new Map<string, number>();
  for (const component of components) {
    const logLoc = Math.log10(component.loc + 10);
    const inWeight = Math.log10((fanIn.get(component.id) ?? 0) + 1);
    const epWeight = Math.min(entryCount.get(component.id) ?? 0, 4) / 4;
    const readmeMention = component.name.length > 2 && readmeText.includes(component.name.toLowerCase()) ? 1 : 0;
    const depWeight = Math.min((externalDepsByComponent.get(component.id)?.size ?? 0) / 20, 1);
    const value = 0.34 * (logLoc / 4) + 0.3 * (inWeight / 2.5) + 0.2 * epWeight + 0.08 * readmeMention + 0.08 * depWeight;
    raw.set(component.id, value);
    maxRaw = Math.max(maxRaw, value);
  }
  for (const component of components) {
    component.importance = Number(((raw.get(component.id) ?? 0) / maxRaw).toFixed(3));
  }
}

let readmeCache: { root: string; text: string } | null = null;
function readReadme(root: string): string {
  if (readmeCache && readmeCache.root === root) return readmeCache.text;
  let text = '';
  for (const candidate of ['README.md', 'readme.md', 'README.rst', 'README.txt', 'README']) {
    const file = path.join(root, candidate);
    if (fs.existsSync(file)) {
      try {
        text = fs.readFileSync(file, 'utf8').slice(0, 20_000);
        break;
      } catch {
        /* ignore */
      }
    }
  }
  readmeCache = { root, text };
  return text;
}

/* ------------------------------------------------------------------ *
 * Entrypoints
 * ------------------------------------------------------------------ */

const ENTRYPOINT_PRIORITY: Record<EntrypointKind, number> = {
  'http-server': 0,
  cli: 1,
  worker: 2,
  'library-export': 3,
  container: 4,
  build: 5,
  other: 6,
  script: 8,
  test: 9,
};

/** One-off patch/migration scripts are technically executable but never the way in. */
function isOneOffScript(filePath: string): boolean {
  return /(^|\/)(patch|migrate|migration|oneoff|one-off|fixup|backfill)[_-]/i.test(filePath);
}

function rankEntrypoints(entrypoints: Entrypoint[]): Entrypoint[] {
  const ranked = [...entrypoints].sort((a, b) => {
    const penalty = (entrypoint: Entrypoint) => ENTRYPOINT_PRIORITY[entrypoint.kind] + (isOneOffScript(entrypoint.path) ? 10 : 0);
    const byPenalty = penalty(a) - penalty(b);
    if (byPenalty !== 0) return byPenalty;
    const depth = a.path.split('/').length - b.path.split('/').length;
    if (depth !== 0) return depth;
    return a.path.localeCompare(b.path);
  });

  // Keep the list honest: a handful of scripts is useful, forty is noise.
  let scripts = 0;
  return ranked.filter((entrypoint) => {
    if (entrypoint.kind !== 'script') return true;
    scripts += 1;
    return scripts <= 6;
  });
}

function detectEntrypoints(pass: PassFile[], manifests: ManifestInfo[], components: Component[]): Entrypoint[] {
  const byPath = new Map(pass.map((f) => [f.path, f]));
  const componentOf = (filePath: string) => components.find((c) => c.files.includes(filePath))?.id;
  const found = new Map<string, Entrypoint>();
  const add = (filePath: string, kind: EntrypointKind, reason: string) => {
    if (!byPath.has(filePath)) return;
    const existing = found.get(filePath);
    if (existing) {
      if (!existing.reason.includes(reason)) existing.reason += `; ${reason}`;
      return;
    }
    found.set(filePath, { path: filePath, kind, reason, component: componentOf(filePath) });
  };

  // package.json
  for (const manifest of manifests) {
    if (manifest.kind !== 'node') continue;
    const dir = dirOf(manifest.path);
    for (const hint of manifest.entryHints) {
      const resolved = normalizePath(dir ? `${dir}/${hint}` : hint);
      add(resolved, manifest.raw?.bin ? 'cli' : 'library-export', `"${manifest.raw?.bin ? 'bin' : 'main'}" in ${manifest.path}`);
    }
    for (const [name, script] of Object.entries(manifest.scripts)) {
      const match = script.match(/\b(?:node|tsx|ts-node|bun|deno|python3?|ruby)\s+(?:--\S+\s+)*["']?([^\s"'|&;]+)/);
      if (!match) continue;
      const resolved = normalizePath(dir ? `${dir}/${match[1]}` : match[1]);
      if (!byPath.has(resolved)) continue;
      const kind: EntrypointKind = /test|spec|lint|typecheck/.test(name) ? 'test' : /start|serve|dev|run/.test(name) ? 'http-server' : 'script';
      add(resolved, kind, `"${name}" script in ${manifest.path}`);
    }
  }

  // Well-known filenames.
  const patterns: { re: RegExp; kind: EntrypointKind; reason: string }[] = [
    { re: /(^|\/)(src\/)?(main|index|app|server|cli|program)\.(ts|tsx|js|jsx|mjs|cjs)$/, kind: 'other', reason: 'conventional entry file name' },
    { re: /(^|\/)(main|__main__|app|manage|wsgi|asgi|cli)\.py$/, kind: 'other', reason: 'conventional Python entry file' },
    { re: /(^|\/)cmd\/[^/]+\/main\.go$/, kind: 'cli', reason: 'Go cmd/ layout' },
    { re: /(^|\/)main\.go$/, kind: 'other', reason: 'Go main package' },
    { re: /(^|\/)src\/main\.rs$/, kind: 'other', reason: 'Cargo binary entry' },
    { re: /(^|\/)src\/lib\.rs$/, kind: 'library-export', reason: 'Cargo library entry' },
    { re: /(^|\/)(Main|Program|Application)\.(java|kt|cs|fs|scala)$/, kind: 'other', reason: 'JVM/.NET main class' },
  ];
  for (const file of pass) {
    for (const pattern of patterns) {
      if (pattern.re.test(file.path)) {
        add(file.path, refineEntryKind(file, pattern.kind), pattern.reason);
      }
    }
    if (file.text && file.text.startsWith('#!')) {
      const firstLine = file.text.split('\n', 1)[0];
      if (/\b(node|python3?|ruby|bash|sh|zsh|deno|bun)\b/.test(firstLine)) {
        const base = file.path.split('/').pop() ?? '';
        const inBinDir = /(^|\/)bin\//.test(file.path);
        const looksLikeProgram = inBinDir || /^(cli|main|index|app)\./.test(base);
        add(file.path, looksLikeProgram ? 'cli' : 'script', 'shebang script');
      }
    }
    if (file.text && /\bcreateServer\s*\(|\.listen\s*\(\s*(?:port|PORT|\d)/.test(file.text)) {
      add(file.path, 'http-server', 'creates an HTTP server');
    }
    if (file.text && /app\.listen|uvicorn\.run|FastAPI\(|Flask\(__name__\)/.test(file.text)) {
      add(file.path, 'http-server', 'web framework bootstrap');
    }
    if (file.text && /\bFn::|exports\.handler|def lambda_handler|func main\(\).*lambda/i.test(file.text)) {
      add(file.path, 'worker', 'serverless handler');
    }
  }

  // Dockerfile CMD / ENTRYPOINT
  for (const file of pass) {
    const base = file.path.split('/').pop()?.toLowerCase() ?? '';
    if (!base.startsWith('dockerfile') || !file.text) continue;
    const match = file.text.match(/^\s*(?:CMD|ENTRYPOINT)\s+(.+)$/im);
    if (match) {
      const script = match[1].match(/["']([^"']+\.[a-z]+)["']/);
      if (script) {
        const resolved = normalizePath(script[1].replace(/^\//, ''));
        add(resolved, 'container', `CMD/ENTRYPOINT in ${file.path}`);
      }
    }
  }

  return rankEntrypoints([...found.values()]);
}

function refineEntryKind(file: PassFile, fallback: EntrypointKind): EntrypointKind {
  const text = file.text ?? '';
  if (/\b(createServer|\.listen\s*\(|FastAPI\(|Flask\(|express\(\)|fastify\()/.test(text)) return 'http-server';
  if (/\b(yargs|commander|process\.argv|argparse|click\.command|sys\.argv|cobra|clap::)/.test(text)) return 'cli';
  if (/\b(BullMQ|Worker\(|celery|consumer\.run|kafka)/i.test(text)) return 'worker';
  if (file.path.endsWith('lib.rs') || /module\.exports|export\s*\{/.test(text)) return 'library-export';
  return fallback;
}

/* ------------------------------------------------------------------ *
 * Services, concepts, docs
 * ------------------------------------------------------------------ */

/**
 * Names that belong to this repository rather than to a dependency: top-level
 * directories, Python packages (directories with `__init__.py`), and package
 * names declared in manifests. Without this, an import the resolver could not
 * follow is reported as an external dependency.
 */
function detectOwnRoots(paths: string[], manifests: ManifestInfo[]): Set<string> {
  const roots = new Set<string>();
  const packageDirs = new Set<string>();
  for (const filePath of paths) {
    const segments = filePath.split('/');
    if (segments.length > 1) roots.add(segments[0]);
    if (segments[segments.length - 1] === '__init__.py' && segments.length > 2) {
      packageDirs.add(segments.slice(0, -1).join('/'));
      roots.add(segments[segments.length - 2]);
    }
  }
  // `tests/onyx_helpers.py` imported as `onyx_helpers` is first-party code, not a
  // dependency. Only files in package-ish directories are considered, so a file
  // called `requests.py` cannot shadow the real `requests` package globally.
  for (const filePath of paths) {
    const dir = dirOf(filePath);
    if (!dir) continue;
    if (!packageDirs.has(dir) && !/(^|\/)(tests?|test_utils|fixtures)(\/|$)/.test(dir)) continue;
    const base = filePath.split('/').pop() as string;
    roots.add(base.replace(/\.[^.]+$/, ''));
  }
  for (const manifest of manifests) {
    if (!manifest.name) continue;
    roots.add(manifest.name);
    roots.add(manifest.name.replace(/^@[^/]+\//, ''));
    roots.add(manifest.name.replace(/^@[^/]+\//, '').replace(/-/g, '_'));
  }
  return roots;
}

function buildDependencies(
  pass: PassFile[],
  imports: ImportEdge[],
  manifests: ManifestInfo[],
  ownRoots: Set<string>,
): ExternalDependency[] {
  const accumulator = createDependencyAccumulator();
  const familyByPath = new Map(pass.map((file) => [file.path, detectLanguage(file.path).family]));

  // 1. Packages that the code actually imports but that do not resolve inside
  //    the repository. The specifier is the identifier; nothing is inferred.
  for (const edge of imports) {
    if (edge.to !== null) continue;
    const family = familyByPath.get(edge.from) ?? 'other';
    const name = dependencyNameFromSpecifier(edge.specifier, family, ownRoots);
    if (!name) continue;
    accumulator.add(name, 'package', edge.from);
  }

  // 2. Runtime dependencies declared in manifests. These are shipped, not
  //    necessarily imported at a site we parsed. Dev-only tooling is excluded
  //    because it is noise for a reader trying to understand the system.
  for (const manifest of manifests) {
    for (const declared of manifest.dependencies) {
      const name = normaliseManifestDependency(declared);
      if (!name || name.length > 80) continue;
      accumulator.add(name, 'manifest', manifest.path);
    }
  }

  // 3. Configuration evidence, which is the most authoritative of all.
  for (const file of pass) {
    for (const image of file.containerImages) accumulator.add(image, 'image', file.path);
    for (const key of file.envKeys) accumulator.add(key, 'env', file.path);
    for (const scheme of file.urlSchemes) accumulator.add(scheme, 'url', file.path);
  }

  return accumulator.finish();
}

function computeHotspots(pass: PassFile[], components: Component[], churn: FileChurn[]): Hotspot[] {
  if (churn.length === 0) return [];
  const byPath = new Map(pass.map((file) => [file.path, file]));
  const componentOf = (filePath: string): string[] =>
    components.filter((component) => component.files.includes(filePath)).map((component) => component.name);

  return churn
    .filter((entry) => byPath.has(entry.path))
    .map((entry) => {
      const file = byPath.get(entry.path);
      const loc = file?.entry.lines ?? 0;
      // Churn alone favours tiny files edited constantly; size alone favours
      // untouched monoliths. The product is where both are high.
      const score = entry.commits * Math.log10(loc + 10);
      return { path: entry.path, score: Number(score.toFixed(2)), commits: entry.commits, loc, components: componentOf(entry.path) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
}

function aggregateLanguages(pass: PassFile[]): { language: string; files: number; loc: number }[] {
  const map = new Map<string, { files: number; loc: number }>();
  for (const file of pass) {
    if (file.entry.isNoise) continue;
    const entry = map.get(file.entry.language) ?? { files: 0, loc: 0 };
    entry.files += 1;
    entry.loc += file.entry.lines;
    map.set(file.entry.language, entry);
  }
  return [...map.entries()].map(([language, value]) => ({ language, ...value })).sort((a, b) => b.loc - a.loc);
}

function extractConcepts(pass: PassFile[]): ConceptHint[] {
  const docText = pass
    .filter((f) => /readme|docs?\//i.test(f.path) && f.text)
    .map((f) => f.text as string)
    .join('\n')
    .slice(0, 200_000);

  interface Candidate {
    term: string;
    display: string;
    files: Set<string>;
    weight: number;
  }
  const candidates = new Map<string, Candidate>();

  const consider = (raw: string, filePath: string, weight: number) => {
    const parts = splitIdentifier(raw);
    if (parts.length === 0) return;
    // Leading underscores mark private/dunder names, which are never the
    // concept a leader needs to learn first.
    if (raw.startsWith('_')) return;
    const key = parts.join(' ');
    const skip = ['index', 'main', 'app', 'src', 'lib', 'util', 'utils', 'helper', 'helpers', 'common', 'types', 'type', 'test', 'spec', 'config', 'const', 'constants', 'setup', 'base', 'get', 'set', 'new', 'init', 'run', 'handle', 'handler', 'create', 'make', 'build', 'load', 'save', 'update', 'delete', 'remove', 'add', 'list', 'find', 'search', 'fetch', 'call', 'start', 'stop', 'close', 'open', 'read', 'write', 'parse', 'format', 'log', 'debug', 'error', 'value', 'data', 'result', 'response', 'request', 'options', 'params', 'args', 'name', 'string', 'number', 'object'];
    if (parts.every((p) => skip.includes(p))) return;
    // Single generic words are noise unless the docs use them.
    if (parts.length === 1 && (parts[0].length < 5 || skip.includes(parts[0]))) return;
    const existing = candidates.get(key);
    if (existing) {
      existing.files.add(filePath);
      existing.weight += weight;
    } else {
      candidates.set(key, { term: key, display: raw, files: new Set([filePath]), weight });
    }
  };

  for (const file of pass) {
    if (file.entry.category === 'source') {
      for (const symbol of file.entry.symbols) {
        if (symbol.kind === 'function' || symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'struct' || symbol.kind === 'trait') {
          consider(symbol.name, file.path, symbol.exported ? 2.5 : 1);
        }
      }
      const segments = file.path.split('/');
      consider(segments[segments.length - 1].replace(/\.[^.]+$/, ''), file.path, 0.8);
      if (segments.length > 1) consider(segments[segments.length - 2], file.path, 0.6);
    }
  }

  const docLower = docText.toLowerCase();
  const ranked = [...candidates.values()]
    .map((candidate) => {
      const parts = candidate.term.split(' ');
      const inDocs = docLower.includes(candidate.term.split(' ')[0]) || docLower.includes(parts.join(''));
      return { candidate, parts, inDocs };
    })
    .filter(({ candidate, parts, inDocs }) => {
      // A concept earns its place by being compound (a real domain term),
      // used widely, or explicitly named in the documentation.
      if (inDocs) return candidate.files.size >= 2;
      if (parts.length >= 2) return candidate.files.size >= 3;
      return candidate.files.size >= 6 && candidate.weight >= 8;
    })
    .map(({ candidate, inDocs }) => ({
      name: candidate.display,
      reason: `Used across ${candidate.files.size} files${inDocs ? ' and named in the documentation' : ''}.`,
      relatedFiles: [...candidate.files].slice(0, 6),
      weight: candidate.weight + (inDocs ? 6 : 0),
    }))
    .sort((a, b) => b.weight - a.weight);

  // De-duplicate near-identical terms.
  const kept: ConceptHint[] = [];
  for (const hint of ranked) {
    const tokens = tokenize(hint.name);
    if (kept.some((k) => jaccard(tokens, tokenize(k.name)) > 0.7)) continue;
    kept.push(hint);
    if (kept.length >= 14) break;
  }
  return kept;
}

function extractDocs(pass: PassFile[]): { path: string; title: string; excerpt: string }[] {
  return pass
    .filter((f) => f.entry.category === 'docs' && f.text && /\.(md|mdx|rst)$/i.test(f.path))
    .slice(0, 40)
    .map((f) => {
      const text = f.text as string;
      const heading = text.match(/^#{1,3}\s+(.+)$/m)?.[1] ?? (f.path.split('/').pop() as string);
      const excerpt = firstLines(
        text
          .split('\n')
          .filter((line) => !line.trim().startsWith('#'))
          .join('\n')
          .trim(),
        6,
        600,
      );
      return { path: f.path, title: heading.trim(), excerpt };
    });
}

/* ------------------------------------------------------------------ *
 * Data flows
 * ------------------------------------------------------------------ */

function inferFlows(components: Component[], edges: GraphEdge[], entrypoints: Entrypoint[], dependencies: ExternalDependency[]): DataFlow[] {
  const flows: DataFlow[] = [];
  const byId = new Map(components.map((c) => [c.id, c]));
  const outgoing = new Map<string, { to: string; weight: number }[]>();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    (outgoing.get(edge.from) as { to: string; weight: number }[]).push({ to: edge.to, weight: edge.weight });
  }
  for (const list of outgoing.values()) list.sort((a, b) => b.weight - a.weight);

  const SINK_CATEGORIES = new Set(['database', 'cache', 'queue', 'storage', 'search']);
  const dataSink = (component: Component): string | null => {
    const match = dependencies.find(
      (dependency) =>
        SINK_CATEGORIES.has(dependency.category) &&
        dependency.kind !== 'manifest' &&
        dependency.evidence.some((file) => component.files.includes(file)),
    );
    return match ? (match.label ?? match.name) : null;
  };

  const httpComponents = unique(entrypoints.filter((e) => e.kind === 'http-server' && e.component).map((e) => e.component as string));
  const entryFileFor = (componentId: string) => entrypoints.find((e) => e.component === componentId && e.kind === 'http-server')?.path;

  for (const startId of httpComponents.slice(0, 3)) {
    const start = byId.get(startId);
    if (!start) continue;
    const path_ids: string[] = [startId];
    const steps: DataFlow['steps'] = [
      { nodeId: startId, description: `An inbound HTTP request reaches ${start.name} (${entryFileFor(startId) ?? 'handler'}).` },
    ];
    const visited = new Set<string>([startId]);
    let cursor = startId;
    let sink: string | null = null;
    for (let depth = 0; depth < 4; depth += 1) {
      const next = (outgoing.get(cursor) ?? []).find((n) => !visited.has(n.to) && byId.get(n.to)?.kind !== 'test');
      if (!next) break;
      const nextComponent = byId.get(next.to);
      if (!nextComponent) break;
      visited.add(next.to);
      path_ids.push(next.to);
      steps.push({
        nodeId: next.to,
        description: `Control passes to ${nextComponent.name} — ${nextComponent.oneLiner}`,
      });
      cursor = next.to;
      const candidateSink = dataSink(nextComponent);
      if (candidateSink) {
        sink = candidateSink;
        break;
      }
    }
    const evidence = unique(
      steps
        .map((s) => entryFileFor(s.nodeId))
        .filter((p): p is string => Boolean(p)),
    );
    flows.push({
      id: `flow-${startId}`,
      name: `${start.name} request path`,
      summary: sink
        ? `Inbound requests enter through ${start.name}, are handled down the dependency chain, and finish at ${sink}.`
        : `Inbound requests enter through ${start.name} and are handled by the modules it depends on.`,
      path: path_ids,
      steps,
      evidence,
    });
  }

  if (flows.length === 0) {
    // No HTTP entrypoint: describe the highest-importance component and what it depends on.
    const top = topN(components.filter((c) => !c.ancillary), 1, (c) => c.importance)[0];
    if (top) {
      const deps = top.dependsOn.slice(0, 3).map((id) => byId.get(id)).filter((c): c is Component => Boolean(c));
      flows.push({
        id: `flow-${top.id}`,
        name: `${top.name} in context`,
        summary: `${top.name} is the most central component. ${top.oneLiner}`,
        path: [top.id, ...deps.map((d) => d.id)],
        steps: [
          { nodeId: top.id, description: `Everything of consequence starts in ${top.name}: ${top.oneLiner}` },
          ...deps.map((d) => ({ nodeId: d.id, description: `It leans on ${d.name} — ${d.oneLiner}` })),
        ],
        evidence: top.keyFiles.slice(0, 3),
      });
    }
  }

  return flows.slice(0, 4);
}

/* ------------------------------------------------------------------ *
 * Graph
 * ------------------------------------------------------------------ */

const MAX_GRAPH_MODULE_NODES = 400;

function buildGraph(components: Component[], modules: ModuleNode[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const componentPaths = new Set(components.map((c) => c.path).filter((p) => p !== ''));

  nodes.push({
    id: 'root',
    label: 'System',
    sublabel: 'the whole repository',
    kind: 'app',
    level: 0,
    parent: null,
    children: components.filter((c) => !c.ancillary).map((c) => `cmp:${c.id}`),
    importance: 1,
    ancillary: false,
    tags: [],
  });

  for (const component of components) {
    const nodeId = `cmp:${component.id}`;
    nodes.push({
      id: nodeId,
      label: component.name,
      sublabel: component.oneLiner,
      kind: component.kind,
      level: 1,
      parent: 'root',
      children: [],
      importance: component.importance,
      ancillary: component.ancillary,
      tags: [component.kind, `${component.loc.toLocaleString()} LOC`],
      componentId: component.id,
    });
    edges.push({ from: 'root', to: nodeId, kind: 'contains', weight: 1 });
  }

  // Which component does a module belong to?
  const componentForModule = (moduleId: string): string | null => {
    const match = components
      .filter((c) => c.path !== '' && (moduleId === c.path || moduleId.startsWith(`${c.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return match ? match.id : null;
  };

  const moduleNodes = modules
    .filter((m) => m.id !== '' && !componentPaths.has(m.id))
    .sort((a, b) => b.totalLoc - a.totalLoc)
    .slice(0, MAX_GRAPH_MODULE_NODES);

  const moduleIds = new Set(moduleNodes.map((m) => m.id));

  for (const module of moduleNodes) {
    const parentComponent = componentForModule(module.id);
    const parentModule = moduleIds.has(module.parent ?? '') ? `mod:${module.parent}` : null;
    const parent = parentModule ?? (parentComponent ? `cmp:${parentComponent}` : 'root');
    const nodeId = `mod:${module.id}`;
    const declaredKind = module.signals.roles.length > 0 ? (module.signals.roles[0] as ComponentKind) : undefined;
    nodes.push({
      id: nodeId,
      label: module.name,
      sublabel: `${module.totalFiles} files · ${module.totalLoc.toLocaleString()} LOC`,
      kind: declaredKind && ['api', 'ui', 'data', 'infra', 'tooling', 'docs', 'test', 'library', 'cli', 'service'].includes(declaredKind) ? declaredKind : 'library',
      level: module.depth + 1,
      parent,
      children: [],
      importance: Number(Math.min(1, Math.log10(module.totalLoc + 10) / 4).toFixed(3)),
      ancillary: module.ancillary,
      tags: unique([...module.languages.slice(0, 2), ...module.signals.roles]).slice(0, 3),
      componentId: parentComponent ?? undefined,
      moduleId: module.id,
    });
    edges.push({ from: parent, to: nodeId, kind: 'contains', weight: 1 });
    if (parentComponent) {
      const componentNode = nodes.find((n) => n.id === `cmp:${parentComponent}`);
      if (componentNode && !componentNode.children.includes(nodeId)) componentNode.children.push(nodeId);
    }
  }

  for (const module of moduleNodes) {
    const node = nodes.find((n) => n.id === `mod:${module.id}`);
    if (!node) continue;
    node.children = moduleNodes.filter((m) => m.parent === module.id).map((m) => `mod:${m.id}`);
  }

  return { nodes, edges };
}
