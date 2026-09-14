import { describe, it, expect } from 'vitest';
import { ContextBuilder } from '../chat/contextBuilder.js';
import type { Message } from '../storage/repositories/types.js';

describe('ContextBuilder & Context Budgeting', () => {
  const builder = new ContextBuilder();

  it('estimates token count based on string length', () => {
    expect(ContextBuilder.estimateTokens('')).toBe(0);
    expect(ContextBuilder.estimateTokens('1234')).toBe(1);
    expect(ContextBuilder.estimateTokens('12345678')).toBe(2);
  });

  it('preserves system prompt and includes recent messages', () => {
    const messages: Message[] = [
      { id: 'm1', conversationId: 'c1', role: 'user', content: 'First message', status: 'completed', createdAt: '2026-08-16T10:00:00Z' },
      { id: 'm2', conversationId: 'c1', role: 'assistant', content: 'First reply', status: 'completed', createdAt: '2026-08-16T10:00:05Z' },
    ];

    const ctx = builder.buildContext(messages, { maxContextTokens: 4096 });

    expect(ctx.messages).toHaveLength(2);
    expect(ctx.truncatedCount).toBe(0);
    expect(ctx.systemTokens).toBeGreaterThan(0);
  });

  it('truncates older messages when context token budget is exceeded', () => {
    // Generate long messages that exceed small budget
    const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      conversationId: 'c1',
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}: ${'x'.repeat(400)}`, // ~100 tokens per message
      status: 'completed',
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
    }));

    // Pass small context token budget (e.g. 500 tokens total)
    const ctx = builder.buildContext(messages, { maxContextTokens: 600, reserveOutputTokens: 100 });

    expect(ctx.truncatedCount).toBeGreaterThan(0);
    expect(ctx.messages.length).toBeLessThan(10);
    // Recent messages should be preserved
    expect(ctx.messages[ctx.messages.length - 1].id).toBe('m9');
  });
});
