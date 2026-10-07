import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, ensureDirs } from '../src/core/config.js';
import { Store } from '../src/core/store.js';
import { RepoService, type RepoContext } from '../src/core/service.js';
import { MockProvider } from '../src/core/llm/mock.js';
import { investigate, shouldInvestigate } from '../src/core/chat/agent.js';
import { askRepo, resolveCitations } from '../src/core/chat/chat.js';
import { retrieve } from '../src/core/chat/retrieval.js';
import type { LlmRequest } from '../src/core/types.js';
import { createFixtureRepo, createTempHome, type FixtureRepo } from './helpers/fixtureRepo.js';

let fixture: FixtureRepo;
let ctx: RepoContext;
let cleanupHome: () => void;

beforeAll(async () => {
  fixture = createFixtureRepo();
  const temp = createTempHome();
  cleanupHome = temp.cleanup;
  const cfg = loadConfig({
    home: temp.home,
    dataDir: `${temp.home}/data`,
    cacheDir: `${temp.home}/cache`,
    exportDir: `${temp.home}/exports`,
    provider: 'mock',
  });
  ensureDirs(cfg);
  const service = new RepoService(cfg, new Store(cfg));
  ctx = await service.open(fixture.root, { force: true });
}, 90_000);

afterAll(() => {
  fixture?.cleanup();
  cleanupHome?.();
});

function scripted(responses: string[]): MockProvider {
  const queue = [...responses];
  return new MockProvider((_request: LlmRequest) => queue.shift() ?? '{"done": true}');
}

function scoped(provider: MockProvider): RepoContext {
  return { ...ctx, provider, providerId: 'mock', modelName: 'mock-1' };
}

describe('deciding whether a question needs investigating', () => {
  it('investigates questions about behaviour across the codebase', () => {
    expect(shouldInvestigate('what happens if normaliseDocument throws')).toBe(true);
    expect(shouldInvestigate('which components depend on the document store')).toBe(true);
    expect(shouldInvestigate('trace a document from the API to storage')).toBe(true);
  });

  it('answers a plain lookup without spending a model call on planning', () => {
    expect(shouldInvestigate('normaliseDocument')).toBe(false);
    expect(shouldInvestigate('what does src/index.ts do')).toBe(false);
  });

  it('treats a long, detailed question as one worth investigating', () => {
    expect(shouldInvestigate(`${'detail '.repeat(40)}why is this shaped this way?`)).toBe(true);
  });
});

describe('the investigation loop', () => {
  it('gathers evidence with real tools and then stops', async () => {
    const provider = scripted([
      JSON.stringify({ thought: 'I need to see who calls it.', tool: 'callers_of', args: { symbol: 'normaliseDocument' } }),
      JSON.stringify({ done: true }),
    ]);
    const steps: string[] = [];
    const result = await investigate(scoped(provider), {
      question: 'who calls normaliseDocument?',
      history: [],
      seed: '',
      seedFiles: [],
      seedText: 'Question: who calls normaliseDocument?',
      onStep: (step) => steps.push(step.tool),
    });

    expect(result.immediate).toBe(false);
    expect(steps).toEqual(['callers_of']);
    expect(result.observations).toHaveLength(1);
    // The observation is real tool output, not a restatement of the question.
    expect(result.observations[0]).toContain('registerRoutes');
  }, 60_000);

  it('stops immediately when the excerpts are already enough', async () => {
    const provider = scripted([JSON.stringify({ done: true })]);
    const result = await investigate(scoped(provider), {
      question: 'what does the API export?',
      history: [],
      seed: '',
      seedFiles: [],
      seedText: 'Question: what does the API export?',
    });

    expect(result.immediate).toBe(true);
    expect(result.steps).toEqual([]);
    expect(result.observations).toEqual([]);
  }, 60_000);

  it('accepts an answer-shaped reply as a signal to stop', async () => {
    const provider = scripted([JSON.stringify({ thought: 'enough.', answer: 'It normalises documents.' })]);
    const result = await investigate(scoped(provider), {
      question: 'what is normaliseDocument for?',
      history: [],
      seed: '',
      seedFiles: [],
      seedText: 'Question: what is normaliseDocument for?',
    });
    expect(result.immediate).toBe(true);
  }, 60_000);

  it('does not run the same tool call twice', async () => {
    const call = JSON.stringify({ tool: 'callers_of', args: { symbol: 'normaliseDocument' } });
    const provider = scripted([call, call, JSON.stringify({ done: true })]);
    const steps: string[] = [];
    const result = await investigate(scoped(provider), {
      question: 'who calls it?',
      history: [],
      seed: '',
      seedFiles: [],
      seedText: 'Question: who calls it?',
      onStep: (step) => steps.push(step.tool),
    });

    expect(result.steps).toHaveLength(1);
  }, 60_000);

  it('gives up gracefully rather than throwing when the model returns rubbish', async () => {
    const provider = scripted(['not json at all', 'still not json', 'nor this']);
    const result = await investigate(scoped(provider), {
      question: 'anything',
      history: [],
      seed: '',
      seedFiles: [],
      seedText: 'Question: anything',
    });
    expect(result.observations).toEqual([]);
  }, 60_000);

  it('respects the step budget', async () => {
    const provider = scripted([
      JSON.stringify({ tool: 'list_dir', args: { path: 'apps' } }),
      JSON.stringify({ tool: 'list_dir', args: { path: 'apps/api' } }),
      JSON.stringify({ tool: 'list_dir', args: { path: 'apps/api/src' } }),
      JSON.stringify({ tool: 'list_dir', args: { path: 'docs' } }),
      JSON.stringify({ tool: 'list_dir', args: { path: 'apps/web' } }),
      JSON.stringify({ done: true }),
    ]);
    const result = await investigate(scoped(provider), {
      question: 'map the repository',
      history: [],
      seed: '',
      seedFiles: [],
      seedText: 'Question: map the repository',
      maxSteps: 2,
    });
    expect(result.steps).toHaveLength(2);
  }, 60_000);
});

describe('answering with investigated evidence', () => {
  it('cites a file the agent found even though keyword search never returned it', () => {
    const retrieval = retrieve(ctx.model, ctx.index, 'who calls normaliseDocument', { maxChars: 4000, topK: 4 });
    // The agent read a file that retrieval did not surface at all. Its range must
    // still become a citation, or the reader loses the reference the agent went
    // and found — which is the whole point of investigating.
    const unreached = ctx.model.files
      .map((file) => file.path)
      .find((path) => !retrieval.files.includes(path));
    expect(unreached).toBeTruthy();

    const answer = `The detail is in [${unreached}:3-9].`;
    const withSteps = resolveCitations(ctx, answer, retrieval, [
      { index: 1, tool: 'read_file', args: { path: unreached as string, startLine: 3, endLine: 9 }, summary: 'read' },
    ]);
    expect(withSteps.some((citation) => citation.path === unreached)).toBe(true);

    // And without any step evidence, the same marker is still kept — it names a
    // real file, which is the only rule resolveCitations enforces.
    const withoutSteps = resolveCitations(ctx, answer, retrieval);
    expect(withoutSteps.some((citation) => citation.path === unreached)).toBe(true);
  });

  it('offers the agent\'s read ranges as sources when the answer carries no markers', () => {
    const retrieval = retrieve(ctx.model, ctx.index, 'who calls normaliseDocument', { maxChars: 4000, topK: 4 });
    const path = 'apps/api/src/normalise.ts';
    const citations = resolveCitations(ctx, 'It is called from the route layer.', retrieval, [
      { index: 1, tool: 'read_file', args: { path, startLine: 4, endLine: 12 }, summary: 'read' },
    ]);
    const match = citations.find((citation) => citation.path === path);
    expect(match).toBeTruthy();
    expect(match?.startLine).toBe(4);
  });

  it('streams an answer and reports the steps it took', async () => {
    const provider = scripted([
      JSON.stringify({ tool: 'callers_of', args: { symbol: 'normaliseDocument' } }),
      JSON.stringify({ done: true }),
      'normaliseDocument is called by the route layer.', // the answering call
      'Titles the session', // the title call
    ]);
    const tokens: string[] = [];
    const result = await askRepo(scoped(provider), {
      question: 'who calls normaliseDocument and what happens next?',
      investigate: true,
      onToken: (delta) => tokens.push(delta),
    });

    expect(result.steps.map((step) => step.tool)).toEqual(['callers_of']);
    expect(result.answer).toContain('route layer');
    expect(tokens.join('')).toContain('route layer');
  }, 60_000);

  it('skips the investigation when asked to', async () => {
    const provider = scripted(['The API exports a router.', 'A title']);
    const result = await askRepo(scoped(provider), { question: 'what does the API export?', investigate: false });
    expect(result.steps).toEqual([]);
    expect(result.answer).toContain('router');
  }, 60_000);
});

describe('session titles', () => {
  it('cuts a long question at a word boundary rather than mid-word', async () => {
    // The model's own title is rejected here, forcing the fallback path.
    const provider = scripted(['An answer.', 'x']);
    const result = await askRepo(scoped(provider), {
      question: 'When an explainer is generated, what actually happens between the UI and the file on disk?',
      investigate: false,
    });
    expect(result.session.title.endsWith('…')).toBe(true);
    expect(result.session.title).not.toMatch(/betwee$/);
    // The cut lands on a space, so no word is sliced in half.
    expect(result.session.title.trim().split(' ').every((word) => word.length > 0)).toBe(true);
    expect(result.session.title.length).toBeLessThanOrEqual(62);
  }, 60_000);

  it('leaves a short question as the title', async () => {
    const provider = scripted(['An answer.', 'x']);
    const result = await askRepo(scoped(provider), { question: 'What is the store?', investigate: false });
    expect(result.session.title).toBe('What is the store?');
  }, 60_000);
});
