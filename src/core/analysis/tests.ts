import type { Component, ExternalDependency, FileEntry, ImportEdge, SymbolRecord, CallEdge } from '../types.js';
import type { LanguageFamily } from './languages.js';

/**
 * Which code the tests actually reach.
 *
 * The question an engineering leader asks first is "what is tested?", and it is
 * the one thing a language model cannot answer by reading, because answering it
 * requires knowing what every test touches. Static analysis can answer it
 * exactly, so it should.
 *
 * The rule is deliberately simple enough to state in one sentence: a source file
 * counts as referenced when a file that contains test cases imports it, calls
 * into it, or reaches it within two hops of imports and calls. Two hops is what
 * covers the ordinary shape of `test -> fixture/helper -> code under test`,
 * without claiming that everything a tested module calls is itself tested.
 */
export interface TestCoverage {
  summary: {
    sourceFiles: number;
    /** Files a test refers to directly. */
    referenced: number;
    /** Files a test reaches within two hops. */
    reachable: number;
    testFiles: number;
    percentReferenced: number;
    percentReachable: number;
    testLoc: number;
    sourceLoc: number;
  };
  /**
   * Files under a test path that contain no test cases and reach no source file.
   * They look like coverage on a file listing and are not.
   */
  testsReachingNothing: { path: string; reason: string }[];
  /** Source files no test reaches, largest first. */
  untested: { path: string; loc: number; symbols: number; component: string | null }[];
  /** Per-component coverage, worst first. */
  components: { id: string; name: string; sourceFiles: number; referenced: number; percent: number }[];
  /** Source files with the most churn that no test reaches — the riskiest gaps. */
  riskyGaps: { path: string; loc: number; churn: number; component: string | null }[];
}

export interface TestCoverageInput {
  files: FileEntry[];
  imports: ImportEdge[];
  calls: CallEdge[];
  symbols: SymbolRecord[];
  components: Component[];
  /**
   * Paths of test-category files that declare at least one test case.
   *
   * Supplied by the caller rather than derived here because the parser frees
   * file text early to keep memory down, so by the time coverage is computed the
   * text is gone. Deciding it during the parse is both cheaper and immune to
   * that ordering.
   */
  testCaseFiles: Set<string>;
  /** Churn per path, to rank the riskiest gaps. */
  churn?: Map<string, number>;
}

const MAX_LISTED = 200;
const MAX_HOPS = 2;

/**
 * Test-case declarations per language family.
 *
 * Deliberately about *test cases*, not file names: a fixture or a helper sitting
 * in `tests/` is not a test, and counting it as one makes coverage look better
 * than it is.
 */
const TEST_DECLARATIONS: Partial<Record<LanguageFamily, RegExp>> = {
  // Anchored to the start of a line, which is how a formatter writes a test case.
  // Matching anywhere made a file that merely *mentions* a test case look like
  // one — a fixture holding generated sample code was counted as a test that
  // covers nothing.
  js: /^[ \t]*(?:it|test|describe|it\.each|test\.each|fit|xit|xtest)(?:\.[a-z]+)?\s*\(/m,
  python: /^[ \t]*(?:async\s+)?def\s+test_/m,
  go: /^func\s+(Test|Benchmark|Example)\w*\s*\(/m,
  rust: /^[ \t]*#\[(?:tokio::)?test\]/m,
  jvm: /^[ \t]*@(?:Test|ParameterizedTest|RepeatedTest)\b/m,
  dotnet: /^[ \t]*\[(?:Fact|Theory|Test|TestMethod|TestCase)/m,
  ruby: /^[ \t]*(?:it|describe|specify)\s+['"]|^[ \t]*def\s+test_/m,
  php: /^[ \t]*(?:(?:public|protected|private)\s+)?function\s+test[A-Z_]\w*\s*\(/m,
  swift: /^[ \t]*func\s+test[A-Z]\w*\s*\(|^[ \t]*@Test\b/m,
  c: /^[ \t]*(?:TEST|TEST_F|TEST_CASE|SCENARIO)\s*\(/m,
};

const FAMILY_BY_LANGUAGE: Record<string, LanguageFamily> = {
  typescript: 'js',
  javascript: 'js',
  tsx: 'js',
  jsx: 'js',
  python: 'python',
  go: 'go',
  rust: 'rust',
  java: 'jvm',
  kotlin: 'jvm',
  scala: 'jvm',
  csharp: 'dotnet',
  ruby: 'ruby',
  php: 'php',
  swift: 'swift',
  c: 'c',
  cpp: 'c',
};

/** Map a detected language id onto the family that decides how tests look. */
export function familyOfLanguage(language: string): LanguageFamily {
  return FAMILY_BY_LANGUAGE[language] ?? 'other';
}

/** True when the file declares at least one test case. */
export function hasTestCases(text: string | null | undefined, family: LanguageFamily): boolean {
  // The parser nulls file text once it has been parsed. Guard rather than
  // silently testing the four-character string "null", which is how every test
  // file ended up classified as containing no test cases.
  if (typeof text !== 'string' || text.length === 0) return false;
  const pattern = TEST_DECLARATIONS[family];
  if (!pattern) return false;
  return pattern.test(text);
}

export function computeTestCoverage(input: TestCoverageInput): TestCoverage {
  const source = new Set<string>();
  const testPath = new Set<string>();
  const locByPath = new Map<string, number>();
  let sourceLoc = 0;

  for (const file of input.files) {
    locByPath.set(file.path, file.lines);
    if (file.category === 'test') {
      testPath.add(file.path);
      continue;
    }
    if (file.category !== 'source') continue;
    source.add(file.path);
    sourceLoc += file.lines;
  }

  // Test files that actually declare test cases. Files under a test path with no
  // cases (helpers, fixtures, snapshots) are not evidence of coverage.
  const testFiles = new Set<string>();
  const testsReachingNothing: { path: string; reason: string }[] = [];
  let testLoc = 0;
  for (const path of testPath) {
    if (!input.testCaseFiles.has(path)) continue;
    testFiles.add(path);
    testLoc += locByPath.get(path) ?? 0;
  }

  // Forward file-level edges, so a test can be followed into what it exercises.
  const forward = new Map<string, Set<string>>();
  const addEdge = (from: string | null, to: string | null): void => {
    if (!from || !to || from === to) return;
    if (!forward.has(from)) forward.set(from, new Set());
    (forward.get(from) as Set<string>).add(to);
  };
  for (const edge of input.imports) addEdge(edge.from, edge.to);
  for (const edge of input.calls) addEdge(edge.fromPath, edge.toPath);

  // Breadth-first from every test file. Traversing *through* another test file
  // is skipped so that a test importing a helper does not make the helper's own
  // imports look like direct evidence.
  const depth = new Map<string, number>();
  let frontier = [...testFiles];
  for (const path of frontier) depth.set(path, 0);
  for (let hop = 1; hop <= MAX_HOPS && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const path of frontier) {
      for (const target of forward.get(path) ?? []) {
        if (depth.has(target)) continue;
        depth.set(target, hop);
        if (!testFiles.has(target)) next.push(target);
      }
    }
    frontier = next;
  }

  let referenced = 0;
  let reachable = 0;
  for (const path of source) {
    const hops = depth.get(path);
    if (hops === undefined) continue;
    reachable += 1;
    // Direct reference, or through a single intermediary such as a fixture.
    if (hops <= 2) referenced += 1;
  }

  const symbolCounts = new Map<string, number>();
  for (const symbol of input.symbols) symbolCounts.set(symbol.path, (symbolCounts.get(symbol.path) ?? 0) + 1);

  const componentOf = new Map<string, Component>();
  for (const component of input.components) {
    for (const path of component.files) if (!componentOf.has(path)) componentOf.set(path, component);
  }

  const untestedAll = [...source]
    .filter((path) => !depth.has(path))
    .map((path) => ({
      path,
      loc: locByPath.get(path) ?? 0,
      symbols: symbolCounts.get(path) ?? 0,
      component: componentOf.get(path)?.name ?? null,
    }))
    .sort((a, b) => b.loc - a.loc || a.path.localeCompare(b.path));

  const churn = input.churn ?? new Map<string, number>();
  const riskyGaps = untestedAll
    .filter((file) => (churn.get(file.path) ?? 0) > 0)
    .map((file) => ({ ...file, churn: churn.get(file.path) ?? 0 }))
    .sort((a, b) => b.churn - a.churn || b.loc - a.loc)
    .slice(0, 15);

  // Test files that reach no source file at all. A helper or a fixture is a
  // legitimate reason to be here; a test file that exercises nothing is not.
  for (const path of testFiles) {
    const touchesSource = [...(forward.get(path) ?? [])].some((target) => source.has(target));
    const reachesAnySource = touchesSource || depthIndirect(path, forward, source, testFiles);
    if (!reachesAnySource) {
      testsReachingNothing.push({ path, reason: 'no test case in this file reaches any source file' });
    }
  }
  testsReachingNothing.sort((a, b) => a.path.localeCompare(b.path));

  const components = input.components
    .filter((component) => !component.ancillary)
    .map((component) => {
      const own = component.files.filter((path) => source.has(path)).length;
      const covered = component.files.filter((path) => source.has(path) && depth.has(path)).length;
      return {
        id: component.id,
        name: component.name,
        sourceFiles: own,
        referenced: covered,
        percent: own === 0 ? 0 : Math.round((covered / own) * 100),
      };
    })
    .filter((component) => component.sourceFiles > 0)
    .sort((a, b) => a.percent - b.percent || b.sourceFiles - a.sourceFiles);

  const percent = (value: number, total: number): number => (total === 0 ? 0 : Math.round((value / total) * 100));

  return {
    summary: {
      sourceFiles: source.size,
      referenced,
      reachable,
      testFiles: testFiles.size,
      testLoc,
      sourceLoc,
      percentReferenced: percent(referenced, source.size),
      percentReachable: percent(reachable, source.size),
    },
    testsReachingNothing,
    untested: untestedAll.slice(0, MAX_LISTED),
    riskyGaps,
    components,
  };
}

/** Does this test file reach any source file at all, at any depth? */
function depthIndirect(
  start: string,
  forward: Map<string, Set<string>>,
  source: Set<string>,
  testFiles: Set<string>,
): boolean {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    for (const target of forward.get(path) ?? []) {
      if (source.has(target)) return true;
      if (seen.has(target)) continue;
      seen.add(target);
      if (!testFiles.has(target)) queue.push(target);
    }
  }
  return false;
}

/** Declaration-looking imports, for the "is this test wired up" question. */
export function testFrameworkDependency(dependencies: ExternalDependency[]): string | null {
  const known = ['vitest', 'jest', 'mocha', 'ava', 'jasmine', 'pytest', 'unittest', 'testing', 'rspec', 'junit', 'xunit', 'nunit'];
  const found = dependencies.find((dependency) => known.includes(dependency.name.toLowerCase()));
  return found?.name ?? null;
}
