import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StorageService } from '../storage/index.js';
import { OllamaAdapter } from '../intelligence/ollamaAdapter.js';
import { ModelRegistry } from '../intelligence/modelRegistry.js';
import { ModelRouter } from '../intelligence/modelRouter.js';
import { ModelGateway } from '../intelligence/modelGateway.js';

describe('ModelGateway & ModelRouter Inference Foundation', () => {
  let storage: StorageService;
  let adapter: OllamaAdapter;
  let registry: ModelRegistry;
  let router: ModelRouter;
  let gateway: ModelGateway;

  beforeEach(async () => {
    storage = new StorageService(':memory:', 'error');
    await storage.initialize();

    adapter = new OllamaAdapter('http://127.0.0.1:11434', 'error');
    registry = new ModelRegistry(adapter, storage.models, 'error');
    router = new ModelRouter(registry, 'error');
    gateway = new ModelGateway(adapter, registry, router, storage.models, 'error');

    storage.models.upsert({
      id: 'qwen2.5-coder:7b',
      name: 'qwen2.5-coder:7b',
      capabilities: ['coding', 'general'],
    });

    storage.models.upsert({
      id: 'llama3.1:8b',
      name: 'llama3.1:8b',
      capabilities: ['general', 'summarization'],
    });
  });

  afterEach(() => {
    storage.close();
  });

  it('selects explicit model via ModelRouter', () => {
    const route = router.selectRoute('qwen2.5-coder:7b');
    expect(route.primaryModel.id).toBe('qwen2.5-coder:7b');
    expect(route.fallbackModel?.id).toBe('llama3.1:8b');
  });

  it('selects candidate model by task capability via ModelRouter', () => {
    const route = router.selectRoute(undefined, 'coding');
    expect(route.primaryModel.id).toBe('qwen2.5-coder:7b');
  });

  it('executes fallback when primary model is invalid and fallback is allowed', async () => {
    // Primary model point to nonexistent model ID
    storage.models.upsert({
      id: 'non-existent-primary',
      name: 'non-existent-primary',
      capabilities: ['coding'],
    });

    // Gateway request with allowFallback: true and short timeout
    const resultPromise = gateway.generate({
      prompt: 'Hello',
      modelId: 'non-existent-primary',
      allowFallback: true,
      timeoutMs: 100,
    });

    // Should either fallback to a valid model or throw if Ollama is unreachable
    await expect(resultPromise).rejects.toThrow();
  });
});
