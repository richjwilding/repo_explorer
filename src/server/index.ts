import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { loadConfig, ensureDirs, resolveSecrets, type AppConfig } from '../core/config.js';
import { redact } from '../core/util/redact.js';
import { createLogger, setLogLevel, type LogLevel } from '../core/logger.js';
import { Store } from '../core/store.js';
import { RepoService } from '../core/service.js';
import { registerRepoRoutes } from './routes/repos.js';
import { registerExplainRoutes } from './routes/explain.js';
import { registerChangeRoutes } from './routes/changes.js';
import { registerChatRoutes } from './routes/chat.js';

export interface ServerOptions {
  config?: Partial<AppConfig>;
  logger?: boolean;
}

export interface RunningServer {
  url: string;
  port: number;
  config: AppConfig;
  /** The same service the HTTP routes use, so startup analysis warms it. */
  service: RepoService;
  store: Store;
  close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger('server');

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const cfg = await resolveSecrets(loadConfig(options.config));
  ensureDirs(cfg);
  if (!options.logger) setLogLevel((process.env.REPO_EXPLORER_LOG as LogLevel | undefined) ?? 'info');

  const store = new Store(cfg);
  const service = new RepoService(cfg, store);

  const app = Fastify({
    logger: false,
    bodyLimit: 8 * 1024 * 1024,
  });

  app.setErrorHandler((rawError, _request, reply) => {
    const error = rawError as Error & { statusCode?: number };
    const status = error.statusCode ?? 500;
    if (status >= 500) log.error(error.message, error.stack ?? '');
    else log.warn(error.message);
    reply.code(status).send({ error: redact(error.message), status });
  });

  const deps = { cfg, store, service };
  await registerRepoRoutes(app, deps);
  await registerExplainRoutes(app, deps);
  await registerChangeRoutes(app, deps);
  await registerChatRoutes(app, deps);

  // Serve the built single-page app when it exists (production), and provide a
  // helpful message in development where Vite serves the UI instead.
  const webRoot = resolveWebRoot();
  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.code(404).send({ error: `Unknown API route: ${request.url}` });
        return;
      }
      reply.type('text/html').send(fs.readFileSync(path.join(webRoot, 'index.html')));
    });
    log.info(`serving UI from ${webRoot}`);
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.code(404).send({ error: `Unknown API route: ${request.url}` });
        return;
      }
      reply
        .type('text/html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>Repo Explorer</title>
<body style="font:16px/1.6 -apple-system,Segoe UI,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1.5rem">
<h1>Repo Explorer API is running</h1>
<p>The UI has not been built yet. Either run <code>npm run dev</code> (Vite serves the UI on port 5173)
or build it with <code>npm run build</code> and restart.</p>
<p>API health: <a href="/api/health">/api/health</a></p>
</body>`,
        );
    });
  }

  const port = cfg.port;
  const host = cfg.host;
  const url = await app.listen({ port, host });
  log.info(`listening on ${url}`);

  return {
    url,
    port,
    config: cfg,
    service,
    store,
    close: async () => {
      await app.close();
    },
  };
}

/**
 * Locate the built UI. Only a real Vite build is served: `src/web` must never
 * be served directly, because its index.html points at untransformed sources.
 * In development, Vite serves the UI and proxies /api here instead.
 */
function resolveWebRoot(): string | null {
  let dir = here;
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const built = path.join(dir, 'dist', 'web');
      if (fs.existsSync(path.join(built, 'index.html'))) return built;
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const isDirectRun = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  startServer()
    .then(async (server) => {
      const repoArg = process.argv.slice(2).find((arg) => !arg.startsWith('-') && arg !== '.');
      if (repoArg) {
        const dir = path.resolve(repoArg);
        log.info(`analysing ${dir} on startup`);
        try {
          await server.service.open(dir, {
            onProgress: (message, pct) => log.info(`[${String(pct).padStart(3)}%] ${message}`),
          });
          log.info('startup analysis complete — the repository is ready in the UI');
        } catch (error) {
          log.error('startup analysis failed:', error instanceof Error ? error.message : error);
        }
      }
      log.info(`UI: ${server.url}`);
    })
    .catch((error) => {
      log.error('failed to start:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
