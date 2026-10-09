import type { ComplexityReport } from './analysis/complexity.js';
import type { ConventionsReport } from './analysis/conventions.js';
import type { DataModelReport } from './analysis/contracts.js';
import type { GapsReport } from './analysis/gaps.js';
import type { CouplingInfo } from './analysis/coupling.js';
import type { OperationalSurface } from './analysis/ops.js';
import type { TestCoverage } from './analysis/tests.js';
/**
 * Core domain model for Repo Explorer.
 *
 * Everything the analysis engine produces, the LLM explains, and the UI renders
 * flows through these types. They are deliberately plain data (JSON-serialisable)
 * so they can be cached to disk and shipped to the browser unchanged.
 */

/* ------------------------------------------------------------------ *
 * Repositories
 * ------------------------------------------------------------------ */

export interface RepoRef {
  /** Stable id derived from the absolute path. */
  id: string;
  /** Absolute path on disk. */
  path: string;
  /** Directory name, e.g. "repo_explorer". */
  name: string;
  /** Optional `owner/name` when a git remote is present. */
  slug?: string;
}

export interface GitSummary {
  isRepo: boolean;
  /** Current branch name, or null when detached / unavailable. */
  branch: string | null;
  head: string | null;
  headShort: string | null;
  /** Total commits reachable from HEAD (capped). */
  commitCount: number;
  firstCommitDate: string | null;
  lastCommitDate: string | null;
  remoteUrl: string | null;
  /** Top contributors by commit count on the analysed history. */
  contributors: { name: string; email: string; commits: number }[];
  /** Commit activity per ISO week for the last ~52 weeks. */
  activity: { week: string; commits: number }[];
  /** Files with the most historical churn (commits and line deltas). */
  churn: FileChurn[];
  defaultBranch: string | null;
  tags: string[];
}

export interface FileChurn {
  path: string;
  commits: number;
  additions: number;
  deletions: number;
}

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

export type FileCategory =
  | 'source'
  | 'test'
  | 'docs'
  | 'config'
  | 'asset'
  | 'generated'
  | 'build'
  | 'data'
  | 'other';

export interface FileEntry {
  /** Repo-relative POSIX path. */
  path: string;
  size: number;
  /** Modification time when the analysis ran; used to detect that code moved on. */
  mtimeMs: number;
  /**
   * Truncated content hash, when the file was read.
   *
   * Modification time changes for reasons that are not content changes (a
   * checkout, a formatter that writes the same bytes), so a moved mtime is
   * confirmed by re-hashing before anything is reported as changed.
   */
  hash?: string;
  lines: number;
  language: string;
  category: FileCategory;
  isBinary: boolean;
  /** True for lockfiles, minified bundles, vendored code, build output. */
  isNoise: boolean;
  /** Top-level symbols (functions/classes) discovered by the light parser. */
  symbols: SymbolInfo[];
}

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'method' | 'enum' | 'struct' | 'trait' | 'module';
  exported: boolean;
  line: number;
}

/** A flat, cross-file record of a definition, with body extent and call stats. */
export interface SymbolRecord {
  /** Stable id: `path#name@line`. */
  id: string;
  path: string;
  name: string;
  kind: SymbolInfo['kind'];
  exported: boolean;
  line: number;
  endLine: number;
  /** Enclosing class/struct/object, when the symbol is a method. */
  container: string | null;
  loc: number;
  /** Reachable from a known entrypoint by following resolved call edges. */
  reachable: boolean;
  callerCount: number;
  calleeCount: number;
  /** True when the symbol is itself an entrypoint (route handler, main, CLI). */
  entry: boolean;
}

export type CallKind = 'call' | 'method' | 'constructor' | 'callback' | 'jsx';

export interface CallEdge {
  /** Symbol id of the caller, or `entry:<path>` when outside any tracked symbol. */
  from: string;
  fromPath: string;
  fromLine: number;
  /** Symbol id of the callee when it resolved inside the repository. */
  to: string | null;
  toPath: string | null;
  toName: string;
  kind: CallKind;
  resolved: boolean;
  /** Package name when the target is external (a library call). */
  external?: string;
}

export interface Route {
  id: string;
  method: string;
  path: string;
  framework: string;
  file: string;
  line: number;
  handler: string | null;
  handlerId: string | null;
}

export interface DeadCodeCandidate {
  symbolId: string;
  path: string;
  name: string;
  kind: SymbolInfo['kind'];
  loc: number;
  reason: string;
}

/** Churn × size, i.e. the files most likely to be both hard and constantly touched. */
export interface Hotspot {
  path: string;
  score: number;
  commits: number;
  loc: number;
  /** Decision points summed across the file's definitions. */
  branches: number;
  /** Deepest control-flow nesting in the file. */
  maxDepth: number;
  /**
   * False when the file has no function bodies to measure — a churned config or
   * stylesheet — in which case it is ranked by size and the reader is told.
   */
  measured: boolean;
  components: string[];
}

export interface ImportEdge {
  from: string;
  /** Resolved repo-relative path, or null when it points outside the repo. */
  to: string | null;
  /** Raw specifier as written in source. */
  specifier: string;
  kind: 'static' | 'dynamic' | 'require' | 'type' | 'python' | 'go' | 'rust' | 'java';
}

/* ------------------------------------------------------------------ *
 * Modules & components
 * ------------------------------------------------------------------ */

export interface ModuleNode {
  /** Directory path relative to repo root; '' is the root module. */
  id: string;
  name: string;
  depth: number;
  parent: string | null;
  children: string[];
  /** Directories excluded from the tree (node_modules, .git, ...). */
  fileCount: number;
  loc: number;
  languages: string[];
  /** Files that live directly in this directory. */
  ownFiles: string[];
  /** Loc/language totals for this directory and everything beneath it. */
  totalLoc: number;
  totalFiles: number;
  /** Secondary detail (tests, fixtures, generated code) hidden until asked for. */
  ancillary: boolean;
  /** Signals used to guess a module's role. */
  signals: ModuleSignals;
}

export interface ModuleSignals {
  entrypoints: string[];
  hasTests: boolean;
  manifestFiles: string[];
  configFiles: string[];
  docsFiles: string[];
  /** Repo-internal modules this one imports from. */
  internalDeps: string[];
  /** External npm/pip/cargo packages referenced by files in this module. */
  externalDeps: string[];
  /** Heuristic roles, e.g. ['http-api', 'ui', 'worker']. */
  roles: string[];
}

export type ComponentKind =
  | 'app'
  | 'service'
  | 'library'
  | 'ui'
  | 'api'
  | 'cli'
  | 'data'
  | 'infra'
  | 'tooling'
  | 'docs'
  | 'test'
  | 'unknown';

export interface Component {
  id: string;
  name: string;
  kind: ComponentKind;
  /** Directory path this component is anchored to. */
  path: string;
  /** Deterministic one-line description derived from signals. */
  oneLiner: string;
  /** Modules folded into this component. */
  moduleIds: string[];
  files: string[];
  keyFiles: string[];
  /** Other component ids this depends on. */
  dependsOn: string[];
  externalDeps: string[];
  loc: number;
  /** Higher = more central to understanding the repo. */
  importance: number;
  /** Ancillary components are collapsed/hidden at the top level. */
  ancillary: boolean;
}

export type EntrypointKind =
  | 'http-server'
  | 'cli'
  | 'worker'
  | 'library-export'
  | 'script'
  | 'build'
  | 'test'
  | 'container'
  | 'other';

export interface Entrypoint {
  path: string;
  kind: EntrypointKind;
  /** Why we believe this is an entrypoint. */
  reason: string;
  component?: string;
}

/**
 * Where a dependency was discovered. Provenance matters: a package import and a
 * container image are very different kinds of evidence.
 */
export type DependencyKind = 'package' | 'image' | 'env' | 'url' | 'manifest';

export type DependencyCategory =
  | 'database'
  | 'search'
  | 'cache'
  | 'queue'
  | 'storage'
  | 'llm'
  | 'auth'
  | 'payment'
  | 'observability'
  | 'http'
  | 'framework'
  | 'dependency';

/**
 * An external dependency, named by the identifier that is actually present in
 * the code or configuration.
 *
 * The `name` is never inferred or substituted: it is the package specifier, the
 * container image, the environment variable key, or the URL scheme that was
 * found. `label` is optional human-readable metadata for well-known names and is
 * never used in place of the name.
 */
export interface ExternalDependency {
  name: string;
  kind: DependencyKind;
  category: DependencyCategory;
  label?: string;
  evidence: string[];
  references: number;
}

export interface StackInfo {
  primaryLanguage: string | null;
  languages: { language: string; files: number; loc: number }[];
  packageManagers: string[];
  frameworks: string[];
  runtimes: string[];
  testFrameworks: string[];
  ci: string[];
}

export interface RepoStats {
  fileCount: number;
  sourceFileCount: number;
  loc: number;
  testLoc: number;
  docCount: number;
  moduleCount: number;
  componentCount: number;
  maxDepth: number;
}

/* ------------------------------------------------------------------ *
 * Knowledge graph / navigation
 * ------------------------------------------------------------------ */

export interface GraphNode {
  id: string;
  label: string;
  sublabel?: string;
  kind: ComponentKind | 'external' | 'dataflow';
  /** 0 = the single root "system" node. */
  level: number;
  parent: string | null;
  children: string[];
  importance: number;
  ancillary: boolean;
  /** Chips shown in the UI. */
  tags: string[];
  componentId?: string;
  moduleId?: string;
  filePath?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  kind: 'depends' | 'data' | 'contains';
  weight: number;
}

export interface DataFlow {
  id: string;
  name: string;
  summary: string;
  /** Component/node ids in order. */
  path: string[];
  steps: { nodeId: string; description: string }[];
  /** Where this flow was inferred from. */
  evidence: string[];
}

export interface ConceptHint {
  name: string;
  /** Why it surfaced (e.g. "appears in 12 files and in README"). */
  reason: string;
  relatedFiles: string[];
  /** Deterministic frequency score. */
  weight: number;
}

/* ------------------------------------------------------------------ *
 * The full analysis
 * ------------------------------------------------------------------ */

export interface RepoModel {
  version: number;
  repo: RepoRef;
  generatedAt: string;
  stats: RepoStats;
  stack: StackInfo;
  git: GitSummary;
  files: FileEntry[];
  imports: ImportEdge[];
  modules: ModuleNode[];
  components: Component[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  entrypoints: Entrypoint[];
  /** External dependencies, named by the exact identifier found in the code. */
  dependencies: ExternalDependency[];
  dataFlows: DataFlow[];
  concepts: ConceptHint[];
  /** Every tracked definition, with body extent and call statistics. */
  symbols: SymbolRecord[];
  /** Resolved call graph edges (caller symbol → callee symbol). */
  calls: CallEdge[];
  /** HTTP/RPC endpoints discovered by framework-specific pattern matching. */
  routes: Route[];
  /** Exported or sizeable symbols with no callers and no reachability. */
  deadCode: DeadCodeCandidate[];
  /** Churn × size ranking across the repository. */
  hotspots: Hotspot[];
  /** Which source files the tests actually reach. */
  tests: TestCoverage;
  /** How the project is built, verified, shipped and run. */
  ops: OperationalSurface;
  /** Which files change together, and who owns what — read from git history. */
  coupling: CouplingInfo;
  /** Measured nesting and decision points, rather than size as a proxy. */
  complexity: ComplexityReport;
  /** Conventions inferred from the code, and the places that break them. */
  conventions: ConventionsReport;
  /** The shape of the data: tables, models, enums and API definitions. */
  dataModel: DataModelReport;
  /** What the repository does not state about itself. */
  gaps: GapsReport;
  /** First ~120 lines of README, if present. */
  readme: string | null;
  docs: { path: string; title: string; excerpt: string }[];
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * Explainers
 * ------------------------------------------------------------------ */

export type ExplainerKind = 'repo-overview' | 'component' | 'module' | 'flow' | 'change';

/**
 * How another part of the system relates to what is on screen.
 *
 * - `child`: inside it, so genuinely deeper.
 * - `parent`: the thing that contains it.
 * - `related`: alongside it — something that uses it, or another view of it.
 */
export type NextRelation = 'child' | 'parent' | 'related';

export interface ExplainerTarget {
  kind: ExplainerKind;
  /** Graph node id / component id / module id / change id. */
  id: string;
  label: string;
  /** Level within the progressive disclosure tree. */
  level: number;
}

export interface DiagramFlowNode {
  id: string;
  label: string;
  sub?: string;
  tone?: 'primary' | 'accent' | 'muted' | 'danger' | 'success';
}

export type Diagram =
  | {
      kind: 'flow';
      direction?: 'horizontal' | 'vertical';
      nodes: DiagramFlowNode[];
      edges: { from: string; to: string; label?: string; dashed?: boolean }[];
      example?: string;
    }
  | {
      kind: 'layers';
      layers: { label: string; hint?: string; items: { label: string; sub?: string; tone?: DiagramFlowNode['tone'] }[] }[];
    }
  | {
      kind: 'tree';
      root: DiagramTreeNode;
    }
  | {
      kind: 'compare';
      left: { title: string; items: string[]; tone?: DiagramFlowNode['tone'] };
      right: { title: string; items: string[]; tone?: DiagramFlowNode['tone'] };
    }
  | {
      kind: 'ui';
      title: string;
      regions: { id: string; label: string; detail: string; tone?: DiagramFlowNode['tone'] }[];
    }
  | {
      kind: 'sequence';
      actors: { id: string; label: string; tone?: DiagramFlowNode['tone'] }[];
      steps: { from: string; to: string; label: string }[];
      example?: string;
    }
  | {
      /**
       * Mermaid source, rendered to SVG.
       *
       * Preferred for the shape of a system and for an end-to-end flow: a real
       * graph engine draws branching and merging far more legibly than a hand
       * rolled chain of boxes, and a `sequenceDiagram` is exactly the right
       * shape for a request lifecycle.
       */
      kind: 'mermaid';
      /** The diagram type keyword, e.g. `flowchart`, `sequenceDiagram`. */
      diagramType: string;
      code: string;
      /** Optional caption shown under the diagram. */
      caption?: string;
    };

export interface DiagramTreeNode {
  label: string;
  sub?: string;
  tone?: DiagramFlowNode['tone'];
  children?: DiagramTreeNode[];
}

export type ExplainerSection =
  | { type: 'prose'; id: string; title: string; markdown: string; collapsible?: boolean; level?: 'deep' | 'narrow' }
  | { type: 'callout'; id: string; variant: 'concept' | 'warning' | 'edge' | 'tip'; title: string; markdown: string }
  | { type: 'diagram'; id: string; title: string; caption?: string; diagram: Diagram }
  | {
      type: 'code';
      id: string;
      title: string;
      language: string;
      code: string;
      file?: string;
      startLine?: number;
      caption?: string;
      /** Line numbers (1-based, relative to `code`) to highlight. */
      highlights?: number[];
    }
  | { type: 'list'; id: string; title: string; items: { term: string; detail: string }[] }
  | { type: 'steps'; id: string; title: string; steps: { label: string; detail: string }[] }
  | { type: 'table'; id: string; title: string; headers: string[]; rows: string[][] }
  | { type: 'quiz'; id: string; title: string; questions: QuizQuestion[] };

export interface QuizQuestion {
  id: string;
  question: string;
  options: string[];
  /** Index into options. */
  answer: number;
  explanation: string;
}

/**
 * What an explainer was written against.
 *
 * An explainer is a snapshot of an understanding, and the code keeps moving.
 * Recording the scope lets us tell the reader that a given explainer is out of
 * date — without hiding or deleting it, since a slightly stale explanation of a
 * component is usually still worth reading.
 */
export interface ExplainerScope {
  /** Aggregate of path + mtime + size for every file the explainer covered. */
  fingerprint: string;
  fileCount: number;
  /** Git HEAD when it was written, when the repository is a git repository. */
  head: string | null;
  /**
   * The per-file baseline, as newline-separated `path\tmtime\tsize`.
   *
   * Needed to name which files changed. Comparing against the *analysis* instead
   * made a freshly written explainer report itself as stale, because the
   * analysis is older than the explainer by definition. Capped, so an explainer
   * covering a very large repository keeps the fingerprint but not the list.
   */
  files?: string;
}

export interface StalenessReport {
  stale: boolean;
  /** True when commits landed after the explainer was written. */
  headMoved: boolean;
  /** Files whose modification time changed since the explainer was written. */
  changedFiles: string[];
  /** Files that no longer exist. */
  removedFiles: string[];
  /** How many files were examined. */
  checkedFiles: number;
  /** Human-readable summary, suitable for a badge. */
  summary: string;
}

export interface Explainer {
  id: string;
  version: number;
  kind: ExplainerKind;
  target: ExplainerTarget;
  title: string;
  subtitle: string;
  /** Short summary used in cards and as LLM context for children. */
  tldr: string;
  sections: ExplainerSection[];
  /**
   * What the reader can go to next.
   *
   * `relation` distinguishes genuine depth (a sub-directory of what is on
   * screen) from a cross-reference (a component that uses this one). Presenting
   * both as "go deeper" implies a hierarchy that does not exist.
   */
  next: { id: string; label: string; kind: ExplainerKind; hint: string; relation?: NextRelation }[];
  /** Citation anchors the LLM used. */
  sources: { path: string; startLine?: number; endLine?: number }[];
  model: string;
  provider: string;
  generatedAt: string;
  /** What the explainer was written against, for staleness checks. */
  scope?: ExplainerScope;
  /** True when produced without an LLM (deterministic fallback). */
  degraded?: boolean;
  /**
   * Why a written explanation is absent, in the reader's terms. The reader used
   * to be told the model "was unavailable or did not return something usable",
   * which was often wrong and always unhelpful.
   */
  degradedReason?: string;
  tokens?: { prompt: number; completion: number };
}

/* ------------------------------------------------------------------ *
 * Changes (commits / PRs / diffs)
 * ------------------------------------------------------------------ */

export interface ChangeFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unknown';
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  /** Language for highlighting. */
  language: string;
}

export interface Change {
  id: string;
  /** 'commit' | 'range' | 'branch' | 'pr' | 'working' */
  kind: 'commit' | 'range' | 'branch' | 'pr' | 'working';
  title: string;
  subtitle?: string;
  /** Commit sha(s) involved, oldest-first. */
  commits: { sha: string; short: string; author: string; email: string; date: string; subject: string; body: string }[];
  base: string;
  head: string;
  author?: string;
  date?: string;
  url?: string;
  body?: string;
  files: ChangeFile[];
  stats: { files: number; additions: number; deletions: number };
}

/* ------------------------------------------------------------------ *
 * Index & retrieval
 * ------------------------------------------------------------------ */

export interface Chunk {
  id: string;
  path: string;
  language: string;
  kind: 'function' | 'class' | 'block' | 'file' | 'config' | 'docs';
  symbol?: string;
  startLine: number;
  endLine: number;
  text: string;
  tokens: string[];
}

export interface SearchHit {
  chunk: Chunk;
  score: number;
  matched: string[];
}

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */

export interface Citation {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  createdAt: string;
}

export interface ChatSession {
  id: string;
  repoId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ChatTurn[];
}

/* ------------------------------------------------------------------ *
 * Client-facing shapes
 * ------------------------------------------------------------------ */

/**
 * The analysis minus the parts that are too large to ship to the browser at
 * once. File contents and per-file symbols are fetched on demand.
 */
export interface ClientComponent extends Omit<Component, 'files'> {
  fileCount: number;
}

export interface ClientRepoModel extends Omit<RepoModel, 'files' | 'imports' | 'components' | 'symbols' | 'calls'> {
  components: ClientComponent[];
}

/** A cached explainer as listed for the UI, with its freshness. */
export interface ExplainerSummary {
  id: string;
  title: string;
  kind: ExplainerKind;
  generatedAt: string;
  target: string;
  stale: boolean;
  freshness: string;
}

/** A symbol as shipped to the UI: everything except the full call graph. */
export interface SymbolSummary {
  id: string;
  path: string;
  name: string;
  kind: SymbolRecord['kind'];
  container: string | null;
  exported: boolean;
  line: number;
  endLine: number;
  loc: number;
  reachable: boolean;
  entry: boolean;
  callerCount: number;
  calleeCount: number;
}

export interface SymbolDetail extends SymbolSummary {
  callers: { name: string; path: string; line: number; container: string | null }[];
  callees: { name: string; path: string | null; line: number | null; external: boolean }[];
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  lines?: number;
  language?: string;
  category?: string;
  childCount?: number;
}

export interface ChangeSummary {
  id: string;
  kind: Change['kind'];
  title: string;
  subtitle?: string;
  base: string;
  head: string;
  author?: string;
  date?: string;
  stats: Change['stats'];
}

/* ------------------------------------------------------------------ *
 * LLM provider contract
 * ------------------------------------------------------------------ */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmUsage {
  prompt: number;
  completion: number;
}

export interface LlmRequest {
  messages: LlmMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider to emit a JSON object. */
  json?: boolean;
  signal?: AbortSignal;
}

export interface LlmResult {
  text: string;
  model: string;
  provider: string;
  usage?: LlmUsage;
  /**
   * Why the provider stopped. `'length'` means the answer was cut off by the
   * output limit, which is the difference between a model that refused to write
   * an explainer and one that wrote too much of one.
   */
  finishReason?: string;
}

export interface LlmStreamChunk {
  delta: string;
  done?: boolean;
  usage?: LlmUsage;
}

export type CredentialSource = 'env' | 'dotenv' | 'config' | 'none';

export interface ProviderStatus {
  id: string;
  label: string;
  available: boolean;
  /** Whether a credential is present, and where it came from. Never the secret. */
  credential?: { present: boolean; source: CredentialSource };
  /** Human-readable explanation when unavailable. */
  detail: string;
  models: string[];
  defaultModel?: string;
  /** Local providers run on-device (no data leaves the machine). */
  local: boolean;
}

export interface LlmProvider {
  id: string;
  label: string;
  local: boolean;
  status(): Promise<ProviderStatus>;
  complete(req: LlmRequest): Promise<LlmResult>;
  stream(req: LlmRequest): AsyncGenerator<LlmStreamChunk, void, unknown>;
}
