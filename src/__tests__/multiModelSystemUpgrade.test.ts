import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StorageService } from '../storage/index.js';
import { ModelRegistry } from '../intelligence/modelRegistry.js';
import { ModelRouter } from '../intelligence/modelRouter.js';
import { ModelGateway } from '../intelligence/modelGateway.js';
import { AIRuntimeManager } from '../intelligence/runtime/runtimeManager.js';
import { OllamaAdapter } from '../intelligence/ollamaAdapter.js';
import { OllamaRuntimeAdapter } from '../intelligence/runtime/ollamaRuntimeAdapter.js';
import { EmbeddedRuntimeAdapter } from '../intelligence/runtime/embeddedRuntimeAdapter.js';
import { ChatService } from '../chat/chatService.js';
import { ConversationService } from '../chat/conversationService.js';
import { MessageService } from '../chat/messageService.js';
import { AgentRunner } from '../cli/agentRunner.js';
import { ApplicationApi } from '../api/index.js';

describe('Complete Multi-Model System Setup Upgrade', () => {
  let storage: StorageService;
  let embeddedAdapter: EmbeddedRuntimeAdapter;

  beforeEach(async () => {
    storage = new StorageService(':memory:', 'error');
    await storage.initialize();
    embeddedAdapter = new EmbeddedRuntimeAdapter({ logLevel: 'error' });
  });

  afterEach(() => {
    storage.close();
    vi.restoreAllMocks();
  });

  it('1. Embedded model availability: embedded model remains available when runtime is healthy', async () => {
    const manager = new AIRuntimeManager(embeddedAdapter, 'error', 'embedded');
    const registry = new ModelRegistry(manager, storage.models, 'error');

    const models = await registry.syncDiscoveredModels();
    expect(models.length).toBeGreaterThan(0);

    const embeddedModel = models.find((m) => m.provider === 'embedded');
    expect(embeddedModel).toBeDefined();
    expect(embeddedModel?.id).toBe('qwen2.5-coder-1.5b');
    expect(embeddedModel?.isAvailable).toBe(true);
  });

  it('2. Ollama model discovery: dynamically discovers models from Ollama daemon', async () => {
    const mockOllamaAdapter = new OllamaAdapter('http://127.0.0.1:11434', 'error');
    vi.spyOn(mockOllamaAdapter, 'checkHealth').mockResolvedValue({ available: true, version: '0.3.0' });
    vi.spyOn(mockOllamaAdapter, 'discoverModels').mockResolvedValue([
      {
        name: 'qwen2.5-coder:7b',
        size: 4400000000,
        digest: 'sha256:abc123456789',
        modified_at: '2026-09-01T00:00:00Z',
        details: { format: 'gguf', family: 'qwen2.5-coder', parameter_size: '7.6B', quantization_level: 'Q4_K_M' },
      },
    ]);

    const ollamaRuntime = new OllamaRuntimeAdapter('http://127.0.0.1:11434', 'error', mockOllamaAdapter);
    const manager = new AIRuntimeManager(ollamaRuntime, 'error', 'auto');
    const registry = new ModelRegistry(manager, storage.models, 'error');

    const discovered = await registry.syncDiscoveredModels();
    expect(discovered.some((m) => m.id === 'qwen2.5-coder:7b' && m.provider === 'ollama')).toBe(true);
  });

  it('3. Multiple installed Ollama models: handles discovery of all target Ollama models', async () => {
    const mockOllamaAdapter = new OllamaAdapter('http://127.0.0.1:11434', 'error');
    vi.spyOn(mockOllamaAdapter, 'checkHealth').mockResolvedValue({ available: true, version: '0.3.0' });
    vi.spyOn(mockOllamaAdapter, 'discoverModels').mockResolvedValue([
      { name: 'qwen2.5-coder:7b', size: 4400000000, digest: 'sha256:1', modified_at: '2026-09-01T00:00:00Z' },
      { name: 'deepseek-r1:8b', size: 4900000000, digest: 'sha256:2', modified_at: '2026-09-01T00:00:00Z' },
      { name: 'qwen2.5:3b', size: 1900000000, digest: 'sha256:3', modified_at: '2026-09-01T00:00:00Z' },
      { name: 'llama3.1:8b', size: 4700000000, digest: 'sha256:4', modified_at: '2026-09-01T00:00:00Z' },
      { name: 'R4C3R/qwen2.5-coder-7b-instruct-heretic:q4_k_m', size: 4400000000, digest: 'sha256:5', modified_at: '2026-09-01T00:00:00Z' },
    ]);

    const ollamaRuntime = new OllamaRuntimeAdapter('http://127.0.0.1:11434', 'error', mockOllamaAdapter);
    const manager = new AIRuntimeManager(ollamaRuntime, 'error', 'auto');
    const registry = new ModelRegistry(manager, storage.models, 'error');

    const discovered = await registry.syncDiscoveredModels();
    expect(discovered.length).toBe(6); // 1 embedded + 5 ollama

    const embedded = discovered.find((m) => m.id === 'qwen2.5-coder-1.5b');
    expect(embedded).toBeDefined();
    expect(embedded?.provider).toBe('embedded');

    const ollamaModels = discovered.filter((m) => m.provider === 'ollama');
    expect(ollamaModels.length).toBe(5);

    const available = registry.getAvailableModels();
    expect(available.length).toBe(6);
  });

  it('4. Provider identification: tags each model with correct provider (embedded vs ollama)', async () => {
    storage.models.upsert({
      id: 'qwen2.5-coder-1.5b',
      name: 'qwen2.5-coder-1.5b',
      provider: 'embedded',
      capabilities: ['planning', 'coding', 'lightweight', 'general'],
      isAvailable: true,
    });
    storage.models.upsert({
      id: 'llama3.1:8b',
      name: 'llama3.1:8b',
      provider: 'ollama',
      capabilities: ['chat', 'general'],
      isAvailable: true,
    });

    const embeddedModel = storage.models.findById('qwen2.5-coder-1.5b');
    const ollamaModel = storage.models.findById('llama3.1:8b');

    expect(embeddedModel?.provider).toBe('embedded');
    expect(ollamaModel?.provider).toBe('ollama');
  });

  it('5. Capability-based routing: automatically routes tasks to ideal capability model', () => {
    const manager = new AIRuntimeManager(embeddedAdapter, 'error', 'auto');
    const registry = new ModelRegistry(manager, storage.models, 'error');

    // Register complete target model set
    storage.models.upsert({ id: 'qwen2.5-coder-1.5b', name: 'qwen2.5-coder-1.5b', provider: 'embedded', capabilities: ['planning', 'coding', 'lightweight', 'general'], isAvailable: true });
    storage.models.upsert({ id: 'qwen2.5-coder:7b', name: 'qwen2.5-coder:7b', provider: 'ollama', capabilities: ['coding', 'planning'], isAvailable: true });
    storage.models.upsert({ id: 'deepseek-r1:8b', name: 'deepseek-r1:8b', provider: 'ollama', capabilities: ['reasoning', 'planning'], isAvailable: true });
    storage.models.upsert({ id: 'qwen2.5:3b', name: 'qwen2.5:3b', provider: 'ollama', capabilities: ['lightweight', 'general'], isAvailable: true });
    storage.models.upsert({ id: 'llama3.1:8b', name: 'llama3.1:8b', provider: 'ollama', capabilities: ['chat', 'general'], isAvailable: true });
    storage.models.upsert({ id: 'R4C3R/qwen2.5-coder-7b-instruct-heretic:q4_k_m', name: 'R4C3R/qwen2.5-coder-7b-instruct-heretic:q4_k_m', provider: 'ollama', capabilities: ['coding'], isAvailable: true });

    const router = new ModelRouter(registry, 'error');

    expect(router.selectRoute(undefined, 'planning').primaryModel.id).toBe('qwen2.5-coder-1.5b');
    expect(router.selectRoute(undefined, 'coding').primaryModel.id).toBe('qwen2.5-coder:7b');
    expect(router.selectRoute(undefined, 'reasoning').primaryModel.id).toBe('deepseek-r1:8b');
    expect(router.selectRoute(undefined, 'lightweight').primaryModel.id).toBe('qwen2.5:3b');
    expect(router.selectRoute(undefined, 'chat').primaryModel.id).toBe('llama3.1:8b');
  });

  it('6. Chat model selection: selects llama3.1:8b when available, falls back to embedded when unavailable', async () => {
    const manager = new AIRuntimeManager(embeddedAdapter, 'error', 'auto');
    const registry = new ModelRegistry(manager, storage.models, 'error');
    const router = new ModelRouter(registry, 'error');
    const gateway = new ModelGateway(manager, registry, router, storage.models, 'error');
    const convService = new ConversationService(storage.conversations);
    const msgService = new MessageService(storage.messages);

    const chatService = new ChatService(convService, msgService, gateway, undefined, 'error');
    const conv = convService.createConversation('Chat Test');

    // Case 1: Ollama unavailable -> Only embedded available
    storage.models.upsert({ id: 'qwen2.5-coder-1.5b', name: 'qwen2.5-coder-1.5b', provider: 'embedded', capabilities: ['planning', 'coding', 'lightweight', 'general'], isAvailable: true });

    const resOffline = await chatService.sendMessage({ conversationId: conv.id, userPrompt: 'Hello NEXUS' });
    expect(resOffline.assistantMessage.content).toContain('Embedded AI');

    // Case 2: Ollama available with llama3.1:8b
    storage.models.upsert({ id: 'llama3.1:8b', name: 'llama3.1:8b', provider: 'ollama', capabilities: ['chat', 'general'], isAvailable: true });
    const chatRoute = router.selectRoute(undefined, 'chat');
    expect(chatRoute.primaryModel.id).toBe('llama3.1:8b');
  });

  it('7. Manual model switching: supports /model <index>, /model <id>, and role overrides', () => {
    const manager = new AIRuntimeManager(embeddedAdapter, 'error', 'auto');
    const registry = new ModelRegistry(manager, storage.models, 'error');

    storage.models.upsert({ id: 'qwen2.5-coder-1.5b', name: 'qwen2.5-coder-1.5b', provider: 'embedded', capabilities: ['planning'], isAvailable: true });
    storage.models.upsert({ id: 'deepseek-r1:8b', name: 'deepseek-r1:8b', provider: 'ollama', capabilities: ['reasoning'], isAvailable: true });

    const router = new ModelRouter(registry, 'error');

    // Global override by index (index 1 is deepseek-r1:8b alphabetically)
    const resIdx = router.setGlobalOverride(1);
    expect(resIdx.success).toBe(true);
    expect(resIdx.model?.id).toBe('deepseek-r1:8b');

    // Global override by ID
    const resId = router.setGlobalOverride('qwen2.5-coder-1.5b');
    expect(resId.success).toBe(true);
    expect(resId.model?.id).toBe('qwen2.5-coder-1.5b');

    // Role override
    const resRole = router.setRoleOverride('coder', 'deepseek-r1:8b');
    expect(resRole.success).toBe(true);
    expect(router.getRoleStatus().coder.modelId).toBe('deepseek-r1:8b');
  });

  it('8. Missing-model fallback: falls back when requested model is not installed', async () => {
    storage.models.upsert({ id: 'qwen2.5-coder-1.5b', name: 'qwen2.5-coder-1.5b', provider: 'embedded', capabilities: ['planning', 'coding'], isAvailable: true });

    const manager = new AIRuntimeManager(embeddedAdapter, 'error', 'auto');
    const registry = new ModelRegistry(manager, storage.models, 'error');
    const router = new ModelRouter(registry, 'error');

    const route = router.selectRoute('non-existent-model', 'coding');
    expect(route.primaryModel.id).toBe('qwen2.5-coder-1.5b');
  });

  it('9. Ollama unavailable fallback: system continues functioning via embedded model when Ollama daemon is offline', async () => {
    const mockOllamaAdapter = new OllamaAdapter('http://127.0.0.1:11434', 'error');
    vi.spyOn(mockOllamaAdapter, 'checkHealth').mockResolvedValue({ available: false, error: 'ECONNREFUSED' });

    const ollamaRuntime = new OllamaRuntimeAdapter('http://127.0.0.1:11434', 'error', mockOllamaAdapter);
    const manager = new AIRuntimeManager(ollamaRuntime, 'error', 'auto');

    const registry = new ModelRegistry(manager, storage.models, 'error');
    const discovered = await registry.syncDiscoveredModels();

    expect(discovered.length).toBe(1);
    expect(discovered[0].id).toBe('qwen2.5-coder-1.5b');
    expect(discovered[0].provider).toBe('embedded');
  });

  it('10. /models output: renders model name, provider, capabilities, and status', () => {
    storage.models.upsert({ id: 'qwen2.5-coder-1.5b', name: 'qwen2.5-coder-1.5b', provider: 'embedded', capabilities: ['planning', 'coding'], isAvailable: true });
    storage.models.upsert({ id: 'llama3.1:8b', name: 'llama3.1:8b', provider: 'ollama', capabilities: ['chat'], isAvailable: true });

    const manager = new AIRuntimeManager(embeddedAdapter, 'error', 'auto');
    const registry = new ModelRegistry(manager, storage.models, 'error');
    const router = new ModelRouter(registry, 'error');

    const fakeApi = {
      intelligence: { registry, router },
    } as unknown as ApplicationApi;

    const runner = new AgentRunner(fakeApi, 'error');
    const output = runner.getModelsText();

    expect(output).toContain('qwen2.5-coder-1.5b');
    expect(output).toContain('[Embedded]');
    expect(output).toContain('llama3.1:8b');
    expect(output).toContain('[Ollama]');
    expect(output).toContain('AVAILABLE');
  });

  it('11. /model output: renders current active model, provider, roles, and available models', () => {
    storage.models.upsert({ id: 'qwen2.5-coder-1.5b', name: 'qwen2.5-coder-1.5b', provider: 'embedded', capabilities: ['planning', 'coding'], isAvailable: true });

    const manager = new AIRuntimeManager(embeddedAdapter, 'error', 'auto');
    const registry = new ModelRegistry(manager, storage.models, 'error');
    const router = new ModelRouter(registry, 'error');

    const fakeApi = {
      intelligence: { registry, router, getStatus: () => ({ details: { activeProvider: 'embedded' } }) },
    } as unknown as ApplicationApi;

    const runner = new AgentRunner(fakeApi, 'error');
    const output = runner.handleModelCommand([]);

    expect(output).toContain('NEXUS MODEL CONTROL');
    expect(output).toContain('Current Active Model:');
    expect(output).toContain('qwen2.5-coder-1.5b');
    expect(output).toContain('MODEL ROLES');
    expect(output).toContain('Planner');
    expect(output).toContain('Coder');
    expect(output).toContain('Reasoning');
    expect(output).toContain('Chat');
  });

  it('12. /model reset: resets model overrides back to automatic routing', () => {
    const manager = new AIRuntimeManager(embeddedAdapter, 'error', 'auto');
    const registry = new ModelRegistry(manager, storage.models, 'error');
    storage.models.upsert({ id: 'qwen2.5-coder-1.5b', name: 'qwen2.5-coder-1.5b', provider: 'embedded', capabilities: ['planning'], isAvailable: true });
    storage.models.upsert({ id: 'llama3.1:8b', name: 'llama3.1:8b', provider: 'ollama', capabilities: ['chat'], isAvailable: true });

    const router = new ModelRouter(registry, 'error');
    router.setRoleOverride('coder', 'llama3.1:8b');
    expect(router.getRoleStatus().coder.source).toBe('USER');

    const resetRes = router.resetOverrides();
    expect(resetRes.success).toBe(true);
    expect(router.getRoleStatus().coder.source).toBe('AUTO');
  });
});
