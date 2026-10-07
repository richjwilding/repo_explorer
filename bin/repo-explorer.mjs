#!/usr/bin/env node
/**
 * Repo Explorer launcher.
 *
 *   repo-explorer [path]        analyse a repository on startup
 *   repo-explorer --build       build the UI first, then start
 *
 * Uses the compiled server when it exists, and falls back to running the
 * TypeScript sources through tsx so a fresh checkout works immediately.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const compiledServer = path.join(projectRoot, 'dist', 'server', 'server', 'index.js');
const sourceServer = path.join(projectRoot, 'src', 'server', 'index.ts');
const webBuild = path.join(projectRoot, 'dist', 'web', 'index.html');

const args = process.argv.slice(2);
const wantsBuild = args.includes('--build');
const passthrough = args.filter((arg) => arg !== '--build');

if (wantsBuild) {
  console.log('Building the UI…');
  const build = spawnSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
} else if (!existsSync(webBuild)) {
  console.log('No UI build found. Building it once (this takes a few seconds)…');
  const build = spawnSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'inherit' });
  if (build.status !== 0) {
    console.warn('Build failed; starting the API only. Run `npm run dev` for the live UI.');
  }
}

const useCompiled = existsSync(compiledServer);
const command = useCompiled ? process.execPath : 'npx';
const commandArgs = useCompiled ? [compiledServer, ...passthrough] : ['tsx', sourceServer, ...passthrough];

console.log(`Starting Repo Explorer${useCompiled ? '' : ' from source'}`);
const child = spawn(command, commandArgs, { cwd: projectRoot, stdio: 'inherit' });

const port = process.env.REPO_EXPLORER_PORT ?? '5178';
const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
setTimeout(() => {
  if (process.env.REPO_EXPLORER_OPEN === 'false') return;
  spawn(openCmd, [`http://127.0.0.1:${port}`], { stdio: 'ignore', detached: true }).on('error', () => {
    /* opening a browser is best-effort */
  });
}, 2500).unref();

const forward = (signal) => () => child.kill(signal);
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 0));
