import { describe, it, expect } from 'vitest';
import { OllamaInferenceProvider } from '../intelligence/providers/ollamaInferenceProvider.js';
import { EmbeddedInferenceProvider } from '../intelligence/providers/embeddedInferenceProvider.js';
import { runEmbeddedPrototype } from '../intelligence/prototype/runPrototype.js';

describe('Phase 2 — Self-Contained AI Embedded Inference Runtime Prototype', () => {
  it('1. OllamaInferenceProvider satisfies InferenceProvider interface contract', async () => {
    const provider = new OllamaInferenceProvider('http://127.0.0.1:11434', 'error');
    expect(provider.providerType).toBe('ollama');

    const health = await provider.healthCheck(500);
    expect(health.providerType).toBe('ollama');
    expect(['READY', 'UNAVAILABLE']).toContain(health.status);
    expect(health.endpoint).toBe('http://127.0.0.1:11434');

    await provider.shutdown();
  });

  it('2. EmbeddedInferenceProvider starts, generates, streams, and shuts down cleanly without Ollama', async () => {
    const provider = new EmbeddedInferenceProvider({
      modelName: 'qwen2.5-0.5b-nexus-test.gguf',
      logLevel: 'error',
    });
    expect(provider.providerType).toBe('embedded');

    // Health check initialization
    const health = await provider.healthCheck();
    expect(health.status).toBe('READY');
    expect(health.details?.engine).toBe('node-llama-cpp (Embedded)');

    // Model listing
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe('qwen2.5-0.5b-nexus-test.gguf');
    expect(models[0].readiness).toBe('ready');

    // Generation
    const genRes = await provider.generate({
      model: 'qwen2.5-0.5b-nexus-test.gguf',
      prompt: 'Test prompt for embedded provider',
    });
    expect(genRes.response).toContain('[NEXUS Embedded AI]');
    expect(genRes.done).toBe(true);
    expect(genRes.totalDurationMs).toBeGreaterThanOrEqual(0);

    // Streaming
    const chunks: string[] = [];
    const streamRes = await provider.streamChat(
      {
        model: 'qwen2.5-0.5b-nexus-test.gguf',
        messages: [{ role: 'user', content: 'Stream test' }],
      },
      (chunk) => {
        chunks.push(chunk.delta);
      }
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(streamRes.message.content).toBe(chunks.join(''));

    // Clean shutdown
    await provider.shutdown();
    const shutdownHealth = await provider.healthCheck();
    expect(shutdownHealth.status).toBe('UNAVAILABLE');
  });

  it('3. Standalone Prototype Execution runEmbeddedPrototype() completes successfully', async () => {
    const res = await runEmbeddedPrototype();
    expect(res.success).toBe(true);
    expect(res.passedWithoutOllama).toBe(true);
    expect(res.modelUsed).toBeTruthy();
    expect(res.modelSizeMb).toBeGreaterThan(0);
    expect(res.startupTimeMs).toBeGreaterThanOrEqual(0);
    expect(res.generatedText).toBeTruthy();
    expect(res.streamedChunksCount).toBeGreaterThan(0);
  });
});
