import { describe, expect, it } from 'vitest';
import { classifyNameStyle, computeConventions } from '../src/core/analysis/conventions.js';
import type { ConventionInput } from '../src/core/analysis/conventions.js';

/**
 * Conventions are only worth stating if they are derived from the repository
 * rather than asserted at it, so these tests are mostly about the thresholds:
 * a pattern followed by three files is not a convention, and an exception in a
 * file that is not really a test is not an exception.
 */

const files = (...paths: string[]): ConventionInput['files'] =>
  paths.map((path) => ({ path, language: path.endsWith('.py') ? 'python' : 'typescript', category: /(^|\/)(tests?|__tests__)\//.test(path) || /\.test\./.test(path) ? 'test' : 'source' }));

const base = (overrides: Partial<ConventionInput> = {}): ConventionInput => ({
  files: [],
  imports: [],
  components: [],
  sources: [],
  ...overrides,
});

describe('name style classification', () => {
  it('recognises the four styles and rejects anything else', () => {
    expect(classifyNameStyle('check-staleness')).toBe('kebab');
    expect(classifyNameStyle('check_staleness')).toBe('snake');
    expect(classifyNameStyle('checkStaleness')).toBe('camel');
    expect(classifyNameStyle('CheckStaleness')).toBe('pascal');
    expect(classifyNameStyle('checkStaleness2')).toBe('camel');
    expect(classifyNameStyle('check.staleness')).toBe('other');
    expect(classifyNameStyle('CHECK')).toBe('other');
  });
});

describe('inferring a rule', () => {
  it('states a convention that the majority follows', () => {
    const report = computeConventions(
      base({ files: files('src/a/one.ts', 'src/a/two.ts', 'src/a/three.ts', 'src/a/four.ts', 'src/a/five.ts', 'src/a/six.ts') }),
    );
    const rule = report.rules.find((entry) => entry.id.startsWith('naming:'));
    expect(rule?.rule).toContain('camelCase');
    expect(rule?.adherence).toBe(1);
    expect(rule?.violations).toEqual([]);
  });

  it('reports the file that breaks a well-supported rule', () => {
    // Eight camelCase and one kebab-case: 89% adherence, so the rule holds and
    // the odd one out is named.
    const report = computeConventions(
      base({
        files: files(
          'src/a/one.ts',
          'src/a/two.ts',
          'src/a/three.ts',
          'src/a/four.ts',
          'src/a/five.ts',
          'src/a/six.ts',
          'src/a/seven.ts',
          'src/a/notCamel.ts',
          'src/a/also-camel.ts',
        ),
      }),
    );
    const rule = report.rules.find((entry) => entry.id.startsWith('naming:'));
    expect(rule?.violations.map((violation) => violation.path)).toEqual(['src/a/also-camel.ts']);
    expect(rule?.violations[0].detail).toContain('kebab-case');
  });

  it('does not report a rule that is only just a majority', () => {
    // Five of seven is 71%, below the threshold: worth mentioning, not a rule.
    const report = computeConventions(
      base({ files: files('src/a/one.ts', 'src/a/two.ts', 'src/a/three.ts', 'src/a/four.ts', 'src/a/five.ts', 'src/a/six-thing.ts', 'src/a/seven-thing.ts') }),
    );
    expect(report.rules.filter((rule) => rule.id.startsWith('naming:'))).toEqual([]);
    expect(report.weakPatterns.join(' ')).toContain('mixed');
  });

  it('does not invent a rule from too few files', () => {
    const report = computeConventions(base({ files: files('src/a/one.ts', 'src/a/two.ts') }));
    expect(report.rules.filter((rule) => rule.id.startsWith('naming:'))).toEqual([]);
  });

  it('calls a genuinely mixed directory a weak pattern rather than a rule', () => {
    const report = computeConventions(
      base({
        files: files(
          'src/a/one-thing.ts',
          'src/a/second-thing.ts',
          'src/a/third-thing.ts',
          'src/a/fourthThing.ts',
          'src/a/fifthThing.ts',
          'src/a/sixthThing.ts',
        ),
      }),
    );
    expect(report.rules.filter((rule) => rule.id.startsWith('naming:'))).toEqual([]);
    expect(report.weakPatterns.join(' ')).toContain('are mixed');
  });

  it('ignores structural names, which are not naming choices', () => {
    // `index.ts` must not make a camelCase directory look kebab-case.
    const report = computeConventions(
      base({ files: files('src/a/index.ts', 'src/a/one.ts', 'src/a/two.ts', 'src/a/three.ts', 'src/a/four.ts', 'src/a/five.ts') }),
    );
    const rule = report.rules.find((entry) => entry.id.startsWith('naming:'));
    expect(rule?.supporting).toBe(5);
  });

  it('keeps component and helper conventions apart in one directory', () => {
    const report = computeConventions(
      base({
        files: files(
          'src/web/Alpha.tsx',
          'src/web/Beta.tsx',
          'src/web/Gamma.tsx',
          'src/web/Delta.tsx',
          'src/web/Epsilon.tsx',
          'src/web/formatDate.ts',
          'src/web/parseArgs.ts',
          'src/web/renderHtml.ts',
          'src/web/buildTree.ts',
          'src/web/loadData.ts',
        ),
      }),
    );
    const rules = report.rules.filter((rule) => rule.id.startsWith('naming:'));
    expect(rules.map((rule) => (rule.rule.includes('PascalCase') ? 'pascal' : 'camel')).sort()).toEqual(['camel', 'pascal']);
    expect(rules.every((rule) => rule.violations.length === 0)).toBe(true);
  });
});

describe('test conventions', () => {
  it('derives placement and naming from the test files themselves', () => {
    const report = computeConventions(
      base({
        files: files(
          'tests/one.test.ts',
          'tests/two.test.ts',
          'tests/three.test.ts',
          'tests/four.test.ts',
          'tests/five.test.ts',
          'tests/six.test.ts',
        ),
      }),
    );
    expect(report.rules.find((rule) => rule.id === 'tests:placement')?.rule).toContain('under `tests/`');
    expect(report.rules.find((rule) => rule.id === 'tests:naming')?.rule).toContain('`*.test.*`');
  });

  it('does not count a helper under tests/ as a test', () => {
    // The regression: a fixture was counted as a test file that broke the naming
    // convention, producing a false exception.
    const report = computeConventions(
      base({
        files: files(
          'tests/one.test.ts',
          'tests/two.test.ts',
          'tests/three.test.ts',
          'tests/four.test.ts',
          'tests/five.test.ts',
          'tests/helpers/fixtureRepo.ts',
        ),
        testCaseFiles: new Set(['tests/one.test.ts', 'tests/two.test.ts', 'tests/three.test.ts', 'tests/four.test.ts', 'tests/five.test.ts']),
      }),
    );
    const naming = report.rules.find((rule) => rule.id === 'tests:naming');
    expect(naming?.supporting).toBe(5);
    expect(naming?.violations).toEqual([]);
  });

  it('reports the minority placement as an exception', () => {
    const report = computeConventions(
      base({
        files: files(
          'tests/a.test.ts',
          'tests/b.test.ts',
          'tests/c.test.ts',
          'tests/d.test.ts',
          'tests/e.test.ts',
          'tests/f.test.ts',
          'src/beside.test.ts',
        ),
      }),
    );
    const placement = report.rules.find((rule) => rule.id === 'tests:placement');
    expect(placement?.violations.map((violation) => violation.path)).toEqual(['src/beside.test.ts']);
  });
});

describe('dependency direction', () => {
  const components = [
    { id: 'core', name: 'core', files: ['src/core/a.ts', 'src/core/b.ts'] },
    { id: 'web', name: 'web', files: ['src/web/a.ts', 'src/web/b.ts'] },
  ];

  it('derives the rule from the majority direction and reports the back-edge', () => {
    const imports: ConventionInput['imports'] = [
      ...Array.from({ length: 6 }, () => ({ from: 'src/web/a.ts', to: 'src/core/a.ts' })),
      { from: 'src/core/b.ts', to: 'src/web/a.ts' },
    ];
    const report = computeConventions(base({ components, imports }));
    const rule = report.rules.find((entry) => entry.id.startsWith('layering:'));
    expect(rule?.rule).toContain('`web` depends on `core`');
    expect(rule?.violations).toHaveLength(1);
    expect(rule?.violations[0].path).toBe('src/core/b.ts');
    // The message must name what the file imports, not the component it is in.
    expect(rule?.violations[0].detail).toContain('`web`');
  });

  it('treats a mutual dependency as a weak pattern, not a broken rule', () => {
    const imports: ConventionInput['imports'] = [
      ...Array.from({ length: 5 }, () => ({ from: 'src/web/a.ts', to: 'src/core/a.ts' })),
      ...Array.from({ length: 4 }, () => ({ from: 'src/core/b.ts', to: 'src/web/a.ts' })),
    ];
    const report = computeConventions(base({ components, imports }));
    expect(report.rules.filter((rule) => rule.id.startsWith('layering:'))).toEqual([]);
    expect(report.weakPatterns.join(' ')).toContain('depend on each other');
  });

  it('ignores imports within one component', () => {
    const imports: ConventionInput['imports'] = Array.from({ length: 9 }, () => ({ from: 'src/core/a.ts', to: 'src/core/b.ts' }));
    expect(computeConventions(base({ components, imports })).rules.filter((rule) => rule.id.startsWith('layering:'))).toEqual([]);
  });

  it('ignores unresolved imports', () => {
    const imports: ConventionInput['imports'] = Array.from({ length: 9 }, () => ({ from: 'src/core/a.ts', to: null }));
    expect(computeConventions(base({ components, imports })).rules.filter((rule) => rule.id.startsWith('layering:'))).toEqual([]);
  });
});

describe('gatekeeper conventions', () => {
  it('finds the single door for configuration, and who bypasses it', () => {
    const sources = [
      { path: 'src/config.ts', text: Array.from({ length: 10 }, (_, i) => `const a${i} = process.env.VAR_${i};`).join('\n') },
      { path: 'src/other.ts', text: 'const x = process.env.ONE;' },
      { path: 'src/third.ts', text: 'const y = process.env.TWO;' },
      { path: 'src/fourth.ts', text: 'const z = process.env.THREE;' },
      { path: 'src/fifth.ts', text: 'const w = process.env.FOUR;' },
      { path: 'src/sixth.ts', text: 'const v = process.env.FIVE;' },
    ];
    const report = computeConventions(base({ sources }));
    const rule = report.rules.find((entry) => entry.id === 'config:single-door');
    expect(rule?.rule).toContain('`src/config.ts`');
    expect(rule?.violations.length).toBe(5);
  });

  it('says so plainly when there is no single door', () => {
    const sources = Array.from({ length: 6 }, (_, i) => ({ path: `src/f${i}.ts`, text: 'const x = process.env.A; const y = process.env.B;' }));
    const report = computeConventions(base({ sources }));
    expect(report.rules.find((entry) => entry.id === 'config:single-door')).toBeUndefined();
    expect(report.weakPatterns.join(' ')).toContain('no single door');
  });

  it('detects a logging convention, and the files that skip it', () => {
    const loggerPath = 'src/core/logger.ts';
    const sources = [
      { path: loggerPath, text: 'export const logger = { info: () => {} };' },
      ...Array.from({ length: 6 }, (_, i) => ({ path: `src/uses${i}.ts`, text: 'export const f = () => 1;' })),
      { path: 'src/rogue.ts', text: 'console.log(1);\nconsole.error(2);' },
    ];
    const imports: ConventionInput['imports'] = Array.from({ length: 6 }, (_, i) => ({ from: `src/uses${i}.ts`, to: loggerPath }));
    const report = computeConventions(base({ files: files(loggerPath, 'src/rogue.ts'), sources, imports }));
    const rule = report.rules.find((entry) => entry.id === 'logging:single-door');
    expect(rule?.rule).toContain(loggerPath);
    expect(rule?.violations.map((violation) => violation.path)).toEqual(['src/rogue.ts']);
  });
});

describe('barrel structure', () => {
  it('notices when directories consistently re-export through an index', () => {
    const dirs = ['src/a', 'src/b', 'src/c', 'src/d', 'src/e', 'src/f'];
    const paths = dirs.flatMap((dir) => [`${dir}/index.ts`, ...Array.from({ length: 4 }, (_, i) => `${dir}/mod${i}.ts`)]);
    // One directory without a barrel is the exception.
    const withoutBarrel = paths.filter((path) => path !== 'src/f/index.ts');
    const report = computeConventions(base({ files: files(...withoutBarrel.slice(0, 29)) }));
    const rule = report.rules.find((entry) => entry.id === 'structure:barrel');
    expect(rule?.rule).toContain('index.ts');
    expect(rule?.violations.some((violation) => violation.path === 'src/f')).toBe(true);
  });

  it('stays quiet when barrels are used inconsistently', () => {
    const paths = [
      ...['src/a', 'src/b', 'src/c'].flatMap((dir) => [`${dir}/index.ts`, ...Array.from({ length: 4 }, (_, i) => `${dir}/m${i}.ts`)]),
      ...['src/x', 'src/y', 'src/z'].flatMap((dir) => Array.from({ length: 5 }, (_, i) => `${dir}/m${i}.ts`)),
    ];
    const report = computeConventions(base({ files: files(...paths) }));
    expect(report.rules.find((entry) => entry.id === 'structure:barrel')).toBeUndefined();
    expect(report.weakPatterns.join(' ')).toContain('Barrel files');
  });
});

describe('ordering and limits', () => {
  it('puts the most closely followed rules first', () => {
    const report = computeConventions(
      base({
        files: files('src/a/one.ts', 'src/a/two.ts', 'src/a/three.ts', 'src/a/four.ts', 'src/a/five.ts', 'src/a/NotCamel.ts'),
      }),
    );
    const adherences = report.rules.map((rule) => rule.adherence);
    expect([...adherences].sort((a, b) => b - a)).toEqual(adherences);
  });

  it('caps the violations it reports per rule', () => {
    const paths = Array.from({ length: 40 }, (_, i) => `src/a/file${i}.ts`).concat(Array.from({ length: 30 }, (_, i) => `src/a/Not-camel-${i}.ts`));
    const report = computeConventions(base({ files: files(...paths) }));
    for (const rule of report.rules) expect(rule.violations.length).toBeLessThanOrEqual(20);
  });
});
