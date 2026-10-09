import { describe, expect, it } from 'vitest';
import { describeGenerationFailure, selectChangeDiff } from '../src/core/explain/generate.js';
import type { ChangeFile } from '../src/core/types.js';

/**
 * A change explainer reads a diff, and a real commit's diff is far larger than a
 * model can hold. These tests cover what is chosen, what is left out — and, for
 * the case where nothing usable comes back, that the reader is told the truth
 * rather than the wrong one of two possible reasons.
 */

const file = (path: string, additions: number, body = 'x'.repeat(100)): ChangeFile => ({
  path,
  status: 'modified',
  additions,
  deletions: 0,
  binary: false,
  patch: `diff --git a/${path} b/${path}\n${body}`,
  language: 'typescript',
});

describe('selecting the diff to explain', () => {
  it('drops lockfiles and generated output before spending the budget', () => {
    // A dependency bump is mostly a lockfile diff, and a lockfile says nothing
    // about what the change means.
    const diff = selectChangeDiff([
      file('package-lock.json', 9000),
      file('yarn.lock', 9000),
      file('src/real.ts', 12),
    ]);
    expect(diff).toContain('src/real.ts');
    expect(diff).not.toContain('diff --git a/package-lock.json');
    expect(diff).not.toContain('diff --git a/yarn.lock');
    // The omission is stated rather than left silent.
    expect(diff).toContain('omitted as lockfiles, generated output or binary assets');
    expect(diff).toContain('package-lock.json');
  });

  it('drops built output, bundles and binary assets as well', () => {
    // A diff comes from git, so it can contain paths the analysis never scanned.
    const diff = selectChangeDiff([
      file('dist/bundle.js', 5000),
      file('src/app.min.js', 2000),
      file('assets/logo.png', 0),
      file('src/a.ts', 3),
    ]);
    // The disclosure note names them, so assert on the patch itself.
    expect(diff).not.toContain('diff --git a/dist/bundle.js');
    expect(diff).not.toContain('diff --git a/src/app.min.js');
    expect(diff).not.toContain('diff --git a/assets/logo.png');
    expect(diff).toContain('diff --git a/src/a.ts');
  });

  it('ranks by how much changed, largest first', () => {
    const diff = selectChangeDiff([file('src/small.ts', 2), file('src/large.ts', 900), file('src/medium.ts', 100)]);
    expect(diff.indexOf('src/large.ts')).toBeLessThan(diff.indexOf('src/medium.ts'));
    expect(diff.indexOf('src/medium.ts')).toBeLessThan(diff.indexOf('src/small.ts'));
  });

  it('stays inside its budget and says what it left out', () => {
    const many = Array.from({ length: 40 }, (_, index) => file(`src/file${index}.ts`, 500, 'y'.repeat(400)));
    const diff = selectChangeDiff(many, 4000);
    expect(diff.length).toBeLessThan(9000);
    expect(diff).toContain('omitted for length');
  });

  it('keeps a partially-fitted file rather than dropping it whole', () => {
    const diff = selectChangeDiff([file('src/big.ts', 900, 'z'.repeat(5000)), file('src/next.ts', 10)], 3000);
    expect(diff).toContain('src/big.ts');
    expect(diff).toContain('[diff truncated]');
  });

  it('handles a diff with nothing usable in it', () => {
    expect(selectChangeDiff([])).toBe('');
    // A change touching only a binary asset still says so, rather than sending
    // nothing at all: the model should know the file was touched.
    const onlyBinary = selectChangeDiff([{ ...file('logo.png', 0), binary: true, patch: '' }]);
    expect(onlyBinary).toContain('omitted as lockfiles, generated output or binary assets');
    expect(onlyBinary).toContain('logo.png');
  });
});

describe('explaining why a written explanation is missing', () => {
  it('identifies the budget case and says it is usually transient', () => {
    const reason = describeGenerationFailure(new Error('Exploration exceeded its budget without producing an explainer.'));
    expect(reason).toContain('investigation budget');
    expect(reason).toContain('regenerating');
  });

  it('identifies a missing or rejected credential', () => {
    expect(describeGenerationFailure(new Error('No provider is configured'))).toContain('No language model is available');
    expect(describeGenerationFailure(new Error('401 Unauthorized'))).toContain('No language model is available');
  });

  it('identifies an unreachable provider', () => {
    expect(describeGenerationFailure(new Error('fetch failed'))).toContain('could not be reached');
    expect(describeGenerationFailure(new Error('request timed out'))).toContain('could not be reached');
  });

  it('identifies an unreadable reply, and quotes it', () => {
    const reason = describeGenerationFailure(new Error('Unexpected token < in JSON at position 0'));
    expect(reason).toContain('could not be read as an explainer');
  });

  it('passes an unrecognised error through rather than inventing a cause', () => {
    expect(describeGenerationFailure(new Error('something entirely unexpected'))).toBe('something entirely unexpected');
  });

  it('never claims the model was unavailable for a budget failure', () => {
    // The message the reader used to get offered two causes, and this was
    // usually the wrong one of them.
    const reason = describeGenerationFailure(new Error('Exploration exceeded its budget without producing an explainer.'));
    expect(reason).not.toContain('unavailable');
  });
});
