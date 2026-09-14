import type { Message } from '../storage/repositories/types.js';

export interface PromptPackage {
  systemPrompt: string;
  formattedMessages: Array<{ role: string; content: string }>;
  version: string;
}

export class PromptTemplates {
  public static readonly CURRENT_VERSION = 'v1.0.0';

  public static getDefaultSystemPrompt(): string {
    return (
      'You are NEXUS AI, an offline-first local AI workstation assistant. ' +
      'Provide helpful, accurate, and concise answers based on the conversation context. ' +
      'Keep technical explanations clear and structured.'
    );
  }

  public static buildPromptPackage(
    messages: Message[],
    customSystemPrompt?: string
  ): PromptPackage {
    const systemPrompt = customSystemPrompt || this.getDefaultSystemPrompt();
    const formattedMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    return {
      systemPrompt,
      formattedMessages,
      version: this.CURRENT_VERSION,
    };
  }

  public static formatForOllama(promptPackage: PromptPackage): { system: string; prompt: string } {
    const system = promptPackage.systemPrompt;
    // Format full dialogue stream into prompt string for single-prompt endpoint
    const historyText = promptPackage.formattedMessages
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');

    return {
      system,
      prompt: historyText,
    };
  }
}
