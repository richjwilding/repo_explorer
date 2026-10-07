import { describe, expect, it } from 'vitest';
import { findBodyEnd, indentWidth } from '../src/core/analysis/bodies.js';
import { extractCalls } from '../src/core/analysis/callgraph.js';
import { resolveSpecifier } from '../src/core/analysis/imports.js';
import { computeTestCoverage, hasTestCases, familyOfLanguage } from '../src/core/analysis/tests.js';
import type { CallEdge, Component, FileEntry, ImportEdge, SymbolRecord } from '../src/core/types.js';

/**
 * Regressions for four defects found while adding test-coverage analysis.
 *
 * Each one was invisible from the outside and made the analysis quietly wrong
 * rather than failing: body extents that stopped on the declaration line, JSX
 * that was never seen as a call, TypeScript's `.js`-for-`.ts` import convention,
 * and test-case detection matching text inside a string.
 */

describe('body extents', () => {
  const lines = (text: string) => text.split('\n');

  it('does not end the body at a destructured parameter', () => {
    const source = lines(
      [
        'export function SectionRenderer({ section, onOpenFile }) {',
        '  switch (section.type) {',
        "    case 'prose':",
        '      return render(section);',
        '  }',
        '}',
        'const after = 1;',
      ].join('\n'),
    );
    // The `}` of the parameter list used to close a body that had never opened.
    expect(findBodyEnd(source, 0, 'js')).toBe(5);
  });

  it('does not end the body at an inline object return type', () => {
    const source = lines(
      [
        'function aggregate(pass: PassFile[]): { language: string; files: number }[] {',
        '  const map = new Map();',
        '  return [...map];',
        '}',
      ].join('\n'),
    );
    expect(findBodyEnd(source, 0, 'js')).toBe(3);
  });

  it('does not end the body at a union return type', () => {
    const source = lines(
      [
        'function classify(name: string): { category: string } | null {',
        '  return lookup(name);',
        '}',
      ].join('\n'),
    );
    expect(findBodyEnd(source, 0, 'js')).toBe(2);
  });

  it('still ends the body at the closing brace of a plain function', () => {
    const source = lines(['function plain(a) {', '  return a + 1;', '}', 'const x = 2;'].join('\n'));
    expect(findBodyEnd(source, 0, 'js')).toBe(2);
  });

  it('still handles classes, whose brace is not preceded by a parameter list', () => {
    const source = lines(['class Thing {', '  method() {}', '  other() {}', '}', 'const y = 1;'].join('\n'));
    expect(findBodyEnd(source, 0, 'js')).toBe(3);
  });

  it('handles a body opening on the line after a multi-line parameter list', () => {
    const source = lines(
      [
        'export function big(',
        '  { first, second }: Options,',
        ') {',
        '  return first + second;',
        '}',
      ].join('\n'),
    );
    expect(findBodyEnd(source, 0, 'js')).toBe(4);
  });

  it('ignores a brace inside a string or a comment', () => {
    const source = lines(['function f() {', "  const s = '}';", '  // } not the end', '  return s;', '}'].join('\n'));
    expect(findBodyEnd(source, 0, 'js')).toBe(4);
  });

  it('measures indentation, counting a tab as one level', () => {
    expect(indentWidth('    x')).toBe(4);
    expect(indentWidth('\tx')).toBe(4);
    expect(indentWidth('\t\tx')).toBe(8);
    expect(indentWidth('x')).toBe(0);
  });
});

describe('JSX as a call', () => {
  it('records a JSX element as a call to that component', () => {
    const source = ['function App() {', '  return <DiagramView data={x} />;', '}'].join('\n');
    const names = extractCalls(source, 1, 'js').filter((call) => call.kind === 'jsx').map((call) => call.name);
    expect(names).toContain('DiagramView');
  });

  it('finds self-closing, paired and nested elements', () => {
    const source = [
      'const view = (',
      '  <Panel>',
      '    <Row key={1} />',
      '    <SectionRenderer section={s}></SectionRenderer>',
      '  </Panel>',
      ');',
    ].join('\n');
    const names = extractCalls(source, 1, 'js').filter((call) => call.kind === 'jsx').map((call) => call.name);
    expect(names).toEqual(expect.arrayContaining(['Panel', 'Row', 'SectionRenderer']));
  });

  it('records a namespaced element with its receiver', () => {
    const source = 'const a = <Motion.Div />;';
    const call = extractCalls(source, 1, 'js').find((candidate) => candidate.kind === 'jsx');
    expect(call?.name).toBe('Div');
    expect(call?.receiver).toBe('Motion');
  });

  it('does not mistake a generic type for an element', () => {
    const source = [
      'function f(a: Map<SymbolRecord, string>) {',
      '  const b = new Set<CallEdge>();',
      '  return a;',
      '}',
    ].join('\n');
    const names = extractCalls(source, 1, 'js').filter((call) => call.kind === 'jsx').map((call) => call.name);
    expect(names).toEqual([]);
  });

  it('does not mistake an HTML element for a component', () => {
    const source = 'const x = <div className="a"><span>hi</span></div>;';
    const names = extractCalls(source, 1, 'js').filter((call) => call.kind === 'jsx').map((call) => call.name);
    expect(names).toEqual([]);
  });

  it('does not treat a closing tag as a second call on the same line', () => {
    const source = 'const x = <Row></Row>;';
    const names = extractCalls(source, 1, 'js').filter((call) => call.kind === 'jsx').map((call) => call.name);
    expect(names).toEqual(['Row']);
  });
});

describe('TypeScript import specifiers', () => {
  const known = new Set(['src/core/config.ts', 'src/web/App.tsx', 'src/a/index.ts', 'src/legacy/old.mts']);

  it('resolves `./x.js` to the TypeScript source that emits it', () => {
    expect(resolveSpecifier('src/main.ts', './core/config.js', known)).toBe('src/core/config.ts');
  });

  it('resolves a `.jsx` specifier to `.tsx`', () => {
    expect(resolveSpecifier('src/main.ts', './web/App.jsx', known)).toBe('src/web/App.tsx');
  });

  it('resolves a `.mjs` specifier to `.mts`', () => {
    expect(resolveSpecifier('src/x.ts', './legacy/old.mjs', known)).toBe('src/legacy/old.mts');
  });

  it('resolves a directory written with a `.js` suffix', () => {
    expect(resolveSpecifier('src/main.ts', './a/index.js', known)).toBe('src/a/index.ts');
  });

  it('still resolves an extensionless specifier', () => {
    expect(resolveSpecifier('src/main.ts', './core/config', known)).toBe('src/core/config.ts');
  });

  it('still resolves a real `.js` file rather than swapping it away', () => {
    const withJs = new Set(['src/real.js', 'src/real.ts']);
    expect(resolveSpecifier('src/main.ts', './real.js', withJs)).toBe('src/real.js');
  });

  it('returns null for something genuinely absent', () => {
    expect(resolveSpecifier('src/main.ts', './nowhere.js', known)).toBeNull();
  });
});

describe('recognising a test file', () => {
  it('accepts each language\'s test declarations', () => {
    expect(hasTestCases("it('works', () => {});", 'js')).toBe(true);
    expect(hasTestCases("describe('group', () => {});", 'js')).toBe(true);
    expect(hasTestCases('def test_thing():\n    pass', 'python')).toBe(true);
    expect(hasTestCases('func TestThing(t *testing.T) {}', 'go')).toBe(true);
    expect(hasTestCases('#[test]\nfn works() {}', 'rust')).toBe(true);
    expect(hasTestCases('@Test\npublic void works() {}', 'jvm')).toBe(true);
    expect(hasTestCases('[Fact]\npublic void Works() {}', 'dotnet')).toBe(true);
    expect(hasTestCases('public function testItWorks() {}', 'php')).toBe(true);
  });

  it('rejects a file that merely mentions a test case in a string', () => {
    // This is a fixture that writes sample code containing a test, not a test.
    const fixture = ['const sample = [', `  "  it('parses a document', () => {",`, '];'].join('\n');
    expect(hasTestCases(fixture, 'js')).toBe(false);
  });

  it('rejects ordinary source code', () => {
    expect(hasTestCases('export function run() { return 1; }', 'js')).toBe(false);
  });

  it('rejects null text rather than testing the string "null"', () => {
    expect(hasTestCases(null, 'js')).toBe(false);
    expect(hasTestCases(undefined, 'js')).toBe(false);
    expect(hasTestCases('', 'js')).toBe(false);
  });

  it('maps language ids onto families', () => {
    expect(familyOfLanguage('typescript')).toBe('js');
    expect(familyOfLanguage('tsx')).toBe('js');
    expect(familyOfLanguage('csharp')).toBe('dotnet');
    expect(familyOfLanguage('brainfuck')).toBe('other');
  });
});

/* ------------------------------------------------------------------ *
 * Coverage graph
 * ------------------------------------------------------------------ */

function file(path: string, category: FileEntry['category'], lines: number): FileEntry {
  return { path, size: lines * 30, mtimeMs: 0, lines, language: 'typescript', category, isBinary: false, isNoise: false, symbols: [] };
}

describe('test coverage', () => {
  const files = [
    file('src/api.ts', 'source', 100),
    file('src/store.ts', 'source', 200),
    file('src/orphan.ts', 'source', 50),
    file('tests/api.test.ts', 'test', 40),
    file('tests/helpers/build.ts', 'test', 20),
    file('tests/empty.test.ts', 'test', 5),
  ];

  const imports: ImportEdge[] = [
    { from: 'tests/api.test.ts', to: 'tests/helpers/build.ts', specifier: './helpers/build.js', kind: 'static' },
    // Reached through the helper: the ordinary `test -> fixture -> code` shape.
    { from: 'tests/helpers/build.ts', to: 'src/store.ts', specifier: '../src/store.js', kind: 'static' },
    { from: 'tests/api.test.ts', to: 'src/api.ts', specifier: '../src/api.js', kind: 'static' },
  ];

  const components: Component[] = [
    { id: 'src', name: 'src', kind: 'library', path: 'src', oneLiner: '', moduleIds: [], files: ['src/api.ts', 'src/store.ts', 'src/orphan.ts'], keyFiles: [], dependsOn: [], externalDeps: [], loc: 350, importance: 1, ancillary: false },
  ];

  const coverage = computeTestCoverage({
    files,
    imports,
    calls: [],
    symbols: [] as SymbolRecord[],
    components,
    testCaseFiles: new Set(['tests/api.test.ts', 'tests/empty.test.ts']),
    churn: new Map([['src/orphan.ts', 7]]),
  });

  it('counts a file a test imports directly', () => {
    expect(coverage.untested.map((entry) => entry.path)).not.toContain('src/api.ts');
  });

  it('counts a file reached through a helper', () => {
    expect(coverage.untested.map((entry) => entry.path)).not.toContain('src/store.ts');
  });

  it('lists a file nothing reaches', () => {
    expect(coverage.untested.map((entry) => entry.path)).toContain('src/orphan.ts');
  });

  it('ranks the riskiest gap by churn', () => {
    expect(coverage.riskyGaps[0].path).toBe('src/orphan.ts');
    expect(coverage.riskyGaps[0].churn).toBe(7);
  });

  it('reports a test file that reaches no source file', () => {
    expect(coverage.testsReachingNothing.map((entry) => entry.path)).toContain('tests/empty.test.ts');
    expect(coverage.testsReachingNothing.map((entry) => entry.path)).not.toContain('tests/api.test.ts');
  });

  it('reports a percentage per component', () => {
    const src = coverage.components.find((component) => component.id === 'src');
    expect(src?.sourceFiles).toBe(3);
    expect(src?.referenced).toBe(2);
    expect(src?.percent).toBe(67);
  });

  it('does not count a file reached through a sibling test as covered', () => {
    // Two tests importing each other must not manufacture coverage.
    const result = computeTestCoverage({
      files: [file('tests/a.test.ts', 'test', 10), file('tests/b.test.ts', 'test', 10)],
      imports: [{ from: 'tests/a.test.ts', to: 'tests/b.test.ts', specifier: './b.js', kind: 'static' }],
      calls: [] as CallEdge[],
      symbols: [] as SymbolRecord[],
      components: [],
      testCaseFiles: new Set(['tests/a.test.ts', 'tests/b.test.ts']),
    });
    expect(result.summary.referenced).toBe(0);
  });

  it('follows the call graph as well as imports', () => {
    const result = computeTestCoverage({
      files: [file('tests/a.test.ts', 'test', 10), file('src/run.ts', 'source', 20)],
      imports: [],
      calls: [{ from: 'entry:tests/a.test.ts', fromPath: 'tests/a.test.ts', fromLine: 1, to: null, toPath: 'src/run.ts', toName: 'run', kind: 'call', resolved: true }],
      symbols: [] as SymbolRecord[],
      components: [],
      testCaseFiles: new Set(['tests/a.test.ts']),
    });
    expect(result.summary.referenced).toBe(1);
  });

  it('says nothing is verified when there are no test files', () => {
    const result = computeTestCoverage({
      files: [file('src/a.ts', 'source', 10)],
      imports: [],
      calls: [],
      symbols: [],
      components: [],
      testCaseFiles: new Set<string>(),
    });
    expect(result.summary.testFiles).toBe(0);
    expect(result.summary.percentReferenced).toBe(0);
    expect(result.untested).toHaveLength(1);
  });
});
