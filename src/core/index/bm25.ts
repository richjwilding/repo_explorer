/**
 * BM25 ranking with a light path/symbol boost.
 *
 * A pure-JS implementation keeps the app dependency-free and fast enough for
 * tens of thousands of chunks, and makes retrieval behaviour predictable.
 */
export interface Bm25Document {
  id: string;
  tokens: string[];
  /** Extra tokens (path segments, symbol names) that boost matches. */
  metaTokens?: string[];
}

export interface Bm25Hit {
  id: string;
  index: number;
  score: number;
  matched: string[];
}

const K1 = 1.35;
const B = 0.72;
const META_WEIGHT = 1.6;

export class Bm25Index {
  private postings = new Map<string, Map<number, number>>();
  private metaPostings = new Map<string, Set<number>>();
  private docLengths: number[] = [];
  private avgLength = 1;
  private readonly docCount: number;

  constructor(private readonly documents: Bm25Document[]) {
    this.docCount = documents.length;
    let total = 0;
    documents.forEach((doc, index) => {
      const length = Math.max(1, doc.tokens.length);
      this.docLengths[index] = length;
      total += length;
      const tf = new Map<string, number>();
      for (const token of doc.tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
      for (const [token, count] of tf) {
        let map = this.postings.get(token);
        if (!map) {
          map = new Map();
          this.postings.set(token, map);
        }
        map.set(index, count);
      }
      for (const token of doc.metaTokens ?? []) {
        let set = this.metaPostings.get(token);
        if (!set) {
          set = new Set();
          this.metaPostings.set(token, set);
        }
        set.add(index);
      }
    });
    this.avgLength = this.docCount > 0 ? total / this.docCount : 1;
  }

  get size(): number {
    return this.docCount;
  }

  get vocabularySize(): number {
    return this.postings.size;
  }

  private idf(term: string): number {
    const df = this.postings.get(term)?.size ?? 0;
    if (df === 0) return 0;
    return Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));
  }

  /** Documents that contain every query term (used for exact-phrase fallback). */
  private candidates(terms: string[], requireAll: boolean): Set<number> | null {
    let result: Set<number> | null = null;
    for (const term of terms) {
      const postings = this.postings.get(term);
      if (!postings) {
        if (requireAll) return new Set();
        continue;
      }
      if (result === null) {
        result = new Set(postings.keys());
      } else {
        for (const index of [...result]) if (!postings.has(index)) result.delete(index);
      }
    }
    return result;
  }

  search(queryTokens: string[], topK = 12, options: { requireAll?: boolean } = {}): Bm25Hit[] {
    const terms = [...new Set(queryTokens)];
    if (terms.length === 0) return [];

    const allowed = options.requireAll ? this.candidates(terms, true) : null;
    const scores = new Map<number, number>();
    const matchedTerms = new Map<number, Set<string>>();

    for (const term of terms) {
      const postings = this.postings.get(term);
      const idf = this.idf(term);
      if (!postings || idf === 0) continue;
      for (const [index, tf] of postings) {
        if (allowed && !allowed.has(index)) continue;
        const length = this.docLengths[index] || 1;
        const denominator = tf + K1 * (1 - B + B * (length / this.avgLength));
        const contribution = idf * ((tf * (K1 + 1)) / denominator);
        scores.set(index, (scores.get(index) ?? 0) + contribution);
        let set = matchedTerms.get(index);
        if (!set) {
          set = new Set();
          matchedTerms.set(index, set);
        }
        set.add(term);
      }
    }

    // Boost documents whose path or symbol names contain query terms.
    for (const term of terms) {
      const meta = this.metaPostings.get(term);
      if (!meta) continue;
      for (const index of meta) {
        if (allowed && !allowed.has(index)) continue;
        scores.set(index, (scores.get(index) ?? 0) + this.idf(term) * META_WEIGHT * 0.5);
        let set = matchedTerms.get(index);
        if (!set) {
          set = new Set();
          matchedTerms.set(index, set);
        }
        set.add(term);
      }
    }

    return [...scores.entries()]
      .map(([index, score]) => ({
        id: this.documents[index].id,
        index,
        score,
        matched: [...(matchedTerms.get(index) ?? [])],
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
