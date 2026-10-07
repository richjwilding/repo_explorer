import { describe, expect, it } from 'vitest';
import {
  complexityScore,
  computeComplexity,
  countBranches,
  measureBraceNesting,
  measureIndentNesting,
  stripNonCode,
} from '../src/core/analysis/complexity.js';
import type { ComplexityFileInput } from '../src/core/analysis/complexity.js';

/**
 * Complexity is only worth reporting if it is trustworthy, so most of these
 * tests are about the ways a naive count goes wrong: keywords inside strings and
 * comments, a destructured parameter mistaken for a block, and an indented
 * object literal mistaken for nesting.
 */

const stub = (text: string, symbols: ComplexityFileInput['symbols'], entryLines = text.split('\n').length): ComplexityFileInput => ({
  path: 'sample.ts',
  language: 'ts',
  text,
  entryLines,
  symbols,
});

describe('removing strings and comments', () => {
  it('does not count keywords that are only text', () => {
    const code = stripNonCode(
      `const a = "if you want, for the while case";
// if for while case
/* if for */
const b = 1;`,
      'js',
    );
    expect(countBranches(code, 'js')).toBe(0);
    expect(code).not.toContain('if you want');
    expect(code).toContain('const b = 1;');
  });

  it('strips hash comments in languages that use them', () => {
    expect(countBranches(stripNonCode('# if for while\nx = 1', 'python'), 'python')).toBe(0);
    // The same text in a brace language is code, not a comment.
    expect(stripNonCode('# if for while\nx = 1', 'js')).toContain('# if for while');
  });

  it('keeps structure so line positions still line up', () => {
    const stripped = stripNonCode('a\n// comment\nb', 'js');
    expect(stripped.split('\n')).toHaveLength(3);
  });
});

describe('counting decision points', () => {
  it('counts branches, loops and operators in each language', () => {
    // `try` alone is not a decision; `catch` is.
    expect(countBranches('if (a) {} for (;;) {} while (b) {} try {} catch (e) {}', 'js')).toBe(4);
    // `else if` is one decision; a bare `else` is not a decision at all.
    expect(countBranches('if (a) {} else if (b) {} else {}', 'js')).toBe(2);
    expect(countBranches('a && b || c', 'js')).toBe(2);
    expect(countBranches('a ?? b', 'js')).toBe(1);
    expect(countBranches('a ? b : c', 'js')).toBe(1);
    // Optional chaining and a ternary-in-string must not be counted.
    expect(countBranches('a?.b?.c', 'js')).toBe(0);
    expect(countBranches('if a: pass\nelif b: pass\nelse: pass', 'python')).toBe(2);
    expect(countBranches('a and b or c', 'python')).toBe(2);
    expect(countBranches('if a then b elsif c then d end', 'ruby')).toBe(2);
  });

  it('counts each switch case as a decision', () => {
    expect(countBranches('switch (x) { case 1: break; case 2: break; default: break; }', 'js')).toBe(2);
  });
});

describe('measuring nesting', () => {
  it('does not count the function body itself as a level', () => {
    expect(measureBraceNesting('function f() { return 1; }')).toBe(0);
    expect(measureBraceNesting('function f() { if (a) { return 1; } }')).toBe(1);
  });

  it('does not count a destructured parameter as a block', () => {
    expect(measureBraceNesting('function f({ a, b }) { return a; }')).toBe(0);
    expect(measureBraceNesting('function f({ a }) { if (a) { return 1; } }')).toBe(1);
  });

  it('does not count an object or array literal as nesting', () => {
    // The reason for the whole design: a nested config object is not complexity.
    expect(measureBraceNesting('const config = { a: { b: { c: { d: 1 } } } };')).toBe(0);
    expect(measureBraceNesting('function f() { return { a: { b: { c: 1 } } }; }')).toBe(0);
  });

  it('counts nested control flow, including else-branches and callbacks', () => {
    expect(measureBraceNesting('function f() { if (a) { for (;;) { if (b) { return 1; } } } }')).toBe(3);
    expect(measureBraceNesting('if (a) { } else { }')).toBe(1);
    expect(measureBraceNesting('function f() { items.map((x) => { if (x) { return x; } }); }')).toBe(2);
  });

  it('measures indentation-delimited nesting for python and ruby', () => {
    const python = 'def f(items):\n    if items:\n        for item in items:\n            if item.ok:\n                return item\n    return None\n';
    expect(measureIndentNesting(python, 'python')).toBe(3);
    const flat = 'def f(items):\n    return [x for x in items]\n';
    expect(measureIndentNesting(flat, 'python')).toBe(0);
  });
});

describe('scoring', () => {
  it('weights nesting above branching and blast radius above both', () => {
    // Two branches in sequence versus two nested: the nested one is harder.
    expect(complexityScore(2, 0, 0)).toBe(2);
    expect(complexityScore(2, 1, 0)).toBe(4);
    expect(complexityScore(2, 2, 0)).toBe(6);
    // More callers means more to break.
    expect(complexityScore(2, 1, 30)).toBeGreaterThan(complexityScore(2, 1, 1));
    // A branchy function nothing calls is cheaper than one with callers.
    expect(complexityScore(20, 0, 0)).toBe(20);
    expect(complexityScore(20, 0, 3)).toBeGreaterThan(20);
  });
});

describe('computing a report', () => {
  const text = `function simple(a) { return a + 1; }
function branchy(x, y) {
  if (x) { return 1; }
  for (const i of y) { while (i) { if (i) { return 2; } } }
  return 0;
}`;

  it('measures each definition and ranks the hardest first', () => {
    const report = computeComplexity({
      files: [
        stub(text, [
          { id: 'a', name: 'simple', kind: 'function', line: 1, endLine: 1, callers: 1, reachable: true },
          { id: 'b', name: 'branchy', kind: 'function', line: 2, endLine: 6, callers: 1, reachable: true },
        ]),
      ],
    });
    const [first, second] = report.symbols;
    expect(first.name).toBe('branchy');
    expect(first.branches).toBe(4);
    expect(first.maxDepth).toBe(3);
    expect(second.name).toBe('simple');
    expect(second.branches).toBe(0);
    expect(second.maxDepth).toBe(0);
  });

  it('ranks a branchy function with many callers above a deeper orphan', () => {
    const report = computeComplexity({
      files: [
        stub(text, [
          { id: 'a', name: 'branchy', kind: 'function', line: 2, endLine: 6, callers: 40, reachable: true },
          { id: 'b', name: 'simple', kind: 'function', line: 1, endLine: 1, callers: 0, reachable: false },
        ]),
      ],
    });
    expect(report.symbols[0].name).toBe('branchy');
  });

  it('summarises the distribution', () => {
    const report = computeComplexity({
      files: [
        stub(text, [
          { id: 'a', name: 'simple', kind: 'function', line: 1, endLine: 1, callers: 0, reachable: true },
          { id: 'b', name: 'branchy', kind: 'function', line: 2, endLine: 6, callers: 0, reachable: true },
        ]),
      ],
    });
    expect(report.summary.functionsAnalysed).toBe(2);
    expect(report.summary.mostBranches).toBe(4);
    expect(report.summary.deepest).toBe(3);
    // Depth 3 is below the "deep" threshold, so nothing is flagged yet.
    expect(report.summary.deepFunctions).toBe(0);
    expect(report.summary.meanBranches).toBe(2);
  });

  it('flags deep and branchy functions at their thresholds', () => {
    const deepBody = `function f() {
  if (a) {
    if (b) {
      if (c) {
        if (d) { return 1; }
      }
    }
  }
  return 0;
}`;
    const report = computeComplexity({
      files: [stub(deepBody, [{ id: 'a', name: 'f', kind: 'function', line: 1, endLine: 11, callers: 0, reachable: true }])],
    });
    expect(report.symbols[0].maxDepth).toBe(4);
    expect(report.summary.deepFunctions).toBe(1);
  });

  it('does not rank a file with no measurable bodies as complex', () => {
    const report = computeComplexity({
      files: [stub('const a = { b: { c: 1 } };\nexport default a;', [], 2)],
      churn: new Map([['sample.ts', 50]]),
    });
    // A file of constants has no complexity to report, however churned.
    expect(report.files).toEqual([]);
    expect(report.symbols).toEqual([]);
    expect(report.warnings.join(' ')).toContain('No function or method bodies');
  });

  it('weights a file by churn when churn is known', () => {
    const symbols = [{ id: 'a', name: 'f', kind: 'function', line: 2, endLine: 6, callers: 0, reachable: true }];
    const cold = computeComplexity({ files: [stub(text, symbols)], churn: new Map([['sample.ts', 1]]) });
    const hot = computeComplexity({ files: [stub(text, symbols)], churn: new Map([['sample.ts', 50]]) });
    expect(hot.files[0].score).toBeGreaterThan(cold.files[0].score);
    expect(hot.files[0].commits).toBe(50);
  });

  it('survives a symbol whose body extends past the end of the file', () => {
    const report = computeComplexity({
      files: [stub('function f() { return 1; }', [{ id: 'a', name: 'f', kind: 'function', line: 1, endLine: 99, callers: 0, reachable: true }])],
    });
    expect(report.symbols).toHaveLength(1);
    expect(report.symbols[0].branches).toBe(0);
  });

  it('ignores empty files and null text', () => {
    const report = computeComplexity({
      files: [
        { path: 'empty.ts', language: 'ts', text: '', entryLines: 0, symbols: [] },
        { path: 'gone.ts', language: 'ts', text: null as unknown as string, entryLines: 0, symbols: [] },
      ],
    });
    expect(report.files).toEqual([]);
  });
});
