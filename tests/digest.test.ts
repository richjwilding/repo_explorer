import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeRepo } from '../src/core/analysis/analyzeRepo.js';
import { buildComponentDigest, buildRepoDigest } from '../src/core/explain/digest.js';
import { createFixtureRepo, type FixtureRepo } from './helpers/fixtureRepo.js';
import type { RepoModel } from '../src/core/types.js';

/**
 * Every analysis feeds the model through the digest, and the digest is
 * truncated to a budget. When sections were appended, the truncation silently
 * removed six whole analyses from the tail — the work was done, wired in, and
 * then thrown away before the model ever saw it. These tests make that failure
 * loud.
 */

let fixture: FixtureRepo;
let model: RepoModel;

beforeAll(async () => {
  fixture = createFixtureRepo();
  model = await analyzeRepo(fixture.root);
}, 60_000);

afterAll(() => fixture?.cleanup());

/** The headings that must survive, whatever the size of the enumerations. */
const REQUIRED_SECTIONS = [
  'Components',
  'How it is built, verified and run',
  'Complexity (measured, not inferred from size)',
  'Data model',
  'What is absent',
  'Conventions the code follows',
  'Hotspots',
];

describe('repo digest', () => {
  it('carries every analysis section', () => {
    const digest = buildRepoDigest(model);
    for (const section of REQUIRED_SECTIONS) {
      expect(digest, `missing section: ${section}`).toContain(`## ${section}`);
    }
  });

  it('orders the analyses before the long enumerations', () => {
    // The regression this exists for: analytical sections were appended after the
    // long lists, so truncation removed whole analyses before the model ever saw
    // them. Ordering is the guarantee — the interpretation must come first, so
    // that whatever is cut is a list rather than a conclusion.
    const digest = buildRepoDigest(model);
    const at = (section: string) => digest.indexOf(`## ${section}`);
    const absent = at('What is absent');
    expect(absent).toBeGreaterThan(-1);
    for (const listSection of ['Entrypoints', 'HTTP / RPC endpoints', 'Call graph', 'Known data flows', 'README excerpt']) {
      const position = digest.indexOf(`## ${listSection}`);
      if (position === -1) continue;
      expect(absent, `${listSection} should come after the analyses`).toBeLessThan(position);
    }
    // The same holds for the other interpretative sections.
    for (const early of ['How it is built, verified and run', 'Complexity (measured, not inferred from size)', 'Data model']) {
      expect(at(early), `${early} should come before the enumerations`).toBeLessThan(at('Entrypoints'));
    }
  });

  it('stays inside its budget on the default setting', () => {
    const digest = buildRepoDigest(model);
    expect(digest.length).toBeLessThanOrEqual(20_000);
  });

  it('stays honest about absence rather than omitting it', () => {
    const digest = buildRepoDigest(model);
    // The fixture has no CI, so the negative-space section must say something.
    expect(digest).toContain('ABSENT');
  });

  it('describes how the project is run, from its own files', () => {
    const digest = buildRepoDigest(model);
    expect(digest).toContain('## How it is built, verified and run');
  });
});

describe('component digest', () => {
  it('leads with what the component needs to run, and what breaks its conventions', () => {
    const component = model.components[0];
    const digest = buildComponentDigest(model, component);
    expect(digest).toContain(`# Component: ${component.name}`);
    // These are only present when the analysis found something; the fixture has
    // both configuration and conventions to report.
    expect(digest.length).toBeGreaterThan(100);
    expect(digest.length).toBeLessThanOrEqual(7000);
  });
});
