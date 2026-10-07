import path from 'node:path';
import { builtinModules } from 'node:module';
import type { DependencyCategory, DependencyKind, ExternalDependency, StackInfo } from '../types.js';
import { readTextFileSync } from '../util/fs.js';


interface PackageJson {
  name?: string;
  main?: string;
  module?: string;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: unknown;
}

export interface ManifestInfo {
  path: string;
  kind: 'node' | 'python' | 'go' | 'rust' | 'jvm' | 'ruby' | 'php' | 'dotnet' | 'other';
  name?: string;
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
  entryHints: string[];
  raw?: PackageJson;
}

const FRAMEWORK_HINTS: { pattern: RegExp; label: string }[] = [
  { pattern: /^react$|^react-dom$/, label: 'React' },
  { pattern: /^next$/, label: 'Next.js' },
  { pattern: /^nuxt/, label: 'Nuxt' },
  { pattern: /^vue$/, label: 'Vue' },
  { pattern: /^svelte/, label: 'Svelte' },
  { pattern: /^@angular\//, label: 'Angular' },
  { pattern: /^astro$/, label: 'Astro' },
  { pattern: /^solid-js$/, label: 'SolidJS' },
  { pattern: /^express$/, label: 'Express' },
  { pattern: /^fastify$/, label: 'Fastify' },
  { pattern: /^koa$/, label: 'Koa' },
  { pattern: /^hapi$|^@hapi\//, label: 'Hapi' },
  { pattern: /^@nestjs\//, label: 'NestJS' },
  { pattern: /^electron$/, label: 'Electron' },
  { pattern: /^@tauri-apps\//, label: 'Tauri' },
  { pattern: /^tailwindcss$/, label: 'Tailwind CSS' },
  { pattern: /^prisma$|^@prisma\//, label: 'Prisma' },
  { pattern: /^typeorm$/, label: 'TypeORM' },
  { pattern: /^sequelize$/, label: 'Sequelize' },
  { pattern: /^mongoose$/, label: 'Mongoose' },
  { pattern: /^@trpc\//, label: 'tRPC' },
  { pattern: /^redux$|^@reduxjs\//, label: 'Redux' },
  { pattern: /^apollo|^@apollo\//, label: 'Apollo GraphQL' },
  { pattern: /^graphql$/, label: 'GraphQL' },
  { pattern: /^zod$/, label: 'Zod' },
  { pattern: /^socket\.io$/, label: 'Socket.IO' },
  { pattern: /^vite$/, label: 'Vite' },
  { pattern: /^webpack$/, label: 'webpack' },
  { pattern: /^rollup$/, label: 'Rollup' },
  { pattern: /^esbuild$/, label: 'esbuild' },
  { pattern: /^turbo$/, label: 'Turborepo' },
  { pattern: /^lerna$/, label: 'Lerna' },
  { pattern: /^typescript$/, label: 'TypeScript' },
  { pattern: /^fastapi$/, label: 'FastAPI' },
  { pattern: /^django$|^djangorestframework$/, label: 'Django' },
  { pattern: /^flask$/, label: 'Flask' },
  { pattern: /^pydantic$/, label: 'Pydantic' },
  { pattern: /^sqlalchemy$/, label: 'SQLAlchemy' },
  { pattern: /^celery$/, label: 'Celery' },
  { pattern: /^pandas$/, label: 'pandas' },
  { pattern: /^numpy$/, label: 'NumPy' },
  { pattern: /^torch$|^pytorch/, label: 'PyTorch' },
  { pattern: /^tensorflow$/, label: 'TensorFlow' },
  { pattern: /^langchain/, label: 'LangChain' },
  { pattern: /^anthropic$/, label: 'Anthropic SDK' },
  { pattern: /^openai$/, label: 'OpenAI SDK' },
  { pattern: /^gin-gonic\/gin$|^gin$/, label: 'Gin' },
  { pattern: /^labstack\/echo$/, label: 'Echo' },
  { pattern: /^gofiber\/fiber$/, label: 'Fiber' },
  { pattern: /^gorm\.io\/gorm$/, label: 'GORM' },
  { pattern: /^spf13\/cobra$/, label: 'Cobra' },
  { pattern: /^actix-web$/, label: 'Actix Web' },
  { pattern: /^axum$/, label: 'Axum' },
  { pattern: /^tokio$/, label: 'Tokio' },
  { pattern: /^serde$/, label: 'Serde' },
  { pattern: /^clap$/, label: 'clap' },
  { pattern: /^spring-boot|^org\.springframework/, label: 'Spring Boot' },
  { pattern: /^rails$|^railties$/, label: 'Ruby on Rails' },
  { pattern: /^sinatra$/, label: 'Sinatra' },
  { pattern: /^laravel\/framework$/, label: 'Laravel' },
  { pattern: /^symfony\//, label: 'Symfony' },
];

const TEST_FRAMEWORK_HINTS: { pattern: RegExp; label: string }[] = [
  { pattern: /^jest$/, label: 'Jest' },
  { pattern: /^vitest$/, label: 'Vitest' },
  { pattern: /^mocha$/, label: 'Mocha' },
  { pattern: /^jasmine$/, label: 'Jasmine' },
  { pattern: /^ava$/, label: 'AVA' },
  { pattern: /^@playwright\/test$|^playwright$/, label: 'Playwright' },
  { pattern: /^cypress$/, label: 'Cypress' },
  { pattern: /^pytest$/, label: 'pytest' },
  { pattern: /^unittest$/, label: 'unittest' },
  { pattern: /^nose$/, label: 'nose' },
  { pattern: /^rspec$/, label: 'RSpec' },
  { pattern: /^junit/, label: 'JUnit' },
  { pattern: /^googletest$|^gtest$/, label: 'GoogleTest' },
  { pattern: /^xunit$/, label: 'xUnit' },
];

function matchHints(names: string[], hints: { pattern: RegExp; label: string }[]): string[] {
  const found = new Set<string>();
  for (const name of names) {
    const bare = name.replace(/^@types\//, '');
    for (const hint of hints) {
      if (hint.pattern.test(bare) || hint.pattern.test(name)) found.add(hint.label);
    }
  }
  return [...found].sort();
}

function parsePackageJson(file: string): ManifestInfo | null {
  const text = readTextFileSync(file);
  if (!text) return null;
  try {
    const pkg = JSON.parse(text) as PackageJson;
    const deps = Object.keys(pkg.dependencies ?? {});
    const dev = Object.keys(pkg.devDependencies ?? {});
    const peer = Object.keys(pkg.peerDependencies ?? {});
    const entryHints: string[] = [];
    if (typeof pkg.main === 'string') entryHints.push(pkg.main);
    if (typeof pkg.module === 'string') entryHints.push(pkg.module);
    if (typeof pkg.bin === 'string') entryHints.push(pkg.bin);
    else if (pkg.bin) entryHints.push(...Object.values(pkg.bin));
    return {
      path: file,
      kind: 'node',
      name: pkg.name,
      scripts: pkg.scripts ?? {},
      dependencies: [...deps, ...peer],
      devDependencies: dev,
      entryHints,
      raw: pkg,
    };
  } catch {
    return null;
  }
}

/**
 * PEP 621 declares dependencies as an array rather than a table:
 *   dependencies = [ "fastapi>=0.110", "opensearch-py" ]
 * which the table parser cannot see, so poetry-style projects looked empty.
 */
function parseTomlDependencyArrays(text: string): string[] {
  const names: string[] = [];
  const arrayRe = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/gm;
  for (const match of text.matchAll(arrayRe)) {
    for (const quoted of match[1].matchAll(/["']([^"']+)["']/g)) {
      const name = quoted[1].split(/[<>=!~;[\s]/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function parseTomlDeps(text: string, sectionPattern: RegExp): string[] {
  const names: string[] = [];
  let inSection = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inSection = sectionPattern.test(line);
      continue;
    }
    if (!inSection || !line || line.startsWith('#')) continue;
    const m = line.match(/^["']?([A-Za-z0-9_.@/-]+)["']?\s*[=:]/);
    if (m) names.push(m[1]);
  }
  return names;
}

export function readManifests(root: string, paths: string[]): ManifestInfo[] {
  const manifests: ManifestInfo[] = [];
  const lower = new Map(paths.map((p) => [p.toLowerCase(), p]));

  for (const [lowerPath, original] of lower) {
    const base = lowerPath.split('/').pop() ?? '';
    const abs = path.join(root, original);
    if (base === 'package.json') {
      const info = parsePackageJson(abs);
      if (info) {
        info.path = original;
        manifests.push(info);
      }
    } else if (base === 'pyproject.toml') {
      const text = readTextFileSync(abs);
      if (text) {
        const deps = [
          ...parseTomlDependencyArrays(text),
          ...parseTomlDeps(text, /\[(?:tool\.poetry\.dependencies|project\.dependencies|tool\.pdm\.dependencies|dependencies)\]/),
          ...parseTomlDeps(text, /\[project\.optional-dependencies[^\]]*\]/),
          ...parseTomlDeps(text, /\[tool\.poetry\.group\.[^\]]*\]/),
        ];
        const nameMatch = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
        manifests.push({ path: original, kind: 'python', name: nameMatch?.[1], scripts: {}, dependencies: deps, devDependencies: [], entryHints: [] });
      }
    } else if (base === 'requirements.txt' || base === 'requirements-dev.txt' || base.endsWith('.requirements.txt')) {
      const text = readTextFileSync(abs);
      if (text) {
        const deps = text
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#') && !l.startsWith('-'))
          .map((l) => l.split(/[<>=!~\[; ]/)[0])
          .filter(Boolean);
        manifests.push({ path: original, kind: 'python', scripts: {}, dependencies: deps, devDependencies: base.includes('dev') ? deps : [], entryHints: [] });
      }
    } else if (base === 'go.mod') {
      const text = readTextFileSync(abs);
      if (text) {
        const deps = [...text.matchAll(/^\s*(?:require\s+)?([a-z0-9.\-]+\.[a-z]{2,}\/[^\s]+)\s+v/gim)].map((m) => m[1]);
        const moduleMatch = text.match(/^module\s+(\S+)/m);
        manifests.push({ path: original, kind: 'go', name: moduleMatch?.[1], scripts: {}, dependencies: [...new Set(deps)], devDependencies: [], entryHints: [] });
      }
    } else if (base === 'cargo.toml') {
      const text = readTextFileSync(abs);
      if (text) {
        const deps = [...parseTomlDeps(text, /^\[(?:dependencies|dev-dependencies|build-dependencies)/), ...parseTomlDeps(text, /^\[target\..*dependencies.*\]/)];
        const nameMatch = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
        manifests.push({ path: original, kind: 'rust', name: nameMatch?.[1], scripts: {}, dependencies: deps, devDependencies: [], entryHints: [] });
      }
    } else if (base === 'pom.xml') {
      const text = readTextFileSync(abs);
      if (text) {
        const deps = [...text.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map((m) => m[1]);
        const nameMatch = text.match(/<artifactId>([^<]+)<\/artifactId>/);
        manifests.push({ path: original, kind: 'jvm', name: nameMatch?.[1], scripts: {}, dependencies: deps.slice(0, 60), devDependencies: [], entryHints: [] });
      }
    } else if (base === 'build.gradle' || base === 'build.gradle.kts') {
      const text = readTextFileSync(abs);
      if (text) {
        const deps = [...text.matchAll(/["']([a-zA-Z0-9_.\-]+:[a-zA-Z0-9_.\-]+)(?::[^"']*)?["']/g)].map((m) => m[1]);
        manifests.push({ path: original, kind: 'jvm', scripts: {}, dependencies: [...new Set(deps)], devDependencies: [], entryHints: [] });
      }
    } else if (base === 'gemfile') {
      const text = readTextFileSync(abs);
      if (text) {
        const deps = [...text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((m) => m[1]);
        manifests.push({ path: original, kind: 'ruby', scripts: {}, dependencies: deps, devDependencies: [], entryHints: [] });
      }
    } else if (base === 'composer.json') {
      const text = readTextFileSync(abs);
      if (text) {
        try {
          const json = JSON.parse(text) as { name?: string; require?: Record<string, string>; 'require-dev'?: Record<string, string> };
          manifests.push({
            path: original,
            kind: 'php',
            name: json.name,
            scripts: {},
            dependencies: Object.keys(json.require ?? {}),
            devDependencies: Object.keys(json['require-dev'] ?? {}),
            entryHints: [],
          });
        } catch {
          /* ignore malformed composer.json */
        }
      }
    } else if (base.endsWith('.csproj') || base.endsWith('.fsproj')) {
      const text = readTextFileSync(abs);
      if (text) {
        const deps = [...text.matchAll(/<PackageReference\s+Include="([^"]+)"/g)].map((m) => m[1]);
        manifests.push({ path: original, kind: 'dotnet', name: base.replace(/\.(cs|fs)proj$/, ''), scripts: {}, dependencies: deps, devDependencies: [], entryHints: [] });
      }
    }
  }

  return manifests;
}

export function buildStack(paths: string[], languages: { language: string; files: number; loc: number }[], manifests: ManifestInfo[]): StackInfo {
  const allDeps = manifests.flatMap((m) => [...m.dependencies, ...m.devDependencies]);
  const frameworks = matchHints(allDeps, FRAMEWORK_HINTS);
  const testFrameworks = matchHints(allDeps, TEST_FRAMEWORK_HINTS);

  const packageManagers = new Set<string>();
  for (const p of paths) {
    const base = p.split('/').pop()?.toLowerCase() ?? '';
    if (base === 'package.json') packageManagers.add(p.includes('pnpm-lock') ? 'pnpm' : 'npm');
    if (base === 'pnpm-lock.yaml' || base === 'pnpm-workspace.yaml') packageManagers.add('pnpm');
    if (base === 'yarn.lock') packageManagers.add('yarn');
    if (base === 'bun.lockb' || base === 'bun.lock') packageManagers.add('bun');
    if (base === 'poetry.lock' || base === 'pyproject.toml') packageManagers.add('poetry/uv');
    if (base === 'requirements.txt' || base === 'pipfile') packageManagers.add('pip');
    if (base === 'go.mod') packageManagers.add('go modules');
    if (base === 'cargo.toml') packageManagers.add('cargo');
    if (base === 'gemfile') packageManagers.add('bundler');
    if (base === 'composer.json') packageManagers.add('composer');
    if (base === 'pom.xml') packageManagers.add('maven');
    if (base === 'build.gradle' || base === 'build.gradle.kts') packageManagers.add('gradle');
    if (base === 'dockerfile') packageManagers.add('docker');
  }
  if (packageManagers.size === 0 && manifests.some((m) => m.kind === 'node')) packageManagers.add('npm');

  const runtimes = new Set<string>();
  if (manifests.some((m) => m.kind === 'node')) runtimes.add('Node.js');
  if (manifests.some((m) => m.kind === 'python')) runtimes.add('Python');
  if (manifests.some((m) => m.kind === 'go')) runtimes.add('Go');
  if (manifests.some((m) => m.kind === 'rust')) runtimes.add('Rust');
  if (manifests.some((m) => m.kind === 'jvm')) runtimes.add('JVM');
  if (manifests.some((m) => m.kind === 'ruby')) runtimes.add('Ruby');
  if (manifests.some((m) => m.kind === 'dotnet')) runtimes.add('.NET');
  if (paths.some((p) => p.toLowerCase().endsWith('dockerfile'))) runtimes.add('Docker');

  const ci = new Set<string>();
  for (const p of paths) {
    if (p.startsWith('.github/workflows/')) ci.add('GitHub Actions');
    if (p === '.gitlab-ci.yml') ci.add('GitLab CI');
    if (p === 'Jenkinsfile' || p.endsWith('/Jenkinsfile')) ci.add('Jenkins');
    if (p === '.circleci/config.yml') ci.add('CircleCI');
    if (p === '.travis.yml') ci.add('Travis CI');
    if (p === 'azure-pipelines.yml') ci.add('Azure Pipelines');
    if (p === 'buildkite.yml' || p === '.buildkite/pipeline.yml') ci.add('Buildkite');
    if (p === 'bitbucket-pipelines.yml') ci.add('Bitbucket Pipelines');
  }

  const sortedLanguages = [...languages].filter((l) => l.language !== 'unknown').sort((a, b) => b.loc - a.loc);

  return {
    primaryLanguage: sortedLanguages[0]?.language ?? null,
    languages: sortedLanguages,
    packageManagers: [...packageManagers],
    frameworks,
    runtimes: [...runtimes],
    testFrameworks,
    ci: [...ci],
  };
}

/* ------------------------------------------------------------------ *
 * External dependencies
 * ------------------------------------------------------------------ *
 *
 * These are discovered, not guessed. Four kinds of evidence, in descending
 * order of authority:
 *
 *   1. container images          docker-compose / Dockerfile / k8s manifests
 *   2. environment variable keys .env files and os.environ / process.env reads
 *   3. URL schemes               connection-string defaults (postgres://, redis://)
 *   4. package specifiers        imports that did not resolve inside the repo
 *
 * The dependency's `name` is always the literal identifier found. We never scan
 * file bodies for product names: a curated list of products would be
 * incomplete by construction, would drift, and — as this codebase learned the
 * hard way — a merged pattern like /elasticsearch|opensearch/ reports the wrong
 * product with total confidence.
 */

/** Generic scheme → category. A URL scheme is a fact, not a guess about a vendor. */
const SCHEME_CATEGORIES: Record<string, { category: DependencyCategory; label: string }> = {
  postgres: { category: 'database', label: 'PostgreSQL' },
  postgresql: { category: 'database', label: 'PostgreSQL' },
  mysql: { category: 'database', label: 'MySQL' },
  mariadb: { category: 'database', label: 'MariaDB' },
  mongodb: { category: 'database', label: 'MongoDB' },
  redis: { category: 'cache', label: 'Redis' },
  rediss: { category: 'cache', label: 'Redis (TLS)' },
  amqp: { category: 'queue', label: 'AMQP' },
  amqps: { category: 'queue', label: 'AMQP (TLS)' },
  kafka: { category: 'queue', label: 'Kafka' },
  nats: { category: 'queue', label: 'NATS' },
  sqs: { category: 'queue', label: 'Amazon SQS' },
  s3: { category: 'storage', label: 'S3-compatible object storage' },
  gs: { category: 'storage', label: 'Google Cloud Storage' },
  azblob: { category: 'storage', label: 'Azure Blob Storage' },
  elasticsearch: { category: 'search', label: 'Elasticsearch' },
  opensearch: { category: 'search', label: 'OpenSearch' },
  neo4j: { category: 'database', label: 'Neo4j' },
  clickhouse: { category: 'database', label: 'ClickHouse' },
  etcd: { category: 'database', label: 'etcd' },
  vault: { category: 'auth', label: 'HashiCorp Vault' },
  http: { category: 'http', label: 'HTTP' },
  https: { category: 'http', label: 'HTTPS' },
  ws: { category: 'http', label: 'WebSocket' },
  wss: { category: 'http', label: 'WebSocket (TLS)' },
  grpc: { category: 'http', label: 'gRPC' },
};

/**
 * Additive metadata for well-known identifiers: a display label and a category.
 * This is the *only* curated table, it is keyed by exact identifier, and it can
 * never rename anything. Anything absent lands in the `dependency` category and
 * is still reported.
 */
const KNOWN_IDENTIFIERS: Record<string, { category: DependencyCategory; label?: string }> = {
  // JavaScript / TypeScript
  pg: { category: 'database', label: 'node-postgres' },
  postgres: { category: 'database', label: 'PostgreSQL' },
  mysql2: { category: 'database', label: 'MySQL' },
  mariadb: { category: 'database', label: 'MariaDB' },
  'better-sqlite3': { category: 'database', label: 'SQLite' },
  sqlite3: { category: 'database', label: 'SQLite' },
  mongodb: { category: 'database', label: 'MongoDB driver' },
  mongoose: { category: 'database', label: 'MongoDB ODM' },
  ioredis: { category: 'cache', label: 'Redis client' },
  redis: { category: 'cache', label: 'Redis client' },
  kafkajs: { category: 'queue', label: 'Kafka client' },
  amqplib: { category: 'queue', label: 'RabbitMQ / AMQP client' },
  nats: { category: 'queue', label: 'NATS client' },
  openai: { category: 'llm', label: 'OpenAI SDK' },
  '@anthropic-ai/sdk': { category: 'llm', label: 'Anthropic SDK' },
  '@google/generative-ai': { category: 'llm', label: 'Google Generative AI SDK' },
  '@huggingface/inference': { category: 'llm', label: 'Hugging Face Inference' },
  langchain: { category: 'llm', label: 'LangChain' },
  stripe: { category: 'payment', label: 'Stripe' },
  '@paypal/checkout-server-sdk': { category: 'payment', label: 'PayPal' },
  '@clerk/clerk-sdk-node': { category: 'auth', label: 'Clerk' },
  'express-session': { category: 'auth', label: 'Session middleware' },
  passport: { category: 'auth', label: 'Passport' },
  '@sentry/node': { category: 'observability', label: 'Sentry' },
  '@sentry/react': { category: 'observability', label: 'Sentry' },
  'dd-trace': { category: 'observability', label: 'Datadog tracer' },
  'prom-client': { category: 'observability', label: 'Prometheus client' },
  pino: { category: 'observability', label: 'Pino logger' },
  winston: { category: 'observability', label: 'Winston logger' },
  '@opentelemetry/api': { category: 'observability', label: 'OpenTelemetry' },

  // Python
  psycopg2: { category: 'database', label: 'PostgreSQL driver' },
  psycopg: { category: 'database', label: 'PostgreSQL driver' },
  asyncpg: { category: 'database', label: 'PostgreSQL driver' },
  pymysql: { category: 'database', label: 'MySQL driver' },
  mysqlclient: { category: 'database', label: 'MySQL driver' },
  'mysql-connector-python': { category: 'database', label: 'MySQL connector' },
  aiosqlite: { category: 'database', label: 'SQLite driver' },
  pymongo: { category: 'database', label: 'MongoDB driver' },
  motor: { category: 'database', label: 'MongoDB async driver' },
  sqlalchemy: { category: 'database', label: 'SQLAlchemy' },
  'django.db': { category: 'database', label: 'Django ORM' },
  aiokafka: { category: 'queue', label: 'Kafka async client' },
  'kafka-python': { category: 'queue', label: 'Kafka client' },
  pika: { category: 'queue', label: 'RabbitMQ / AMQP client' },
  'aio-pika': { category: 'queue', label: 'RabbitMQ / AMQP client' },
  celery: { category: 'queue', label: 'Celery' },
  kombu: { category: 'queue', label: 'Kombu (AMQP)' },
  boto3: { category: 'dependency', label: 'AWS SDK for Python' },
  botocore: { category: 'dependency', label: 'AWS SDK core' },
  opensearchpy: { category: 'search', label: 'OpenSearch client' },
  'opensearch-py': { category: 'search', label: 'OpenSearch client' },
  elasticsearch: { category: 'search', label: 'Elasticsearch client' },
  anthropic: { category: 'llm', label: 'Anthropic SDK' },
  llamaindex: { category: 'llm', label: 'LlamaIndex' },
  transformers: { category: 'llm', label: 'Hugging Face Transformers' },
  sentence_transformers: { category: 'llm', label: 'Sentence Transformers' },
  sentry_sdk: { category: 'observability', label: 'Sentry' },
  opentelemetry: { category: 'observability', label: 'OpenTelemetry' },
  'prometheus_client': { category: 'observability', label: 'Prometheus client' },
  structlog: { category: 'observability', label: 'structlog' },
  fastapi: { category: 'framework' },
  flask: { category: 'framework' },
  django: { category: 'framework' },
  starlette: { category: 'framework' },
  uvicorn: { category: 'framework' },
  gunicorn: { category: 'framework' },
  requests: { category: 'http', label: 'HTTP client' },
  httpx: { category: 'http', label: 'HTTP client' },
  aiohttp: { category: 'http', label: 'HTTP client' },

  // Go
  'github.com/jackc/pgx': { category: 'database', label: 'PostgreSQL driver' },
  'github.com/lib/pq': { category: 'database', label: 'PostgreSQL driver' },
  'gorm.io/gorm': { category: 'database', label: 'GORM' },
  'github.com/redis/go-redis': { category: 'cache', label: 'Redis client' },
  'github.com/segmentio/kafka-go': { category: 'queue', label: 'Kafka client' },
  'github.com/minio/minio-go': { category: 'storage', label: 'MinIO / S3 client' },
  'github.com/opensearch-project/opensearch-go': { category: 'search', label: 'OpenSearch client' },
  'github.com/elastic/go-elasticsearch': { category: 'search', label: 'Elasticsearch client' },
  'github.com/sashabaranov/go-openai': { category: 'llm', label: 'OpenAI SDK' },
  'github.com/gin-gonic/gin': { category: 'framework' },
  'github.com/labstack/echo': { category: 'framework' },

  // Rust
  tokio_postgres: { category: 'database', label: 'PostgreSQL driver' },
  sqlx: { category: 'database' },
  diesel: { category: 'database' },
  rdkafka: { category: 'queue', label: 'Kafka client' },
  lapin: { category: 'queue', label: 'RabbitMQ / AMQP client' },
  aws_sdk_s3: { category: 'storage', label: 'AWS S3 SDK' },
  opensearch: { category: 'search', label: 'OpenSearch client' },
  axum: { category: 'framework' },
  actix_web: { category: 'framework' },
  reqwest: { category: 'http', label: 'HTTP client' },

  // Container images (self-naming)
  mysql: { category: 'database', label: 'MySQL' },
  mongo: { category: 'database', label: 'MongoDB' },
  memcached: { category: 'cache', label: 'Memcached' },
  rabbitmq: { category: 'queue', label: 'RabbitMQ' },
  kafka: { category: 'queue', label: 'Kafka' },
  minio: { category: 'storage', label: 'MinIO' },
  clickhouse: { category: 'database', label: 'ClickHouse' },
  neo4j: { category: 'database', label: 'Neo4j' },
  qdrant: { category: 'database', label: 'Qdrant' },
  weaviate: { category: 'database', label: 'Weaviate' },
  chroma: { category: 'database', label: 'Chroma' },
  milvus: { category: 'database', label: 'Milvus' },
  temporal: { category: 'queue', label: 'Temporal' },
  vault: { category: 'auth', label: 'HashiCorp Vault' },
  keycloak: { category: 'auth', label: 'Keycloak' },
  jaeger: { category: 'observability', label: 'Jaeger' },
  prometheus: { category: 'observability', label: 'Prometheus' },
  grafana: { category: 'observability', label: 'Grafana' },
  loki: { category: 'observability', label: 'Grafana Loki' },
  ollama: { category: 'llm', label: 'Ollama' },
};

/** Structural rules: derive the category from the shape of the specifier. */
function classifyByShape(name: string): { category: DependencyCategory; label?: string } | null {
  // @aws-sdk/client-sqs → queue, @aws-sdk/client-dynamodb → database, …
  const aws = name.match(/^@aws-sdk\/client-(.+)$/);
  if (aws) {
    const service = aws[1];
    if (/(sqs|sns|eventbridge|kinesis|mq)\b/.test(service)) return { category: 'queue', label: 'AWS SDK' };
    if (/(dynamodb|rds|neptune|docdb|keyspaces)\b/.test(service)) return { category: 'database', label: 'AWS SDK' };
    if (/(^|-)s3$|s3-/.test(service)) return { category: 'storage', label: 'AWS SDK' };
    if (/(cognito|sts|iam)\b/.test(service)) return { category: 'auth', label: 'AWS SDK' };
    if (/(cloudwatch|logs|xray)\b/.test(service)) return { category: 'observability', label: 'AWS SDK' };
    if (/(bedrock|polly|transcribe|comprehend|rekognition)\b/.test(service)) return { category: 'llm', label: 'AWS SDK' };
    return { category: 'dependency', label: 'AWS SDK' };
  }
  if (name.startsWith('google-cloud-') || name.startsWith('@google-cloud/')) {
    const rest = name.replace(/^@?google-cloud\//, '').replace(/^google-cloud-/, '');
    if (/^storage/.test(rest)) return { category: 'storage', label: 'Google Cloud Storage' };
    if (/^(bigquery|spanner|firestore|datastore)/.test(rest)) return { category: 'database', label: 'Google Cloud' };
    if (/^(pubsub|tasks|scheduler)/.test(rest)) return { category: 'queue', label: 'Google Cloud' };
    if (/^(aiplatform|vertexai|generative)/.test(rest)) return { category: 'llm', label: 'Google Cloud' };
    if (/^(logging|trace|monitoring)/.test(rest)) return { category: 'observability', label: 'Google Cloud' };
    return { category: 'dependency', label: 'Google Cloud' };
  }
  if (name.startsWith('@azure/') || name.startsWith('azure-')) {
    if (/(storage-blob|storage-file)/.test(name)) return { category: 'storage', label: 'Azure SDK' };
    if (/cosmos/.test(name)) return { category: 'database', label: 'Azure Cosmos DB' };
    if (/service[-_]?bus|event[-_]?grid|event[-_]?hub/.test(name)) return { category: 'queue', label: 'Azure SDK' };
    if (/identity/.test(name)) return { category: 'auth', label: 'Azure SDK' };
    if (/monitor|applicationinsights/.test(name)) return { category: 'observability', label: 'Azure SDK' };
    return { category: 'dependency', label: 'Azure SDK' };
  }
  if (/^boto3$|^botocore$/.test(name)) return { category: 'dependency', label: 'AWS SDK for Python' };
  if (name.startsWith('@aws-sdk/')) return { category: 'dependency', label: 'AWS SDK' };
  return null;
}

/**
 * Look up metadata for an exact identifier.
 *
 * Deliberately not fuzzy: matching on the last path segment swept in
 * `@sentry/node` for the `node` base image and reported it as Sentry. An
 * identifier we do not recognise is reported as an unrecognised dependency,
 * which is both true and useful.
 */
function lookupKnown(name: string): { category: DependencyCategory; label?: string } | null {
  const direct = KNOWN_IDENTIFIERS[name];
  if (direct) return direct;
  return classifyByShape(name);
}

export function classifyDependency(name: string, kind: DependencyKind): { category: DependencyCategory; label?: string } {
  if (kind === 'url') {
    const scheme = name.replace(/:$/, '').toLowerCase();
    const known = SCHEME_CATEGORIES[scheme];
    if (known) return known;
    return { category: 'dependency' };
  }
  if (kind === 'image') {
    // `opensearchproject/opensearch:2.11` → the image repository is the
    // identifier; Docker namespaces it, so the repository name is the fact.
    const repository = name.split(':')[0].split('@')[0];
    const known = lookupKnown(repository) ?? lookupKnown(repository.split('/').pop() ?? repository);
    if (known) return known;
    return { category: 'dependency' };
  }
  if (kind === 'env') {
    // The key itself is the fact; the stem hints at the category.
    const stem = name.replace(/_(URL|URI|HOST|HOSTS|ENDPOINT|PORT|BUCKET|QUEUE|TOPIC|DSN|CLUSTER|NODES?|BROKERS?|INSTANCE|REGION|KEY|SECRET|TOKEN|PASSWORD|USER|NAME|ID)$/i, '');
    const known = lookupKnown(stem) ?? lookupKnown(stem.toLowerCase());
    if (known) return known;
    return { category: 'dependency' };
  }
  return lookupKnown(name) ?? { category: 'dependency' };
}

/** Package-manager dependency names are already the real identifier. */
export function normaliseManifestDependency(name: string): string {
  return name.replace(/\[.*$/, '').replace(/[<>=!~].*$/, '').trim();
}

/** Top-level module names of the Python standard library (from CPython's sys.stdlib_module_names). */
const PYTHON_STDLIB = new Set([
  'abc', 'antigravity', 'argparse', 'array', 'ast', 'asyncio', 'atexit', 'base64', 'bdb',
  'binascii', 'bisect', 'builtins', 'bz2', 'cProfile', 'calendar', 'cmath', 'cmd', 'code',
  'codecs', 'codeop', 'collections', 'colorsys', 'compileall', 'concurrent', 'configparser', 'contextlib', 'contextvars',
  'copy', 'copyreg', 'csv', 'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm', 'decimal',
  'difflib', 'dis', 'doctest', 'email', 'encodings', 'ensurepip', 'enum', 'errno', 'faulthandler',
  'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'genericpath',
  'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'grp', 'gzip', 'hashlib', 'heapq',
  'hmac', 'html', 'http', 'idlelib', 'imaplib', 'importlib', 'inspect', 'io', 'ipaddress',
  'itertools', 'json', 'keyword', 'linecache', 'locale', 'logging', 'lzma', 'mailbox', 'marshal',
  'math', 'mimetypes', 'mmap', 'modulefinder', 'msvcrt', 'multiprocessing', 'netrc', 'nt', 'ntpath',
  'nturl2path', 'numbers', 'opcode', 'operator', 'optparse', 'os', 'pathlib', 'pdb', 'pickle',
  'pickletools', 'pkgutil', 'platform', 'plistlib', 'poplib', 'posix', 'posixpath', 'pprint', 'profile',
  'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr', 'pydoc', 'pydoc_data', 'pyexpat', 'queue',
  'quopri', 'random', 're', 'readline', 'reprlib', 'resource', 'rlcompleter', 'runpy', 'sched',
  'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site', 'smtplib',
  'socket', 'socketserver', 'sqlite3', 'sre_compile', 'sre_constants', 'sre_parse', 'ssl', 'stat', 'statistics',
  'string', 'stringprep', 'struct', 'subprocess', 'symtable', 'sys', 'sysconfig', 'syslog', 'tabnanny',
  'tarfile', 'tempfile', 'termios', 'textwrap', 'this', 'threading', 'time', 'timeit', 'tkinter',
  'token', 'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc', 'tty', 'turtle', 'turtledemo',
  'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uuid', 'venv', 'warnings', 'wave',
  'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xml', 'xmlrpc', 'zipapp', 'zipfile',
  'zipimport', 'zlib', 'zoneinfo',]);

/** Node built-in modules (`fs`, `path`, …), which are language facts, not dependencies. */
const JS_BUILTINS = new Set(builtinModules);

/**
 * Normalise an import specifier to the identifier a reader would recognise.
 * Returns null for anything that is not a dependency of *this* project:
 * relative paths, protocol imports, language built-ins, and first-party modules.
 */
export function dependencyNameFromSpecifier(specifier: string, family: string, ownRoots: Set<string> = new Set()): string | null {
  const clean = specifier.replace(/[?#].*$/, '').trim();
  if (!clean) return null;
  if (clean.startsWith('.') || clean.startsWith('/')) return null;
  if (/^(node|bun):/.test(clean)) return null;
  // Guard against stray punctuation and shell/config fragments being treated as
  // package names (a lone `=` once appeared in the inventory).
  if (!/^[A-Za-z_@][A-Za-z0-9_.@/-]*$/.test(clean) || clean.length < 2) return null;

  let name: string;
  if (family === 'js') {
    const parts = clean.split('/');
    name = clean.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (JS_BUILTINS.has(name)) return null;
  } else if (family === 'python') {
    // Python module paths do not map cleanly onto distribution names, and
    // `sqlalchemy.ext` is not a second dependency. Report the top-level module;
    // manifests supply distribution names where they are declared.
    name = clean.split('.')[0];
  } else if (family === 'java' || family === 'dotnet') {
    const segments = clean.split('.');
    name = segments.slice(0, 2).join('.');
  } else {
    name = clean;
  }

  // A module whose first segment is a directory in this repository is first
  // party, not a dependency — the resolver simply failed to follow the layout.
  const root = family === 'python' ? name.split('.')[0] : name;
  if (ownRoots.has(root)) return null;
  if (family === 'python' && PYTHON_STDLIB.has(root)) return null;
  if (family === 'python' && name.startsWith('__')) return null;

  return name;
}

// No `i` flag: `FROM` is uppercase in Dockerfiles, while `image:` is lowercase in
// compose/manifests. A case-insensitive `FROM` matched Python `from x import y`
// lines inside Dockerfile heredocs and reported modules as container images.
const IMAGE_REFERENCE = /^\s*(?:image:\s*|FROM\s+)([A-Za-z0-9][\w./-]*(?::[\w.-]+)?(?:@sha256:[a-f0-9]+)?)/gm;

/**
 * Container images from compose files, Dockerfiles and Kubernetes/Helm manifests.
 *
 * The file gate matters: without it a Python `from x import y` line matches a
 * bare `FROM` and gets reported as a container image.
 */
export function extractContainerImages(text: string, filePath: string): { name: string; file: string }[] {
  const base = filePath.split('/').pop() ?? '';
  const isDockerfile = /^dockerfile(\..*)?$/i.test(base) || /\.dockerfile$/i.test(base);
  const isCompose = /^docker-compose.*\.ya?ml$/i.test(base) || /^compose\.ya?ml$/i.test(base);
  const isManifest = /\.ya?ml$/i.test(base) && /(^|\/)(k8s|kubernetes|helm|charts|manifests?|deploy(ment)?s?|infra)(\/|$)/i.test(filePath);
  if (!isDockerfile && !isCompose && !isManifest) return [];
  const found: { name: string; file: string }[] = [];
  for (const match of text.matchAll(IMAGE_REFERENCE)) {
    const raw = match[1].trim();
    if (!raw || /^(scratch|build|base)$/i.test(raw)) continue;
    if (raw.includes('${') || raw.includes('{{')) continue;
    // A dotted name with no registry path and no tag is a module path, not an
    // image reference (`onyx.configs.constants` is a Python module).
    if (raw.includes('.') && !raw.includes('/') && !raw.includes(':')) continue;
    found.push({ name: raw, file: filePath });
  }
  return found;
}

// A key is interesting when it names a service or a way to reach one. Credential
// and schema fields (`*_USER`, `*_PASSWORD`, `*_DB_NAME`) are properties of a
// service we already know about, so they are noise here.
const ENV_KEYS_OF_INTEREST = /(URL|URI|HOST|HOSTS|ENDPOINT|BUCKET|QUEUE|TOPIC|DSN|CLUSTER|BROKERS?|INSTANCE|API_KEY)/i;
const ENV_KEYS_EXCLUDED = /_(USER|USERNAME|PASSWORD|PASS|SECRET|NAME|PORT|TABLE|COLUMN|ID)$/i;
const ENV_NOISE = new Set(['NODE_ENV', 'ENVIRONMENT', 'ENV', 'PATH', 'HOME', 'TZ', 'DEBUG', 'LOG_LEVEL', 'PATH_TEMPLATE', 'BASE_PATH', 'PUBLIC_URL', 'API_URL_BASE']);

/** Environment variable keys that name a service or a connection. */
export function extractEnvKeys(text: string, filePath: string): { name: string; file: string }[] {
  const found = new Map<string, string>();
  const consider = (key: string) => {
    const upper = key.trim().toUpperCase();
    if (!upper || upper.length > 64) return;
    if (ENV_NOISE.has(upper)) return;
    if (!ENV_KEYS_OF_INTEREST.test(upper)) return;
    if (ENV_KEYS_EXCLUDED.test(upper)) return;
    if (!found.has(upper)) found.set(upper, filePath);
  };

  // .env style files: KEY=value
  if (/(^|\/)\.env|(^|\/)env\.(example|sample|template)$/i.test(filePath) || /\.env/.test(filePath)) {
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
      if (match) consider(match[1]);
    }
  }

  // Code reads: process.env.X, os.environ["X"], os.getenv("X"), getenv("X")
  for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) consider(match[1]);
  for (const match of text.matchAll(/process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g)) consider(match[1]);
  for (const match of text.matchAll(/os\.environ(?:\[|\s*\.get\()\s*["']([A-Z][A-Z0-9_]*)["']/g)) consider(match[1]);
  for (const match of text.matchAll(/os\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g)) consider(match[1]);

  return [...found.entries()].map(([name, file]) => ({ name, file }));
}

/** Connection strings name their protocol, which is a fact about the system. */
export function extractUrlSchemes(text: string, filePath: string): { name: string; file: string }[] {
  if (/\.(md|mdx|txt|lock)$/i.test(filePath)) return [];
  const found = new Map<string, string>();
  for (const match of text.matchAll(/(?:^|["'`(\s=])([a-z][a-z0-9+.-]{2,15}):\/\//g)) {
    const scheme = match[1].toLowerCase().replace(/\+.*$/, '');
    // Only protocols we can name. Anything followed by `://` is not necessarily
    // a protocol — `f"{scheme}://…"` and docstring examples are not evidence.
    if (!SCHEME_CATEGORIES[scheme]) continue;
    if (['http', 'https', 'ws', 'wss'].includes(scheme)) continue;
    if (!found.has(scheme)) found.set(scheme, filePath);
  }
  return [...found.entries()].map(([name, file]) => ({ name, file }));
}

export interface DependencyAccumulator {
  add(name: string, kind: DependencyKind, file: string): void;
  finish(): ExternalDependency[];
}

export function createDependencyAccumulator(): DependencyAccumulator {
  const entries = new Map<string, { name: string; kind: DependencyKind; files: Set<string>; references: number }>();
  return {
    add(name, kind, file) {
      const key = `${kind}\u0000${name}`;
      const existing = entries.get(key);
      if (existing) {
        existing.references += 1;
        if (existing.files.size < 12) existing.files.add(file);
        return;
      }
      entries.set(key, { name, kind, files: new Set([file]), references: 1 });
    },
    finish() {
      return [...entries.values()]
        .map((entry) => {
          const classified = classifyDependency(entry.name, entry.kind);
          const dependency: ExternalDependency = {
            name: entry.name,
            kind: entry.kind,
            category: classified.category,
            evidence: [...entry.files],
            references: entry.references,
          };
          if (classified.label) dependency.label = classified.label;
          return dependency;
        })
        .sort((a, b) => {
          // Configuration evidence outranks package noise; then by usage.
          const weight = (dependency: ExternalDependency) =>
            (dependency.kind === 'image' ? 4 : dependency.kind === 'env' ? 3 : dependency.kind === 'url' ? 2 : 1) * 1000 +
            dependency.references;
          return weight(b) - weight(a);
        });
    },
  };
}


