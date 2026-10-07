import { describe, expect, it } from 'vitest';
import { computeGaps, describeGaps } from '../src/core/analysis/gaps.js';
import type { GapsInput } from '../src/core/analysis/gaps.js';
import { EMPTY_COMPLEXITY } from '../src/core/analysis/complexity.js';
import { EMPTY_DATA_MODEL } from '../src/core/analysis/contracts.js';
import type { OperationalSurface } from '../src/core/analysis/ops.js';
import type { TestCoverage } from '../src/core/analysis/tests.js';

/**
 * The negative-space report makes claims about things that are not there, which
 * is the easiest kind of claim to get wrong. These tests are about the two rules
 * the module holds itself to: never report an absence in a dimension the project
 * does not have, and never report one that the facts do not support.
 */

const emptyOps = (overrides: Partial<OperationalSurface> = {}): OperationalSurface => ({
  ci: [],
  containers: [],
  compose: [],
  infra: [],
  scripts: [],
  envVars: [],
  summary: { ports: [], deployTargets: [] },
  warnings: [],
  ...overrides,
});

const emptyTests = (overrides: Partial<TestCoverage> = {}): TestCoverage => ({
  summary: { sourceFiles: 40, referenced: 40, reachable: 40, testFiles: 10, testLoc: 500, sourceLoc: 4000, percentReferenced: 100, percentReachable: 100 },
  testsReachingNothing: [],
  untested: [],
  components: [],
  riskyGaps: [],
  ...overrides,
});

const base = (overrides: Partial<GapsInput> = {}): GapsInput => ({
  files: [{ path: 'src/a.ts', category: 'source' }],
  ops: emptyOps(),
  tests: emptyTests(),
  dataModel: EMPTY_DATA_MODEL,
  complexity: EMPTY_COMPLEXITY,
  components: [],
  dependencies: [],
  routes: [],
  readme: 'a readme',
  deadCode: [],
  sources: [],
  sourceLoc: 4000,
  ...overrides,
});

const ids = (input: GapsInput) => computeGaps(input).gaps.map((gap) => gap.id);

describe('not claiming an absence that does not apply', () => {
  it('stays quiet about migrations when there is no database at all', () => {
    const found = ids(base());
    expect(found).not.toContain('schema');
    expect(found).not.toContain('migrations');
  });

  it('stays quiet about containers when there are none to check', () => {
    expect(ids(base())).not.toContain('container-healthcheck');
  });

  it('stays quiet about route handlers when there are no routes', () => {
    expect(ids(base())).not.toContain('handler-errors');
  });

  it('stays quiet about tests for a repository too small to judge', () => {
    const small = base({ tests: emptyTests({ summary: { ...emptyTests().summary, testFiles: 0 } }), sourceLoc: 120 });
    expect(ids(small)).not.toContain('tests');
  });
});

describe('each finding is derived from a fact', () => {
  it('reports missing CI with its evidence', () => {
    const gap = computeGaps(base()).gaps.find((entry) => entry.id === 'ci');
    expect(gap?.weight).toBe('high');
    expect(gap?.evidence.join(' ')).toContain('No CI definition');
  });

  it('reports CI that does not run the tests it has', () => {
    const ops = emptyOps({
      ci: [{ path: '.github/workflows/ci.yml', name: 'CI', triggers: ['push'], jobs: [], commands: ['npm run lint'], actions: [], gating: true }],
      scripts: [{ manifest: 'package.json', name: 'test', command: 'vitest run', category: 'test' }],
    });
    const gap = computeGaps(base({ ops })).gaps.find((entry) => entry.id === 'ci-runs-tests');
    expect(gap?.title).toContain('does not appear to run the tests');
    expect(gap?.evidence.join(' ')).toContain('vitest run');
  });

  it('accepts CI that does run them, in either form', () => {
    const viaScript = emptyOps({
      ci: [{ path: 'ci.yml', name: 'CI', triggers: ['push'], jobs: [], commands: ['npm test'], actions: [], gating: true }],
      scripts: [{ manifest: 'package.json', name: 'test', command: 'vitest run', category: 'test' }],
    });
    expect(ids(base({ ops: viaScript }))).not.toContain('ci-runs-tests');

    const viaRunner = emptyOps({
      ci: [{ path: 'ci.yml', name: 'CI', triggers: ['push'], jobs: [], commands: ['npx vitest run'], actions: [], gating: true }],
      scripts: [{ manifest: 'package.json', name: 'test', command: 'vitest run', category: 'test' }],
    });
    expect(ids(base({ ops: viaRunner }))).not.toContain('ci-runs-tests');
  });

  it('names the hardest untested functions, with their numbers', () => {
    const complexity = {
      ...EMPTY_COMPLEXITY,
      symbols: [
        { id: 'a', path: 'src/big.ts', name: 'risky', kind: 'function', line: 10, loc: 40, branches: 30, maxDepth: 5, callers: 12, reachable: true, score: 200 },
        { id: 'b', path: 'src/covered.ts', name: 'safe', kind: 'function', line: 1, loc: 5, branches: 40, maxDepth: 1, callers: 1, reachable: true, score: 50 },
      ],
    };
    const tests = emptyTests({ untested: [{ path: 'src/big.ts', loc: 40, symbols: 1, component: 'core' }] });
    const gap = computeGaps(base({ complexity, tests })).gaps.find((entry) => entry.id === 'untested-complexity');
    expect(gap?.title).toContain('hardest function');
    expect(gap?.evidence.join(' ')).toContain('risky');
    // The well-covered but branchier function must not be named.
    expect(gap?.evidence.join(' ')).not.toContain('safe');
  });

  it('reports a store with no declared schema', () => {
    const gap = computeGaps(base({ dataModel: { ...EMPTY_DATA_MODEL, summary: { ...EMPTY_DATA_MODEL.summary, stores: ['PostgreSQL'] } } })).gaps.find(
      (entry) => entry.id === 'schema',
    );
    expect(gap?.title).toContain('PostgreSQL');
    expect(gap?.detail).toContain('another repository');
  });

  it('reports unpinned dependencies', () => {
    const ops = emptyOps({ scripts: [{ manifest: 'package.json', name: 'start', command: 'node .', category: 'start' }] });
    const gap = computeGaps(base({ ops, files: [{ path: 'package.json', category: 'config' }] })).gaps.find((entry) => entry.id === 'lockfile');
    expect(gap).toBeDefined();
    // A lockfile present satisfies it.
    const pinned = computeGaps(base({ ops, files: [{ path: 'package.json', category: 'config' }, { path: 'package-lock.json', category: 'config' }] }));
    expect(pinned.gaps.map((entry) => entry.id)).not.toContain('lockfile');
  });

  it('reports undocumented configuration only when there is enough of it', () => {
    const many = emptyOps({
      envVars: Array.from({ length: 5 }, (_, i) => ({ name: `VAR_${i}`, files: ['src/config.ts'], primaryFile: 'src/config.ts', testOnly: false })),
    });
    expect(ids(base({ ops: many }))).toContain('env-example');

    const few = emptyOps({
      envVars: Array.from({ length: 2 }, (_, i) => ({ name: `VAR_${i}`, files: ['src/config.ts'], primaryFile: 'src/config.ts', testOnly: false })),
    });
    expect(ids(base({ ops: few }))).not.toContain('env-example');

    // Test-only variables are not configuration anyone has to set.
    const onlyTests = emptyOps({
      envVars: Array.from({ length: 5 }, (_, i) => ({ name: `VAR_${i}`, files: ['tests/a.ts'], primaryFile: 'tests/a.ts', testOnly: true })),
    });
    expect(ids(base({ ops: onlyTests }))).not.toContain('env-example');
  });

  it('reports handlers with no visible error handling, with the caveat stated', () => {
    const routes = [
      { id: 'a', method: 'GET', path: '/a', file: 'src/r.ts', line: 2, handler: 'h', handlerId: null, framework: 'express' },
      { id: 'b', method: 'POST', path: '/b', file: 'src/r.ts', line: 10, handler: 'safe', handlerId: null, framework: 'express' },
    ] as unknown as GapsInput['routes'];
    const sources = [{ path: 'src/r.ts', text: 'const app = express();\napp.get("/a", (req, res) => {\n  res.json(1);\n});\n\n\n\n\n\napp.post("/b", (req, res) => {\n  try { res.json(1); } catch (e) { res.status(500).end(); }\n});\n' }];
    const gap = computeGaps(base({ routes, sources })).gaps.find((entry) => entry.id === 'handler-errors');
    expect(gap?.title).toContain('1 route handler');
    expect(gap?.evidence.join(' ')).toContain('GET /a');
    expect(gap?.evidence.join(' ')).not.toContain('/b');
    // The caveat must be present: this is a reading of the handler's opening.
    expect(gap?.detail).toContain('middleware');
  });

  it('reports every satisfied expectation so the report is balanced', () => {
    const report = computeGaps(base());
    expect(report.summary.checked).toBe(report.summary.absent + report.summary.met);
    expect(report.met.map((item) => item.id)).toContain('tests');
    expect(report.met.map((item) => item.id)).toContain('readme');
  });

  it('orders findings by how much they usually matter', () => {
    const report = computeGaps(base());
    const order = { high: 0, medium: 1, low: 2 };
    const weights = report.gaps.map((gap) => order[gap.weight]);
    expect([...weights].sort((a, b) => a - b)).toEqual(weights);
  });

  it('describes itself for the digest, and says so when nothing is absent', () => {
    const ops = emptyOps({
      ci: [{ path: 'ci.yml', name: 'CI', triggers: ['push'], jobs: [], commands: ['npm test'], actions: [], gating: true }],
      containers: [{ path: 'Dockerfile', stages: [{ name: '#1', base: 'node:20', line: 1 }], baseImages: ['node:20'], exposedPorts: [], buildArgs: [], healthcheck: true, runsAsRoot: false, multiStage: false, cachesDependencies: true, declaredEnv: [] }],
      infra: [{ path: 'k8s/d.yaml', format: 'kubernetes', resources: [{ kind: 'Deployment', name: 'x', line: 1 }], images: [] }],
      scripts: [
        { manifest: 'package.json', name: 'test', command: 'vitest run', category: 'test' },
        { manifest: 'package.json', name: 'typecheck', command: 'tsc', category: 'typecheck' },
      ],
    });
    const report = computeGaps(
      base({
        ops,
        // A deployed service with no observability dependency is its own finding,
        // so it has to be present for this fixture to have no gaps at all.
        dependencies: [{ name: 'pino', category: 'observability', kind: 'runtime', evidence: ['src/log.ts'], references: 3 } as never],
        files: [
          { path: 'LICENSE', category: 'docs' },
          { path: 'package-lock.json', category: 'config' },
          { path: '.env.example', category: 'config' },
        ],
      }),
    );
    expect(report.gaps).toEqual([]);
    expect(describeGaps(report).join(' ')).toContain('Nothing notable is absent');
  });
});
