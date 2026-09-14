import type { KnowledgeRepository } from '../storage/repositories/knowledgeRepository.js';

export interface SearchCandidate {
  chunkId: string;
  documentId: string;
  collectionId: string;
  content: string;
  section: string | null;
  pageNumber: number | null;
  filename: string;
  sourcePath: string;
  vectorScore: number;
  lexicalScore: number;
  combinedScore: number;
}

export class VectorStore {
  constructor(private knowledgeRepo: KnowledgeRepository) {}

  public static cosineSimilarity(v1: number[], v2: number[]): number {
    if (v1.length !== v2.length || v1.length === 0) return 0;

    let dot = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < v1.length; i++) {
      dot += v1[i] * v2[i];
      norm1 += v1[i] * v1[i];
      norm2 += v2[i] * v2[i];
    }

    if (norm1 === 0 || norm2 === 0) return 0;
    return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }

  public searchVector(collectionId: string, queryVector: number[], topK: number = 5): SearchCandidate[] {
    const records = this.knowledgeRepo.getEmbeddingsForCollection(collectionId);
    const results: SearchCandidate[] = [];

    for (const rec of records) {
      const vectorScore = VectorStore.cosineSimilarity(queryVector, rec.embedding);
      results.push({
        chunkId: rec.chunkId,
        documentId: rec.documentId,
        collectionId: rec.collectionId,
        content: rec.content,
        section: rec.section,
        pageNumber: rec.pageNumber,
        filename: rec.filename,
        sourcePath: rec.sourcePath,
        vectorScore,
        lexicalScore: 0,
        combinedScore: vectorScore,
      });
    }

    return results.sort((a, b) => b.vectorScore - a.vectorScore).slice(0, topK);
  }

  public searchLexical(collectionId: string, query: string, topK: number = 5): SearchCandidate[] {
    const chunks = this.knowledgeRepo.getChunksByCollection(collectionId);
    const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results: SearchCandidate[] = [];

    for (const chunk of chunks) {
      const contentLower = chunk.content.toLowerCase();
      let matchCount = 0;

      for (const token of queryTokens) {
        if (contentLower.includes(token)) {
          matchCount++;
        }
      }

      const lexicalScore = queryTokens.length > 0 ? matchCount / queryTokens.length : 0;
      if (lexicalScore > 0) {
        results.push({
          chunkId: chunk.id,
          documentId: chunk.documentId,
          collectionId: chunk.collectionId,
          content: chunk.content,
          section: chunk.section,
          pageNumber: chunk.pageNumber,
          filename: chunk.filename,
          sourcePath: chunk.sourcePath,
          vectorScore: 0,
          lexicalScore,
          combinedScore: lexicalScore,
        });
      }
    }

    return results.sort((a, b) => b.lexicalScore - a.lexicalScore).slice(0, topK);
  }
}
