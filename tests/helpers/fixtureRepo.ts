import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface FixtureRepo {
  root: string;
  cleanup(): void;
  hasGit: boolean;
}

interface Files {
  [relativePath: string]: string;
}

const FILES: Files = {
  'package.json': JSON.stringify(
    {
      name: 'fixture-monorepo',
      private: true,
      workspaces: ['apps/*', 'packages/*'],
      devDependencies: { typescript: '^5.0.0', vitest: '^1.0.0' },
    },
    null,
    2,
  ),
  'README.md': [
    '# Fixture Monorepo',
    '',
    'A tiny system used by the test suite. It has an HTTP API, a worker, a React UI, and a shared library.',
    '',
    'The central concept is the **ingest job**: documents arrive, get normalised, and are written to Postgres.',
    '',
  ].join('\n'),

  'apps/api/package.json': JSON.stringify(
    {
      name: '@fixture/api',
      main: 'src/server.ts',
      scripts: { start: 'node src/server.ts', test: 'vitest run' },
      dependencies: { fastify: '^4.0.0', pg: '^8.0.0', zod: '^3.0.0' },
    },
    null,
    2,
  ),
  'apps/api/src/server.ts': [
    "import { createApp } from './app';",
    "import { loadConfig } from './config';",
    '',
    'export async function main(): Promise<void> {',
    '  const config = loadConfig();',
    '  const app = createApp(config);',
    '  await app.listen({ port: config.port });',
    '}',
    '',
    "if (require.main === module) {",
    '  void main();',
    '}',
    '',
  ].join('\n'),
  'apps/api/src/app.ts': [
    "import { registerRoutes } from './routes';",
    "import { IngestService } from './ingest-service';",
    "import { createPool } from './db';",
    '',
    'export interface Config {',
    '  port: number;',
    '  databaseUrl: string;',
    '}',
    '',
    'export function createApp(config: Config) {',
    '  const pool = createPool(config.databaseUrl);',
    '  const service = new IngestService(pool);',
    '  const app = {',
    '    listen: async ({ port }: { port: number }) => {',
    '      registerRoutes(app, service);',
    '      return port;',
    '    },',
    '  };',
    '  return app;',
    '}',
    '',
  ].join('\n'),
  'apps/api/src/routes.ts': [
    "import { IngestService } from './ingest-service';",
    "import { normaliseDocument } from './normalise';",
    '',
    'export function registerRoutes(app: any, service: IngestService): void {',
    "  app.get('/health', healthCheck);",
    "  app.post('/documents', async (request: any) => {",
    '    const document = normaliseDocument(request.body);',
    '    return service.ingest(document);',
    '  });',
    "  app.get('/documents/:id', async (request: any) => service.findById(request.params.id));",
    '}',
    '',
    'export function healthCheck(): { ok: boolean } {',
    '  return { ok: true };',
    '}',
    '',
  ].join('\n'),
  'apps/api/src/ingest-service.ts': [
    'export interface Document {',
    '  id: string;',
    '  title: string;',
    '  body: string;',
    '}',
    '',
    'export class IngestService {',
    '  constructor(private readonly pool: unknown) {}',
    '',
    '  async ingest(document: Document): Promise<Document> {',
    '    const prepared = this.prepare(document);',
    '    await this.persist(prepared);',
    '    return prepared;',
    '  }',
    '',
    '  prepare(document: Document): Document {',
    '    return { ...document, title: document.title.trim() };',
    '  }',
    '',
    '  async persist(document: Document): Promise<void> {',
    '    await (this.pool as any).query("insert into documents values ($1)", [document.id]);',
    '  }',
    '',
    '  async findById(id: string): Promise<Document | null> {',
    '    return (this.pool as any).query("select * from documents where id = $1", [id]);',
    '  }',
    '}',
    '',
  ].join('\n'),
  'apps/api/src/normalise.ts': [
    "import { z } from 'zod';",
    "import type { Document } from './ingest-service';",
    '',
    'const schema = z.object({ id: z.string(), title: z.string(), body: z.string() });',
    '',
    'export function normaliseDocument(input: unknown): Document {',
    '  return schema.parse(input) as Document;',
    '}',
    '',
    'export function unusedLegacyNormaliser(input: unknown): unknown {',
    '  return input;',
    '}',
    '',
  ].join('\n'),
  'apps/api/src/db.ts': [
    "import { Pool } from 'pg';",
    '',
    'export function createPool(databaseUrl: string) {',
    '  return new Pool({ connectionString: databaseUrl });',
    '}',
    '',
    'export function closePool(pool: any): Promise<void> {',
    '  return pool.end();',
    '}',
    '',
  ].join('\n'),
  'apps/api/src/config.ts': [
    'export interface Config {',
    '  port: number;',
    '  databaseUrl: string;',
    '}',
    '',
    'export function loadConfig(): Config {',
    '  return {',
    "    port: Number(process.env.PORT ?? 8080),",
    "    databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost/fixture',",
    '    openaiKey: process.env.OPENAI_API_KEY,',
    '  };',
    '}',
    '',
  ].join('\n'),
  'apps/api/src/routes.test.ts': [
    "import { normaliseDocument } from './normalise';",
    '',
    "describe('normaliseDocument', () => {",
    "  it('parses a document', () => {",
    "    expect(normaliseDocument({ id: 'a', title: ' b ', body: 'c' })).toBeTruthy();",
    '  });',
    '});',
    '',
  ].join('\n'),

  'apps/web/package.json': JSON.stringify(
    { name: '@fixture/web', main: 'src/main.tsx', dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' } },
    null,
    2,
  ),
  'apps/web/src/main.tsx': [
    "import { createRoot } from 'react-dom/client';",
    "import { DocumentList } from './document-list';",
    '',
    'const root = createRoot(document.getElementById("root")!);',
    'root.render(<DocumentList />);',
    '',
  ].join('\n'),
  'apps/web/src/document-list.tsx': [
    "import { useEffect, useState } from 'react';",
    '',
    'export function DocumentList() {',
    '  const [documents, setDocuments] = useState([]);',
    '  useEffect(() => {',
    "    void fetch('/documents').then((response) => response.json()).then(setDocuments);",
    '  }, []);',
    '  return <ul>{documents.length} documents</ul>;',
    '}',
    '',
  ].join('\n'),

  'packages/lib/package.json': JSON.stringify(
    { name: '@fixture/lib', main: 'src/index.ts', dependencies: {} },
    null,
    2,
  ),
  'packages/lib/src/index.ts': [
    "export { slugify } from './slugify';",
    "export { truncateText } from './truncate';",
    '',
  ].join('\n'),
  'packages/lib/src/slugify.ts': [
    'export function slugify(input: string): string {',
    "  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-');",
    '}',
    '',
  ].join('\n'),
  'packages/lib/src/truncate.ts': [
    'export function truncateText(input: string, max: number): string {',
    "  return input.length <= max ? input : `${input.slice(0, max)}…`;",
    '}',
    '',
  ].join('\n'),
  'packages/lib/src/legacy.ts': [
    'export function removedHelper(value: string): string {',
    '  return value.split("").reverse().join("");',
    '}',
    '',
  ].join('\n'),
  'packages/lib/src/util.py': [
    'from opensearchpy import OpenSearch',
    '',
    '',
    'def slugify_python(value: str) -> str:',
    '    """Slugify a value the Python way."""',
    '    return "-".join(value.lower().split())',
    '',
    '',
    'class LegacyExporter:',
    '    def export(self, rows):',
    '        return [slugify_python(row) for row in rows]',
    '',
  ].join('\n'),

  'docs/architecture.md': [
    '# Architecture',
    '',
    'Documents flow from the API into Postgres. The ingest job is idempotent.',
    '',
  ].join('\n'),
  'docker-compose.yml': [
    'services:',
    '  db:',
    '    image: postgres:16',
    '  search:',
    '    image: opensearchproject/opensearch:2.11.0',
    '  cache:',
    '    image: redis:7-alpine',
    '',
  ].join('\n'),
  '.env.example': [
    'DATABASE_URL=postgres://localhost:5432/fixture',
    'OPENSEARCH_HOST=http://localhost:9200',
    'REDIS_URL=redis://localhost:6379',
    'NODE_ENV=development',
    '',
  ].join('\n'),
  'Dockerfile': ['FROM node:20', 'CMD ["node", "apps/api/src/server.ts"]', ''].join('\n'),
  '.gitignore': ['node_modules', 'dist', ''].join('\n'),
  // Committed build output and vendored code must be ignored by the analysis.
  'node_modules/left-pad/index.js': 'module.exports = function leftPad() {};\n',
  'apps/api/dist/server.js': 'console.log("compiled output");\n',
  'apps/api/src/generated/client.ts': 'export const generatedClient = {};\n',
};

/** Create a small, realistic multi-language repository in a temp directory. */
export function createFixtureRepo(): FixtureRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-explorer-fixture-'));
  for (const [relative, contents] of Object.entries(FILES)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, 'utf8');
  }

  let hasGit = false;
  try {
    const run = (args: string[]) =>
      execFileSync('git', args, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' } });
    run(['init', '-q']);
    run(['config', 'user.email', 'fixture@example.com']);
    run(['config', 'user.name', 'Fixture']);
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'Initial fixture commit', '--no-gpg-sign']);
    // A second commit that touches one file, so churn has something to report.
    fs.appendFileSync(path.join(root, 'apps/api/src/normalise.ts'), '\nexport const REVISION = 2;\n');
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'Bump revision', '--no-gpg-sign']);
    hasGit = true;
  } catch {
    hasGit = false;
  }

  return {
    root,
    hasGit,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** A temp directory suitable for the app's data/export dirs. */
export function createTempHome(): { home: string; cleanup(): void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-explorer-home-'));
  return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}
