/**
 * NEXUS AI — Chat Mode Runner & Conversational Subsystem
 *
 * Provides a dedicated, conversational CLI runner for normal AI chat.
 * Cleanly separated from AgentRunner:
 *  - Zero Agent Task creation
 *  - Zero planner / tool execution / filesystem inspection
 *  - Zero approval workflow
 *
 * Directly interfaces with ChatService, ConversationService, and ModelGateway.
 */

import type { ApplicationApi } from '../api/index.js';
import { Logger, LogLevel } from '../common/logger.js';
import {
  colors,
  renderChatBanner,
  renderChatHistory,
  renderChatSearchResults,
  renderHelpMenu,
  renderModelControlScreen,
  drawDivider,
} from './uiFormatters.js';
import { SIGNAL_EXIT_CHAT } from './inputEngine.js';

export class ChatRunner {
  private logger: Logger;
  public currentConversationId: string | null = null;
  public activeAbortController: AbortController | null = null;

  constructor(
    public api: ApplicationApi,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('ChatRunner', logLevel);
  }

  /**
   * Initializes or resumes a chat session.
   * If conversationId is given, loads it; otherwise creates a new conversation if none active.
   */
  async startOrResumeChat(conversationId?: string): Promise<string> {
    if (conversationId) {
      try {
        const conv = this.api.conversations.getConversation(conversationId);
        this.currentConversationId = conv.id;
        const messages = this.api.messages.getMessages(conv.id);
        const lines: string[] = [];
        lines.push(renderChatBanner());
        lines.push('');
        lines.push(`${colors.bold}Resumed conversation:${colors.reset} "${conv.title}" ${colors.dim}(ID: ${conv.id})${colors.reset}`);
        if (messages.length > 0) {
          lines.push(drawDivider('─', 40));
          const recent = messages.slice(-4);
          recent.forEach((m) => {
            const roleTag = m.role === 'user' ? `${colors.bold}User:${colors.reset}` : `${colors.bold}${colors.brightCyan}NEXUS:${colors.reset}`;
            lines.push(`${roleTag} ${m.content}`);
          });
          lines.push(drawDivider('─', 40));
        }
        return lines.join('\n');
      } catch (err) {
        this.logger.warn(`Could not load requested conversation '${conversationId}': ${String(err)}`);
      }
    }

    if (!this.currentConversationId) {
      const conv = this.api.conversations.createConversation({ title: 'New Chat' });
      this.currentConversationId = conv.id;
    }

    return renderChatBanner();
  }

  /**
   * Start a new chat conversation.
   */
  newChat(): string {
    const conv = this.api.conversations.createConversation({ title: 'New Chat' });
    this.currentConversationId = conv.id;
    return `\n${colors.brightGreen}✓ Started new conversation${colors.reset} (ID: ${colors.brightCyan}${conv.id}${colors.reset})\n`;
  }

  /**
   * Exit chat mode.
   */
  exitChat(): string {
    return SIGNAL_EXIT_CHAT;
  }

  /**
   * List all conversation history.
   */
  listChats(): string {
    const conversations = this.api.conversations.listAllConversations();
    return renderChatHistory(conversations);
  }

  /**
   * Open a specific conversation by ID.
   */
  openChat(id: string): string {
    const cleanId = id.trim();
    try {
      const conv = this.api.conversations.getConversation(cleanId);
      this.currentConversationId = conv.id;
      const messages = this.api.messages.getMessages(conv.id);

      const lines: string[] = [];
      lines.push(`${colors.brightGreen}✓ Opened conversation:${colors.reset} "${conv.title}" ${colors.dim}(ID: ${conv.id})${colors.reset}`);
      if (messages.length > 0) {
        lines.push('');
        lines.push(drawDivider('─', 40));
        const recent = messages.slice(-6);
        recent.forEach((m) => {
          const roleTag = m.role === 'user' ? `${colors.bold}User:${colors.reset}` : `${colors.bold}${colors.brightCyan}NEXUS:${colors.reset}`;
          lines.push(`${roleTag}\n${m.content}\n`);
        });
        lines.push(drawDivider('─', 40));
      }
      return lines.join('\n');
    } catch {
      return `${colors.brightRed}Error: Conversation '${cleanId}' not found.${colors.reset}`;
    }
  }

  /**
   * Search conversations by query.
   */
  searchChats(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) {
      return this.listChats();
    }
    const results = this.api.conversations.searchConversations(trimmed);
    return renderChatSearchResults(trimmed, results);
  }

  /**
   * Delete a conversation by ID.
   */
  deleteChat(id: string): string {
    const cleanId = id.trim();
    if (!cleanId) {
      return `${colors.brightRed}Usage: /chats delete <id>${colors.reset}`;
    }

    try {
      const conv = this.api.conversations.getConversation(cleanId);
      const title = conv.title;
      this.api.conversations.deleteConversation(cleanId);

      if (this.currentConversationId === cleanId) {
        this.currentConversationId = null;
      }

      return `${colors.brightGreen}✓ Deleted conversation "${title}" (ID: ${cleanId})${colors.reset}`;
    } catch {
      return `${colors.brightRed}Error: Conversation '${cleanId}' not found.${colors.reset}`;
    }
  }

  /**
   * Handle model command in chat mode.
   */
  handleModelCommand(args: string[]): string {
    const router = this.api.intelligence.router;
    const registry = this.api.intelligence.registry;
    if (!router || !registry) {
      return `${colors.brightRed}Error: ModelRouter or ModelRegistry uninitialized.${colors.reset}`;
    }

    if (args.length === 0) {
      const available = registry.getAvailableModels();
      const roleStatus = router.getRoleStatus();
      const activeModelId = router.selectRoute(undefined, undefined, 'chat').primaryModel.id;
      return renderModelControlScreen(available, roleStatus, 'Ollama', activeModelId);
    }

    const sub = args[0].toLowerCase();
    if (sub === 'reset') {
      router.resetOverrides('chat');
      return `${colors.brightGreen}✓ Chat model override reset to automatic routing.${colors.reset}`;
    }

    // Direct model selection for chat
    const res = router.setRoleOverride('chat', args[0]);
    if (!res.success || !res.model) {
      return `${colors.brightRed}Error: ${res.message}${colors.reset}`;
    }

    return `${colors.brightGreen}✓ Chat model set to ${res.model.id}${colors.reset}`;
  }

  /**
   * Process an input string inside Chat Mode.
   */
  async runCommand(
    input: string,
    options: { streamToStdout?: boolean; onStreamChunk?: (delta: string) => void } = { streamToStdout: true }
  ): Promise<string> {
    const trimmed = input.trim();
    if (!trimmed) {
      return '';
    }

    // 1. Slash commands handling
    if (trimmed.startsWith('/')) {
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      switch (cmd) {
        case '/exit-chat':
        case '/exitchat':
          return SIGNAL_EXIT_CHAT;

        case '/new-chat':
        case '/newchat':
        case '/new':
          return this.newChat();

        case '/chats':
        case '/history':
          if (args.length > 0) {
            const sub = args[0].toLowerCase();
            if (sub === 'open' && args[1]) {
              return this.openChat(args[1]);
            }
            if (sub === 'delete' && args[1]) {
              return this.deleteChat(args[1]);
            }
            if (sub === 'search' && args.length > 1) {
              return this.searchChats(args.slice(1).join(' '));
            }
            if (args[0].startsWith('conv-') || args[0].startsWith('chat-')) {
              return this.openChat(args[0]);
            }
          }
          return this.listChats();

        case '/model':
        case '/models':
          if (cmd === '/models') {
            const available = this.api.intelligence.registry?.getAvailableModels() ?? [];
            const lines: string[] = [];
            lines.push(`${colors.bold}${colors.brightCyan}AVAILABLE MODELS FOR CHAT${colors.reset}`);
            lines.push(drawDivider('─', 40));
            available.forEach((m, idx) => {
              lines.push(`  ${idx + 1}. ${m.id} (${m.capabilities.join(', ')})`);
            });
            return lines.join('\n');
          }
          return this.handleModelCommand(args);

        case '/help':
        case '/?':
        case '/h':
          return renderHelpMenu();

        case '/clear':
        case '/cls':
          return '\x1bc';

        case '/exit':
        case '/quit':
        case '/q':
          return SIGNAL_EXIT_CHAT;

        default:
          return `${colors.brightYellow}Unknown chat command '${cmd}'. Type /help for available commands or /exit-chat to return to Agent mode.${colors.reset}`;
      }
    }

    // 2. Normal conversational message handling (NO AGENT TASK CREATED)
    if (!this.currentConversationId) {
      const conv = this.api.conversations.createConversation({ title: 'New Chat' });
      this.currentConversationId = conv.id;
    }

    const conversationId = this.currentConversationId;
    this.activeAbortController = new AbortController();

    if (options.streamToStdout) {
      process.stdout.write(`\n${colors.bold}${colors.brightCyan}NEXUS:${colors.reset}\n`);
    }

    let streamedAny = false;

    try {
      const result = await this.api.chat.sendMessage(
        {
          conversationId,
          userPrompt: trimmed,
        },
        (event) => {
          if (event.type === 'delta' && event.delta) {
            streamedAny = true;
            if (options.streamToStdout) {
              process.stdout.write(event.delta);
            }
            if (options.onStreamChunk) {
              options.onStreamChunk(event.delta);
            }
          }
        },
        this.activeAbortController.signal
      );

      if (options.streamToStdout) {
        process.stdout.write('\n');
      }

      // If already streamed to stdout in interactive mode, return empty string so main loop doesn't double print
      if (options.streamToStdout && streamedAny) {
        return '';
      }

      return result.assistantMessage.content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Chat error: ${msg}`);
      return `\n${colors.brightRed}Error communicating with AI model: ${msg}${colors.reset}\n`;
    } finally {
      this.activeAbortController = null;
    }
  }

  /**
   * Cancel active streaming generation.
   */
  cancelActiveGeneration(): boolean {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
      return true;
    }
    return false;
  }
}
