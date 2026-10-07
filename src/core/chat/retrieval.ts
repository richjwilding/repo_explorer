import type { Citation, RepoModel, SearchHit } from '../types.js';
import type { RepoIndex } from '../index/indexer.js';
import { splitIdentifier, tokenize, truncate } from '../util/text.js';

export interface RetrieveOptions {
  maxChars?: number;
  topK?: number;
  /** Files to always consider first (e.g. a component's key files). */
  focusFiles?: string[];
  /** Extra literal terms to search for (e.g. a component name). */
  extraTerms?: string[];
}

export interface RetrievalResult {
  hits: SearchHit[];
  context: string;
  citations: Citation[];
  files: string[];
}

const DEFAULT_MAX_CHARS = 60_000;

/** Merge chunks that are adjacent in the same file so context reads naturally. */
function mergeChunks(hits: SearchHit[]): { path: string; start: number; end: number; text: string; score: number }[] {
  const byPath = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    if (!byPath.has(hit.chunk.path)) byPath.set(hit.chunk.path, []);
    (byPath.get(hit.chunk.path) as SearchHit[]).push(hit);
  }

  const merged: { path: string; start: number; end: number; text: string; score: number }[] = [];
  for (const [filePath, fileHits] of byPath) {
    const sorted = [...fileHits].sort((a, b) => a.chunk.startLine - b.chunk.startLine);
    let current: { path: string; start: number; end: number; lines: string[]; score: number } | null = null;
    for (const hit of sorted) {
      const lines = hit.chunk.text.split('\n');
      if (current && hit.chunk.startLine <= current.end + 4 && current.lines.length + lines.length <= 260) {
        const overlap = Math.max(0, current.end - hit.chunk.startLine + 1);
        current.lines.push(...lines.slice(overlap));
        current.end = Math.max(current.end, hit.chunk.endLine);
        current.score = Math.max(current.score, hit.score);
      } else {
        if (current) merged.push({ path: current.path, start: current.start, end: current.end, text: current.lines.join('\n'), score: current.score });
        current = { path: filePath, start: hit.chunk.startLine, end: hit.chunk.endLine, lines: [...lines], score: hit.score };
      }
    }
    if (current) merged.push({ path: current.path, start: current.start, end: current.end, text: current.lines.join('\n'), score: current.score });
  }

  return merged.sort((a, b) => b.score - a.score);
}

export function retrieve(model: RepoModel, index: RepoIndex, query: string, options: RetrieveOptions = {}): RetrievalResult {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const topK = options.topK ?? 14;

  const queryTerms = tokenize(query);
  const extra = (options.extraTerms ?? []).flatMap((term) => tokenize(term));
  const allTerms = [...new Set([...queryTerms, ...extra])];

  const hits: SearchHit[] = index.search([...queryTerms, ...extra].join(' '), topK);

  // Structural seeding: if the query names a component, module, or file, pull
  // in its key files even when lexical search would not have surfaced them.
  const structuralSeeds = new Map<string, SearchHit>();
  const lowerQuery = query.toLowerCase();
  for (const component of model.components) {
    const name = component.name.toLowerCase();
    const pathHit = component.path !== '' && lowerQuery.includes(component.path.toLowerCase());
    const nameHit = name.length > 2 && lowerQuery.includes(name);
    if (!nameHit && !pathHit) continue;
    for (const file of component.keyFiles.slice(0, 3)) {
      for (const chunk of index.chunksForFile(file).slice(0, 2)) {
        structuralSeeds.set(chunk.id, { chunk, score: 50, matched: [] });
      }
    }
  }
  // Explicit focus files win.
  for (const file of options.focusFiles ?? []) {
    for (const chunk of index.chunksForFile(file).slice(0, 3)) {
      structuralSeeds.set(chunk.id, { chunk, score: 100, matched: [] });
    }
  }

  // Keyword match against component/module names that the query mentions.
  for (const component of model.components) {
    const tokens = splitIdentifier(component.name);
    if (tokens.length === 0) continue;
    if (tokens.every((t) => allTerms.includes(t))) {
      for (const file of component.keyFiles.slice(0, 2)) {
        for (const chunk of index.chunksForFile(file).slice(0, 2)) {
          if (!structuralSeeds.has(chunk.id)) structuralSeeds.set(chunk.id, { chunk, score: 30, matched: tokens });
        }
      }
    }
  }

  const combined = [...hits];
  const seen = new Set(combined.map((h) => h.chunk.id));
  for (const seed of structuralSeeds.values()) {
    if (!seen.has(seed.chunk.id)) {
      combined.push(seed);
      seen.add(seed.chunk.id);
    }
  }

  const merged = mergeChunks(combined);
  const parts: string[] = [];
  const citations: Citation[] = [];
  let used = 0;

  for (const item of merged) {
    const header = `\n--- FILE: ${item.path} (lines ${item.start}-${item.end}) ---\n`;
    const body = item.text.length > 12_000 ? truncate(item.text, 12_000) : item.text;
    if (used + header.length + body.length > maxChars) continue;
    parts.push(`${header}${body}`);
    used += header.length + body.length;
    citations.push({
      path: item.path,
      startLine: item.start,
      endLine: item.end,
      snippet: truncate(item.text.split('\n').slice(0, 4).join('\n'), 240, ' …'),
    });
    if (parts.length >= 40) break;
  }

  return {
    hits: combined,
    context: parts.join('\n'),
    citations,
    files: [...new Set(merged.map((m) => m.path))],
  };
}

/** Convenience: the citations that overlap a set of file paths. */
export function citationsFor(result: RetrievalResult, files: string[]): Citation[] {
  const set = new Set(files);
  return result.citations.filter((c) => set.has(c.path));
}
