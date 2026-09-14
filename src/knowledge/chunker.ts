import type { ParsedDocument } from './parsers.js';

export interface ChunkOptions {
  targetChunkSize?: number; // Target character length per chunk
  overlapSize?: number;     // Overlap character length
}

export interface DocumentChunkSpec {
  chunkIndex: number;
  content: string;
  section: string | null;
  pageNumber: number | null;
  tokenCount: number;
}

export class Chunker {
  constructor(private defaultOptions: ChunkOptions = {}) {}

  public chunkDocument(doc: ParsedDocument, options?: ChunkOptions): DocumentChunkSpec[] {
    const targetSize = options?.targetChunkSize || this.defaultOptions.targetChunkSize || 400;
    const overlap = options?.overlapSize || this.defaultOptions.overlapSize || 50;

    const chunks: DocumentChunkSpec[] = [];
    let globalIndex = 0;

    for (const sec of doc.sections) {
      const text = sec.content;
      if (!text || text.trim().length === 0) continue;

      if (text.length <= targetSize) {
        chunks.push({
          chunkIndex: globalIndex++,
          content: text,
          section: sec.title,
          pageNumber: sec.pageNumber,
          tokenCount: Math.ceil(text.length / 4),
        });
      } else {
        // Split section text into sliding chunks with overlap
        let start = 0;
        while (start < text.length) {
          let end = Math.min(start + targetSize, text.length);

          // If not at text end, try to snap to nearest space or newline
          if (end < text.length) {
            const lastSpace = text.lastIndexOf(' ', end);
            if (lastSpace > start + Math.floor(targetSize / 2)) {
              end = lastSpace + 1;
            }
          }

          const chunkText = text.substring(start, end).trim();
          if (chunkText.length > 0) {
            chunks.push({
              chunkIndex: globalIndex++,
              content: chunkText,
              section: sec.title,
              pageNumber: sec.pageNumber,
              tokenCount: Math.ceil(chunkText.length / 4),
            });
          }

          if (end >= text.length) break;
          start = Math.max(start + 1, end - overlap);
        }
      }
    }

    return chunks;
  }
}
