import type { SearchCandidate } from './vectorStore.js';

export interface IReranker {
  rerank(query: string, candidates: SearchCandidate[], topN?: number): SearchCandidate[];
}

export class SimpleReranker implements IReranker {
  constructor(private minScoreThreshold: number = 0.01) {}

  public rerank(_query: string, candidates: SearchCandidate[], topN: number = 5): SearchCandidate[] {
    const filtered = candidates.filter((c) => c.combinedScore >= this.minScoreThreshold);
    return filtered.sort((a, b) => b.combinedScore - a.combinedScore).slice(0, topN);
  }
}
