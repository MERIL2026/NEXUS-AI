import type { MessageRepository } from '../storage/repositories/messageRepository.js';
import type { Message } from '../storage/repositories/types.js';
import { Logger, LogLevel } from '../common/logger.js';

export interface AddMessageDto {
  id?: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  status?: Message['status'];
}

export class MessageService {
  private logger: Logger;

  constructor(
    private messageRepo: MessageRepository,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('MessageService', logLevel);
  }

  addMessage(dto: AddMessageDto): Message {
    const id = dto.id || `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const status = dto.status || 'completed';

    const record = this.messageRepo.create({
      id,
      conversationId: dto.conversationId,
      role: dto.role,
      content: dto.content,
      status,
    });

    this.logger.debug(`Added ${dto.role} message '${id}' to conversation '${dto.conversationId}'`);
    return record;
  }

  getMessages(conversationId: string): Message[] {
    return this.messageRepo.listByConversation(conversationId);
  }
}
