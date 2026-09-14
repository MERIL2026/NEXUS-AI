import type { SearchCandidate } from './vectorStore.js';

export interface SourceCitation {
  documentId: string;
  filename: string;
  sourcePath: string;
  section: string | null;
  pageNumber: number | null;
  chunkId: string;
  snippet: string;
  score: number;
}

export type GroundingStatus = 'GROUNDED' | 'PARTIALLY_GROUNDED' | 'UNGROUNDED';

export interface RetrievalResultPackage {
  query: string;
  citations: SourceCitation[];
  groundingStatus: GroundingStatus;
  evidenceText: string;
  totalCandidatesFound: number;
}

export class CitationService {
  public formatCitations(candidates: SearchCandidate[]): SourceCitation[] {
    return candidates.map((c) => ({
      documentId: c.documentId,
      filename: c.filename,
      sourcePath: c.sourcePath,
      section: c.section,
      pageNumber: c.pageNumber,
      chunkId: c.chunkId,
      snippet: c.content,
      score: c.combinedScore,
    }));
  }

  public evaluateGrounding(citations: SourceCitation[]): GroundingStatus {
    if (citations.length === 0) {
      return 'UNGROUNDED';
    }

    const topScore = citations[0].score;
    if (topScore >= 0.15) {
      return 'GROUNDED';
    } else if (topScore > 0.01) {
      return 'PARTIALLY_GROUNDED';
    } else {
      return 'UNGROUNDED';
    }
  }

  public assembleEvidenceBlock(citations: SourceCitation[]): string {
    if (citations.length === 0) {
      return 'No relevant source evidence found in knowledge base.';
    }

    return citations
      .map((c, i) => {
        const secInfo = c.section ? ` (Section: ${c.section})` : '';
        return `[Source ${i + 1}: ${c.filename}${secInfo}]\n${c.snippet}`;
      })
      .join('\n\n');
  }

  public formatCitationFooter(citations: SourceCitation[]): string {
    if (citations.length === 0) return '';
    const items = citations.map(
      (c, i) => `[${i + 1}] ${c.filename}${c.section ? ` - ${c.section}` : ''}`
    );
    return `\n\n**Sources:**\n` + items.join('\n');
  }
}
