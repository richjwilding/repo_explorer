import type { Chunk, FileEntry } from '../types.js';
import { detectLanguage } from '../analysis/languages.js';
import { extractSymbols } from '../analysis/imports.js';
import { tokenize } from '../util/text.js';

const MAX_CHUNK_LINES = 120;
const WINDOW_LINES = 80;
const WINDOW_OVERLAP = 12;

/**
 * Split a source file into retrieval-sized chunks.
 *
 * We deliberately avoid a full parser: symbol declarations give us natural
 * boundaries for almost every language, and a sliding window covers the rest.
 * Each chunk carries its line range so answers can cite exact locations.
 */
export function chunkFile(text: string, filePath: string, entry?: FileEntry): Chunk[] {
  const language = detectLanguage(filePath).id;
  const lines = text.split('\n');
  const makeChunk = (
    start: number,
    end: number,
    kind: Chunk['kind'],
    symbol?: string,
  ): Chunk | null => {
    if (end <= start) return null;
    const body = lines.slice(start, end).join('\n');
    if (!body.trim()) return null;
    const id = `${filePath}#L${start + 1}-${end}`;
    return {
      id,
      path: filePath,
      language,
      kind,
      ...(symbol ? { symbol } : {}),
      startLine: start + 1,
      endLine: end,
      text: body,
      tokens: tokenize(`${filePath} ${symbol ?? ''} ${body}`),
    };
  };

  if (isDocFile(filePath)) return chunkMarkdown(text, language, makeChunk);
  if (entry?.category === 'config' && lines.length <= MAX_CHUNK_LINES) {
    const chunk = makeChunk(0, lines.length, 'config');
    return chunk ? [chunk] : [];
  }

  const symbols = entry?.symbols?.length ? entry.symbols : extractSymbols(text, filePath);
  const boundaries = [...new Set(symbols.map((s) => s.line))]
    .filter((line) => line >= 1 && line <= lines.length)
    .sort((a, b) => a - b);

  if (boundaries.length === 0) return chunkWindow(text, filePath, language, makeChunk);

  const chunks: Chunk[] = [];
  // Preamble: imports, constants, and file-level doc comments.
  if (boundaries[0] > 1) {
    const preamble = makeChunk(0, Math.min(boundaries[0] - 1, MAX_CHUNK_LINES), 'file');
    if (preamble) chunks.push(preamble);
  }

  for (let i = 0; i < boundaries.length; i += 1) {
    const start = boundaries[i] - 1;
    const nextBoundary = boundaries[i + 1] ?? lines.length + 1;
    let end = nextBoundary - 1;
    const symbol = symbols.find((s) => s.line === boundaries[i]);

    // Very large bodies are split so a single function can't dominate results.
    if (end - start > MAX_CHUNK_LINES * 2) {
      const sub = chunkWindow(
        lines.slice(start, end).join('\n'),
        filePath,
        language,
        (s, e, kind, sym) => {
          const chunk = makeChunk(start + s, start + e, kind, sym);
          return chunk;
        },
        symbol?.name,
      );
      chunks.push(...sub);
      continue;
    }
    if (end <= start) end = start + 1;
    const chunk = makeChunk(start, end, symbolKindToChunkKind(symbol?.kind), symbol?.name);
    if (chunk) chunks.push(chunk);
  }

  return chunks.length > 0 ? chunks : chunkWindow(text, filePath, language, makeChunk);
}

function symbolKindToChunkKind(kind?: string): Chunk['kind'] {
  if (kind === 'function' || kind === 'method') return 'function';
  if (kind === 'class' || kind === 'struct' || kind === 'trait' || kind === 'enum') return 'class';
  if (kind === 'interface' || kind === 'type') return 'class';
  return 'block';
}

function isDocFile(filePath: string): boolean {
  return /\.(md|mdx|rst)$/i.test(filePath) || /(^|\/)(readme|contributing|architecture|design)/i.test(filePath);
}

function chunkMarkdown(
  text: string,
  language: string,
  makeChunk: (start: number, end: number, kind: Chunk['kind'], symbol?: string) => Chunk | null,
): Chunk[] {
  const lines = text.split('\n');
  const headings: { line: number; title: string }[] = [];
  lines.forEach((line, index) => {
    const match = line.match(/^(#{1,4})\s+(.+)$/);
    if (match) headings.push({ line: index + 1, title: match[2].trim() });
  });

  if (headings.length === 0) {
    const chunks: Chunk[] = [];
    for (let start = 0; start < lines.length; start += WINDOW_LINES) {
      const chunk = makeChunk(start, Math.min(start + WINDOW_LINES, lines.length), 'docs');
      if (chunk) chunks.push(chunk);
    }
    return chunks;
  }

  const chunks: Chunk[] = [];
  if (headings[0].line > 1) {
    const intro = makeChunk(0, headings[0].line - 1, 'docs', 'introduction');
    if (intro) chunks.push(intro);
  }
  for (let i = 0; i < headings.length; i += 1) {
    const start = headings[i].line - 1;
    const end = (headings[i + 1]?.line ?? lines.length + 1) - 1;
    const chunk = makeChunk(start, Math.min(end, start + MAX_CHUNK_LINES * 2), 'docs', headings[i].title);
    if (chunk) chunks.push({ ...chunk, language });
  }
  return chunks;
}

function chunkWindow(
  text: string,
  filePath: string,
  language: string,
  makeChunk: (start: number, end: number, kind: Chunk['kind'], symbol?: string) => Chunk | null,
  symbol?: string,
): Chunk[] {
  const lines = text.split('\n');
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += WINDOW_LINES - WINDOW_OVERLAP) {
    const end = Math.min(start + WINDOW_LINES, lines.length);
    const chunk = makeChunk(start, end, 'block', symbol);
    if (chunk) chunks.push({ ...chunk, language, path: filePath });
    if (end >= lines.length) break;
  }
  return chunks;
}
