import type { ConversationService } from './conversationService.js';
import type { MessageService } from './messageService.js';
import type { ModelGateway } from '../intelligence/modelGateway.js';
import type { RagEngine } from '../knowledge/ragEngine.js';
import type { Message } from '../storage/repositories/types.js';
import { ContextBuilder, type ContextPackage } from './contextBuilder.js';
import { PromptTemplates } from './promptTemplates.js';
import { CitationService, type RetrievalResultPackage } from '../knowledge/citationService.js';
import { Logger, LogLevel } from '../common/logger.js';

export interface SendMessageOptions {
  conversationId: string;
  userPrompt: string;
  modelId?: string;
  customSystemPrompt?: string;
  maxContextTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  enableRag?: boolean;
  collectionId?: string;
}

export interface ChatStreamEvent {
  type: 'delta' | 'completion' | 'error' | 'cancellation';
  conversationId: string;
  delta?: string;
  fullText?: string;
  messageId?: string;
  error?: string;
  contextInfo?: {
    estimatedTokens: number;
    truncatedCount: number;
    ragGrounding?: string;
  };
}

export class ChatService {
  private logger: Logger;
  private contextBuilder = new ContextBuilder();
  private citationService = new CitationService();

  constructor(
    private conversationService: ConversationService,
    private messageService: MessageService,
    private modelGateway: ModelGateway,
    private ragEngine?: RagEngine,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('ChatService', logLevel);
  }

  async sendMessage(
    options: SendMessageOptions,
    onEvent?: (event: ChatStreamEvent) => void,
    externalSignal?: AbortSignal
  ): Promise<{ userMessage: Message; assistantMessage: Message; context: ContextPackage; ragResult?: RetrievalResultPackage }> {
    const { conversationId, userPrompt } = options;

    // 1. Conversation validation & auto-title update if new
    const conversation = this.conversationService.getConversation(conversationId);
    const existingMessages = this.messageService.getMessages(conversation.id);

    if (
      existingMessages.length === 0 ||
      conversation.title === 'New Chat' ||
      conversation.title === 'new-chat' ||
      conversation.title === ''
    ) {
      const generatedTitle = this.conversationService.generateTitle(userPrompt);
      try {
        this.conversationService.updateConversation(conversation.id, { title: generatedTitle });
      } catch (err) {
        this.logger.warn(`Failed to auto-update conversation title: ${String(err)}`);
      }
    }

    // 2. Persist user message
    const userMessage = this.messageService.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: userPrompt,
      status: 'completed',
    });

    // 3. RAG Evidence Retrieval (if enabled)
    let ragResult: RetrievalResultPackage | undefined;
    let customSystemPrompt = options.customSystemPrompt || PromptTemplates.getDefaultSystemPrompt();

    if (options.enableRag && this.ragEngine) {
      const colId = options.collectionId || this.ragEngine.getOrCreateDefaultCollection().id;
      this.logger.info(`Retrieving RAG evidence for query in collection '${colId}'`);

      ragResult = await this.ragEngine.retrieveEvidence(userPrompt, colId, 3);

      if (ragResult.groundingStatus === 'UNGROUNDED') {
        customSystemPrompt += '\n\n[RAG Grounding Note]: Insufficient evidence found in knowledge base. State clearly if information is unknown.';
      } else {
        customSystemPrompt += `\n\n[Untrusted Source Context Evidence (${ragResult.groundingStatus})]:\n${ragResult.evidenceText}`;
      }
    }

    // 4. Retrieve conversation history & build context
    const history = this.messageService.getMessages(conversation.id);
    const context = this.contextBuilder.buildContext(history, {
      maxContextTokens: options.maxContextTokens,
      customSystemPrompt,
    });

    // 5. Construct prompt package
    const promptPkg = PromptTemplates.buildPromptPackage(context.messages, context.systemPrompt);
    const formatted = PromptTemplates.formatForOllama(promptPkg);

    const assistantMsgId = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    let accumulatedText = '';
    let isCancelled = false;

    if (externalSignal?.aborted) {
      isCancelled = true;
    }

    if (externalSignal) {
      externalSignal.addEventListener('abort', () => {
        isCancelled = true;
        if (onEvent) {
          onEvent({
            type: 'cancellation',
            conversationId: conversation.id,
            messageId: assistantMsgId,
            fullText: accumulatedText,
          });
        }
      });
    }

    try {
      this.logger.info(`[ChatService] Starting chat for conversation '${conversation.id}'`);

      let loggedStreamStart = false;

      const gatewayResponse = await this.modelGateway.generateStream(
        {
          prompt: formatted.prompt,
          system: formatted.system,
          modelId: options.modelId,
          taskCapability: options.modelId ? undefined : 'chat',
          temperature: options.temperature,
          timeoutMs: options.timeoutMs || 120000,
          allowFallback: true,
        },
        (chunk) => {
          if (chunk.delta) {
            if (!loggedStreamStart) {
              loggedStreamStart = true;
              this.logger.info(`[ChatService] Streaming response to CLI`);
            }
            accumulatedText += chunk.delta;
            if (onEvent) {
              onEvent({
                type: 'delta',
                conversationId: conversation.id,
                messageId: assistantMsgId,
                delta: chunk.delta,
                contextInfo: {
                  estimatedTokens: context.estimatedTokens,
                  truncatedCount: context.truncatedCount,
                  ragGrounding: ragResult?.groundingStatus,
                },
              });
            }
          }
        },
        externalSignal
      );

      accumulatedText = gatewayResponse.text || accumulatedText;

      // Append Citation Footer if RAG evidence was used
      if (ragResult && ragResult.citations.length > 0) {
        const footer = this.citationService.formatCitationFooter(ragResult.citations);
        accumulatedText += footer;
      }

      const assistantMessage = this.messageService.addMessage({
        id: assistantMsgId,
        conversationId: conversation.id,
        role: 'assistant',
        content: accumulatedText,
        status: isCancelled ? 'interrupted' : 'completed',
      });

      if (onEvent) {
        onEvent({
          type: 'completion',
          conversationId: conversation.id,
          messageId: assistantMsgId,
          fullText: accumulatedText,
          contextInfo: {
            estimatedTokens: context.estimatedTokens,
            truncatedCount: context.truncatedCount,
            ragGrounding: ragResult?.groundingStatus,
          },
        });
      }

      return {
        userMessage,
        assistantMessage,
        context,
        ragResult,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Chat orchestration failed: ${errorMsg}`);

      const status: Message['status'] = isCancelled ? 'interrupted' : 'failed';
      const fallbackText = accumulatedText || `[Generation Error: ${errorMsg}]`;

      const assistantMessage = this.messageService.addMessage({
        id: assistantMsgId,
        conversationId: conversation.id,
        role: 'assistant',
        content: fallbackText,
        status,
      });

      if (onEvent) {
        onEvent({
          type: 'error',
          conversationId: conversation.id,
          messageId: assistantMsgId,
          error: errorMsg,
          fullText: fallbackText,
        });
      }

      return {
        userMessage,
        assistantMessage,
        context,
        ragResult,
      };
    }
  }
}
