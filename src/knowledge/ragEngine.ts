import type { KnowledgeRepository } from '../storage/repositories/knowledgeRepository.js';
import type { KnowledgeCollectionRecord, DocumentRecord } from '../storage/repositories/knowledgeRepository.js';
import { DocumentParser } from './parsers.js';
import { Chunker } from './chunker.js';
import { LocalFeatureEmbeddingProvider } from './embeddings.js';
import { VectorStore } from './vectorStore.js';
import { HybridSearchEngine } from './hybridSearch.js';
import { SimpleReranker } from './reranker.js';
import { CitationService, type RetrievalResultPackage } from './citationService.js';
import { Logger, LogLevel } from '../common/logger.js';

export class RagEngine {
  private logger: Logger;
  private parser = new DocumentParser();
  private chunker = new Chunker({ targetChunkSize: 400, overlapSize: 50 });
  private embeddingProvider = new LocalFeatureEmbeddingProvider();
  private vectorStore: VectorStore;
  private hybridSearch: HybridSearchEngine;
  private reranker = new SimpleReranker(0.01);
  private citationService = new CitationService();

  constructor(
    private knowledgeRepo: KnowledgeRepository,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('RagEngine', logLevel);
    this.vectorStore = new VectorStore(knowledgeRepo);
    this.hybridSearch = new HybridSearchEngine(this.vectorStore, this.embeddingProvider);
  }

  public createCollection(name: string, projectId: string | null = null): KnowledgeCollectionRecord {
    const id = `col-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    this.logger.info(`Creating knowledge collection '${id}' (name: "${name}")`);
    return this.knowledgeRepo.createCollection({ id, name, projectId });
  }

  public getOrCreateDefaultCollection(): KnowledgeCollectionRecord {
    const collections = this.knowledgeRepo.listCollections();
    if (collections.length > 0) {
      return collections[0];
    }
    return this.createCollection('Default Knowledge Base');
  }

  public listCollections(): KnowledgeCollectionRecord[] {
    return this.knowledgeRepo.listCollections();
  }

  public async ingestText(filename: string, text: string, collectionId: string): Promise<DocumentRecord> {
    const parsed = this.parser.parseRawText(filename, text);

    // Check idempotency: if content hash matches, return existing document
    const existing = this.knowledgeRepo.findDocumentByHash(collectionId, parsed.contentHash);
    if (existing) {
      this.logger.info(`Document '${filename}' hash match. Skipping duplicate indexing.`);
      return existing;
    }

    const docId = `doc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const versionId = `ver-${docId}-1`;

    const docRecord = this.knowledgeRepo.createDocument({
      id: docId,
      collectionId,
      filename: parsed.filename,
      sourcePath: parsed.sourcePath,
      mimeType: parsed.mimeType,
      contentHash: parsed.contentHash,
    });

    this.knowledgeRepo.createVersion({
      id: versionId,
      documentId: docId,
      version: 1,
      content: parsed.fullText,
    });

    // Chunking
    const chunkSpecs = this.chunker.chunkDocument(parsed);
    this.logger.info(`Chunked document '${filename}' into ${chunkSpecs.length} chunk(s)`);

    for (const spec of chunkSpecs) {
      const chunkId = `chk-${docId}-${spec.chunkIndex}`;
      this.knowledgeRepo.createChunk({
        id: chunkId,
        documentId: docId,
        versionId,
        collectionId,
        chunkIndex: spec.chunkIndex,
        content: spec.content,
        section: spec.section,
        pageNumber: spec.pageNumber,
        tokenCount: spec.tokenCount,
      });

      // Local vector embedding
      const vector = await this.embeddingProvider.embedText(spec.content);
      const embId = `emb-${chunkId}`;
      this.knowledgeRepo.saveEmbedding({
        id: embId,
        chunkId,
        embedding: vector,
        modelName: this.embeddingProvider.modelName,
      });
    }

    return docRecord;
  }

  public async ingestFile(filePath: string, collectionId: string): Promise<DocumentRecord> {
    const parsed = this.parser.parseFile(filePath);

    const existing = this.knowledgeRepo.findDocumentByHash(collectionId, parsed.contentHash);
    if (existing) {
      this.logger.info(`File '${filePath}' hash match. Skipping duplicate indexing.`);
      return existing;
    }

    return this.ingestText(parsed.filename, parsed.fullText, collectionId);
  }

  public async retrieveEvidence(
    query: string,
    collectionId: string,
    topK: number = 3
  ): Promise<RetrievalResultPackage> {
    this.logger.info(`Retrieving evidence for query in collection '${collectionId}'`);

    const rawCandidates = await this.hybridSearch.search(collectionId, query, { alpha: 0.6, topK: topK * 2 });
    const reranked = this.reranker.rerank(query, rawCandidates, topK);
    const citations = this.citationService.formatCitations(reranked);
    const groundingStatus = this.citationService.evaluateGrounding(citations);
    const evidenceText = this.citationService.assembleEvidenceBlock(citations);

    return {
      query,
      citations,
      groundingStatus,
      evidenceText,
      totalCandidatesFound: rawCandidates.length,
    };
  }

  public deleteDocument(documentId: string): boolean {
    this.logger.info(`Deleting document '${documentId}' and derived chunks/embeddings`);
    return this.knowledgeRepo.deleteDocument(documentId);
  }
}
