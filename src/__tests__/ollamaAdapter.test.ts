import { describe, it, expect } from 'vitest';
import { OllamaAdapter } from '../intelligence/ollamaAdapter.js';

describe('OllamaAdapter', () => {
  it('connects to local Ollama host or handles offline gracefully', async () => {
    const adapter = new OllamaAdapter('http://127.0.0.1:11434', 'error');
    const health = await adapter.checkHealth(2000);

    expect(health).toBeDefined();
    expect(typeof health.available).toBe('boolean');
  });

  it('handles invalid/offline Ollama host without crashing', async () => {
    const adapter = new OllamaAdapter('http://127.0.0.1:99999', 'error');
    const health = await adapter.checkHealth(500);

    expect(health.available).toBe(false);
    expect(health.error).toBeDefined();
  });

  it('handles timeout when generating response', async () => {
    const adapter = new OllamaAdapter('http://127.0.0.1:11434', 'error');
    // Set 1ms timeout to force timeout exception
    await expect(
      adapter.generate({
        model: 'qwen2.5:3b',
        prompt: 'Hi',
        timeoutMs: 1,
      })
    ).rejects.toThrow(/timed out/);
  });
});
