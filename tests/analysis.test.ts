import { describe, expect, it } from 'vitest';
import { extractCalls, extractRoutes, buildCallGraph, type CallGraphFile } from '../src/core/analysis/callgraph.js';
import { findBodyEnd } from '../src/core/analysis/bodies.js';
import { extractImports, extractSymbols, resolveSpecifier } from '../src/core/analysis/imports.js';
import { detectLanguage, classifyFile, isNoiseFile } from '../src/core/analysis/languages.js';
import { isHardIgnored } from '../src/core/util/fs.js';
import {
  classifyDependency,
  createDependencyAccumulator,
  dependencyNameFromSpecifier,
  extractContainerImages,
  extractEnvKeys,
  extractUrlSchemes,
} from '../src/core/analysis/stack.js';
import type { FileEntry } from '../src/core/types.js';

function fileEntry(filePath: string, symbols: FileEntry['symbols'] = []): FileEntry {
  return {
    path: filePath,
    size: 0,
    mtimeMs: 0,
    lines: 0,
    language: detectLanguage(filePath).id,
    category: classifyFile(filePath),
    isBinary: false,
    isNoise: isNoiseFile(filePath),
    symbols,
  };
}

describe('file classification', () => {
  it('recognises generated, vendored and test files', () => {
    expect(isHardIgnored('node_modules/left-pad/index.js')).toBe(true);
    expect(isHardIgnored('apps/api/dist/server.js')).toBe(true);
    expect(isHardIgnored('packages/lib/src/index.ts')).toBe(false);
    expect(isNoiseFile('package-lock.json')).toBe(true);
    expect(isNoiseFile('assets/app.min.js')).toBe(true);
    expect(classifyFile('apps/api/src/routes.test.ts')).toBe('test');
    expect(classifyFile('docs/architecture.md')).toBe('docs');
  });
});

describe('import extraction', () => {
  it('records local bindings for JS imports', () => {
    const text = [
      "import DefaultThing, { alpha, beta as gamma } from './mod';",
      "import * as ns from './namespace';",
      "const { helper: renamed } = require('./legacy');",
    ].join('\n');
    const imports = extractImports(text, 'src/example.ts');
    const localNames = imports.flatMap((entry) => entry.bindings.map((binding) => binding.local));
    expect(localNames).toContain('DefaultThing');
    expect(localNames).toContain('alpha');
    expect(localNames).toContain('gamma');
    expect(localNames).toContain('ns');
    expect(localNames).toContain('renamed');

    const namedTs = imports.find((entry) => entry.specifier === './mod');
    expect(namedTs?.bindings.find((binding) => binding.local === 'gamma')?.remote).toBe('beta');
  });

  it('records local bindings for Python imports', () => {
    const imports = extractImports('from .models import Document as Doc, User\nimport os.path as p\n', 'app/service.py');
    const flat = imports.flatMap((entry) => entry.bindings.map((binding) => `${binding.local}<-${binding.remote}`));
    expect(flat).toContain('Doc<-Document');
    expect(flat).toContain('User<-User');
    expect(flat).toContain('p<-os.path');
  });
});

describe('specifier resolution', () => {
  const known = new Set([
    'src/app.ts',
    'src/routes/index.ts',
    'src/lib/util.ts',
    'app/models.py',
    'app/service.py',
    'app/__init__.py',
    'pkg/utils.py',
    'pkg/sub/service.py',
  ]);

  it('resolves relative JS imports, with extension and index fallbacks', () => {
    expect(resolveSpecifier('src/app.ts', './lib/util', known)).toBe('src/lib/util.ts');
    expect(resolveSpecifier('src/app.ts', './routes', known)).toBe('src/routes/index.ts');
    expect(resolveSpecifier('src/app.ts', './missing', known)).toBeNull();
  });

  it('resolves alias roots', () => {
    expect(resolveSpecifier('src/app.ts', 'lib/util', known, ['src'])).toBe('src/lib/util.ts');
  });

  it('resolves Python relative imports, including parent packages', () => {
    expect(resolveSpecifier('app/service.py', '.models', known)).toBe('app/models.py');
    expect(resolveSpecifier('pkg/sub/service.py', '..utils', known)).toBe('pkg/utils.py');
    expect(resolveSpecifier('app/service.py', '.', known)).toBe('app/__init__.py');
  });

  it('returns null for external packages', () => {
    expect(resolveSpecifier('src/app.ts', 'react', known)).toBeNull();
  });
});

describe('body extent', () => {
  it('finds JS function bodies by brace matching', () => {
    const lines = ['function a() {', '  if (x) {', '    return "}";', '  }', '}', 'function b() {', '}'];
    expect(findBodyEnd(lines, 0, 'js')).toBe(4);
  });

  it('finds Python bodies by indentation', () => {
    const lines = ['def a():', '    x = 1', '    return x', '', 'def b():', '    pass'];
    expect(findBodyEnd(lines, 0, 'python')).toBe(2);
  });

  it('finds Ruby bodies by end matching', () => {
    const lines = ['def a', '  if x', '    y', '  end', 'end', 'def b', 'end'];
    expect(findBodyEnd(lines, 0, 'ruby')).toBe(4);
  });
});

describe('call extraction', () => {
  it('extracts bare, method and constructor calls while ignoring keywords', () => {
    const body = [
      'const value = normalise(input);',
      'this.persist(value);',
      'pool.query("select 1");',
      'const pooled = new Pool(options);',
      'if (value) { return value; }',
    ].join('\n');
    const calls = extractCalls(body, 10, 'js');
    const names = calls.map((call) => call.name);
    expect(names).toContain('normalise');
    expect(names).toContain('persist');
    expect(names).toContain('query');
    expect(names).toContain('Pool');
    expect(names).not.toContain('if');
    expect(calls.find((call) => call.name === 'Pool')?.kind).toBe('constructor');
    expect(calls.find((call) => call.name === 'persist')?.receiver).toBe('this');
  });
});

describe('call graph construction', () => {
  const files: CallGraphFile[] = [
    {
      path: 'src/service.ts',
      text: [
        "import { normalise } from './normalise';",
        "import { createPool } from './db';",
        '',
        'export class Service {',
        '  async ingest(input: unknown) {',
        '    const document = normalise(input);',
        '    await this.persist(document);',
        '    return document;',
        '  }',
        '',
        '  async persist(document: unknown) {',
        '    const pool = createPool("postgres://localhost");',
        '    return pool;',
        '  }',
        '}',
        '',
      ].join('\n'),
      entry: fileEntry('src/service.ts', [
        { name: 'Service', kind: 'class', exported: true, line: 4 },
        { name: 'ingest', kind: 'method', exported: false, line: 5 },
        { name: 'persist', kind: 'method', exported: false, line: 11 },
      ]),
      imports: extractImports(
        ["import { normalise } from './normalise';", "import { createPool } from './db';"].join('\n'),
        'src/service.ts',
      ),
    },
    {
      path: 'src/normalise.ts',
      text: ['export function normalise(input: unknown) {', '  return String(input);', '}', ''].join('\n'),
      entry: fileEntry('src/normalise.ts', [{ name: 'normalise', kind: 'function', exported: true, line: 1 }]),
      imports: [],
    },
    {
      path: 'src/db.ts',
      text: ['export function createPool(url: string) {', '  return { url };', '}', ''].join('\n'),
      entry: fileEntry('src/db.ts', [{ name: 'createPool', kind: 'function', exported: true, line: 1 }]),
      imports: [],
    },
    {
      path: 'src/server.ts',
      text: ["import { Service } from './service';", '', 'export function main() {', '  const service = new Service();', '  return service;', '}', ''].join('\n'),
      entry: fileEntry('src/server.ts', [{ name: 'main', kind: 'function', exported: true, line: 3 }]),
      imports: extractImports("import { Service } from './service';", 'src/server.ts'),
    },
  ];

  const known = new Set(files.map((file) => file.path));
  const result = buildCallGraph(files, known, { entrypointFiles: new Set(['src/server.ts']) });

  it('creates one record per definition with body extents', () => {
    const ingest = result.symbols.find((symbol) => symbol.name === 'ingest');
    expect(ingest).toBeDefined();
    expect(ingest?.container).toBe('Service');
    expect(ingest?.endLine).toBeGreaterThan(ingest?.line ?? 0);
  });

  it('resolves calls to local and imported definitions', () => {
    const normaliseCall = result.calls.find((call) => call.toName === 'normalise');
    expect(normaliseCall?.resolved).toBe(true);
    expect(normaliseCall?.toPath).toBe('src/normalise.ts');

    const persistCall = result.calls.find((call) => call.toName === 'persist');
    expect(persistCall?.resolved).toBe(true);
    expect(persistCall?.toPath).toBe('src/service.ts');
  });

  it('records caller counts', () => {
    const normalise = result.symbols.find((symbol) => symbol.name === 'normalise');
    expect(normalise?.callerCount).toBe(1);
  });

  it('marks what is reachable from the entrypoint', () => {
    const main = result.symbols.find((symbol) => symbol.name === 'main');
    expect(main?.entry).toBe(true);
    expect(main?.reachable).toBe(true);
    const createPool = result.symbols.find((symbol) => symbol.name === 'createPool');
    expect(createPool?.reachable).toBe(true);
  });
});

describe('dependency discovery', () => {
  it('names the identifier that is actually present, never a substitute', () => {
    // The whole point: no curated product list decides the name. `opensearchpy`
    // is reported as `opensearchpy`, not as a rival product.
    const classified = classifyDependency('opensearchpy', 'package');
    expect(classified.category).toBe('search');
    expect(classified.label).toBe('OpenSearch client');

    expect(classifyDependency('elasticsearch', 'package').label).toBe('Elasticsearch client');
    expect(classifyDependency('redis', 'package').category).toBe('cache');
    expect(classifyDependency('sqlx', 'package').category).toBe('database');
  });

  it('derives categories from the shape of scoped SDK specifiers', () => {
    expect(classifyDependency('@aws-sdk/client-sqs', 'package').category).toBe('queue');
    expect(classifyDependency('@aws-sdk/client-dynamodb', 'package').category).toBe('database');
    expect(classifyDependency('@aws-sdk/client-s3', 'package').category).toBe('storage');
    expect(classifyDependency('@google-cloud/storage', 'package').category).toBe('storage');
    expect(classifyDependency('@google-cloud/bigquery', 'package').category).toBe('database');
    expect(classifyDependency('@azure/service-bus', 'package').category).toBe('queue');
  });

  it('does not mislabel a base image because a package shares its last segment', () => {
    // Regression: `node:20-alpine` was reported as "Sentry" because @sentry/node
    // ends in `node`. Exact identifiers only.
    const baseImage = classifyDependency('node:20-alpine', 'image');
    expect(baseImage.label).toBeUndefined();
    expect(classifyDependency('@sentry/node', 'package').category).toBe('observability');
  });

  it('reports unknown identifiers instead of dropping them', () => {
    const classified = classifyDependency('some-inhouse-thing', 'package');
    expect(classified.category).toBe('dependency');
    expect(classified.label).toBeUndefined();
  });

  it('normalises import specifiers without inventing distribution names', () => {
    expect(dependencyNameFromSpecifier('react', 'js')).toBe('react');
    expect(dependencyNameFromSpecifier('@scope/pkg/sub/path', 'js')).toBe('@scope/pkg');
    expect(dependencyNameFromSpecifier('./local', 'js')).toBeNull();
    expect(dependencyNameFromSpecifier('node:fs', 'js')).toBeNull();
    // Python submodules are not separate dependencies.
    expect(dependencyNameFromSpecifier('google.cloud.storage', 'python')).toBe('google');
    expect(dependencyNameFromSpecifier('sqlalchemy.ext.asyncio', 'python')).toBe('sqlalchemy');
    expect(dependencyNameFromSpecifier('github.com/minio/minio-go/v7', 'go')).toBe('github.com/minio/minio-go/v7');
  });

  it('does not mistake a Python import inside a Dockerfile heredoc for an image', () => {
    // Regression: a case-insensitive FROM matched `from onyx.db.models import X`
    // in a heredoc and reported the module as a container image.
    const images = extractContainerImages(
      ['FROM python:3.12-slim', "RUN python - <<'PY'", 'from onyx.db.models import Document', 'PY', ''].join('\n'),
      'images/backend/Dockerfile',
    ).map((entry) => entry.name);
    expect(images).toEqual(['python:3.12-slim']);

    // Dotted names with no registry path or tag are module paths, not images.
    const dotted = extractContainerImages(
      ['services:', '  app:', '    image: onyx.configs.constants', '  db:', '    image: postgres:16', ''].join('\n'),
      'docker-compose.yml',
    ).map((entry) => entry.name);
    expect(dotted).toEqual(['postgres:16']);
  });

  it('ignores non-container files entirely', () => {
    const fromPython = extractContainerImages('from app.config import settings\n', 'app/config.py');
    expect(fromPython).toEqual([]);
    const fromYaml = extractContainerImages('image: postgres:16\n', 'data/fixtures.yaml');
    expect(fromYaml).toEqual([]);
  });

  it('reads container images out of compose files and Dockerfiles', () => {
    const compose = extractContainerImages(
      ['services:', '  db:', '    image: postgres:16', '  search:', '    image: opensearchproject/opensearch:2.11.0', ''].join('\n'),
      'docker-compose.yml',
    ).map((entry) => entry.name);
    expect(compose).toContain('postgres:16');
    expect(compose).toContain('opensearchproject/opensearch:2.11.0');

    const dockerfile = extractContainerImages('FROM node:20-alpine\nFROM postgres:16\n', 'Dockerfile').map((entry) => entry.name);
    expect(dockerfile).toContain('node:20-alpine');
    expect(dockerfile).toContain('postgres:16');
  });

  it('reads service-naming environment variables and ignores generic ones', () => {
    const keys = extractEnvKeys(
      ['DATABASE_URL=postgres://localhost/db', 'OPENSEARCH_HOST=http://localhost:9200', 'NODE_ENV=development', 'PORT=3000', ''].join('\n'),
      '.env.example',
    ).map((entry) => entry.name);
    expect(keys).toContain('DATABASE_URL');
    expect(keys).toContain('OPENSEARCH_HOST');
    expect(keys).not.toContain('NODE_ENV');
    expect(keys).not.toContain('PORT');
  });

  it('ignores credentials and schema fields for services it already knows', () => {
    const keys = extractEnvKeys(
      ['POSTGRES_HOST=localhost', 'POSTGRES_USER=admin', 'ACL_DB_NAME=acl', 'OPS_DASHBOARD_DB_PASSWORD=x', 'S3_BUCKET_NAME=b', 'OPENAI_API_KEY=sk', ''].join('\n'),
      '.env.example',
    ).map((entry) => entry.name);
    expect(keys).toEqual(expect.arrayContaining(['POSTGRES_HOST', 'OPENAI_API_KEY']));
    expect(keys).not.toContain('POSTGRES_USER');
    expect(keys).not.toContain('ACL_DB_NAME');
    expect(keys).not.toContain('OPS_DASHBOARD_DB_PASSWORD');
  });

  it('rejects junk specifiers that are not identifiers', () => {
    expect(dependencyNameFromSpecifier('=', 'python')).toBeNull();
    expect(dependencyNameFromSpecifier('...', 'python')).toBeNull();
    expect(dependencyNameFromSpecifier('$VAR', 'python')).toBeNull();
    expect(dependencyNameFromSpecifier('fastapi', 'python')).toBe('fastapi');
  });

  it('reads environment variables out of code', () => {
    const keys = extractEnvKeys(
      ['const url = process.env.DATABASE_URL;', 'const key = process.env["OPENAI_API_KEY"];', ''].join('\n'),
      'src/config.ts',
    ).map((entry) => entry.name);
    expect(keys).toEqual(expect.arrayContaining(['DATABASE_URL', 'OPENAI_API_KEY']));
  });

  it('reads connection-string schemes but ignores plain web URLs', () => {
    const schemes = extractUrlSchemes(
      ['DATABASE_URL=postgres://localhost/db', 'CACHE=redis://localhost', 'DOCS=https://example.com', ''].join('\n'),
      '.env.example',
    ).map((entry) => entry.name);
    expect(schemes).toContain('postgres');
    expect(schemes).toContain('redis');
    expect(schemes).not.toContain('https');
  });

  it('builds an inventory that keeps names exact and counts references', () => {
    const accumulator = createDependencyAccumulator();
    accumulator.add('opensearchpy', 'package', 'app/search.py');
    accumulator.add('opensearchpy', 'package', 'app/index.py');
    accumulator.add('opensearchproject/opensearch:2.11.0', 'image', 'docker-compose.yml');
    accumulator.add('OPENSEARCH_HOST', 'env', '.env.example');

    const dependencies = accumulator.finish();
    const names = dependencies.map((dependency) => dependency.name);
    expect(names).toEqual(expect.arrayContaining(['opensearchpy', 'opensearchproject/opensearch:2.11.0', 'OPENSEARCH_HOST']));
    expect(names.some((name) => /elasticsearch/i.test(name))).toBe(false);

    const pkg = dependencies.find((dependency) => dependency.name === 'opensearchpy');
    expect(pkg?.references).toBe(2);
    expect(pkg?.evidence).toHaveLength(2);
    // Configuration evidence is ranked above package imports.
    expect(dependencies[0].kind).toBe('image');
  });
});

describe('route extraction', () => {
  it('extracts FastAPI decorator routes with their handler', () => {
    const text = [
      '@app.get("/health")',
      'async def health():',
      '    return {"ok": True}',
      '',
      '@router.post(',
      '    "/documents",',
      '    status_code=201,',
      ')',
      'async def create_document(payload: dict):',
      '    return payload',
      '',
    ].join('\n');
    const routes = extractRoutes([
      {
        path: 'app/main.py',
        text,
        entry: fileEntry('app/main.py', [
          { name: 'health', kind: 'function', exported: false, line: 2 },
          { name: 'create_document', kind: 'function', exported: false, line: 9 },
        ]),
        imports: [],
      },
    ]);
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual(['GET /health', 'POST /documents']);
    expect(routes).toHaveLength(2);
    expect(routes.find((route) => route.path === '/health')?.handler).toBe('health');
    expect(routes.find((route) => route.path === '/documents')?.handler).toBe('create_document');
  });

  it('extracts Express routes and file-based routes', () => {
    const routes = extractRoutes([
      {
        path: 'src/app.ts',
        text: ["app.get('/users/:id', getUser);", "router.post('/users', async (req, res) => res.end());", ''].join('\n'),
        entry: fileEntry('src/app.ts', [{ name: 'getUser', kind: 'function', exported: true, line: 5 }]),
        imports: [],
      },
      { path: 'app/api/documents/route.ts', text: 'export async function GET() { return new Response(); }\n', entry: fileEntry('app/api/documents/route.ts', [{ name: 'GET', kind: 'function', exported: true, line: 1 }]), imports: [] },
    ]);
    expect(routes.some((route) => route.path === '/users/:id' && route.method === 'GET')).toBe(true);
    expect(routes.some((route) => route.path === '/users' && route.method === 'POST')).toBe(true);
    expect(routes.some((route) => route.path === '/api/documents')).toBe(true);
  });
});

describe('symbol extraction', () => {
  it('finds exported and internal definitions across languages', () => {
    const ts = extractSymbols('export class A {}\nfunction b() {}\nexport const c = () => 1;\n', 'x.ts');
    expect(ts.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(['A', 'b', 'c']));

    const py = extractSymbols('class Thing:\n    def method(self):\n        pass\n\ndef helper():\n    pass\n', 'x.py');
    expect(py.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual(expect.arrayContaining(['class:Thing', 'function:method', 'function:helper']));

    const go = extractSymbols('package main\n\ntype Server struct{}\n\nfunc (s *Server) Handle() error { return nil }\n', 'x.go');
    expect(go.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(['Server', 'Handle']));
  });
});
