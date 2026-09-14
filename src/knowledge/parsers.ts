import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface ParsedDocumentSection {
  title: string | null;
  pageNumber: number | null;
  content: string;
}

export interface ParsedDocument {
  filename: string;
  sourcePath: string;
  mimeType: string;
  contentHash: string;
  fullText: string;
  sections: ParsedDocumentSection[];
}

export class DocumentParser {
  public parseFile(filePath: string): ParsedDocument {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found at path: '${filePath}'`);
    }

    const rawBytes = fs.readFileSync(filePath);
    const contentHash = crypto.createHash('sha256').update(rawBytes).digest('hex');
    const filename = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();

    const mimeType = this.detectMimeType(ext);
    const fullText = rawBytes.toString('utf-8');
    const sections = this.extractSections(fullText, ext);

    return {
      filename,
      sourcePath: filePath,
      mimeType,
      contentHash,
      fullText,
      sections,
    };
  }

  public parseRawText(filename: string, text: string, sourcePath: string = filename): ParsedDocument {
    const contentHash = crypto.createHash('sha256').update(text).digest('hex');
    const ext = path.extname(filename).toLowerCase() || '.txt';
    const mimeType = this.detectMimeType(ext);
    const sections = this.extractSections(text, ext);

    return {
      filename,
      sourcePath,
      mimeType,
      contentHash,
      fullText: text,
      sections,
    };
  }

  private detectMimeType(ext: string): string {
    switch (ext) {
      case '.md':
      case '.markdown':
        return 'text/markdown';
      case '.json':
        return 'application/json';
      case '.csv':
        return 'text/csv';
      case '.js':
      case '.ts':
      case '.py':
      case '.java':
      case '.c':
      case '.cpp':
        return 'text/x-code';
      default:
        return 'text/plain';
    }
  }

  private extractSections(text: string, ext: string): ParsedDocumentSection[] {
    const lines = text.split('\n');
    const sections: ParsedDocumentSection[] = [];
    let currentTitle: string | null = null;
    let currentBuffer: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      const isHeader =
        trimmed.startsWith('#') ||
        (ext === '.md' && /^#+\s+/.test(trimmed)) ||
        (ext === '.txt' && /^[A-Z0-9\s_\-]{3,50}:$/.test(trimmed));

      if (isHeader) {
        if (currentBuffer.length > 0) {
          sections.push({
            title: currentTitle,
            pageNumber: 1,
            content: currentBuffer.join('\n').trim(),
          });
          currentBuffer = [];
        }
        currentTitle = trimmed.replace(/^#+\s*/, '').replace(/:$/, '');
      } else {
        currentBuffer.push(line);
      }
    }

    if (currentBuffer.length > 0) {
      sections.push({
        title: currentTitle,
        pageNumber: 1,
        content: currentBuffer.join('\n').trim(),
      });
    }

    return sections.length > 0 ? sections : [{ title: null, pageNumber: 1, content: text }];
  }
}
