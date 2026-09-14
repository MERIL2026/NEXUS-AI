import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StorageService } from '../storage/index.js';
import { DocumentParser } from '../knowledge/parsers.js';
import { Chunker } from '../knowledge/chunker.js';
import { LocalFeatureEmbeddingProvider } from '../knowledge/embeddings.js';
import { VectorStore } from '../knowledge/vectorStore.js';
import { RagEngine } from '../knowledge/ragEngine.js';

describe('Phase P4 RAG & Knowledge Engine Baseline Tests', () => {
  let storage: StorageService;
  let rag: RagEngine;

  beforeEach(async () => {
    storage = new StorageService(':memory:', 'error');
    await storage.initialize();
    rag = new RagEngine(storage.knowledge, 'error');
  });

  afterEach(() => {
    storage.close();
  });

  it('parses markdown document sections and metadata', () => {
    const parser = new DocumentParser();
    const doc = parser.parseRawText('spec.md', '# Section 1\nContent A\n\n# Section 2\nContent B');

    expect(doc.filename).toBe('spec.md');
    expect(doc.mimeType).toBe('text/markdown');
    expect(doc.sections).toHaveLength(2);
    expect(doc.sections[0].title).toBe('Section 1');
  });

  it('chunks documents with semantic section boundaries', () => {
    const parser = new DocumentParser();
    const doc = parser.parseRawText('guide.txt', 'Header Line:\nParagraph text here...');
    const chunker = new Chunker({ targetChunkSize: 50 });
    const chunks = chunker.chunkDocument(doc);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].chunkIndex).toBe(0);
  });

  it('generates normalized local vector embeddings', async () => {
    const provider = new LocalFeatureEmbeddingProvider();
    const vec1 = await provider.embedText('vector similarity test');
    const vec2 = await provider.embedText('vector similarity test');

    expect(vec1).toHaveLength(64);
    expect(vec1).toEqual(vec2);

    const sim = VectorStore.cosineSimilarity(vec1, vec2);
    expect(sim).toBeCloseTo(1.0, 4);
  });

  it('ingests document idempotently without duplicate versioning when hash is unchanged', async () => {
    const col = rag.createCollection('Test Collection');
    const docText = '# System Architecture\nNEXUS AI runs offline.';

    const doc1 = await rag.ingestText('arch.md', docText, col.id);
    const doc2 = await rag.ingestText('arch.md', docText, col.id);

    expect(doc1.id).toBe(doc2.id);
    expect(doc2.currentVersion).toBe(1);
  });

  it('executes hybrid search and returns citations with grounding state', async () => {
    const col = rag.createCollection('Research Collection');
    await rag.ingestText(
      'quantum.md',
      '# Quantum Computing\nSuperposition and entanglement enable high performance computing.',
      col.id
    );

    const result = await rag.retrieveEvidence('superposition computing', col.id, 2);

    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations[0].filename).toBe('quantum.md');
    expect(['GROUNDED', 'PARTIALLY_GROUNDED']).toContain(result.groundingStatus);
    expect(result.evidenceText).toContain('Superposition');
  });

  it('returns UNGROUNDED state when no matching evidence exists', async () => {
    const col = rag.createCollection('Empty Collection');
    await rag.ingestText('fruit.txt', 'Apples and bananas are sweet fruits.', col.id);

    const result = await rag.retrieveEvidence('unrelated quantum mechanics astrophysics', col.id, 2);

    expect(result.groundingStatus).toBe('UNGROUNDED');
  });

  it('enforces collection isolation during retrieval', async () => {
    const colA = rag.createCollection('Collection A');
    const colB = rag.createCollection('Collection B');

    await rag.ingestText('docA.txt', 'Secret information A', colA.id);
    await rag.ingestText('docB.txt', 'Secret information B', colB.id);

    const resultA = await rag.retrieveEvidence('Secret information', colA.id, 5);
    const filenamesA = resultA.citations.map((c) => c.filename);

    expect(filenamesA).toContain('docA.txt');
    expect(filenamesA).not.toContain('docB.txt');
  });

  it('deletes document and invalidates derived search indexes', async () => {
    const col = rag.createCollection('Deletion Test Collection');
    const doc = await rag.ingestText('temp.txt', 'Temporary text to delete', col.id);

    const beforeDelete = await rag.retrieveEvidence('Temporary text', col.id, 2);
    expect(beforeDelete.citations.length).toBeGreaterThan(0);

    rag.deleteDocument(doc.id);

    const afterDelete = await rag.retrieveEvidence('Temporary text', col.id, 2);
    expect(afterDelete.citations).toHaveLength(0);
  });
});
