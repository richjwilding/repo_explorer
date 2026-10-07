/** Text utilities: tokenisation for search, truncation, and small helpers. */

export const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'of', 'to', 'in', 'on', 'at', 'by', 'with',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those',
  'we', 'you', 'they', 'he', 'she', 'i', 'not', 'no', 'do', 'does', 'did', 'done', 'can', 'could', 'should',
  'would', 'will', 'shall', 'may', 'might', 'must', 'have', 'has', 'had', 'const', 'let', 'var', 'function',
  'return', 'import', 'export', 'from', 'class', 'new', 'void', 'null', 'undefined', 'true', 'false', 'async',
  'await', 'public', 'private', 'static', 'this', 'self', 'def', 'end', 'begin', 'type', 'interface', 'string',
  'number', 'boolean', 'any', 'value', 'values', 'get', 'set', 'use', 'using', 'used',
]);

/** Split camelCase / snake_case / kebab-case / dot.notation into lowercase words. */
export function splitIdentifier(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function tokenize(text: string): string[] {
  const raw = text.match(/[A-Za-z0-9_$]+/g) ?? [];
  const out: string[] = [];
  for (const word of raw) {
    const parts = splitIdentifier(word);
    if (parts.length > 1) {
      for (const p of parts) {
        if (p.length > 1 && !STOPWORDS.has(p)) out.push(p);
      }
      out.push(word.toLowerCase());
    } else {
      const lower = word.toLowerCase();
      if (lower.length > 1 && !STOPWORDS.has(lower)) out.push(lower);
    }
  }
  return out;
}

export function termFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

export function truncate(text: string, max: number, marker = '\n… [truncated]'): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - marker.length));
  const lastNewline = cut.lastIndexOf('\n');
  const body = lastNewline > max * 0.6 ? cut.slice(0, lastNewline) : cut;
  return body + marker;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

export function firstLines(text: string, maxLines: number, maxChars = 2000): string {
  const lines = text.split('\n');
  const joined = lines.slice(0, maxLines).join('\n');
  return truncate(joined, maxChars, ' …');
}

/** Extract a window of lines around `line` (1-based). */
export function lineWindow(text: string, line: number, before = 8, after = 12): { text: string; startLine: number } {
  const lines = text.split('\n');
  const start = Math.max(0, line - 1 - before);
  const end = Math.min(lines.length, line + after);
  return { text: lines.slice(start, end).join('\n'), startLine: start + 1 };
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function titleCase(input: string): string {
  return input
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

export function topN<T>(items: T[], n: number, score: (item: T) => number): T[] {
  return [...items].sort((a, b) => score(b) - score(a)).slice(0, n);
}

/** Jaccard similarity over token sets. */
export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
