import path from 'node:path';
import type { Chunk, FileEntry, RepoModel, SearchHit } from '../types.js';
import type { AppConfig } from '../config.js';
import type { Store, IndexSnapshot } from '../store.js';
import { readTextFile } from '../util/fs.js';
import { splitIdentifier, tokenize } from '../util/text.js';
import { chunkFile } from './chunker.js';
import { Bm25Index } from './bm25.js';
import { log } from '../logger.js';

export const INDEX_VERSION = 1;

export interface IndexStats {
  chunks: number;
  files: number;
  vocabulary: number;
  generatedAt: string;
}

/**
 * In-memory search index over a repository, backed by a JSON snapshot on disk.
 * Rebuilding is cheap enough that a stale or missing snapshot is not a problem.
 */
export class RepoIndex {
  private bm25: Bm25Index;
  private readonly byId = new Map<string, Chunk>();

  constructor(
    readonly chunks: Chunk[],
    readonly stats: IndexStats,
  ) {
    for (const chunk of chunks) this.byId.set(chunk.id, chunk);
    this.bm25 = new Bm25Index(
      chunks.map((chunk) => ({
        id: chunk.id,
        tokens: chunk.tokens,
        metaTokens: [...splitIdentifier(chunk.path), ...(chunk.symbol ? splitIdentifier(chunk.symbol) : [])],
      })),
    );
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  getChunk(id: string): Chunk | undefined {
    return this.byId.get(id);
  }

  search(query: string, topK = 12): SearchHit[] {
    const tokens = tokenize(query);
    let hits = this.bm25.search(tokens, topK);
    if (hits.length < Math.min(3, topK)) {
      // Fall back to a looser match so we still return something useful.
      hits = this.bm25.search(tokens, topK, { requireAll: false });
    }
    return hits
      .map((hit) => {
        const chunk = this.byId.get(hit.id);
        if (!chunk) return null;
        return { chunk, score: Number(hit.score.toFixed(3)), matched: hit.matched } satisfies SearchHit;
      })
      .filter((hit): hit is SearchHit => hit !== null);
  }

  /** Chunks for a specific file, in line order. */
  chunksForFile(filePath: string): Chunk[] {
    return this.chunks.filter((c) => c.path === filePath).sort((a, b) => a.startLine - b.startLine);
  }

  toSnapshot(repoId: string): IndexSnapshot {
    return {
      version: INDEX_VERSION,
      repoId,
      generatedAt: this.stats.generatedAt,
      chunkCount: this.chunks.length,
      chunks: this.chunks.map((chunk) => ({
        id: chunk.id,
        path: chunk.path,
        language: chunk.language,
        kind: chunk.kind,
        symbol: chunk.symbol,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: chunk.text,
      })),
    };
  }

  static fromSnapshot(snapshot: IndexSnapshot): RepoIndex {
    const chunks: Chunk[] = snapshot.chunks.map((chunk) => ({
      id: chunk.id,
      path: chunk.path,
      language: chunk.language,
      kind: chunk.kind as Chunk['kind'],
      symbol: chunk.symbol,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      text: chunk.text,
      tokens: tokenize(`${chunk.path} ${chunk.symbol ?? ''} ${chunk.text}`),
    }));
    const files = new Set(chunks.map((c) => c.path));
    return new RepoIndex(chunks, {
      chunks: chunks.length,
      files: files.size,
      vocabulary: 0,
      generatedAt: snapshot.generatedAt,
    });
  }
}

export interface BuildIndexOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function buildIndex(root: string, model: RepoModel, options: BuildIndexOptions = {}): Promise<RepoIndex> {
  const maxFiles = options.maxFiles ?? 6000;
  const maxFileBytes = options.maxFileBytes ?? 300_000;

  const candidates: FileEntry[] = model.files
    .filter((f) => !f.isBinary && !f.isNoise && f.category !== 'asset' && f.category !== 'generated')
    .sort((a, b) => {
      const score = (f: FileEntry) => (f.category === 'source' ? 2 : f.category === 'docs' ? 1.5 : f.category === 'config' ? 1 : 0.5);
      return score(b) - score(a) || b.lines - a.lines;
    })
    .slice(0, maxFiles);

  const chunks: Chunk[] = [];
  let done = 0;
  const concurrency = 16;
  let cursor = 0;

  await Promise.all(
    new Array(Math.min(concurrency, candidates.length)).fill(null).map(async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= candidates.length) return;
        const entry = candidates[index];
        const text = await readTextFile(path.join(root, entry.path), maxFileBytes);
        if (text) {
          try {
            chunks.push(...chunkFile(text, entry.path, entry));
          } catch (error) {
            log.warn('chunker failed', entry.path, error instanceof Error ? error.message : error);
          }
        }
        done += 1;
        if (done % 250 === 0) options.onProgress?.(done, candidates.length);
      }
    }),
  );

  options.onProgress?.(candidates.length, candidates.length);
  chunks.sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);

  const files = new Set(chunks.map((c) => c.path));
  const index = new RepoIndex(chunks, {
    chunks: chunks.length,
    files: files.size,
    vocabulary: 0,
    generatedAt: new Date().toISOString(),
  });
  return index;
}

/** Load a cached index if it matches the current analysis, otherwise build and cache. */
export async function ensureIndex(
  cfg: AppConfig,
  store: Store,
  root: string,
  model: RepoModel,
  options: { force?: boolean } = {},
): Promise<RepoIndex> {
  if (!options.force) {
    const snapshot = await store.readIndex(model.repo.id);
    if (snapshot && snapshot.version === INDEX_VERSION && model.files.length > 0) {
      const known = new Set(snapshot.chunks.map((c) => c.path));
      const sourceCount = model.files.filter((f) => f.category === 'source').length;
      if (known.size >= Math.min(sourceCount, 1) && snapshot.chunkCount > 0) {
        return RepoIndex.fromSnapshot(snapshot);
      }
    }
  }
  const index = await buildIndex(root, model, {
    maxFiles: cfg.maxFiles,
    maxFileBytes: cfg.maxFileBytes,
  });
  await store.writeIndex(model.repo.id, index.toSnapshot(model.repo.id));
  return index;
}

export function emptyIndex(): RepoIndex {
  return new RepoIndex([], { chunks: 0, files: 0, vocabulary: 0, generatedAt: new Date().toISOString() });
}

const indexCache = new Map<string, RepoIndex>();

export function cacheIndex(repoId: string, index: RepoIndex): void {
  indexCache.set(repoId, index);
}

export function getCachedIndex(repoId: string): RepoIndex | undefined {
  return indexCache.get(repoId);
}
