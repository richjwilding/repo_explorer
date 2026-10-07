import { describe, expect, it } from 'vitest';
import {
  categoriseScript,
  computeOperationalSurface,
  copySources,
  describeOperations,
  dockerfileInstructions,
  isCiPath,
  isComposePath,
  isDockerfilePath,
  parseCiWorkflow,
  parseDockerfile,
  type ManifestScript,
} from '../src/core/analysis/ops.js';
import type { ManifestInfo } from '../src/core/analysis/stack.js';

/**
 * The operational surface is read from files whose purpose is to state these
 * facts, so the tests below are mostly about refusing to be clever: an unquoted
 * `on:` in a workflow, a `COPY` whose destination looks like a source, a
 * variable that only exists in a fixture.
 */

const manifest = (scripts: Record<string, string>): ManifestInfo => ({
  path: 'package.json',
  kind: 'node',
  scripts,
  dependencies: [],
  devDependencies: [],
  entryHints: [],
});

describe('path classification', () => {
  it('recognises CI definitions in the layouts people actually use', () => {
    expect(isCiPath('.github/workflows/ci.yml')).toBe(true);
    expect(isCiPath('.gitlab-ci.yml')).toBe(true);
    expect(isCiPath('services/api/.github/workflows/deploy.yaml')).toBe(true);
    expect(isCiPath('Jenkinsfile')).toBe(true);
    expect(isCiPath('src/ci.yml')).toBe(false);
  });

  it('recognises Dockerfiles regardless of suffix or directory', () => {
    expect(isDockerfilePath('Dockerfile')).toBe(true);
    expect(isDockerfilePath('docker/Dockerfile.prod')).toBe(true);
    expect(isDockerfilePath('api.dockerfile')).toBe(true);
    expect(isDockerfilePath('docker-compose.yml')).toBe(false);
  });

  it('recognises compose files but not unrelated yaml', () => {
    expect(isComposePath('docker-compose.yml')).toBe(true);
    expect(isComposePath('compose.yaml')).toBe(true);
    expect(isComposePath('docker-compose.override.yml')).toBe(true);
    expect(isComposePath('config/app.yml')).toBe(false);
  });
});

describe('workflow parsing', () => {
  it('parses triggers, jobs, commands and actions', () => {
    const workflow = parseCiWorkflow(
      '.github/workflows/ci.yml',
      `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Verify
        run: |
          npm run typecheck
          npm test
`,
    );
    expect(workflow).not.toBeNull();
    expect(workflow?.triggers).toEqual(['pull_request', 'push']);
    expect(workflow?.jobs).toHaveLength(1);
    expect(workflow?.jobs[0].runner).toBe('ubuntu-latest');
    expect(workflow?.jobs[0].commands).toEqual(['npm ci', 'npm run typecheck', 'npm test']);
    expect(workflow?.actions).toContain('actions/checkout@v4');
    expect(workflow?.gating).toBe(true);
  });

  it('accepts `on` as a bare string and as a list', () => {
    expect(parseCiWorkflow('.github/workflows/a.yml', 'on: push\njobs:\n  a:\n    steps:\n      - run: x\n')?.triggers).toEqual(['push']);
    expect(parseCiWorkflow('.github/workflows/a.yml', 'on: [push, workflow_dispatch]\njobs:\n  a:\n    steps:\n      - run: x\n')?.triggers).toEqual([
      'push',
      'workflow_dispatch',
    ]);
  });

  it('does not call a workflow gating when it runs no commands', () => {
    const workflow = parseCiWorkflow('.github/workflows/label.yml', 'on: pull_request\njobs:\n  label:\n    steps:\n      - uses: actions/labeler@v5\n');
    expect(workflow?.gating).toBe(false);
  });

  it('reports a Jenkinsfile without pretending to parse Groovy', () => {
    const workflow = parseCiWorkflow('Jenkinsfile', "pipeline { stages { stage('Test') { steps { sh 'make test' } } } }");
    expect(workflow?.commands).toEqual(['make test']);
  });
});

describe('dockerfile parsing', () => {
  it('joins continued lines and ignores comments', () => {
    const instructions = dockerfileInstructions(
      `# a comment that mentions FROM nginx
FROM node:20-alpine
RUN apt-get update \\
 && apt-get install -y curl
`,
    );
    expect(instructions.map((i) => i.instruction)).toEqual(['FROM', 'RUN']);
    expect(instructions[1].argument).toContain('apt-get install');
  });

  it('extracts stages, ports, commands and the user', () => {
    const image = parseDockerfile(
      'Dockerfile',
      `FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm ci
FROM node:20-alpine
USER node
EXPOSE 3000 8080/tcp
ENTRYPOINT ["node"]
CMD ["server.js"]
`,
    );
    expect(image.stages).toEqual([
      { name: 'build', base: 'node:20-alpine', line: 1 },
      { name: '#2', base: 'node:20-alpine', line: 5 },
    ]);
    expect(image.multiStage).toBe(true);
    expect(image.exposedPorts).toEqual([3000, 8080]);
    expect(image.entrypoint).toBe('node');
    expect(image.cmd).toBe('server.js');
    expect(image.user).toBe('node');
    expect(image.runsAsRoot).toBe(false);
  });

  it('flags running as root when no USER is declared', () => {
    expect(parseDockerfile('Dockerfile', 'FROM alpine\nCMD ["sh"]\n').runsAsRoot).toBe(true);
    expect(parseDockerfile('Dockerfile', 'FROM alpine\nUSER root\n').runsAsRoot).toBe(true);
  });

  it('reads the destination of a COPY as a destination, not a source', () => {
    // Regression: `COPY package.json ./` ended in `./`, so the manifest copy was
    // mistaken for the source tree and correct caching looked incorrect.
    expect(copySources('package.json package-lock.json ./')).toBe('package.json package-lock.json');
    expect(copySources('COPY --from=deps /app/node_modules ./node_modules'.replace('COPY ', ''))).toBe('--from=deps /app/node_modules');
    const image = parseDockerfile(
      'Dockerfile',
      `FROM node:20 AS deps
COPY package.json package-lock.json ./
RUN npm ci
FROM node:20
COPY --from=deps /app/node_modules ./node_modules
COPY . .
`,
    );
    expect(image.cachesDependencies).toBe(true);
  });

  it('reports dependencies installed after the source as uncached', () => {
    const image = parseDockerfile('Dockerfile', 'FROM node:20\nCOPY . .\nRUN npm install\n');
    expect(image.cachesDependencies).toBe(false);
  });

  it('collects ENV declarations and HEALTHCHECK', () => {
    const image = parseDockerfile('Dockerfile', 'FROM node:20\nENV NODE_ENV=production\nENV PORT 3000\nHEALTHCHECK CMD wget -qO- localhost:3000\n');
    expect(image.declaredEnv).toEqual(['NODE_ENV', 'PORT']);
    expect(image.healthcheck).toBe(true);
    expect(parseDockerfile('Dockerfile', 'FROM node:20\nHEALTHCHECK NONE\n').healthcheck).toBe(false);
  });
});

describe('compose and infrastructure', () => {
  const files = (map: Record<string, string>) => Object.entries(map).map(([path, text]) => ({ path, text }));

  it('parses services, ports, ordering and both shapes of environment', () => {
    const ops = computeOperationalSurface({
      manifests: [],
      files: files({
        'docker-compose.yml': `services:
  api:
    build: .
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://x
    depends_on: [db]
  worker:
    image: acme/worker:1
    environment:
      - QUEUE_URL=amqp://x
volumes:
  pgdata:
`,
      }),
    });
    const compose = ops.compose[0];
    expect(compose.services.map((s) => s.name)).toEqual(['api', 'worker']);
    expect(compose.services[0].ports).toEqual(['3000:3000']);
    expect(compose.services[0].dependsOn).toEqual(['db']);
    expect(compose.services[0].environment).toEqual(['DATABASE_URL']);
    expect(compose.services[1].environment).toEqual(['QUEUE_URL']);
    expect(compose.namedVolumes).toEqual(['pgdata']);
    expect(ops.summary.ports).toEqual([3000]);
  });

  it('reads every document of a multi-document kubernetes manifest', () => {
    const ops = computeOperationalSurface({
      manifests: [],
      files: files({
        'k8s/app.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/api:1.2.3
---
apiVersion: v1
kind: Service
metadata:
  name: api
`,
      }),
    });
    expect(ops.infra[0].format).toBe('kubernetes');
    expect(ops.infra[0].resources.map((r) => `${r.kind}/${r.name}`)).toEqual(['Deployment/api', 'Service/api']);
    expect(ops.infra[0].images).toEqual(['ghcr.io/acme/api:1.2.3']);
  });

  it('picks up kubernetes yaml outside a conventional directory', () => {
    const ops = computeOperationalSurface({
      manifests: [],
      files: files({ 'weird/place.yaml': 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\n' }),
    });
    expect(ops.infra).toHaveLength(1);
    expect(ops.infra[0].format).toBe('kubernetes');
  });

  it('parses terraform resources and modules', () => {
    const ops = computeOperationalSurface({
      manifests: [],
      files: files({
        'infra/main.tf': `resource "aws_s3_bucket" "assets" {
  bucket = "x"
}
module "vpc" {
  source = "./vpc"
}
`,
      }),
    });
    expect(ops.infra[0].resources.map((r) => `${r.kind}/${r.name}`)).toEqual(['aws_s3_bucket/assets', 'module/vpc']);
  });
});

describe('operational summary', () => {
  it('names the gate and the verification that exists', () => {
    const ops = computeOperationalSurface({
      manifests: [manifest({ test: 'vitest run', typecheck: 'tsc --noEmit', build: 'vite build' })],
      files: [
        {
          path: '.github/workflows/ci.yml',
          text: 'on: pull_request\njobs:\n  t:\n    steps:\n      - run: npm test\n',
        },
      ],
    });
    expect(ops.summary.ciWorkflow).toBe('.github/workflows/ci.yml');
    expect(ops.summary.ciGate).toBe('npm test');
    expect(ops.summary.test).toBe('test: vitest run');
    expect(ops.summary.build).toBe('build: vite build');
  });

  it('says plainly when there is no CI, rather than saying nothing', () => {
    const ops = computeOperationalSurface({ manifests: [], files: [] });
    expect(describeOperations(ops)).toContain('CI: no CI definitions found — nothing automatically verifies a change.');
  });

  it('collects the configuration surface from code, containers and compose', () => {
    const ops = computeOperationalSurface({
      manifests: [],
      files: [
        { path: 'src/config.ts', text: 'export const key = process.env.OPENAI_API_KEY;\n' },
        { path: 'Dockerfile', text: 'FROM node:20\nENV LOG_LEVEL=info\n' },
        { path: 'docker-compose.yml', text: 'services:\n  api:\n    environment:\n      DATABASE_URL: x\n' },
        { path: 'scripts/deploy.sh', text: '#!/bin/sh\nexport API_TOKEN=abc\n' },
      ],
    });
    expect(ops.envVars.map((v) => v.name).sort()).toEqual(['API_TOKEN', 'DATABASE_URL', 'LOG_LEVEL', 'OPENAI_API_KEY']);
  });

  it('marks variables that only appear in tests as test-only', () => {
    const ops = computeOperationalSurface({
      manifests: [],
      files: [
        { path: 'tests/helpers/fixtureRepo.ts', text: 'const url = process.env.DATABASE_URL;\n' },
        { path: 'src/server.ts', text: 'const port = process.env.PORT;\n' },
      ],
    });
    const byName = new Map(ops.envVars.map((entry) => [entry.name, entry]));
    expect(byName.get('DATABASE_URL')?.testOnly).toBe(true);
    expect(byName.get('PORT')?.testOnly).toBe(false);
    // Test-only names must not lead the list a reader sees.
    expect(ops.envVars[0].name).toBe('PORT');
    expect(describeOperations(ops).join(' ')).toContain('appear only in tests');
  });

  it('reports a single-stage container with its ports and start command', () => {
    const ops = computeOperationalSurface({
      manifests: [],
      files: [{ path: 'Dockerfile', text: 'FROM node:20\nEXPOSE 3000\nCMD ["node", "server.js"]\n' }],
    });
    const described = describeOperations(ops).join('\n');
    expect(described).toContain('exposes 3000');
    expect(described).toContain('starts with `node server.js`');
    expect(described).toContain('runs as root');
  });

  it('survives unparseable configuration without losing the rest', () => {
    const ops = computeOperationalSurface({
      manifests: [],
      files: [
        { path: '.github/workflows/broken.yml', text: 'jobs: [this: is: not: yaml\n' },
        { path: 'Dockerfile', text: 'FROM node:20\n' },
      ],
    });
    expect(ops.containers).toHaveLength(1);
    expect(ops.warnings.join(' ')).toContain('broken.yml');
  });
});

describe('script categorisation', () => {
  it('classifies the names projects actually use', () => {
    const cases: [string, ManifestScript['category']][] = [
      ['test', 'test'],
      ['test:unit', 'test'],
      ['typecheck', 'typecheck'],
      ['tsc', 'typecheck'],
      ['lint', 'lint'],
      ['format', 'format'],
      ['build', 'build'],
      ['prebuild', 'build'],
      ['deploy', 'deploy'],
      ['release', 'deploy'],
      ['start', 'start'],
      ['dev', 'dev'],
      ['watch', 'dev'],
      ['db:migrate', 'migrate'],
      ['seed', 'migrate'],
      ['somethingElse', 'other'],
    ];
    for (const [name, expected] of cases) expect(categoriseScript(name), name).toBe(expected);
  });

  it('keeps script names and commands verbatim', () => {
    const ops = computeOperationalSurface({
      manifests: [manifest({ 'test:watch': 'vitest --watch' })],
      files: [],
    });
    expect(ops.scripts[0]).toMatchObject({ name: 'test:watch', command: 'vitest --watch', category: 'test' });
  });
});
