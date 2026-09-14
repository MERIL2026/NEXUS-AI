import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StorageService } from '../storage/index.js';
import { OllamaAdapter } from '../intelligence/ollamaAdapter.js';
import { ModelRegistry } from '../intelligence/modelRegistry.js';
import { ModelRouter } from '../intelligence/modelRouter.js';
import { ModelGateway } from '../intelligence/modelGateway.js';
import { ConversationService } from '../chat/conversationService.js';
import { MessageService } from '../chat/messageService.js';
import { ChatService, type ChatStreamEvent } from '../chat/chatService.js';

describe('ConversationService, MessageService & ChatService Orchestration', () => {
  let storage: StorageService;
  let conversationService: ConversationService;
  let messageService: MessageService;
  let chatService: ChatService;
  let gateway: ModelGateway;

  beforeEach(async () => {
    storage = new StorageService(':memory:', 'error');
    await storage.initialize();

    const adapter = new OllamaAdapter('http://127.0.0.1:11434', 'error');
    const registry = new ModelRegistry(adapter, storage.models, 'error');
    const router = new ModelRouter(registry, 'error');
    gateway = new ModelGateway(adapter, registry, router, storage.models, 'error');

    storage.models.upsert({
      id: 'qwen2.5:3b',
      name: 'qwen2.5:3b',
      capabilities: ['general', 'lightweight'],
    });

    conversationService = new ConversationService(storage.conversations, 'error');
    messageService = new MessageService(storage.messages, 'error');
    chatService = new ChatService(conversationService, messageService, gateway, 'error');
  });

  afterEach(() => {
    storage.close();
  });

  it('creates, retrieves, updates, and lists conversations', () => {
    const conv = conversationService.createConversation({ title: 'Architectural Analysis' });
    expect(conv.id).toBeDefined();
    expect(conv.title).toBe('Architectural Analysis');

    const retrieved = conversationService.getConversation(conv.id);
    expect(retrieved.id).toBe(conv.id);

    const updated = conversationService.updateConversation(conv.id, { title: 'Updated Title' });
    expect(updated.title).toBe('Updated Title');

    const list = conversationService.listConversations();
    expect(list).toHaveLength(1);
  });

  it('persists and orders messages within conversation', () => {
    const conv = conversationService.createConversation({ title: 'Message Order Test' });

    messageService.addMessage({ conversationId: conv.id, role: 'user', content: 'Msg 1' });
    messageService.addMessage({ conversationId: conv.id, role: 'assistant', content: 'Msg 2' });

    const messages = messageService.getMessages(conv.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Msg 1');
    expect(messages[1].content).toBe('Msg 2');
  });

  it('handles cancellation gracefully during chat generation', async () => {
    const conv = conversationService.createConversation({ title: 'Cancellation Test' });
    const controller = new AbortController();

    // Immediately abort request
    controller.abort();

    const events: ChatStreamEvent[] = [];
    const result = await chatService.sendMessage(
      {
        conversationId: conv.id,
        userPrompt: 'Cancel this request immediately',
        modelId: 'non-existent-model',
        timeoutMs: 100,
      },
      (e) => events.push(e),
      controller.signal
    );

    expect(result.assistantMessage).toBeDefined();
    // Message status should be interrupted or failed without crashing
    expect(['interrupted', 'failed']).toContain(result.assistantMessage.status);
  });

  it('handles unavailable model error safely without crashing', async () => {
    const conv = conversationService.createConversation({ title: 'Error Test' });

    const result = await chatService.sendMessage({
      conversationId: conv.id,
      userPrompt: 'Test error handling',
      modelId: 'completely-invalid-model-name',
      timeoutMs: 50,
    });

    expect(result.assistantMessage).toBeDefined();
    expect(result.assistantMessage.status).toBe('failed');
    expect(result.assistantMessage.content).toContain('Generation Error');
  });
});
