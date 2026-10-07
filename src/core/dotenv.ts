import fs from 'node:fs';
import path from 'node:path';

/**
 * A deliberately small `.env` reader and writer.
 *
 * `.env` is the conventional place for credentials in a development tool, and it
 * is one thing to understand instead of several. Files are loaded into
 * `process.env`, but **only for keys that are not already set**, so a real
 * environment variable always wins.
 *
 * Supported: `KEY=value`, `export KEY=value`, quoted values (single or double,
 * with `\n`/`\t`/`\\` escapes inside double quotes), comments, blank lines, and
 * values spanning lines inside quotes. Not supported, on purpose: variable
 * interpolation and command substitution.
 */

export interface DotEnvFile {
  path: string;
  label: string;
}

/** Where `.env` files are looked for, in decreasing order of precedence. */
export function dotEnvCandidates(home: string, cwd = process.cwd()): DotEnvFile[] {
  return [
    { path: path.join(cwd, '.env'), label: 'working directory' },
    { path: path.join(home, '.env'), label: 'app config directory' },
  ];
}

export function parseDotEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (!line) continue;
    // Strip a UTF-8 BOM on the first line and normalise CRLF input.
    if (index === 0) line = line.replace(/^\uFEFF/, '');
    line = line.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/);
    if (!match) continue;
    const key = match[1];
    let raw = match[2];

    const quote = raw[0];
    if (quote === '"' || quote === "'") {
      // A quoted value may span several lines.
      let body = raw.slice(1);
      let closed = body.includes(quote);
      if (!closed) {
        while (index + 1 < lines.length) {
          index += 1;
          body += `\n${lines[index].replace(/\r$/, '')}`;
          if (body.includes(quote)) {
            closed = true;
            break;
          }
        }
      }
      const end = closed ? body.indexOf(quote) : body.length;
      body = body.slice(0, end);
      result[key] = quote === '"' ? body.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : body;
      continue;
    }

    // Unquoted: everything up to an unescaped ` #` is the value.
    raw = raw.replace(/\s+#.*$/, '').trim();
    result[key] = raw;
  }

  return result;
}

/**
 * Keys that this loader put into the environment.
 *
 * Needed to answer "where did this value come from?" accurately: a `.env` file
 * may mention a key that a real environment variable already set, and in that
 * case the file did not supply the value in use.
 */
const injectedByDotEnv = new Set<string>();

export function wasInjectedByDotEnv(key: string): boolean {
  return injectedByDotEnv.has(key);
}

/** Test helper. */
export function resetDotEnvTracking(): void {
  injectedByDotEnv.clear();
}

/**
 * Reflect a change to a `.env` value in this process.
 *
 * Without this the old value lingers in `process.env` after a key is cleared, so
 * the app would keep reporting a credential it no longer has. A value that came
 * from a real environment variable is never deleted.
 */
export function applyToEnvironment(key: string, value: string | null): void {
  if (value) {
    process.env[key] = value;
    injectedByDotEnv.add(key);
    return;
  }
  if (injectedByDotEnv.has(key)) {
    delete process.env[key];
    injectedByDotEnv.delete(key);
  }
}

export interface LoadedDotEnv {
  /** Files that were actually read. */
  files: string[];
  /** Keys taken from a file (i.e. not already present in the environment). */
  keys: string[];
}

/**
 * Load `.env` files into `process.env` without overwriting anything already set.
 * Idempotent, so calling it from `loadConfig` is safe.
 */
export function loadDotEnv(home: string, options: { cwd?: string; force?: boolean } = {}): LoadedDotEnv {
  const loaded: LoadedDotEnv = { files: [], keys: [] };
  if (process.env.REPO_EXPLORER_DOTENV === '0') return loaded;

  for (const candidate of dotEnvCandidates(home, options.cwd)) {
    let text: string;
    try {
      if (!fs.existsSync(candidate.path)) continue;
      text = fs.readFileSync(candidate.path, 'utf8');
    } catch {
      continue;
    }
    loaded.files.push(candidate.path);

    let parsed: Record<string, string>;
    try {
      parsed = parseDotEnv(text);
    } catch {
      continue;
    }

    for (const [key, value] of Object.entries(parsed)) {
      const existing = process.env[key];
      // An explicit `force` is used when the app itself just wrote the file.
      if (existing !== undefined && existing !== '' && !options.force) continue;
      process.env[key] = value;
      injectedByDotEnv.add(key);
      loaded.keys.push(key);
    }
  }

  return loaded;
}

/** Which `.env` file, if any, defines a key. */
export function dotEnvSourceFor(home: string, keys: string[], cwd = process.cwd()): string | null {
  for (const candidate of dotEnvCandidates(home, cwd)) {
    try {
      if (!fs.existsSync(candidate.path)) continue;
      const parsed = parseDotEnv(fs.readFileSync(candidate.path, 'utf8'));
      if (keys.some((key) => parsed[key] !== undefined)) return candidate.path;
    } catch {
      /* ignore unreadable files */
    }
  }
  return null;
}

export function dotEnvWritePath(home: string): string {
  return path.join(home, '.env');
}

/**
 * Set or remove one key in the app's `.env`, preserving comments and the rest of
 * the file. Written `0600` because this file holds credentials.
 */
export function writeDotEnvValue(home: string, key: string, value: string | null): { path: string; removed: boolean } {
  const file = dotEnvWritePath(home);
  let lines: string[] = [];
  try {
    if (fs.existsSync(file)) lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    lines = [];
  }

  const pattern = new RegExp(`^(\\s*(?:export\\s+)?)${key}\\s*=`);
  const index = lines.findIndex((line) => pattern.test(line));
  const shouldRemove = value === null || value === '';

  if (index >= 0 && shouldRemove) lines.splice(index, 1);
  else if (index >= 0) lines[index] = `${key}=${quoteIfNeeded(value as string)}`;
  else if (!shouldRemove) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`${key}=${quoteIfNeeded(value as string)}`);
    if (lines[lines.length - 1] === '') lines.pop();
    lines.push('');
  }

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }

  return { path: file, removed: shouldRemove };
}

function quoteIfNeeded(value: string): string {
  return /[\s#'"]/.test(value) ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
}
