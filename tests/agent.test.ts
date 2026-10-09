import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, ensureDirs } from '../src/core/config.js';
import { Store } from '../src/core/store.js';
import { RepoService, type RepoContext } from '../src/core/service.js';
import { MockProvider } from '../src/core/llm/mock.js';
import { runTool, toolCatalogue, toolNames } from '../src/core/agent/tools.js';
import { explore } from '../src/core/agent/explorer.js';
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

describe('agent tools', () => {
  it('exposes a catalogue with unique names', () => {
    const names = toolNames();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('read_file');
    expect(names).toContain('callers_of');
    expect(names).toContain('trace_calls');
    expect(toolCatalogue()).toContain('search_code');
  });

  it('lists directories and reads files with line numbers', async () => {
    const listing = await runTool(ctx, { tool: 'list_dir', args: { path: 'apps/api/src' } });
    expect(listing.failed).toBeFalsy();
    expect(listing.text).toContain('normalise.ts');

    const file = await runTool(ctx, { tool: 'read_file', args: { path: 'apps/api/src/normalise.ts', startLine: 1, endLine: 6 } });
    expect(file.text).toContain('normaliseDocument');
    expect(file.text).toMatch(/^\s*1 \|/m);
    expect(file.sources?.[0].path).toBe('apps/api/src/normalise.ts');
  });

  it('refuses to read outside the repository root', async () => {
    const result = await runTool(ctx, { tool: 'read_file', args: { path: '../../etc/passwd' } });
    expect(result.failed).toBe(true);
  });

  it('finds symbols and reports their callers and callees', async () => {
    const found = await runTool(ctx, { tool: 'find_symbol', args: { name: 'normaliseDocument' } });
    expect(found.text).toContain('apps/api/src/normalise.ts');

    const callers = await runTool(ctx, { tool: 'callers_of', args: { symbol: 'normaliseDocument' } });
    expect(callers.text).toContain('registerRoutes');

    const callees = await runTool(ctx, { tool: 'callees_of', args: { symbol: 'registerRoutes' } });
    expect(callees.text).toContain('normaliseDocument');
  });

  it('expands a class into its methods', async () => {
    const callees = await runTool(ctx, { tool: 'callees_of', args: { symbol: 'IngestService' } });
    expect(callees.text).toMatch(/persist|prepare/);
  });

  it('traces a call tree', async () => {
    const trace = await runTool(ctx, { tool: 'trace_calls', args: { symbol: 'registerRoutes', depth: 3 } });
    expect(trace.text).toContain('registerRoutes');
    expect(trace.text.length).toBeGreaterThan(40);
  });

  it('lists routes, entrypoints and dependencies', async () => {
    const routes = await runTool(ctx, { tool: 'list_routes', args: {} });
    expect(routes.text).toContain('GET /health');

    const entries = await runTool(ctx, { tool: 'list_entrypoints', args: {} });
    expect(entries.text).toContain('apps/api/src/server.ts');

    const services = await runTool(ctx, { tool: 'list_dependencies', args: {} });
    expect(services.text).toContain('opensearchpy');
    expect(services.text).toContain('postgres:16');
    expect(services.text).toContain('Use these exact names');
  });

  it('searches code and reads the README', async () => {
    const search = await runTool(ctx, { tool: 'search_code', args: { query: 'slugify', limit: 5 } });
    expect(search.text.toLowerCase()).toContain('slug');

    const readme = await runTool(ctx, { tool: 'read_readme', args: {} });
    expect(readme.text).toContain('Fixture Monorepo');
  });

  it('reports unknown tools instead of throwing', async () => {
    const result = await runTool(ctx, { tool: 'does_not_exist', args: {} });
    expect(result.failed).toBe(true);
    expect(result.text).toContain('Unknown tool');
  });
});

/* ------------------------------------------------------------------ *
 * Exploration loop
 * ------------------------------------------------------------------ */

function finalExplainer(): string {
  return JSON.stringify({
    final: {
      title: 'Fixture architecture',
      subtitle: 'A tiny monorepo',
      tldr: 'Documents arrive at the API, are normalised, and go to Postgres.',
      sections: [
        { type: 'prose', title: 'What it does', markdown: 'It ingests documents.', level: 'narrow' },
        { type: 'prose', title: 'Background', markdown: 'The domain is document ingestion.', level: 'deep' },
        {
          type: 'diagram',
          title: 'Flow',
          diagram: { kind: 'flow', nodes: [{ id: 'a', label: 'API' }, { id: 'b', label: 'DB' }], edges: [{ from: 'a', to: 'b' }] },
        },
        { type: 'list', title: 'Components', items: [{ term: 'api', detail: 'The HTTP service.' }] },
        { type: 'callout', title: 'Sharp edges', variant: 'edge', markdown: 'No retries on persist.' },
      ],
      quiz: [{ question: 'Where do documents go?', options: ['Postgres', 'S3'], answer: 0, explanation: 'createPool uses pg.' }],
      next: [],
      sources: [{ path: 'apps/api/src/routes.ts', startLine: 1, endLine: 4 }],
    },
  });
}

/** A thin explainer: too few sections, no quiz. */
function thinExplainer(): string {
  return JSON.stringify({
    final: {
      title: 'Thin',
      subtitle: '',
      tldr: 'Barely anything.',
      sections: [{ type: 'prose', title: 'Only one', markdown: 'Not much here.', level: 'narrow' }],
      quiz: [],
      next: [],
      sources: [],
    },
  });
}

/** The sections a model would return when asked to fill in what it missed. */
function gapFillSections(): string {
  return JSON.stringify({
    sections: [
      { type: 'diagram', title: 'Flow', diagram: { kind: 'flow', nodes: [{ id: 'a', label: 'API' }, { id: 'b', label: 'DB' }], edges: [{ from: 'a', to: 'b' }] } },
      { type: 'list', title: 'Components', items: [{ term: 'api', detail: 'The HTTP service.' }] },
      { type: 'callout', title: 'Edges', variant: 'edge', markdown: 'No retries on persist.' },
      { type: 'steps', title: 'How to orient', steps: [{ label: 'Read routes.ts', detail: 'It defines the surface.' }] },
    ],
  });
}

/** The three investigations every grounded explainer should start with. */
const INVESTIGATE = [
  JSON.stringify({ thought: 'Start with the endpoints.', tool: 'list_routes', args: {} }),
  JSON.stringify({ thought: 'Where does execution begin?', tool: 'list_entrypoints', args: {} }),
  JSON.stringify({ thought: 'Read the core file.', tool: 'read_file', args: { path: 'apps/api/src/routes.ts' } }),
];

function scripted(responses: string[]): MockProvider {
  const queue = [...responses];
  return new MockProvider((_request: LlmRequest) => queue.shift() ?? '{}');
}

async function runLoop(responses: string[], maxSteps = 5) {
  const provider = scripted(responses);
  const scoped: RepoContext = { ...ctx, provider, providerId: 'mock', modelName: 'mock-1' };
  const steps: string[] = [];
  const result = await explore(
    scoped,
    {
      scope: 'repo',
      target: { kind: 'repo-overview', id: 'root', label: 'fixture', level: 0 },
      goal: 'Explain the repository.',
      seed: 'fixture',
      nextOptions: [],
      siblingNames: [],
      next: [],
    },
    { maxSteps, onStep: (step) => steps.push(step.tool) },
  );
  return { result, steps, provider };
}

/**
 * An explainer whose prose quotes prose — the single largest cause of good
 * responses being discarded, because the quotes are unescaped and the result is
 * not valid JSON.
 */
function quotedExplainer(): string {
  return (
    '{"final":{"title":"Eight analyses","tldr":"It says "no CI" here.",' +
    '"sections":[{"type":"prose","title":"Background","markdown":"The tool reports "no CI definitions found"."},' +
    '{"type":"prose","title":"Detail","markdown":"It names "PostgreSQL" as a store."},' +
    '{"type":"list","title":"Parts","items":[{"term":"gaps","detail":"Reports what is "absent"."}]},' +
    '{"type":"callout","title":"Edge","variant":"edge","markdown":"A "digest" budget is not a finding."},' +
    '{"type":"prose","title":"More","markdown":"Enough sections to be usable."}],' +
    '"next":[],"sources":[{"path":"apps/api/src/routes.ts","startLine":1,"endLine":4}]}}'
  );
}

describe('exploration loop', () => {
  it('investigates with tools and then writes the explainer', async () => {
    const { result, steps } = await runLoop([...INVESTIGATE, finalExplainer()]);
    expect(steps).toEqual(['list_routes', 'list_entrypoints', 'read_file']);
    expect(result.explainer.title).toBe('Fixture architecture');
    expect(result.explainer.sections.some((section) => section.type === 'quiz')).toBe(true);
    expect(result.explainer.provider).toBe('mock');
    expect(result.truncated).toBe(false);
  }, 30_000);

  it('refuses to write before investigating', async () => {
    const { result, steps } = await runLoop([finalExplainer(), ...INVESTIGATE, finalExplainer()]);
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(result.explainer.title).toBe('Fixture architecture');
  }, 30_000);

  it('fills in the missing sections when the first attempt is incomplete', async () => {
    const { result } = await runLoop([...INVESTIGATE, thinExplainer(), gapFillSections()]);
    // The model's own title and prose are kept; only the gaps are added.
    expect(result.explainer.title).toBe('Thin');
    const types = result.explainer.sections.map((section) => section.type);
    expect(types).toEqual(expect.arrayContaining(['prose', 'diagram', 'list', 'callout', 'steps']));
  }, 30_000);

  it('keeps the thin explainer when the gap fill produces nothing usable', async () => {
    const { result } = await runLoop([...INVESTIGATE, thinExplainer(), 'not json']);
    expect(result.explainer.title).toBe('Thin');
    expect(result.explainer.sections.length).toBeGreaterThan(0);
  }, 30_000);

  it('writes up the investigation when the model stops producing usable turns', async () => {
    // Three unparseable replies used to abort the whole run, which skipped the
    // compact write path and left the reader with a static outline even though
    // everything needed for an explainer had already been read.
    const { result } = await runLoop([...INVESTIGATE, 'not json at all', 'still not json', 'nor this', finalExplainer()], 5);
    expect(result.explainer.title).toBe('Fixture architecture');
    expect(result.truncated).toBe(true);
    expect(result.steps.length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('keeps an explainer whose prose contains unescaped quotes', async () => {
    const { result } = await runLoop([...INVESTIGATE, quotedExplainer()]);
    expect(result.explainer.title).toBe('Eight analyses');
    expect(result.explainer.tldr).toBe('It says "no CI" here.');
    expect(result.explainer.sections[0].type).toBe('prose');
  }, 30_000);

  it('accepts a model that invents a "final" tool', async () => {
    const payload = JSON.parse(finalExplainer()) as { final: unknown };
    const { result } = await runLoop([...INVESTIGATE, JSON.stringify({ tool: 'final', args: payload.final })]);
    expect(result.explainer.title).toBe('Fixture architecture');
  }, 30_000);

  it('accepts a bare explainer object with no protocol wrapper', async () => {
    const payload = JSON.parse(finalExplainer()) as { final: Record<string, unknown> };
    const { result } = await runLoop([...INVESTIGATE, JSON.stringify(payload.final)]);
    expect(result.explainer.title).toBe('Fixture architecture');
  }, 30_000);

  it('accepts provider-style tool-call shapes', async () => {
    const { result, steps } = await runLoop([
      JSON.stringify({ name: 'list_routes', arguments: {} }),
      JSON.stringify({ tool_calls: [{ function: { name: 'list_entrypoints', arguments: '{}' } }] }),
      JSON.stringify({ list_dir: { path: 'apps/api/src' } }),
      JSON.stringify({ action: { tool: 'search_code', args: { query: 'slugify' } } }),
      finalExplainer(),
    ]);
    expect(steps).toEqual(['list_routes', 'list_entrypoints', 'list_dir', 'search_code']);
    expect(result.explainer.title).toBe('Fixture architecture');
  }, 30_000);

  it('does not repeat an identical tool call', async () => {
    const { steps } = await runLoop([
      ...INVESTIGATE,
      JSON.stringify({ tool: 'list_routes', args: {} }),
      finalExplainer(),
    ]);
    expect(steps).toEqual(['list_routes', 'list_entrypoints', 'read_file']);
  }, 30_000);

  it('recovers from invalid JSON', async () => {
    const { result, steps } = await runLoop(['this is not json at all', ...INVESTIGATE, finalExplainer()]);
    expect(steps).toEqual(['list_routes', 'list_entrypoints', 'read_file']);
    expect(result.explainer.title).toBe('Fixture architecture');
  }, 30_000);

  it('forces a final answer when the step budget runs out', async () => {
    const replies = [
      ...INVESTIGATE,
      JSON.stringify({ tool: 'list_files', args: {} }),
      finalExplainer(),
    ];
    const { result } = await runLoop(replies, 3);
    expect(result.truncated).toBe(true);
    expect(result.explainer.title).toBe('Fixture architecture');
  }, 30_000);

  it('throws a clear error when the model never produces anything usable', async () => {
    await expect(runLoop(['nope', 'still nope', 'nope again'], 3)).rejects.toThrow(/valid JSON|explainer/);
  }, 30_000);

  it('records sources gathered during exploration', async () => {
    const { result } = await runLoop([...INVESTIGATE, finalExplainer()]);
    expect(result.explainer.sources.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('truncated answers', () => {
  it('asks for a complete answer when the JSON was cut off', async () => {
    // Regression: the model wrote its answer during a planning turn, was capped
    // at 4000 tokens, and the salvaged fragment sometimes had no usable section,
    // so a successful run showed the static outline instead.
    const complete = JSON.parse(finalExplainer()) as { final: { sections: unknown[] } };
    const cutOff = JSON.stringify({ final: { ...complete.final, sections: complete.final.sections.slice(0, 1) } }).slice(0, -40);

    const { result, steps } = await runLoop([...INVESTIGATE, cutOff, finalExplainer()]);
    expect(steps).toEqual(['list_routes', 'list_entrypoints', 'read_file']);
    expect(result.explainer.degraded).toBeUndefined();
    expect(result.explainer.sections.filter((section) => section.type !== 'quiz').length).toBeGreaterThanOrEqual(5);
  }, 30_000);

  it('still returns something rather than failing when the retry is also cut off', async () => {
    const complete = JSON.parse(finalExplainer()) as { final: { sections: unknown[] } };
    const cutOff = JSON.stringify({ final: { ...complete.final, sections: complete.final.sections.slice(0, 2) } }).slice(0, -30);

    const { result } = await runLoop([...INVESTIGATE, cutOff, cutOff]);
    // The partial explainer is kept: better than losing the investigation.
    expect(result.explainer.sections.length).toBeGreaterThan(0);
  }, 30_000);
});
