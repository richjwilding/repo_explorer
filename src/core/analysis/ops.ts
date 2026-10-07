/**
 * The operational surface: how the project is built, verified, shipped and run.
 *
 * Everything here is read from files whose whole purpose is to state these
 * facts — CI definitions, Dockerfiles, compose files, infrastructure manifests
 * and package scripts. Nothing is inferred from a dependency's name, because a
 * repository that depends on `express` tells you far less about how it is
 * deployed than its Dockerfile does.
 *
 * The point of collecting it is the question an engineering leader asks first
 * and that reading source cannot answer: if I change this, what runs, what
 * checks it, and how does it reach production?
 */
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import type { ManifestInfo } from './stack.js';

export type ScriptCategory =
  | 'test'
  | 'typecheck'
  | 'lint'
  | 'format'
  | 'build'
  | 'dev'
  | 'start'
  | 'migrate'
  | 'deploy'
  | 'other';

export interface ManifestScript {
  manifest: string;
  name: string;
  command: string;
  category: ScriptCategory;
}

export interface CiStep {
  name?: string;
  run?: string;
  uses?: string;
}

export interface CiJob {
  id: string;
  name?: string;
  runner?: string;
  needs: string[];
  steps: CiStep[];
  /** `run:` commands, in order — what actually executes. */
  commands: string[];
  /** `uses:` actions, e.g. actions/checkout. */
  actions: string[];
}

export interface CiWorkflow {
  path: string;
  name: string;
  /** push, pull_request, schedule, workflow_dispatch, merge_group, … */
  triggers: string[];
  jobs: CiJob[];
  commands: string[];
  actions: string[];
  /** Set when the workflow looks like the one that gates a merge. */
  gating: boolean;
}

export interface ContainerStage {
  name: string;
  base: string;
  line: number;
}

export interface ContainerImage {
  path: string;
  stages: ContainerStage[];
  baseImages: string[];
  exposedPorts: number[];
  entrypoint?: string;
  cmd?: string;
  workdir?: string;
  user?: string;
  buildArgs: string[];
  healthcheck: boolean;
  /** No USER directive, or an explicit root — worth flagging to a reader. */
  runsAsRoot: boolean;
  multiStage: boolean;
  /** `COPY package.json` before copying the rest — dependency caching done right. */
  cachesDependencies: boolean;
  /** Names declared with ENV. */
  declaredEnv: string[];
}

export interface ComposeService {
  name: string;
  image?: string;
  build?: string;
  ports: string[];
  dependsOn: string[];
  /** Environment variable *names* — values are never read. */
  environment: string[];
  command?: string;
  profiles: string[];
}

export interface ComposeFile {
  path: string;
  services: ComposeService[];
  namedVolumes: string[];
}

export interface InfraResource {
  kind: string;
  name?: string;
  line: number;
}

export interface InfraFile {
  path: string;
  format: 'kubernetes' | 'terraform' | 'helm' | 'serverless' | 'cloudformation' | 'ansible' | 'pulumi' | 'other';
  resources: InfraResource[];
  /** Container images referenced by workloads — the deployed artefacts. */
  images: string[];
}

export interface EnvVar {
  name: string;
  files: string[];
  /** A file outside test and fixture directories, if one declares this name. */
  primaryFile: string;
  /** Only ever seen in test or fixture code — not a deployment requirement. */
  testOnly: boolean;
}

export interface OpsSummary {
  test?: string;
  typecheck?: string;
  lint?: string;
  build?: string;
  start?: string;
  dev?: string;
  deploy?: string;
  /** The commands CI runs, joined for display. */
  ciGate?: string;
  /** The workflow that appears to gate a merge. */
  ciWorkflow?: string;
  /** Container entrypoint, if a Dockerfile states one. */
  entrypoint?: string;
  /** Ports the project listens on, from Dockerfiles and compose. */
  ports: number[];
  /** Distinct deployment mechanisms found, e.g. ['kubernetes', 'terraform']. */
  deployTargets: string[];
}

export interface OperationalSurface {
  ci: CiWorkflow[];
  containers: ContainerImage[];
  compose: ComposeFile[];
  infra: InfraFile[];
  scripts: ManifestScript[];
  envVars: EnvVar[];
  summary: OpsSummary;
  warnings: string[];
}

export interface OpsFileInput {
  path: string;
  text: string | null;
}

const MAX_OPS_BYTES = 400_000;

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

const CI_PATHS: { re: RegExp; kind: string }[] = [
  { re: /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/, kind: 'github' },
  { re: /(^|\/)\.gitlab-ci\.ya?ml$/, kind: 'gitlab' },
  { re: /(^|\/)\.circleci\/config\.ya?ml$/, kind: 'circleci' },
  { re: /(^|\/)azure-pipelines\.ya?ml$/, kind: 'azure' },
  { re: /(^|\/)bitbucket-pipelines\.ya?ml$/, kind: 'bitbucket' },
  { re: /(^|\/)\.drone\.ya?ml$/, kind: 'drone' },
  { re: /(^|\/)\.buildkite\/.+\.ya?ml$/, kind: 'buildkite' },
  { re: /(^|\/)cloudbuild\.ya?ml$/, kind: 'gcp' },
  { re: /(^|\/)Jenkinsfile$/, kind: 'jenkins' },
];

export function isCiPath(path: string): boolean {
  return CI_PATHS.some((entry) => entry.re.test(path));
}

export function isDockerfilePath(path: string): boolean {
  const base = path.split('/').pop()?.toLowerCase() ?? '';
  return base === 'dockerfile' || base.startsWith('dockerfile.') || base.endsWith('.dockerfile');
}

export function isComposePath(path: string): boolean {
  const base = path.split('/').pop()?.toLowerCase() ?? '';
  if (base === 'compose.yml' || base === 'compose.yaml') return true;
  return /^docker-compose[^/]*\.ya?ml$/.test(base);
}

/**
 * Infrastructure files, classified by path first.
 *
 * Returns null for anything unrecognised; YAML that is not in a known location
 * is sniffed separately for a Kubernetes shape, so an unusual layout is still
 * picked up without guessing at prose.
 */
export function classifyInfraPath(path: string): InfraFile['format'] | null {
  const base = path.split('/').pop()?.toLowerCase() ?? '';
  const lower = path.toLowerCase();
  if (/\.tf$/.test(base) || /\.tfvars$/.test(base) || base === '.terraform.lock.hcl') return 'terraform';
  if (base === 'pulumi.yaml' || base === 'pulumi.yml' || path.includes('__main__.py')) {
    return base.startsWith('pulumi') ? 'pulumi' : null;
  }
  if (base === 'chart.yaml') return 'helm';
  if (base === 'serverless.yml' || base === 'serverless.yaml') return 'serverless';
  if (base === 'template.yaml' || base === 'template.yml') return 'cloudformation';
  if (/^playbook[^/]*\.ya?ml$/.test(base)) return 'ansible';
  if (/^(deployment|service|statefulset|daemonset|ingress|cronjob|job|configmap|kustomization)[^/]*\.ya?ml$/.test(base)) {
    return 'kubernetes';
  }
  if (/(^|\/)(k8s|kubernetes|manifests|helm|charts|deploy|deployment|infra|terraform)\//.test(lower) && /\.ya?ml$/.test(base)) {
    return 'kubernetes';
  }
  return null;
}

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

interface WorkflowJobShape {
  name?: unknown;
  'runs-on'?: unknown;
  needs?: unknown;
  steps?: unknown;
}

function asStringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>);
  return [];
}

/**
 * Normalise the `on:` block.
 *
 * In YAML 1.1 an unquoted `on` parses as the boolean `true`, and GitHub's own
 * documentation uses both a string and a mapping here, so all three shapes are
 * accepted rather than assuming one.
 */
function parseTriggers(workflow: Record<string, unknown>): string[] {
  const raw = workflow.on ?? workflow.true ?? workflow[true as unknown as string];
  return asStringList(raw).sort();
}

function parseJob(id: string, job: WorkflowJobShape): CiJob {
  const steps: CiStep[] = [];
  const commands: string[] = [];
  const actions: string[] = [];
  const rawSteps = Array.isArray(job.steps) ? job.steps : [];
  for (const step of rawSteps) {
    if (!step || typeof step !== 'object') continue;
    const record = step as Record<string, unknown>;
    const run = typeof record.run === 'string' ? record.run : undefined;
    const uses = typeof record.uses === 'string' ? record.uses : undefined;
    const name = typeof record.name === 'string' ? record.name : undefined;
    steps.push({ name, run, uses });
    if (run) {
      // A single step often holds several commands; each is worth seeing.
      for (const line of run.split('\n')) {
        const command = line.trim().replace(/^[-|>]\s*/, '');
        if (command && !command.startsWith('#')) commands.push(command);
      }
    }
    if (uses) actions.push(uses);
  }
  return {
    id,
    name: typeof job.name === 'string' ? job.name : undefined,
    runner: Array.isArray(job['runs-on'])
      ? job['runs-on'].filter((v): v is string => typeof v === 'string').join(', ')
      : typeof job['runs-on'] === 'string'
        ? job['runs-on']
        : undefined,
    needs: asStringList(job.needs),
    steps,
    commands,
    actions,
  };
}

export function parseCiWorkflow(path: string, text: string): CiWorkflow | null {
  if (!isCiPath(path)) return null;
  // A Jenkinsfile is Groovy, not YAML: report it, but do not pretend to parse it.
  if (/Jenkinsfile$/.test(path)) {
    return {
      path,
      name: 'Jenkinsfile',
      triggers: [],
      jobs: [],
      commands: extractJenkinsStages(text),
      actions: [],
      gating: true,
    };
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const workflow = doc as Record<string, unknown>;
  const triggers = parseTriggers(workflow);
  const rawJobs = workflow.jobs && typeof workflow.jobs === 'object' ? (workflow.jobs as Record<string, WorkflowJobShape>) : {};
  const jobs = Object.entries(rawJobs).map(([id, job]) => parseJob(id, job ?? {}));
  const commands = jobs.flatMap((job) => job.commands);
  const actions = [...new Set(jobs.flatMap((job) => job.actions))];
  const gating =
    (triggers.includes('pull_request') || triggers.includes('push') || triggers.includes('merge_group')) &&
    commands.length > 0;
  return {
    path,
    name: typeof workflow.name === 'string' ? workflow.name : path.split('/').pop() ?? path,
    triggers,
    jobs,
    commands,
    actions,
    gating,
  };
}

/** Jenkinsfiles: stage names and shell steps, without pretending to parse Groovy. */
function extractJenkinsStages(text: string): string[] {
  const commands: string[] = [];
  // Not anchored to the line: a Jenkinsfile is Groovy, and `sh 'x'` can follow
  // a brace on the same line.
  for (const match of text.matchAll(/(?:^|[\s{;])sh\s+['"]([^'"]+)['"]/g)) commands.push(match[1].trim());
  return commands;
}

// ---------------------------------------------------------------------------
// Dockerfile
// ---------------------------------------------------------------------------

/** Join continued lines and drop comments, keeping the original line number. */
export function dockerfileInstructions(text: string): { instruction: string; argument: string; line: number }[] {
  const out: { instruction: string; argument: string; line: number }[] = [];
  const raw = text.split('\n');
  let buffer = '';
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index];
    // Comments are only comments at the start of a line, so `RUN echo '#x'` is safe.
    if (/^\s*#/.test(line)) continue;
    if (buffer === '') start = index + 1;
    const continued = /\\\s*$/.test(line);
    buffer += (buffer ? ' ' : '') + line.replace(/\\\s*$/, '').trim();
    if (!continued) {
      const trimmed = buffer.trim();
      if (trimmed) {
        const match = /^([A-Za-z]+)\s*([\s\S]*)$/.exec(trimmed);
        if (match) out.push({ instruction: match[1].toUpperCase(), argument: match[2].trim(), line: start });
      }
      buffer = '';
    }
  }
  const trimmed = buffer.trim();
  if (trimmed) {
    const match = /^([A-Za-z]+)\s*([\s\S]*)$/.exec(trimmed);
    if (match) out.push({ instruction: match[1].toUpperCase(), argument: match[2].trim(), line: start });
  }
  return out;
}

const MANIFEST_COPY_RE = /package(-lock)?\.json|yarn\.lock|pnpm-lock|requirements\.txt|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile|composer\.json|\.csproj|pyproject\.toml/i;

/**
 * The source operands of a COPY/ADD — everything except the destination.
 *
 * The destination matters: `COPY package.json package-lock.json ./` ends in
 * `./`, and treating that as "copied the source tree" made every correctly
 * cached Dockerfile look like it installed dependencies after the source.
 */
export function copySources(argument: string): string {
  const operands = argument.split(/\s+/).filter(Boolean);
  return operands.slice(0, -1).join(' ');
}

/** `["node", "server.js"]` or shell form, reduced to something readable. */
function normaliseContainerCommand(argument: string): string {
  const trimmed = argument.trim();
  if (!trimmed.startsWith('[')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map((part) => String(part)).join(' ');
  } catch {
    /* fall through to the raw text */
  }
  return trimmed.replace(/^\[|\]$/g, '').replace(/["']/g, '').replace(/,\s*/g, ' ');
}

export function parseDockerfile(path: string, text: string): ContainerImage {
  const instructions = dockerfileInstructions(text);
  const stages: ContainerStage[] = [];
  const baseImages: string[] = [];
  const exposedPorts: number[] = [];
  const buildArgs: string[] = [];
  let entrypoint: string | undefined;
  let cmd: string | undefined;
  let workdir: string | undefined;
  let user: string | undefined;
  let healthcheck = false;
  let cachesDependencies = false;
  const declaredEnv = new Set<string>();

  for (const { instruction, argument, line } of instructions) {
    switch (instruction) {
      case 'FROM': {
        // `FROM --platform=linux/amd64 node:20-alpine AS build`
        const cleaned = argument.replace(/--platform=\S+\s*/gi, '').trim();
        const match = /^(\S+)(?:\s+AS\s+(\S+))?/i.exec(cleaned);
        if (match) {
          const base = match[1];
          baseImages.push(base);
          stages.push({ name: match[2] ?? `#${stages.length + 1}`, base, line });
        }
        break;
      }
      case 'EXPOSE':
        for (const port of argument.split(/\s+/)) {
          const value = Number.parseInt(port.split('/')[0], 10);
          if (Number.isFinite(value) && value > 0 && value < 65_536) exposedPorts.push(value);
        }
        break;
      case 'ENTRYPOINT':
        entrypoint = normaliseContainerCommand(argument);
        break;
      case 'CMD':
        cmd = normaliseContainerCommand(argument);
        break;
      case 'WORKDIR':
        workdir = argument;
        break;
      case 'USER':
        user = argument;
        break;
      case 'ARG':
        buildArgs.push(argument.split('=')[0].trim());
        break;
      case 'HEALTHCHECK':
        healthcheck = !/^\s*NONE/i.test(argument);
        break;
      case 'ENV': {
        // `ENV KEY=value` and `ENV KEY value` both declare a variable.
        const name = argument.split(/\s+/)[0].split('=')[0];
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) declaredEnv.add(name.toUpperCase());
        break;
      }
      default:
        break;
    }
  }

  // Dependency caching done right: the manifest is copied, and dependencies are
  // installed, before the source tree lands — so editing source does not
  // invalidate the install layer. Checked across the whole build rather than
  // within one stage, because the canonical form puts the manifest in a `deps`
  // stage and the source in the final one.
  const sourceCopyRe = /(^|\s)(\.|\.\/|src|app|\/app)(\s|$)/;
  let lastManifestCopy = -1;
  let firstSourceCopy = -1;
  instructions.forEach((instruction, index) => {
    if (instruction.instruction !== 'COPY' && instruction.instruction !== 'ADD') return;
    const sources = copySources(instruction.argument);
    if (MANIFEST_COPY_RE.test(sources)) lastManifestCopy = index;
    else if (sourceCopyRe.test(sources) && firstSourceCopy === -1) firstSourceCopy = index;
  });
  cachesDependencies = lastManifestCopy >= 0 && (firstSourceCopy === -1 || lastManifestCopy < firstSourceCopy);

  return {
    path,
    stages,
    baseImages: [...new Set(baseImages)],
    exposedPorts: [...new Set(exposedPorts)].sort((a, b) => a - b),
    entrypoint,
    cmd,
    workdir,
    user,
    buildArgs: [...new Set(buildArgs)],
    healthcheck,
    runsAsRoot: !user || /^(root|0)$/i.test(user),
    multiStage: stages.length > 1,
    cachesDependencies,
    declaredEnv: [...declaredEnv].sort(),
  };
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

function parseCompose(path: string, text: string): ComposeFile | null {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const root = doc as Record<string, unknown>;
  const serviceMap = root.services && typeof root.services === 'object' ? (root.services as Record<string, unknown>) : {};
  const services: ComposeService[] = [];
  for (const [name, raw] of Object.entries(serviceMap)) {
    if (!raw || typeof raw !== 'object') continue;
    const service = raw as Record<string, unknown>;
    const build = service.build;
    let buildPath: string | undefined;
    if (typeof build === 'string') buildPath = build;
    else if (build && typeof build === 'object') {
      const context = (build as Record<string, unknown>).context;
      if (typeof context === 'string') buildPath = context;
    }
    // `environment` is a list of KEY=value or a mapping — take names only.
    let environment: string[] = [];
    if (Array.isArray(service.environment)) {
      environment = service.environment
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.split('=')[0].trim())
        .filter(Boolean);
    } else if (service.environment && typeof service.environment === 'object') {
      environment = Object.keys(service.environment as Record<string, unknown>);
    }
    let command: string | undefined;
    if (typeof service.command === 'string') command = service.command;
    else if (Array.isArray(service.command)) command = service.command.map(String).join(' ');
    services.push({
      name,
      image: typeof service.image === 'string' ? service.image : undefined,
      build: buildPath,
      ports: Array.isArray(service.ports) ? service.ports.map(String) : [],
      dependsOn: asStringList(service.depends_on),
      environment: [...new Set(environment)].sort(),
      command,
      profiles: asStringList(service.profiles),
    });
  }
  const namedVolumes = root.volumes && typeof root.volumes === 'object' ? Object.keys(root.volumes as Record<string, unknown>) : [];
  return { path, services, namedVolumes };
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

function parseTerraform(text: string): InfraResource[] {
  const resources: InfraResource[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*(resource|data|module)\s+"([^"]+)"(?:\s+"([^"]+)")?/.exec(lines[index]);
    if (match) {
      resources.push({
        kind: match[1] === 'module' ? 'module' : match[1] === 'data' ? `data.${match[2]}` : match[2],
        name: match[3] ?? match[2],
        line: index + 1,
      });
    }
  }
  return resources;
}

function parseCloudFormation(text: string): InfraResource[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];
  const resources = (doc as Record<string, unknown>).Resources;
  if (!resources || typeof resources !== 'object') return [];
  return Object.entries(resources as Record<string, unknown>).map(([name, value]) => {
    const type = value && typeof value === 'object' ? (value as Record<string, unknown>).Type : undefined;
    return { kind: typeof type === 'string' ? type : 'resource', name, line: 1 };
  });
}

/**
 * Kubernetes documents, including multi-document files.
 *
 * Container images are pulled out of pod specs because those images are the
 * artefacts actually deployed, which is often the only place the real runtime
 * stack is stated.
 */
function parseKubernetes(text: string): { resources: InfraResource[]; images: string[] } {
  const resources: InfraResource[] = [];
  const images: string[] = [];
  let docs: unknown[] = [];
  try {
    docs = parseAllDocuments(text).map((doc) => doc.toJS());
  } catch {
    return { resources, images };
  }
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue;
    const record = doc as Record<string, unknown>;
    const kind = record.kind;
    if (typeof kind !== 'string') continue;
    const metadata = record.metadata && typeof record.metadata === 'object' ? (record.metadata as Record<string, unknown>) : {};
    resources.push({ kind, name: typeof metadata.name === 'string' ? metadata.name : undefined, line: 1 });
    collectImages(record, images, 0);
  }
  return { resources, images: [...new Set(images)] };
}

/** Walk a document for `image:` keys, without pretending to know every schema. */
function collectImages(node: unknown, out: string[], depth: number): void {
  if (depth > 8 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectImages(item, out, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'image' && typeof value === 'string' && value.includes('/')) out.push(value);
    else if (key === 'image' && typeof value === 'string' && /:/.test(value)) out.push(value);
    else collectImages(value, out, depth + 1);
  }
}

function parseInfraFile(path: string, text: string): InfraFile | null {
  let format = classifyInfraPath(path);
  // YAML that is not in a known directory is still Kubernetes if it says so.
  if (!format && /\.ya?ml$/.test(path)) {
    if (/^\s*apiVersion\s*:/m.test(text) && /^\s*kind\s*:/m.test(text)) format = 'kubernetes';
  }
  if (!format) return null;

  if (format === 'terraform') {
    return { path, format, resources: parseTerraform(text), images: [] };
  }
  if (format === 'cloudformation') {
    return { path, format, resources: parseCloudFormation(text), images: [] };
  }
  if (format === 'helm') {
    let name: string | undefined;
    let version: string | undefined;
    try {
      const doc = parseYaml(text) as Record<string, unknown> | null;
      if (doc) {
        name = typeof doc.name === 'string' ? doc.name : undefined;
        version = typeof doc.version === 'string' ? doc.version : undefined;
      }
    } catch {
      /* a malformed Chart.yaml is not worth failing the analysis over */
    }
    return {
      path,
      format,
      resources: [{ kind: 'chart', name: name ? `${name}${version ? ` ${version}` : ''}` : undefined, line: 1 }],
      images: [],
    };
  }
  if (format === 'serverless') {
    let functions: InfraResource[] = [];
    let images: string[] = [];
    try {
      const doc = parseYaml(text) as Record<string, unknown> | null;
      if (doc) {
        const rawFunctions = doc.functions && typeof doc.functions === 'object' ? (doc.functions as Record<string, unknown>) : {};
        functions = Object.keys(rawFunctions).map((name) => ({ kind: 'function', name, line: 1 }));
        collectImages(doc, images, 0);
      }
    } catch {
      /* ignore */
    }
    return { path, format, resources: functions, images: [...new Set(images)] };
  }
  if (format === 'ansible') {
    const resources: InfraResource[] = [];
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^\s*-\s*(?:name|hosts):\s*(.+)$/.exec(lines[index]);
      if (match) resources.push({ kind: 'play', name: match[1].trim().replace(/^["']|["']$/g, ''), line: index + 1 });
    }
    return { path, format, resources, images: [] };
  }
  if (format === 'kubernetes') {
    const { resources, images } = parseKubernetes(text);
    return { path, format, resources, images };
  }
  if (format === 'pulumi') {
    return { path, format, resources: [], images: [] };
  }
  return { path, format, resources: [], images: [] };
}

// ---------------------------------------------------------------------------
// Manifest scripts
// ---------------------------------------------------------------------------

const SCRIPT_CATEGORIES: { category: ScriptCategory; re: RegExp }[] = [
  { category: 'test', re: /(^|:)(test|tests|spec|e2e|unit|it|coverage)(:|$)/i },
  { category: 'typecheck', re: /(typecheck|type-check|tsc|flow|mypy|pyright)/i },
  { category: 'lint', re: /(lint|eslint|flake8|rubocop|checkstyle|golangci)/i },
  { category: 'format', re: /(format|fmt|prettier|black|gofmt|rustfmt)/i },
  { category: 'migrate', re: /(migrat|db:|seed)/i },
  { category: 'dev', re: /(^|:)(dev|develop|watch|serve:dev)(:|$)/i },
  { category: 'start', re: /(^|:)(start|serve|run|prod)(:|$)/i },
  { category: 'build', re: /(build|compile|bundle|dist|package|prepare|prepublish)/i },
  { category: 'deploy', re: /(deploy|publish|release|ship)/i },
];

export function categoriseScript(name: string): ScriptCategory {
  for (const { category, re } of SCRIPT_CATEGORIES) if (re.test(name)) return category;
  return 'other';
}

function collectScripts(manifests: ManifestInfo[]): ManifestScript[] {
  const scripts: ManifestScript[] = [];
  for (const manifest of manifests) {
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      if (typeof command !== 'string' || !command.trim()) continue;
      // Skip lifecycle noise that says nothing about how the project works.
      if (/^(pre|post)?(install|prepare|uninstall|prepublishOnly)$/i.test(name) && /^(husky|is-ci|only-allow)/.test(command)) continue;
      scripts.push({ manifest: manifest.path, name, command: command.trim(), category: categoriseScript(name) });
    }
  }
  return scripts;
}

/** First script in a category wins, preferring the shallowest manifest. */
function firstScript(scripts: ManifestScript[], category: ScriptCategory): string | undefined {
  const match = scripts.find((script) => script.category === category);
  return match ? `${match.name}: ${match.command}` : undefined;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface OpsInput {
  files: OpsFileInput[];
  manifests: ManifestInfo[];
}

/**
 * Whether a path belongs to tests or fixtures.
 *
 * Segment-aware rather than a loose substring test, because `src/core/analysis/tests.ts`
 * is a source file about tests and must not be mistaken for one.
 */
export /**
 * Environment variables a program reads, across the languages this analysis
 * understands.
 *
 * Deliberately broader than `extractEnvKeys`, which exists to derive *external
 * dependencies* and therefore only keeps names that hint at a service. A port or
 * a log level is not a dependency, but it is configuration somebody has to set,
 * and leaving it out made the configuration surface quietly incomplete.
 */
const ENV_ACCESSORS: RegExp[] = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
  /os\.environ\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
  /os\.environ\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  /os\.getenv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  /os\.Getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\)/g,
  /ENV\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
  /System\.getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\)/g,
  /Environment\.GetEnvironmentVariable\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\)/g,
  /getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g,
  /\$_ENV\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
];

/** Names that describe the shell the process happens to run in, not the app. */
const ENV_RUNTIME_NOISE = new Set([
  'PATH',
  'HOME',
  'PWD',
  'OLDPWD',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TERM',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'SHLVL',
  'USER',
  'HOSTNAME',
  'COLUMNS',
  'LINES',
]);

export function extractConfiguredEnv(text: string, filePath: string): string[] {
  const found = new Set<string>();
  const consider = (raw: string) => {
    const name = raw.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || name.length > 64) return;
    if (ENV_RUNTIME_NOISE.has(name)) return;
    found.add(name);
  };

  if (/(^|\/)\.env|(^|\/)env\.(example|sample|template)$/i.test(filePath) || /\.env/.test(filePath)) {
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match) consider(match[1]);
    }
  }
  if (/\.(sh|bash|zsh)$/.test(filePath) || /^#!.*\b(sh|bash|zsh)\b/.test(text.slice(0, 200))) {
    for (const match of text.matchAll(/^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=/gm)) consider(match[1]);
  }
  for (const pattern of ENV_ACCESSORS) {
    // Fresh regex per use: a shared /g/ regex carries lastIndex between calls.
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) consider(match[1]);
  }
  return [...found];
}

/** How many places a file reads configuration from the environment. */
export function countConfiguredEnvAccesses(text: string): number {
  let count = 0;
  for (const pattern of ENV_ACCESSORS) {
    for (const _match of text.matchAll(new RegExp(pattern.source, pattern.flags))) count += 1;
  }
  return count;
}

export function isTestOrFixturePath(path: string): boolean {
  const segments = path.split('/');
  const file = segments[segments.length - 1] ?? '';
  if (segments.slice(0, -1).some((segment) => /^(tests?|specs?|__tests__|fixtures?|__mocks__|e2e)$/i.test(segment))) return true;
  if (/\.(test|spec)\.[a-z]+$/i.test(file)) return true;
  if (/^(test_|test-|spec_|spec-|fixture)/i.test(file)) return true;
  return /[._-](tests?|specs?|fixtures?)\.[a-z]+$/i.test(file);
}

export function computeOperationalSurface(input: OpsInput): OperationalSurface {
  const warnings: string[] = [];
  const ci: CiWorkflow[] = [];
  const containers: ContainerImage[] = [];
  const compose: ComposeFile[] = [];
  const infra: InfraFile[] = [];
  const envFiles = new Map<string, Set<string>>();

  for (const file of input.files) {
    if (file.text === null) continue;
    if (file.text.length > MAX_OPS_BYTES) {
      warnings.push(`${file.path} was skipped: too large to read as configuration.`);
      continue;
    }
    const text = file.text;

    if (isCiPath(file.path)) {
      const workflow = parseCiWorkflow(file.path, text);
      if (workflow) {
        ci.push(workflow);
        continue;
      }
      warnings.push(`${file.path} looks like a CI definition but could not be parsed.`);
      continue;
    }
    if (isDockerfilePath(file.path)) {
      containers.push(parseDockerfile(file.path, text));
      continue;
    }
    if (isComposePath(file.path)) {
      const parsed = parseCompose(file.path, text);
      if (parsed) compose.push(parsed);
      else warnings.push(`${file.path} looks like a compose file but could not be parsed.`);
      continue;
    }
    const infraFile = parseInfraFile(file.path, text);
    if (infraFile) {
      infra.push(infraFile);
      continue;
    }
    for (const name of extractConfiguredEnv(text, file.path)) {
      const files = envFiles.get(name) ?? new Set<string>();
      files.add(file.path);
      envFiles.set(name, files);
    }
  }

  const scripts = collectScripts(input.manifests);

  const ports = [...new Set([...containers.flatMap((c) => c.exposedPorts), ...compose.flatMap((c) => c.services.flatMap((s) => s.ports.map((p) => Number.parseInt(p.split(':')[0], 10)))).filter((n) => Number.isFinite(n))])]
    .filter((port) => port > 0 && port < 65_536)
    .sort((a, b) => a - b);

  const gating = ci.filter((workflow) => workflow.gating);
  // Prefer the workflow with the most commands: a repo often has several, and the
  // substantial one is the real gate rather than the one that only lints a title.
  const gate = [...(gating.length > 0 ? gating : ci)].sort((a, b) => b.commands.length - a.commands.length)[0];

  const deployTargets: string[] = [...new Set(infra.map((file) => file.format))].sort();
  if (containers.length > 0) deployTargets.unshift('container');
  if (compose.length > 0) deployTargets.unshift('compose');

  const summary: OpsSummary = {
    test: firstScript(scripts, 'test'),
    typecheck: firstScript(scripts, 'typecheck'),
    lint: firstScript(scripts, 'lint'),
    build: firstScript(scripts, 'build'),
    start: firstScript(scripts, 'start'),
    dev: firstScript(scripts, 'dev'),
    deploy: firstScript(scripts, 'deploy'),
    ciGate: gate && gate.commands.length > 0 ? gate.commands.slice(0, 8).join(' && ') : undefined,
    ciWorkflow: gate?.path,
    entrypoint: containers.find((c) => c.entrypoint || c.cmd)
      ? [containers.find((c) => c.entrypoint)?.entrypoint, containers.find((c) => c.cmd)?.cmd].filter(Boolean).join(' ')
      : undefined,
    ports,
    deployTargets,
  };

  // The configuration surface: names declared anywhere a reader would have to
  // set them to run the thing, not just the ones the code reads.
  for (const container of containers) {
    for (const name of container.declaredEnv) {
      const files = envFiles.get(name) ?? new Set<string>();
      files.add(container.path);
      envFiles.set(name, files);
    }
  }
  for (const file of compose) {
    for (const service of file.services) {
      for (const name of service.environment) {
        const files = envFiles.get(name) ?? new Set<string>();
        files.add(file.path);
        envFiles.set(name, files);
      }
    }
  }

  const envVars: EnvVar[] = [...envFiles.entries()]
    .map(([name, files]) => {
      const sorted = [...files].sort((a, b) => a.localeCompare(b));
      // A variable that appears only in a fixture is not something anyone has to
      // set to deploy, and presenting it as configuration would be misleading.
      const real = sorted.filter((file) => !isTestOrFixturePath(file));
      return { name, files: sorted, primaryFile: real[0] ?? sorted[0], testOnly: real.length === 0 };
    })
    .sort((a, b) => Number(a.testOnly) - Number(b.testOnly) || a.name.localeCompare(b.name));

  return { ci, containers, compose, infra, scripts, envVars, summary, warnings };
}

/**
 * A short, factual description of how the project runs and ships.
 *
 * Used by the digest and the explainer prompts so a leader's first question —
 * "how does this actually run?" — is answered from the repository's own
 * statements rather than guessed at.
 */
export function describeOperations(ops: OperationalSurface): string[] {
  const lines: string[] = [];
  const { summary } = ops;

  if (summary.ciWorkflow && summary.ciGate) {
    lines.push(`CI: ${summary.ciWorkflow} runs ${summary.ciGate}`);
  } else if (ops.ci.length === 0) {
    lines.push('CI: no CI definitions found — nothing automatically verifies a change.');
  }
  const verify = [summary.typecheck && 'typecheck', summary.test && 'tests', summary.lint && 'lint'].filter(Boolean);
  if (verify.length > 0) lines.push(`Verification available: ${verify.join(', ')}.`);

  for (const container of ops.containers) {
    const parts = [container.path.includes('/') ? `Dockerfile ${container.path}` : 'Dockerfile'];
    if (container.baseImages.length > 0) parts.push(`base ${container.baseImages[0]}`);
    if (container.multiStage) parts.push(`${container.stages.length}-stage build`);
    if (container.exposedPorts.length > 0) parts.push(`exposes ${container.exposedPorts.join(', ')}`);
    const start = container.entrypoint ?? container.cmd;
    if (start) parts.push(`starts with \`${start}\``);
    if (container.runsAsRoot) parts.push('runs as root (no USER)');
    lines.push(parts.join('; '));
  }
  for (const file of ops.compose) {
    const services = file.services.map((s) => `${s.name}${s.image ? ` (${s.image})` : ''}`);
    if (services.length > 0) lines.push(`Compose ${file.path}: ${services.join(', ')}`);
  }
  for (const file of ops.infra) {
    if (file.resources.length === 0) continue;
    const counts = new Map<string, number>();
    for (const resource of file.resources) counts.set(resource.kind, (counts.get(resource.kind) ?? 0) + 1);
    const described = [...counts.entries()].map(([kind, count]) => (count > 1 ? `${count}× ${kind}` : kind));
    lines.push(`${file.format} ${file.path}: ${described.slice(0, 8).join(', ')}`);
  }
  const images = [...new Set(ops.infra.flatMap((file) => file.images))];
  if (images.length > 0) lines.push(`Deployed images: ${images.slice(0, 6).join(', ')}`);
  const realEnv = ops.envVars.filter((entry) => !entry.testOnly);
  if (realEnv.length > 0) {
    lines.push(`Configuration is read from ${realEnv.length} environment variable(s), including ${realEnv.slice(0, 6).map((v) => v.name).join(', ')}.`);
  }
  const fixtureEnv = ops.envVars.length - realEnv.length;
  if (fixtureEnv > 0) lines.push(`${fixtureEnv} further variable(s) appear only in tests or fixtures.`);
  return lines;
}
