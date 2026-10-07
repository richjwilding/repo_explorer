import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeRepo } from '../src/core/analysis/analyzeRepo.js';
import { buildIndex } from '../src/core/index/indexer.js';
import { loadConfig, ensureDirs } from '../src/core/config.js';
import { Store } from '../src/core/store.js';
import { RepoService } from '../src/core/service.js';
import { buildRepoDigest } from '../src/core/explain/digest.js';
import { buildStaticQuiz, structuralRepoExplainer, structuralComponentExplainer } from '../src/core/explain/structural.js';
import { explainerIsUsable, normalizeExplainer } from '../src/core/explain/schema.js';
import { exportExplainer } from '../src/core/explain/exportHtml.js';
import { MockProvider } from '../src/core/llm/mock.js';
import { createFixtureRepo, createTempHome, type FixtureRepo } from './helpers/fixtureRepo.js';
import type { RepoModel } from '../src/core/types.js';

let fixture: FixtureRepo;
let model: RepoModel;

beforeAll(async () => {
  fixture = createFixtureRepo();
  model = await analyzeRepo(fixture.root);
}, 60_000);

afterAll(() => fixture?.cleanup());

describe('repository analysis', () => {
  it('discovers workspace packages as components', () => {
    const names = model.components.map((component) => component.name);
    expect(names).toContain('api');
    expect(names).toContain('web');
    expect(names).toContain('lib');
  });

  it('excludes vendored and generated directories', () => {
    expect(model.files.some((file) => file.path.includes('node_modules'))).toBe(false);
    expect(model.files.some((file) => file.path.startsWith('apps/api/dist/'))).toBe(false);
    expect(model.files.some((file) => file.path.startsWith('apps/api/src/generated/'))).toBe(true);
  });

  it('classifies components by what they import', () => {
    const api = model.components.find((component) => component.path === 'apps/api');
    const web = model.components.find((component) => component.path === 'apps/web');
    const lib = model.components.find((component) => component.path === 'packages/lib');
    expect(api?.kind).toBe('api');
    expect(web?.kind).toBe('ui');
    expect(lib?.kind).toBe('library');
  });

  it('finds entrypoints from manifests and conventions', () => {
    const paths = model.entrypoints.map((entrypoint) => entrypoint.path);
    expect(paths).toContain('apps/api/src/server.ts');
    expect(paths).toContain('apps/web/src/main.tsx');
  });

  it('extracts HTTP routes with method, path and handler', () => {
    const rules = model.routes.map((route) => `${route.method} ${route.path}`);
    expect(rules).toContain('GET /health');
    expect(rules).toContain('POST /documents');
    expect(rules).toContain('GET /documents/:id');
    expect(model.routes.find((route) => route.path === '/health')?.handler).toBe('healthCheck');
  });

  it('builds a symbol-level call graph with resolved edges', () => {
    expect(model.symbols.length).toBeGreaterThan(20);
    const resolved = model.calls.filter((call) => call.resolved);
    expect(resolved.length).toBeGreaterThan(5);

    const ingest = model.calls.find((call) => call.toName === 'normaliseDocument');
    expect(ingest?.resolved).toBe(true);
    expect(ingest?.toPath).toBe('apps/api/src/normalise.ts');

    const methodCall = model.calls.find((call) => call.toName === 'persist');
    expect(methodCall?.resolved).toBe(true);
  });

  it('identifies unreachable code in modules nothing imports', () => {
    const names = model.deadCode.map((candidate) => candidate.name);
    expect(names).toContain('removedHelper');
    // Code that *is* reachable must not be reported as dead.
    expect(names).not.toContain('normaliseDocument');
    expect(names).not.toContain('createPool');
  });

  it('discovers dependencies from imports, images, env keys and URLs', () => {
    const names = model.dependencies.map((dependency) => dependency.name);

    // Packages actually imported by the code.
    expect(names).toContain('zod');
    expect(names).toContain('fastify');

    // Container images and environment variables from real configuration files.
    expect(names).toContain('postgres:16');
    expect(names).toContain('OPENSEARCH_HOST');
    expect(names).toContain('DATABASE_URL');

    // A connection-string scheme, which is a protocol fact rather than a guess.
    const schemes = model.dependencies.filter((dependency) => dependency.kind === 'url').map((dependency) => dependency.name);
    expect(schemes).toContain('postgres');

    // The python import is reported under its own name, never a rival product.
    const searchPackage = model.dependencies.find((dependency) => dependency.category === 'search' && dependency.kind === 'package');
    expect(searchPackage?.name).toBe('opensearchpy');
    const searchImage = model.dependencies.find((dependency) => dependency.category === 'search' && dependency.kind === 'image');
    expect(searchImage?.name).toBe('opensearchproject/opensearch:2.11.0');
    expect(names.some((name) => /elasticsearch/i.test(name))).toBe(false);

    // Generic environment variables are not treated as services.
    expect(names).not.toContain('NODE_ENV');

    // Every entry records where it was found.
    for (const dependency of model.dependencies) {
      expect(dependency.evidence.length).toBeGreaterThan(0);
      expect(dependency.references).toBeGreaterThan(0);
    }
  });

  it('summarises the stack', () => {
    expect(model.stack.primaryLanguage).toBe('typescript');
    expect(model.stack.frameworks).toContain('React');
    expect(model.stack.runtimes).toContain('Node.js');
    expect(model.stack.packageManagers).toContain('npm');
  });

  it('produces a graph with a root node and component children', () => {
    const root = model.graph.nodes.find((node) => node.id === 'root');
    expect(root).toBeDefined();
    expect(root?.children.length).toBeGreaterThan(0);
  });

  it('computes churn and hotspots when git history exists', () => {
    if (!fixture.hasGit) return;
    expect(model.git.churn.length).toBeGreaterThan(0);
    expect(model.hotspots.length).toBeGreaterThan(0);
    expect(model.hotspots.some((hotspot) => hotspot.path === 'apps/api/src/normalise.ts')).toBe(true);
  });

  it('writes a digest containing routes, call-graph hubs and hotspots', () => {
    const digest = buildRepoDigest(model);
    expect(digest).toContain('Components');
    expect(digest).toContain('HTTP / RPC endpoints');
    expect(digest).toContain('Call graph');
    expect(digest).toContain('GET /health');
  });

  it('drops drill-down targets that cannot be resolved', async () => {
    const temp = createTempHome();
    try {
      const cfg = loadConfig({ home: temp.home, dataDir: `${temp.home}/data`, cacheDir: `${temp.home}/cache`, exportDir: `${temp.home}/exports`, provider: 'mock' });
      ensureDirs(cfg);
      const service = new RepoService(cfg, new Store(cfg));
      const ctx = await service.open(fixture.root, { force: true });

      const { repoExplainer } = await import('../src/core/explain/generate.js');
      const explainer = await repoExplainer(ctx);

      // Every offered target must be something we can actually generate.
      for (const item of explainer.next) {
        if (item.kind === 'component') {
          expect(ctx.model.components.some((component) => component.id === item.id)).toBe(true);
        }
        if (item.kind === 'module') {
          expect(ctx.model.modules.some((module) => module.id === item.id)).toBe(true);
        }
      }
    } finally {
      temp.cleanup();
    }
  }, 60_000);

  it('can build a factual quiz from the analysis alone', () => {
    const quiz = buildStaticQuiz(model);
    expect(quiz).not.toBeNull();
    if (!quiz || quiz.type !== 'quiz') return;
    expect(quiz.questions.length).toBeGreaterThan(0);
    for (const question of quiz.questions) {
      expect(question.options.length).toBeGreaterThanOrEqual(3);
      expect(question.answer).toBeGreaterThanOrEqual(0);
      expect(question.answer).toBeLessThan(question.options.length);
      expect(question.explanation.length).toBeGreaterThan(10);
    }
  });

  it('renders and caches structural fallback explainers', () => {
    const explainer = structuralRepoExplainer(model);
    expect(explainerIsUsable(explainer)).toBe(true);
    expect(explainer.degraded).toBe(true);
    expect(explainer.sections.length).toBeGreaterThan(2);

    const component = model.components.find((candidate) => candidate.path === 'apps/api');
    expect(component).toBeDefined();
    if (component) {
      const componentExplainer = structuralComponentExplainer(model, component);
      expect(explainerIsUsable(componentExplainer)).toBe(true);
      expect(componentExplainer.next.length).toBeGreaterThan(0);
    }
  });
});

describe('componentisation', () => {
  it('descends through a single source root instead of reporting it as one component', async () => {
    // Regression: a single-package project has no workspace manifests, so the
    // analysis anchored on `src/` and reported the entire system as one
    // component called "src" — a one-box "shape of the system" diagram.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-explorer-single-'));
    try {
      const write = (relative: string, contents: string) => {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
      };
      write('package.json', JSON.stringify({ name: 'single-package', dependencies: { fastify: '^4.0.0' } }));
      write('README.md', '# Single package\n');
      for (const dir of ['analysis', 'server', 'web']) {
        for (let index = 0; index < 3; index += 1) {
          write(`src/${dir}/file${index}.ts`, `export function ${dir}${index}() {\n  return ${index};\n}\n`);
        }
      }
      write('src/core/util/one.ts', 'export const one = 1;\n');
      write('src/core/util/two.ts', 'export const two = 2;\n');
      write('src/main.ts', 'export const bootstrap = 1;\n');
      // A lockfile must not make a directory look substantial.
      write('package-lock.json', `${'  "filler": 1,\n'.repeat(4000)}`);

      const single = await analyzeRepo(root);
      const names = single.components.map((component) => component.name);

      // The source root itself is not a component; its children are.
      expect(names).not.toContain('src');
      expect(names).toEqual(expect.arrayContaining(['analysis', 'server', 'web']));

      // The lockfile does not inflate anything to thousands of lines.
      for (const component of single.components) {
        expect(component.loc).toBeLessThan(2000);
      }

      // A component with no source of its own is supporting material, not a peer.
      const rootComponent = single.components.find((component) => component.name === 'Root');
      if (rootComponent) expect(rootComponent.ancillary).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('leaves a workspace layout alone, since those directories are real units', () => {
    // The fixture uses apps/* and packages/*, each owning a manifest.
    const names = model.components.map((component) => component.name);
    expect(names).toEqual(expect.arrayContaining(['api', 'web', 'lib']));
    expect(names).not.toContain('apps');
    expect(names).not.toContain('packages');
  });
});

describe('search index', () => {
  it('retrieves the right file for a symbol query', async () => {
    const index = await buildIndex(fixture.root, model, { maxFiles: 500 });
    expect(index.chunkCount).toBeGreaterThan(10);
    const hits = index.search('normaliseDocument', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.path).toBe('apps/api/src/normalise.ts');
  }, 30_000);

  it('retrieves by natural-language-ish query', async () => {
    const index = await buildIndex(fixture.root, model, { maxFiles: 500 });
    const hits = index.search('ingest document postgres pool', 5);
    const paths = hits.map((hit) => hit.chunk.path);
    expect(paths.some((file) => file.startsWith('apps/api/src/'))).toBe(true);
  }, 30_000);
});

describe('explainer normalisation', () => {
  it('keeps valid sections and drops unusable ones', () => {
    const explainer = normalizeExplainer(
      {
        title: 'Test explainer',
        subtitle: 'sub',
        tldr: 'A short summary.',
        sections: [
          { type: 'prose', title: 'Good', markdown: 'text' },
          { type: 'prose', title: 'Empty', markdown: '' },
          { type: 'diagram', title: 'Broken diagram', diagram: { kind: 'flow', nodes: [] } },
          {
            type: 'diagram',
            title: 'Good diagram',
            diagram: { kind: 'flow', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] },
          },
          { type: 'quiz', title: 'nope', questions: [] },
          { type: 'unknown', title: 'ignored' },
        ],
        quiz: [
          { question: 'Q1', options: ['a', 'b'], answer: 9, explanation: 'because' },
          { question: 'Q2', options: ['a'], answer: 0, explanation: '' },
        ],
      },
      {
        kind: 'repo-overview',
        target: { kind: 'repo-overview', id: 'root', label: 'fixture', level: 0 },
        provider: 'test',
        model: 'test-1',
        sources: [],
        next: [{ id: 'cmp', label: 'Component', kind: 'component', hint: '' }],
      },
    );

    const types = explainer.sections.map((section) => section.type);
    expect(types).toContain('prose');
    expect(types).toContain('diagram');
    expect(types).toContain('quiz');
    // The empty prose section and the invalid diagram were dropped.
    expect(explainer.sections.filter((section) => section.type === 'prose')).toHaveLength(1);
    expect(explainer.sections.filter((section) => section.type === 'diagram')).toHaveLength(1);

    const quiz = explainer.sections.find((section) => section.type === 'quiz');
    expect(quiz && quiz.type === 'quiz' && quiz.questions).toHaveLength(1);
    expect(quiz && quiz.type === 'quiz' && quiz.questions[0].answer).toBe(0);
    expect(explainer.next[0].label).toBe('Component');
  });

  it('accepts diagrams that reference nodes by label instead of id', () => {
    const explainer = normalizeExplainer(
      {
        title: 'Diagram tolerance',
        tldr: 'Testing diagram normalisation.',
        sections: [
          {
            type: 'diagram',
            title: 'Sequence by label',
            diagram: {
              kind: 'sequence',
              actors: [{ id: 'client', label: 'Client' }, { id: 'api', label: 'API' }, { id: 'db', label: 'Database' }],
              steps: [
                { from: 'Client', to: 'API', label: 'POST /documents' },
                { from: 'API', to: 'Database', label: 'insert' },
              ],
            },
          },
          {
            type: 'diagram',
            title: 'Flow by label',
            diagram: {
              kind: 'flow',
              nodes: [{ id: 'a', label: 'Gateway' }, { id: 'b', label: 'Service' }],
              edges: [{ from: 'Gateway', to: 'Service', label: 'forwards' }],
            },
          },
          {
            type: 'diagram',
            title: 'Unresolvable nodes are dropped',
            diagram: {
              kind: 'sequence',
              actors: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
              steps: [{ from: 'Nowhere', to: 'Elsewhere', label: 'nope' }],
            },
          },
        ],
      },
      {
        kind: 'repo-overview',
        target: { kind: 'repo-overview', id: 'root', label: 'fixture', level: 0 },
        provider: 'test',
        model: 'test-1',
        sources: [],
        next: [],
      },
    );

    const diagrams = explainer.sections.filter((section) => section.type === 'diagram');
    expect(diagrams).toHaveLength(2);
    const sequence = diagrams[0];
    expect(sequence.type === 'diagram' && sequence.diagram.kind === 'sequence' && sequence.diagram.steps).toHaveLength(2);
    const flow = diagrams[1];
    expect(flow.type === 'diagram' && flow.diagram.kind === 'flow' && flow.diagram.edges[0]).toEqual({
      from: 'a',
      to: 'b',
      label: 'forwards',
      dashed: undefined,
    });
  });

  it('escapes model-provided HTML in the exported file', () => {
    const explainer = structuralRepoExplainer(model);
    explainer.sections.push({
      type: 'prose',
      id: 'xss',
      title: 'Injected',
      markdown: '<img src=x onerror="alert(1)">',
      level: 'narrow',
    });
    const { html, filename } = exportExplainer(explainer, model);
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}-explanation-/);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('white-space: pre-wrap');
    expect(html).toContain('<!doctype html>');
  });

  it('renders each quiz exactly once', () => {
    const explainer = structuralRepoExplainer(model);
    explainer.sections.push({
      type: 'quiz',
      id: 'quiz',
      title: 'Check your understanding',
      questions: [{ id: 'q1', question: 'Q?', options: ['a', 'b'], answer: 0, explanation: 'because' }],
    });
    const { html } = exportExplainer(explainer, model);
    const rendered = html.match(/<p class="quiz-prompt">/g) ?? [];
    expect(rendered).toHaveLength(1);
    const headings = html.match(/Check your understanding/g) ?? [];
    // Once in the body, once as the table-of-contents entry.
    expect(headings).toHaveLength(2);
    expect((html.match(/id="quiz"/g) ?? [])).toHaveLength(1);
  });

  it('embeds deeper explainers so "Where to go next" is a working link', () => {
    const parent = structuralRepoExplainer(model);
    parent.next = [
      { id: 'cmp', label: 'The API', kind: 'component', hint: 'HTTP service' },
      { id: 'mod', label: 'apps/api/src', kind: 'module', hint: '24 files' },
    ];
    const component = model.components.find((candidate) => candidate.path === 'apps/api');
    expect(component).toBeDefined();
    if (!component) return;

    const child = structuralComponentExplainer(model, component);
    const { html } = exportExplainer(parent, model, [{ explainer: child, label: 'The API' }]);

    // A real anchor target, a real link, and the child's own sections present.
    expect(html).toContain('id="go-0"');
    expect(html).toContain('class="next-link" href="#go-0"');
    expect(html).toContain('id="go-0-s1"');
    expect(html).toContain('Back to the top');
    // Targets that were not embedded are called out rather than silently dropped.
    expect(html).toContain('Not included here');
    expect(html).toContain('apps/api/src');
    // The child page title appears in the table of contents.
    expect(html).toContain('Deeper<ol>');
  });

  it('renders an interactive quiz in exported HTML', () => {
    const explainer = structuralRepoExplainer(model);
    explainer.sections.push({
      type: 'quiz',
      id: 'quiz',
      title: 'Check your understanding',
      questions: [
        {
          id: 'q1',
          question: 'Which component handles HTTP?',
          options: ['api', 'web', 'lib'],
          answer: 0,
          explanation: 'The api package imports fastify.',
        },
      ],
    });
    const { html } = exportExplainer(explainer, model);
    expect(html).toContain('data-answer="0"');
    expect(html).toContain('data-explanation="The api package imports fastify."');
    expect(html).toContain('quiz-option');
    expect(html).toContain('<script>');
  });
});

describe('service layer', () => {
  it('analyses, persists and re-opens a repository without losing data', async () => {
    const temp = createTempHome();
    try {
      const cfg = loadConfig({ home: temp.home, dataDir: `${temp.home}/data`, cacheDir: `${temp.home}/cache`, exportDir: `${temp.home}/exports`, provider: 'mock' });
      ensureDirs(cfg);
      const store = new Store(cfg);
      const service = new RepoService(cfg, store);

      const ctx = await service.open(fixture.root, { force: true, onProgress: () => undefined });
      expect(ctx.model.repo.name).toBeTruthy();
      expect(ctx.provider.id).toBe('mock');
      expect(ctx.index.chunkCount).toBeGreaterThan(0);

      const stored = await store.readModel(ctx.model.repo.id);
      expect(stored?.version).toBe(ctx.model.version);

      const reopened = await service.open(ctx.model.repo.id);
      expect(reopened.model.repo.id).toBe(ctx.model.repo.id);
      expect(reopened.index.chunkCount).toBeGreaterThan(0);

      const records = await service.listRepos();
      expect(records.some((record) => record.repo.id === ctx.model.repo.id)).toBe(true);
    } finally {
      temp.cleanup();
    }
  }, 60_000);

  it('reuses the cached analysis when re-opened by path', async () => {
    const temp = createTempHome();
    try {
      const cfg = loadConfig({
        home: temp.home,
        dataDir: `${temp.home}/data`,
        cacheDir: `${temp.home}/cache`,
        exportDir: `${temp.home}/exports`,
        provider: 'mock',
      });
      ensureDirs(cfg);

      // A fresh service instance simulates a server restart.
      const first = await new RepoService(cfg, new Store(cfg)).open(fixture.root, { force: true });
      expect(first.model.generatedAt).toBeTruthy();

      let analyses = 0;
      const second = await new RepoService(cfg, new Store(cfg)).open(fixture.root, {
        onProgress: (message) => {
          if (message.startsWith('Analysing ')) analyses += 1;
        },
      });
      expect(analyses).toBe(0);
      expect(second.model.generatedAt).toBe(first.model.generatedAt);
      expect(second.model.repo.id).toBe(first.model.repo.id);
      expect(second.index.chunkCount).toBeGreaterThan(0);

      // Opening by id hits the same cache.
      const third = await new RepoService(cfg, new Store(cfg)).open(first.model.repo.id);
      expect(third.model.generatedAt).toBe(first.model.generatedAt);
    } finally {
      temp.cleanup();
    }
  }, 60_000);

  it('builds and caches a change with diff and stats', async () => {
    if (!fixture.hasGit) return;
    const temp = createTempHome();
    try {
      const cfg = loadConfig({ home: temp.home, dataDir: `${temp.home}/data`, cacheDir: `${temp.home}/cache`, exportDir: `${temp.home}/exports`, provider: 'mock' });
      ensureDirs(cfg);
      const store = new Store(cfg);
      const service = new RepoService(cfg, store);
      const ctx = await service.open(fixture.root, { force: true });

      const change = await service.change(ctx, { kind: 'commit', sha: 'HEAD' });
      expect(change.files.length).toBeGreaterThan(0);
      expect(change.stats.additions).toBeGreaterThan(0);
      expect(change.files.some((file) => file.path === 'apps/api/src/normalise.ts')).toBe(true);

      const cached = await store.readChange(ctx.model.repo.id, change.id);
      expect(cached?.id).toBe(change.id);
    } finally {
      temp.cleanup();
    }
  }, 60_000);

  it('falls back to a structural explainer when the provider is the mock', async () => {
    const temp = createTempHome();
    try {
      const cfg = loadConfig({ home: temp.home, dataDir: `${temp.home}/data`, cacheDir: `${temp.home}/cache`, exportDir: `${temp.home}/exports`, provider: 'mock' });
      ensureDirs(cfg);
      const store = new Store(cfg);
      const service = new RepoService(cfg, store);
      const ctx = await service.open(fixture.root, { force: true });
      const provider = new MockProvider();
      ctx.provider = provider;
      ctx.providerId = 'mock';

      const { repoExplainer } = await import('../src/core/explain/generate.js');
      const explainer = await repoExplainer(ctx);
      expect(explainer.provider).toBe('none');
      expect(explainerIsUsable(explainer)).toBe(true);
    } finally {
      temp.cleanup();
    }
  }, 60_000);
});

describe('section titles', () => {
  it('drops a leading file count, keeping the concept', () => {
    const cleanup = (title: string) =>
      normalizeExplainer(
        { title: 't', tldr: 'x', sections: [{ type: 'prose', title, markdown: 'body' }] },
        { kind: 'repo-overview', target: { kind: 'repo-overview', id: 'root', label: 'r', level: 0 }, provider: 't', model: 't', sources: [], next: [] },
      ).sections[0];
    const first = cleanup('Seven files, four responsibilities');
    expect(first.type === 'prose' && first.title).toBe('Four responsibilities');
    expect(cleanup('What this component is and is not').type === 'prose' && (cleanup('What this component is and is not') as { title: string }).title).toBe(
      'What this component is and is not',
    );
    // A title that is only a count is left alone rather than invented.
    const onlyCount = cleanup('Seven files');
    expect(onlyCount.type === 'prose' && onlyCount.title).toBe('Seven files');
  });
});
