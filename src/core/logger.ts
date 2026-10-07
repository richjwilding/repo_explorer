import pc from 'picocolors';
import { redact } from './util/redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let currentLevel: LogLevel = (process.env.REPO_EXPLORER_LOG as LogLevel) || 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function enabled(level: LogLevel): boolean {
  return ORDER[level] >= ORDER[currentLevel];
}

function stamp(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

function fmt(args: unknown[]): string {
  return redact(
    args
      .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a)))
      .join(' '),
  );
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
}

export function createLogger(scope = 'repo-explorer'): Logger {
  const label = () => pc.dim(stamp()) + ' ' + pc.cyan(scope.padEnd(12));
  return {
    debug: (...a) => enabled('debug') && console.debug(label(), pc.dim(fmt(a))),
    info: (...a) => enabled('info') && console.log(label(), fmt(a)),
    warn: (...a) => enabled('warn') && console.warn(label(), pc.yellow(fmt(a))),
    error: (...a) => enabled('error') && console.error(label(), pc.red(fmt(a))),
    child: (sub: string) => createLogger(`${scope}:${sub}`),
  };
}

export const log = createLogger();
