import type { Message } from '../storage/repositories/types.js';
import { PromptTemplates } from './promptTemplates.js';

export interface ContextBuilderOptions {
  maxContextTokens?: number;
  reserveOutputTokens?: number;
  customSystemPrompt?: string;
}

export interface ContextPackage {
  messages: Message[];
  systemPrompt: string;
  estimatedTokens: number;
  systemTokens: number;
  truncatedCount: number;
  maxContextTokens: number;
}

export class ContextBuilder {
  public static estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  public buildContext(messages: Message[], options: ContextBuilderOptions = {}): ContextPackage {
    const maxTokens = options.maxContextTokens || 4096;
    const reserveTokens = options.reserveOutputTokens || 1024;
    const availableTokens = Math.max(512, maxTokens - reserveTokens);

    const systemPrompt = options.customSystemPrompt || PromptTemplates.getDefaultSystemPrompt();
    const systemTokens = ContextBuilder.estimateTokens(systemPrompt);

    let currentBudget = availableTokens - systemTokens;
    if (currentBudget <= 0) {
      currentBudget = 256; // Minimum floor for user prompt
    }

    const selectedMessages: Message[] = [];
    let totalMessageTokens = 0;
    let truncatedCount = 0;

    // Process messages from most recent to oldest
    const reversed = [...messages].reverse();

    for (const msg of reversed) {
      const msgTokens = ContextBuilder.estimateTokens(msg.content) + 4; // 4 overhead tokens per msg
      if (totalMessageTokens + msgTokens <= currentBudget) {
        selectedMessages.unshift(msg);
        totalMessageTokens += msgTokens;
      } else {
        truncatedCount++;
      }
    }

    return {
      messages: selectedMessages,
      systemPrompt,
      estimatedTokens: systemTokens + totalMessageTokens,
      systemTokens,
      truncatedCount,
      maxContextTokens: maxTokens,
    };
  }
}
