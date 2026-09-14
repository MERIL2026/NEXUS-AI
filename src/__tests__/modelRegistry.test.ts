import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StorageService } from '../storage/index.js';
import { OllamaAdapter } from '../intelligence/ollamaAdapter.js';
import { ModelRegistry } from '../intelligence/modelRegistry.js';

describe('ModelRegistry & Capability Mapping', () => {
  let storage: StorageService;

  beforeEach(async () => {
    storage = new StorageService(':memory:', 'error');
    await storage.initialize();
  });

  afterEach(() => {
    storage.close();
  });

  it('upserts and queries model metadata with inferred capabilities', () => {
    const adapter = new OllamaAdapter('http://127.0.0.1:11434', 'error');
    const registry = new ModelRegistry(adapter, storage.models, 'error');

    storage.models.upsert({
      id: 'qwen2.5-coder:7b',
      name: 'qwen2.5-coder:7b',
      provider: 'ollama',
      versionTag: '7.6B',
      capabilities: ['coding', 'general'],
      contextLimit: 4096,
      isAvailable: true,
    });

    storage.models.upsert({
      id: 'deepseek-r1:8b',
      name: 'deepseek-r1:8b',
      provider: 'ollama',
      versionTag: '8B',
      capabilities: ['reasoning', 'planning', 'general'],
      contextLimit: 4096,
      isAvailable: true,
    });

    const available = registry.getAvailableModels();
    expect(available).toHaveLength(2);

    const coders = registry.findModelsByCapability('coding');
    expect(coders).toHaveLength(1);
    expect(coders[0].id).toBe('qwen2.5-coder:7b');

    const reasoners = registry.findModelsByCapability('reasoning');
    expect(reasoners).toHaveLength(1);
    expect(reasoners[0].id).toBe('deepseek-r1:8b');
  });
});
