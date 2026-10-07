import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor', 'Pods',
  'dist', 'build', 'out', 'output', 'target', 'bin', 'obj', 'release', 'debug',
  '.next', '.nuxt', '.svelte-kit', '.astro', '.angular', '.turbo', '.parcel-cache',
  '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox',
  '.cache', '.gradle', '.mvn', '.terraform', '.serverless', '.aws-sam',
  'coverage', '.nyc_output', 'htmlcov', '.idea', '.vscode', '.vs', 'DerivedData',
  'site-packages', 'dist-packages', '.dart_tool', '.stack-work', '.cargo', '.bloop', '.metals',
  '.DS_Store', '$RECYCLE.BIN', '.repo-explorer', '.kb',
]);

/**
 * Directory names that are never source, even when they are committed to git.
 * Repositories do occasionally commit `node_modules` or build output; ignoring
 * those is the difference between a useful analysis and a meaningless one.
 */
export const HARD_IGNORED_PATH_SEGMENTS = new Set([
  '.git', 'node_modules', 'bower_components', 'vendor', 'third_party', 'thirdparty', 'extern', 'external',
  '.venv', 'venv', 'virtualenv', '__pycache__', 'site-packages', 'dist-packages', 'egg-info', '.eggs',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.nox', '.cache', '.parcel-cache', '.turbo',
  '.next', '.nuxt', '.svelte-kit', '.astro', '.angular', '.dart_tool', '.gradle', '.mvn', '.terraform',
  '.serverless', '.aws-sam', '.stack-work', '.bloop', '.metals', '.fusion', '.kb', '.repo-explorer',
  'dist', 'build', 'out', 'coverage', 'htmlcov', '.nyc_output', 'Pods', 'DerivedData',
]);

/** True when any path segment marks the file as non-source of this project. */
export function isHardIgnored(filePath: string): boolean {
  for (const segment of filePath.split('/')) {
    if (HARD_IGNORED_PATH_SEGMENTS.has(segment.toLowerCase())) return true;
  }
  return false;
}

export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.svgz', '.tiff',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war', '.class',
  '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.obj', '.lib', '.bin', '.dat', '.wasm',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.ogg', '.flac', '.webm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.psd', '.ai', '.sketch', '.fig',
  '.db', '.sqlite', '.sqlite3', '.pyc', '.pyo', '.pyd', '.node', '.lockb', '.pack', '.idx',
]);

export function isBinaryPath(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i += 1) if (buffer[i] === 0) return true;
  return false;
}

export async function readTextFile(absPath: string, maxBytes: number): Promise<string | null> {
  try {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) return null;
    if (isBinaryPath(absPath)) return null;
    const handle = await fsp.open(absPath, 'r');
    try {
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      if (looksBinary(buffer)) return null;
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export function readTextFileSync(absPath: string, maxBytes = 400_000): string | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > maxBytes * 4) return null;
    if (isBinaryPath(absPath)) return null;
    const buffer = fs.readFileSync(absPath);
    if (looksBinary(buffer)) return null;
    return buffer.subarray(0, maxBytes).toString('utf8');
  } catch {
    return null;
  }
}

export interface WalkEntry {
  /** POSIX path relative to root. */
  path: string;
  absPath: string;
  size: number;
}

export interface WalkOptions {
  maxFiles?: number;
  /** Extra directory names to prune. */
  extraIgnores?: Iterable<string>;
  /** Include dotfiles/dot-dirs (other than VCS + well-known caches). */
  includeHidden?: boolean;
}

/**
 * Depth-first walk that prunes well-known noise directories early so that huge
 * `node_modules` trees never slow the analysis down.
 */
export function walkRepo(root: string, options: WalkOptions = {}): WalkEntry[] {
  const maxFiles = options.maxFiles ?? 20_000;
  const ignores = new Set([...IGNORED_DIRS, ...(options.extraIgnores ?? [])]);
  const includeHidden = options.includeHidden ?? false;
  const results: WalkEntry[] = [];
  const stack: string[] = [''];

  while (stack.length > 0 && results.length < maxFiles) {
    const rel = stack.pop() as string;
    const abs = rel ? path.join(root, rel) : root;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const name = entry.name;
      if (entry.isDirectory()) {
        if (ignores.has(name)) continue;
        if (!includeHidden && name.startsWith('.') && name !== '.github' && name !== '.gitlab') continue;
        stack.push(rel ? `${rel}/${name}` : name);
      } else if (entry.isFile()) {
        if (!includeHidden && name.startsWith('.') && name !== '.gitignore' && name !== '.env.example') continue;
        const childRel = rel ? `${rel}/${name}` : name;
        try {
          const stat = fs.statSync(path.join(abs, name));
          results.push({ path: childRel, absPath: path.join(abs, name), size: stat.size });
        } catch {
          /* unreadable file: skip */
        }
      } else if (entry.isSymbolicLink()) {
        // Don't follow symlinks: avoids cycles and escaping the repo.
        continue;
      }
    }
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export function pathExistsSync(p: string): boolean {
  return fs.existsSync(p);
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

export async function writeFileAtomic(file: string, contents: string): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, contents, 'utf8');
  await fsp.rename(tmp, file);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
