/**
 * Negative space: what the repository does not say about itself.
 *
 * Every other analysis here describes what is present. This one looks at what is
 * absent, which is harder and often more useful — a missing migration or an
 * untested payment path is invisible in a list of what exists, and it is exactly
 * what an incoming leader needs to know.
 *
 * Two rules govern everything in this file:
 *
 * 1. **Only report an absence that is derivable from a fact we hold.** "No tests
 *    reach this file" is derived from the coverage graph. "This is insecure" is
 *    not derivable and is never said.
 * 2. **Phrase it as a question, not a verdict.** A repository can have no CI for
 *    excellent reasons. The output says what is not there and why someone might
 *    care, and leaves the judgement to the reader.
 */
import type { ComplexityReport } from './complexity.js';
import type { DataModelReport } from './contracts.js';
import type { OperationalSurface } from './ops.js';
import type { TestCoverage } from './tests.js';
import type { Component, ExternalDependency, Route } from '../types.js';

export type GapWeight = 'high' | 'medium' | 'low';

export interface Gap {
  id: string;
  /** What is absent, stated as a fact. */
  title: string;
  /** Why someone might care, phrased as a question. */
  detail: string;
  /** The facts this is derived from, with numbers. */
  evidence: string[];
  weight: GapWeight;
  /** Where to look. */
  paths: string[];
}

export interface GapsReport {
  gaps: Gap[];
  /** Expectations that were satisfied, so the report reads as balanced. */
  met: { id: string; title: string }[];
  summary: { checked: number; absent: number; met: number };
  warnings: string[];
}

export interface GapsInput {
  files: { path: string; category: string }[];
  ops: OperationalSurface;
  tests: TestCoverage;
  dataModel: DataModelReport;
  complexity: ComplexityReport;
  components: Component[];
  dependencies: ExternalDependency[];
  routes: Route[];
  readme: string | null;
  deadCode: { name: string; path: string }[];
  /** Files whose text is needed to inspect handler bodies. */
  sources: { path: string; text: string }[];
  /** Total lines of source, used to decide whether a check is meaningful. */
  sourceLoc: number;
}

export const EMPTY_GAPS: GapsReport = {
  gaps: [],
  met: [],
  summary: { checked: 0, absent: 0, met: 0 },
  warnings: [],
};

const LOCKFILE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|packages\.lock\.json)$/i;

/** A check that either found something missing or found the expectation met. */
interface Check {
  id: string;
  title: string;
  run: (input: GapsInput) => Gap | { met: true } | null;
}

/**
 * The checks, in the order a reader would want them.
 *
 * A check returns null when it does not apply at all — a repository with no
 * database cannot be missing a migration — so the report never claims an absence
 * in a dimension the project does not have.
 */
const CHECKS: Check[] = [
  {
    id: 'ci',
    title: 'nothing runs automatically on a change',
    run: ({ ops }) => {
      if (ops.ci.length > 0) return { met: true };
      return {
        id: 'ci',
        title: 'There is no CI configuration.',
        detail:
          'Nothing runs automatically when a change is pushed, so every check is one a person has to remember to run. Worth asking whether that is a decision or an oversight.',
        evidence: ['No CI definition was found in any of the layouts checked, including .github/workflows, GitLab, CircleCI and Jenkins.'],
        weight: 'high',
        paths: [],
      };
    },
  },
  {
    id: 'ci-runs-tests',
    title: 'CI runs the tests',
    run: ({ ops }) => {
      if (ops.ci.length === 0) return null;
      const testScript = ops.scripts.find((script) => script.category === 'test');
      if (!testScript) return null;
      const commands = ops.ci.flatMap((workflow) => workflow.commands).join('\n');
      // Match the script's own name, or a direct runner invocation.
      const runner = /^([a-z]+)\s/.exec(testScript.command)?.[1] ?? testScript.command.split(/\s+/)[0];
      if (new RegExp(`\\b${testScript.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(commands) || commands.includes(runner)) {
        return { met: true };
      }
      return {
        id: 'ci-runs-tests',
        title: 'CI does not appear to run the tests.',
        detail:
          'A test command exists but no CI step calls it, so a failing test may not block a merge. It is worth confirming whether the tests run somewhere else.',
        evidence: [
          `The project defines \`${testScript.name}\`: ${testScript.command}.`,
          `CI runs: ${ops.ci.flatMap((workflow) => workflow.commands).slice(0, 6).join(', ')}.`,
        ],
        weight: 'high',
        paths: ops.ci.map((workflow) => workflow.path),
      };
    },
  },
  {
    id: 'tests',
    title: 'the codebase has tests',
    run: ({ tests, sourceLoc }) => {
      if (tests.summary.testFiles > 0) return { met: true };
      if (sourceLoc < 200) return null;
      return {
        id: 'tests',
        title: 'No test files were found.',
        detail:
          'Nothing here verifies that the code does what it claims, so the only way to know is to read it or run it. Every correctness claim in an explanation of this repository is a claim about intent.',
        evidence: [`${tests.summary.sourceFiles} source files and ${sourceLoc.toLocaleString()} lines were analysed.`],
        weight: 'high',
        paths: [],
      };
    },
  },
  {
    id: 'untested-complexity',
    title: 'tests reach the most complex code',
    run: ({ complexity, tests }) => {
      if (complexity.symbols.length === 0) return null;
      const untested = new Set(tests.untested.map((file) => file.path));
      const exposed = complexity.symbols.filter((symbol) => untested.has(symbol.path)).slice(0, 6);
      if (exposed.length === 0) return { met: true };
      return {
        id: 'untested-complexity',
        title: `The ${exposed.length} hardest function${exposed.length === 1 ? '' : 's'} to change safely ${exposed.length === 1 ? 'has' : 'have'} no test reaching ${exposed.length === 1 ? 'it' : 'them'}.`,
        detail:
          'These are the definitions with the most decision points and the most callers, and nothing verifies them. That combination is where a change is most likely to break something quietly.',
        evidence: exposed.map((symbol) => `\`${symbol.name}\` — ${symbol.branches} decision points, ${symbol.callers} caller(s), ${symbol.path}:${symbol.line}`),
        weight: 'high',
        paths: exposed.map((symbol) => symbol.path),
      };
    },
  },
  {
    id: 'deployment',
    title: 'there is a stated way to run it',
    run: ({ ops }) => {
      if (ops.containers.length > 0 || ops.compose.length > 0 || ops.infra.length > 0) return { met: true };
      return {
        id: 'deployment',
        title: 'Nothing states how this is deployed.',
        detail:
          'There is no container definition, compose file or infrastructure manifest, so how this reaches production is not recorded here. Worth asking before you need to know in a hurry.',
        evidence: ['No Dockerfile, compose file, Kubernetes, Terraform or other infrastructure manifest was found.'],
        weight: 'medium',
        paths: [],
      };
    },
  },
  {
    id: 'container-healthcheck',
    title: 'the container reports its own health',
    run: ({ ops }) => {
      const without = ops.containers.filter((container) => !container.healthcheck);
      if (ops.containers.length === 0) return null;
      if (without.length === 0) return { met: true };
      return {
        id: 'container-healthcheck',
        title: `${without.length} container definition(s) declare no healthcheck.`,
        detail: 'Without one, an orchestrator can only tell whether the process is running, not whether it is working.',
        evidence: without.map((container) => `\`${container.path}\` — no HEALTHCHECK instruction`),
        weight: 'low',
        paths: without.map((container) => container.path),
      };
    },
  },
  {
    id: 'schema',
    title: 'the stored data has a declared shape',
    run: ({ dataModel }) => {
      if (dataModel.summary.tables > 0) return { met: true };
      if (dataModel.summary.stores.length === 0) return null;
      return {
        id: 'schema',
        title: `A store is used (${dataModel.summary.stores.join(', ')}) but no table or model is declared here.`,
        detail:
          'The schema may live in another repository or be managed outside the codebase. It is worth knowing which, because it decides where a data change has to be made.',
        evidence: [`Storage named in the code: ${dataModel.summary.stores.join(', ')}.`, 'No SQL schema, ORM model or API definition declaring stored data was found.'],
        weight: 'high',
        paths: [],
      };
    },
  },
  {
    id: 'migrations',
    title: 'schema changes are recorded',
    run: ({ dataModel }) => {
      if (dataModel.summary.tables === 0) return null;
      if (dataModel.summary.migrations > 0) return { met: true };
      return {
        id: 'migrations',
        title: `${dataModel.summary.tables} table(s)/model(s) are declared, but no migration or schema file is present.`,
        detail:
          'There is nowhere in this repository that records how the shape of the data got to where it is, so a schema change has no history to follow and no obvious place to add one.',
        evidence: [`Declared: ${dataModel.schemas.filter((schema) => schema.kind === 'table' || schema.kind === 'model').slice(0, 8).map((schema) => schema.name).join(', ')}.`],
        weight: 'medium',
        paths: [],
      };
    },
  },
  {
    id: 'lockfile',
    title: 'dependencies are pinned',
    run: ({ files, ops }) => {
      const hasManifest = ops.scripts.length > 0 || ops.envVars.length > 0 || files.some((file) => /(^|\/)(package\.json|requirements\.txt|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/i.test(file.path));
      if (!hasManifest) return null;
      if (files.some((file) => LOCKFILE_RE.test(file.path))) return { met: true };
      return {
        id: 'lockfile',
        title: 'There is no lockfile.',
        detail: 'Dependency versions are not pinned, so two installs of the same commit can produce different code. Worth asking how reproducibility is handled.',
        evidence: ['A package or build manifest was found, but no lockfile alongside it.'],
        weight: 'medium',
        paths: [],
      };
    },
  },
  {
    id: 'env-example',
    title: 'required configuration is documented',
    run: ({ files, ops }) => {
      const required = ops.envVars.filter((entry) => !entry.testOnly);
      if (required.length < 3) return null;
      if (files.some((file) => /(^|\/)\.env\.(example|sample|template|dist)$/i.test(file.path) || /(^|\/)env\.(example|sample|template)$/i.test(file.path))) return { met: true };
      return {
        id: 'env-example',
        title: `${required.length} environment variables are read, and no example file documents them.`,
        detail: 'Setting this up means reading the source to find out what it expects. A committed example file is the usual answer.',
        evidence: [`Read in code: ${required.slice(0, 10).map((entry) => entry.name).join(', ')}${required.length > 10 ? ` (+${required.length - 10} more)` : ''}.`],
        weight: 'medium',
        paths: required.slice(0, 6).map((entry) => entry.primaryFile),
      };
    },
  },
  {
    id: 'readme',
    title: 'there is a README',
    run: ({ readme }) => (readme ? { met: true } : {
      id: 'readme',
      title: 'There is no README.',
      detail: 'Nothing in the repository states its purpose in prose, so the only description of what it is for has to be reconstructed from the code.',
      evidence: ['No README file was found at the repository root.'],
      weight: 'low',
      paths: [],
    }),
  },
  {
    id: 'license',
    title: 'there is a licence',
    run: ({ files }) => {
      if (files.some((file) => /(^|\/)(LICEN[CS]E|COPYING|UNLICENSE)(\.(md|txt))?$/i.test(file.path))) return { met: true };
      return {
        id: 'license',
        title: 'There is no licence file.',
        detail: 'Without one, the legal terms of using this code are unstated, which matters the moment anyone outside the team needs to know.',
        evidence: ['No LICENSE, COPYING or UNLICENCE file was found.'],
        weight: 'low',
        paths: [],
      };
    },
  },
  {
    id: 'static-checks',
    title: 'the project checks its own code',
    run: ({ ops }) => {
      const has = ops.scripts.some((script) => script.category === 'typecheck') || ops.scripts.some((script) => script.category === 'lint');
      if (has) return { met: true };
      if (ops.scripts.length === 0) return null;
      return {
        id: 'static-checks',
        title: 'No typecheck or lint script is declared.',
        detail: 'The project has no stated way to catch a mistake before a reviewer or a user does.',
        evidence: [`Declared scripts: ${ops.scripts.map((script) => script.name).slice(0, 10).join(', ')}.`],
        weight: 'medium',
        paths: ops.scripts.slice(0, 3).map((script) => script.manifest),
      };
    },
  },
  {
    id: 'handler-errors',
    title: 'request handlers handle failure',
    run: ({ routes, sources }) => {
      if (routes.length === 0) return null;
      const byPath = new Map(sources.map((source) => [source.path, source.text]));
      // Read only up to the next handler in the same file. A fixed 40-line window
      // ran into the following route's error handling and made a handler with no
      // handling of its own look handled.
      const nextLine = new Map<string, number>();
      const ordered = [...routes].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
      for (let index = 0; index < ordered.length; index += 1) {
        const route = ordered[index];
        const next = ordered[index + 1];
        if (next && next.file === route.file) nextLine.set(`${route.file}:${route.line}`, next.line);
      }
      // Only handlers whose body we can actually read are judged.
      const exposed = routes
        .filter((route) => route.handler && byPath.has(route.file))
        .filter((route) => {
          const text = byPath.get(route.file) as string;
          const lines = text.split('\n');
          const start = Math.max(0, route.line - 1);
          const boundary = nextLine.get(`${route.file}:${route.line}`);
          const end = boundary ? Math.min(lines.length, boundary - 1) : Math.min(lines.length, start + 40);
          const body = lines.slice(start, end).join('\n');
          return !/\b(try|catch|\.catch\s*\(|reject|throw)\b/.test(body);
        })
        .slice(0, 6);
      if (exposed.length === 0) return { met: true };
      return {
        id: 'handler-errors',
        title: `${exposed.length} route handler(s) show no error handling in their first lines.`,
        detail:
          'This is a reading of the start of each handler, not a guarantee — the handling may sit in middleware. Worth confirming how a failure in these paths reaches the caller.',
        evidence: exposed.map((route) => `${route.method} ${route.path} → ${route.handler} (${route.file}:${route.line})`),
        weight: 'medium',
        paths: exposed.map((route) => route.file),
      };
    },
  },
  {
    id: 'observability',
    title: 'there is somewhere for logs and metrics to go',
    run: ({ dependencies, ops, routes }) => {
      // Only worth raising for something that actually runs somewhere: a library
      // or a script has no production output to look at.
      const deployed = ops.containers.length + ops.infra.length + ops.compose.length > 0 || routes.length > 0;
      if (!deployed) return null;
      const found = dependencies.filter((dependency) => dependency.category === 'observability');
      if (found.length > 0) return { met: true };
      return {
        id: 'observability',
        title: 'No logging, metrics or tracing library is named.',
        detail:
          'When something goes wrong in production there may be nothing to look at beyond the process output. Worth asking where you would look first.',
        evidence: ['No dependency in the observability category was found.'],
        weight: 'low',
        paths: [],
      };
    },
  },
  {
    id: 'orphans',
    title: 'there is little or no unreachable code',
    run: ({ deadCode, complexity }) => {
      if (complexity.symbols.length === 0) return null;
      if (deadCode.length < 5) return { met: true };
      return {
        id: 'orphans',
        title: `${deadCode.length} definitions are unreachable from any entrypoint.`,
        detail:
          'Reachability is derived from resolved calls, so this is a question to investigate rather than proof. Some of it will be entrypoints the analysis did not recognise.',
        evidence: deadCode.slice(0, 8).map((item) => `\`${item.name}\` (${item.path})`),
        weight: 'low',
        paths: deadCode.slice(0, 6).map((item) => item.path),
      };
    },
  },
];

export function computeGaps(input: GapsInput): GapsReport {
  const gaps: Gap[] = [];
  const met: { id: string; title: string }[] = [];
  for (const check of CHECKS) {
    let result: Gap | { met: true } | null = null;
    try {
      result = check.run(input);
    } catch {
      // A check that cannot answer must not take the report down with it.
      continue;
    }
    if (!result) continue;
    if ('met' in result) met.push({ id: check.id, title: check.title });
    else gaps.push(result);
  }

  const rank: Record<GapWeight, number> = { high: 0, medium: 1, low: 2 };
  gaps.sort((a, b) => rank[a.weight] - rank[b.weight] || a.id.localeCompare(b.id));

  return {
    gaps,
    met,
    summary: { checked: gaps.length + met.length, absent: gaps.length, met: met.length },
    warnings: [],
  };
}

/** The negative-space section of the digest. */
export function describeGaps(report: GapsReport): string[] {
  if (report.summary.checked === 0) return ['Nothing could be checked: the repository is too small or too unusual to draw conclusions from.'];
  const lines: string[] = [
    `${report.summary.met} of ${report.summary.checked} things a repository this size usually states are present.`,
  ];
  for (const gap of report.gaps) {
    lines.push(`- ABSENT: ${gap.title} ${gap.detail}`);
    for (const item of gap.evidence.slice(0, 4)) lines.push(`    evidence: ${item}`);
  }
  if (report.gaps.length === 0) lines.push('Nothing notable is absent.');
  return lines;
}
