import type { VectorStore, SearchCandidate } from './vectorStore.js';
import type { IEmbeddingProvider } from './embeddings.js';

export interface HybridSearchOptions {
  alpha?: number; // Weight for vector score vs lexical score (0.0 to 1.0, default 0.6)
  topK?: number;  // Max merged candidates
}

export class HybridSearchEngine {
  constructor(
    private vectorStore: VectorStore,
    private embeddingProvider: IEmbeddingProvider
  ) {}

  public async search(
    collectionId: string,
    query: string,
    options: HybridSearchOptions = {}
  ): Promise<SearchCandidate[]> {
    const alpha = options.alpha ?? 0.6;
    const topK = options.topK ?? 10;

    const queryVector = await this.embeddingProvider.embedText(query);
    const vectorCandidates = this.vectorStore.searchVector(collectionId, queryVector, topK * 2);
    const lexicalCandidates = this.vectorStore.searchLexical(collectionId, query, topK * 2);

    const mergedMap = new Map<string, SearchCandidate>();

    for (const c of vectorCandidates) {
      mergedMap.set(c.chunkId, {
        ...c,
        combinedScore: alpha * c.vectorScore,
      });
    }

    for (const c of lexicalCandidates) {
      const existing = mergedMap.get(c.chunkId);
      if (existing) {
        existing.lexicalScore = c.lexicalScore;
        existing.combinedScore = alpha * existing.vectorScore + (1 - alpha) * c.lexicalScore;
      } else {
        mergedMap.set(c.chunkId, {
          ...c,
          combinedScore: (1 - alpha) * c.lexicalScore,
        });
      }
    }

    const merged = Array.from(mergedMap.values());
    return merged.sort((a, b) => b.combinedScore - a.combinedScore).slice(0, topK);
  }
}
