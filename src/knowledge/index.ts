import type { SubsystemStatus } from '../storage/index.js';
import type { KnowledgeRepository } from '../storage/repositories/knowledgeRepository.js';
import { RagEngine } from './ragEngine.js';
import { Logger, LogLevel } from '../common/logger.js';

export interface IKnowledgeEngine {
  initialize(repo?: KnowledgeRepository): Promise<SubsystemStatus>;
  getStatus(): SubsystemStatus;
}

export class KnowledgeEngine implements IKnowledgeEngine {
  private initialized = false;
  private logger: Logger;
  public rag!: RagEngine;

  constructor(logLevel: LogLevel = 'info') {
    this.logger = new Logger('KnowledgeEngine', logLevel);
  }

  async initialize(repo?: KnowledgeRepository): Promise<SubsystemStatus> {
    this.logger.info('Initializing KnowledgeEngine & local RAG pipeline');

    if (repo) {
      this.rag = new RagEngine(repo, 'info');
      // Ensure a default collection exists
      this.rag.getOrCreateDefaultCollection();
    }

    this.initialized = true;
    return this.getStatus();
  }

  getStatus(): SubsystemStatus {
    return {
      name: 'KnowledgeEngine',
      initialized: this.initialized,
      status: this.initialized ? 'ok' : 'degraded',
      message: this.initialized ? 'Local RAG & Knowledge Engine ready' : 'Uninitialized',
    };
  }
}

export * from './parsers.js';
export * from './chunker.js';
export * from './embeddings.js';
export * from './vectorStore.js';
export * from './hybridSearch.js';
export * from './reranker.js';
export * from './citationService.js';
export * from './ragEngine.js';
