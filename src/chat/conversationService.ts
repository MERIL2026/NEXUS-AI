import type { ConversationRepository } from '../storage/repositories/conversationRepository.js';
import type { Conversation, ConversationSummary } from '../storage/repositories/types.js';
import { Logger, LogLevel } from '../common/logger.js';

export interface CreateConversationDto {
  id?: string;
  projectId?: string | null;
  title?: string;
  mode?: string;
}

export interface UpdateConversationDto {
  title?: string;
  mode?: string;
  archivedAt?: string | null;
}

export class ConversationService {
  private logger: Logger;

  constructor(
    private conversationRepo: ConversationRepository,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('ConversationService', logLevel);
  }

  createConversation(dto: CreateConversationDto = {}): Conversation {
    const id = dto.id || `conv-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const title = dto.title || 'New Chat';
    const mode = dto.mode || 'chat';

    this.logger.info(`Creating conversation '${id}' (title: "${title}")`);
    return this.conversationRepo.create({
      id,
      projectId: dto.projectId ?? null,
      title,
      mode,
    });
  }

  getConversation(id: string): Conversation {
    const conv = this.conversationRepo.findById(id);
    if (!conv) {
      throw new Error(`Conversation not found: '${id}'`);
    }
    return conv;
  }

  listConversations(projectId: string | null = null): Conversation[] {
    return this.conversationRepo.listByProject(projectId);
  }

  listAllConversations(limit = 100, offset = 0): ConversationSummary[] {
    return this.conversationRepo.listAll(limit, offset);
  }

  searchConversations(query: string, limit = 50): ConversationSummary[] {
    if (!query || !query.trim()) {
      return this.listAllConversations(limit);
    }
    return this.conversationRepo.search(query, limit);
  }

  updateConversation(id: string, updates: UpdateConversationDto): Conversation {
    this.getConversation(id); // Ensure existence
    const updated = this.conversationRepo.update(id, updates);
    if (!updated) {
      throw new Error(`Failed to update conversation '${id}'`);
    }
    this.logger.info(`Updated conversation '${id}' metadata`);
    return updated;
  }

  deleteConversation(id: string): boolean {
    this.logger.info(`Deleting conversation '${id}'`);
    return this.conversationRepo.deleteById(id);
  }

  /**
   * Deterministically generates a clean, concise conversation title from the first user prompt.
   */
  generateTitle(prompt: string): string {
    if (!prompt || !prompt.trim()) {
      return 'New Chat';
    }

    let cleaned = prompt
      .trim()
      .replace(/^[/#][a-zA-Z0-9_-]+\s*/, '') // Strip slash command prefixes
      .replace(/^(hello|hi|hey|dear)\s+(nexus|ai|assistant)[,.!]?\s*/i, '') // Strip greeting
      .replace(/^(can you|please|could you)\s+(explain|describe|show|clarify)\s+/i, '$2 ')
      .replace(/^(can you|please|could you)\s+/i, '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/[?.,!;:]+$/, '')
      .trim();

    if (!cleaned) {
      cleaned = prompt.trim().slice(0, 40);
    }

    // Capitalize first character
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

    // Limit to 50 chars at word boundary if possible
    if (cleaned.length > 50) {
      const truncated = cleaned.slice(0, 47);
      const lastSpace = truncated.lastIndexOf(' ');
      if (lastSpace > 20) {
        cleaned = truncated.slice(0, lastSpace) + '...';
      } else {
        cleaned = truncated + '...';
      }
    }

    return cleaned || 'New Chat';
  }
}
