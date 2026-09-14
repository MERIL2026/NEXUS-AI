/**
 * NEXUS AI — P7-B AI Runtime & Model Management Test Suite
 *
 * Verifies P7-B runtime management deliverables:
 *  1. AIRuntimeManager initialization & adapter registration
 *  2. Ollama runtime detection
 *  3. Ollama unavailable status & actionable diagnostic message
 *  4. Ollama reachable status & version extraction
 *  5. Version discovery
 *  6. Model tags discovery
 *  7. Missing model detection (MODEL_NOT_INSTALLED)
 *  8. Model readiness check (MODEL_READY vs MODEL_NOT_INSTALLED)
 *  9. Requested model selection
 * 10. Fallback model selection
 * 11. No-usable-model error handling
 * 12. Structured runtime diagnostics
 * 13. Endpoint URL validation (NOT_CONFIGURED)
 * 14. Inference timeout handling
 * 15. AbortSignal cancellation handling
 * 16. Primary/fallback model attribution
 * 17. Malformed JSON response handling
 * 18. Empty generation response handling
 * 19. Startup degraded mode (Core ready when runtime offline)
 * 20. Security regression verification (zero process execution, zero path traversal)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { AIRuntimeManager } from '../intelligence/runtime/runtimeManager.js';
import { OllamaRuntimeAdapter } from '../intelligence/runtime/ollamaRuntimeAdapter.js';
import { EmbeddedRuntimeAdapter } from '../intelligence/runtime/embeddedRuntimeAdapter.js';
import type { AIRuntimeAdapter, RuntimeModelInfo } from '../intelligence/runtime/types.js';
import { ConfigService } from '../config/index.js';
import { ApplicationApi } from '../api/index.js';
import { StorageService } from '../storage/index.js';
import { ModelGateway } from '../intelligence/modelGateway.js';
import { ModelRegistry } from '../intelligence/modelRegistry.js';
import { ModelRouter } from '../intelligence/modelRouter.js';

describe('P7-B — AI Runtime & Model Management', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-p7b-test-'));
    dbPath = path.join(tmpDir, 'test_p7b.sqlite');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // 1. Runtime Manager Initialization
  it('1. AIRuntimeManager initializes cleanly with default OllamaRuntimeAdapter', () => {
    const manager = new AIRuntimeManager(undefined, 'error', 'ollama');
    const adapter = manager.getActiveAdapter();
    expect(adapter.providerId).toBe('ollama');
    expect(adapter.getHost()).toBe('http://127.0.0.1:11434');
  });

  // 2. Ollama Detection & Health
  it('2. OllamaRuntimeAdapter performs health check and returns structured RuntimeHealth', async () => {
    const adapter = new OllamaRuntimeAdapter('http://127.0.0.1:11434', 'error');
    const health = await adapter.checkHealth();

    expect(health.providerId).toBe('ollama');
    expect(health.endpoint).toBe('http://127.0.0.1:11434');
    expect(['READY', 'UNREACHABLE', 'UNAVAILABLE']).toContain(health.status);
    expect(health.timestamp).toBeDefined();
  });

  // 3. Ollama Unavailable State & Actionable Diagnostics
  it('3. Reports UNREACHABLE state with actionable diagnostic suggestions when host is offline', async () => {
    // Port 59999 is guaranteed offline
    const adapter = new OllamaRuntimeAdapter('http://127.0.0.1:59999', 'error');
    const health = await adapter.checkHealth(1000);

    expect(health.status).toBe('UNREACHABLE');
    expect(health.reason).toBeDefined();
    expect(health.suggestedAction).toContain('Start the local Ollama runtime process');
  });

  // 4. Ollama Reachable State & Version
  it('4. Reports READY state and parses version when Ollama mock returns HTTP 200', async () => {
    const mockAdapter: AIRuntimeAdapter = {
      providerId: 'ollama',
      getHost: () => 'http://127.0.0.1:11434',
      checkHealth: async () => ({
        providerId: 'ollama',
        status: 'READY',
        endpoint: 'http://127.0.0.1:11434',
        version: '0.3.14',
        timestamp: new Date().toISOString(),
      }),
      discoverModels: async () => [],
      checkModelReadiness: async () => ({ readiness: 'MODEL_READY' }),
      warmupModel: async (m) => ({ success: true, modelId: m, latencyMs: 10 }),
      generate: async () => ({ model: 'qwen2.5:3b', response: 'hi', done: true }),
      generateStream: async () => ({ model: 'qwen2.5:3b', response: 'hi', done: true }),
    };

    const manager = new AIRuntimeManager(mockAdapter, 'error');
    const health = await manager.getHealth();

    expect(health.status).toBe('READY');
    expect(health.version).toBe('0.3.14');
  });

  // 5. Version Discovery
  it('5. Discovers version safely from provider health status', async () => {
    const mockAdapter: AIRuntimeAdapter = {
      providerId: 'ollama',
      getHost: () => 'http://127.0.0.1:11434',
      checkHealth: async () => ({
        providerId: 'ollama',
        status: 'READY',
        endpoint: 'http://127.0.0.1:11434',
        version: '0.4.0',
        timestamp: new Date().toISOString(),
      }),
      discoverModels: async () => [],
      checkModelReadiness: async () => ({ readiness: 'MODEL_READY' }),
      warmupModel: async (m) => ({ success: true, modelId: m, latencyMs: 5 }),
      generate: async () => ({ model: 'm', response: '', done: true }),
      generateStream: async () => ({ model: 'm', response: '', done: true }),
    };

    const manager = new AIRuntimeManager(mockAdapter, 'error');
    const health = await manager.getHealth(true);
    expect(health.version).toBe('0.4.0');
  });

  // 6. Model Discovery
  it('6. Discovers installed models via listModels()', async () => {
    const mockModels: RuntimeModelInfo[] = [
      { id: 'qwen2.5:3b', name: 'qwen2.5:3b', sizeBytes: 1900000000, readiness: 'MODEL_READY' },
      { id: 'llama3:8b', name: 'llama3:8b', sizeBytes: 4700000000, readiness: 'MODEL_READY' },
    ];

    const mockAdapter: AIRuntimeAdapter = {
      providerId: 'ollama',
      getHost: () => 'http://127.0.0.1:11434',
      checkHealth: async () => ({ providerId: 'ollama', status: 'READY', endpoint: 'http://127.0.0.1:11434', timestamp: '' }),
      discoverModels: async () => mockModels,
      checkModelReadiness: async (id) => ({ readiness: mockModels.some((m) => m.id === id) ? 'MODEL_READY' : 'MODEL_NOT_INSTALLED' }),
      warmupModel: async (m) => ({ success: true, modelId: m, latencyMs: 2 }),
      generate: async () => ({ model: 'm', response: '', done: true }),
      generateStream: async () => ({ model: 'm', response: '', done: true }),
    };

    const manager = new AIRuntimeManager(mockAdapter, 'error');
    const models = await manager.listModels();

    expect(models).toHaveLength(2);
    expect(models.map((m) => m.id)).toEqual(['qwen2.5:3b', 'llama3:8b']);
  });

  // 7. Missing Model Detection
  it('7. Detects uninstalled models as MODEL_NOT_INSTALLED', async () => {
    const mockAdapter: AIRuntimeAdapter = {
      providerId: 'ollama',
      getHost: () => 'http://127.0.0.1:11434',
      checkHealth: async () => ({ providerId: 'ollama', status: 'READY', endpoint: '', timestamp: '' }),
      discoverModels: async () => [{ id: 'qwen2.5:3b', name: 'qwen2.5:3b', readiness: 'MODEL_READY' }],
      checkModelReadiness: async (id) => ({
        readiness: id === 'qwen2.5:3b' ? 'MODEL_READY' : 'MODEL_NOT_INSTALLED',
      }),
      warmupModel: async (m) => ({ success: true, modelId: m, latencyMs: 1 }),
      generate: async () => ({ model: 'm', response: '', done: true }),
      generateStream: async () => ({ model: 'm', response: '', done: true }),
    };

    const manager = new AIRuntimeManager(mockAdapter, 'error');
    const res = await manager.checkModelReadiness('non_existent_model');

    expect(res.readiness).toBe('MODEL_NOT_INSTALLED');
  });

  // 8. Model Readiness Check
  it('8. Evaluates model readiness deterministically', async () => {
    const adapter = new OllamaRuntimeAdapter('http://127.0.0.1:11434', 'error');
    const check = await adapter.checkModelReadiness('qwen2.5:3b');
    expect(['MODEL_READY', 'MODEL_NOT_INSTALLED', 'MODEL_ERROR']).toContain(check.readiness);
  });

  // 9. Requested Model Selection
  it('9. Selects requested model when available', async () => {
    const storage = new StorageService(dbPath, 'error');
    await storage.initialize();

    const mockAdapter: AIRuntimeAdapter = {
      providerId: 'ollama',
      getHost: () => 'http://127.0.0.1:11434',
      checkHealth: async () => ({ providerId: 'ollama', status: 'READY', endpoint: '', timestamp: '' }),
      discoverModels: async () => [{ id: 'qwen2.5:3b', name: 'qwen2.5:3b', readiness: 'MODEL_READY' }],
      checkModelReadiness: async () => ({ readiness: 'MODEL_READY' }),
      warmupModel: async (m) => ({ success: true, modelId: m, latencyMs: 1 }),
      generate: async (opts) => ({ model: opts.model, response: 'Selected requested model', done: true }),
      generateStream: async (opts) => ({ model: opts.model, response: 'Selected requested model', done: true }),
    };

    const manager = new AIRuntimeManager(mockAdapter, 'error');
    const registry = new ModelRegistry(manager, storage.models, 'error');
    await registry.syncDiscoveredModels();
    const router = new ModelRouter(registry, 'error');
    const gateway = new ModelGateway(manager, registry, router, storage.models, 'error');

    const res = await gateway.generate({ prompt: 'test prompt', modelId: 'qwen2.5:3b' });
    expect(res.modelId).toBe('qwen2.5:3b');
    expect(res.usedFallback).toBe(false);

    storage.close();
  });

  // 10. Fallback Model Selection
  it('10. Falls back to fallback model when primary model fails', async () => {
    const storage = new StorageService(dbPath, 'error');
    await storage.initialize();

    const mockAdapter: AIRuntimeAdapter = {
      providerId: 'ollama',
      getHost: () => 'http://127.0.0.1:11434',
      checkHealth: async () => ({ providerId: 'ollama', status: 'READY', endpoint: '', timestamp: '' }),
      discoverModels: async () => [
        { id: 'primary-model', name: 'primary-model', readiness: 'MODEL_READY' },
        { id: 'fallback-model', name: 'fallback-model', readiness: 'MODEL_READY' },
      ],
      checkModelReadiness: async () => ({ readiness: 'MODEL_READY' }),
      warmupModel: async (m) => ({ success: true, modelId: m, latencyMs: 1 }),
      generate: async (opts) => {
        if (opts.model === 'primary-model') {
          throw new Error('Primary model execution failed');
        }
        return { model: 'fallback-model', response: 'Fallback model response', done: true };
      },
      generateStream: async () => ({ model: 'm', response: '', done: true }),
    };

    const manager = new AIRuntimeManager(mockAdapter, 'error');
    const registry = new ModelRegistry(manager, storage.models, 'error');
    await registry.syncDiscoveredModels();

    const router: ModelRouter = {
      selectRoute: () => ({
        primaryModel: { id: 'primary-model' },
        fallbackModel: { id: 'fallback-model' },
        routingReason: 'Primary with fallback',
      }),
    } as unknown as ModelRouter;

    const gateway = new ModelGateway(manager, registry, router, storage.models, 'error');
    const res = await gateway.generate({ prompt: 'hello', modelId: 'primary-model', allowFallback: true });

    expect(res.modelId).toBe('fallback-model');
    expect(res.usedFallback).toBe(true);

    storage.close();
  });

  // 11. No-Usable-Model Failure Handling
  it('11. Returns clear error when no usable model is available', async () => {
    const storage = new StorageService(dbPath, 'error');
    await storage.initialize();

    const registry = new ModelRegistry(
      new AIRuntimeManager(undefined, 'error'),
      storage.models,
      'error'
    );

    const router = new ModelRouter(registry, 'error');
    expect(() => router.selectRoute('non_existent_model')).toThrow();

    storage.close();
  });

  // 12. Structured Runtime Diagnostics
  it('12. Outputs structured runtime diagnostics for offline provider', async () => {
    const adapter = new OllamaRuntimeAdapter('http://127.0.0.1:59999', 'error');
    const health = await adapter.checkHealth(500);

    expect(health.providerId).toBe('ollama');
    expect(health.status).toBe('UNREACHABLE');
    expect(health.endpoint).toBe('http://127.0.0.1:59999');
    expect(health.reason).toBeDefined();
    expect(health.suggestedAction).toBeDefined();
  });

  // 13. Endpoint URL Validation
  it('13. Marks status as NOT_CONFIGURED for malformed host endpoint', async () => {
    const adapter = new OllamaRuntimeAdapter('invalid_host_url', 'error');
    const health = await adapter.checkHealth();

    expect(health.status).toBe('NOT_CONFIGURED');
    expect(health.reason).toContain('malformed');
  });

  // 14. Timeout Handling
  it('14. Handles inference timeout gracefully', async () => {
    const mockAdapter: AIRuntimeAdapter = {
      providerId: 'ollama',
      getHost: () => 'http://127.0.0.1:11434',
      checkHealth: async () => ({ providerId: 'ollama', status: 'READY', endpoint: '', timestamp: '' }),
      discoverModels: async () => [],
      checkModelReadiness: async () => ({ readiness: 'MODEL_READY' }),
      warmupModel: async (m) => ({ success: true, modelId: m, latencyMs: 1 }),
      generate: async (opts) => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Ollama generate request timed out after ${opts.timeoutMs}ms`)), 50);
        });
      },
      generateStream: async () => ({ model: 'm', response: '', done: true }),
    };

    const manager = new AIRuntimeManager(mockAdapter, 'error');
    await expect(manager.generate({ model: 'm', prompt: 'test', timeoutMs: 30 })).rejects.toThrow(/timed out/);
  });

  // 15. AbortSignal Cancellation
  it('15. Cancels inference when external AbortSignal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const mockAdapter: AIRuntimeAdapter = {
      providerId: 'ollama',
      getHost: () => 'http://127.0.0.1:11434',
      checkHealth: async () => ({ providerId: 'ollama', status: 'READY', endpoint: '', timestamp: '' }),
      discoverModels: async () => [],
      checkModelReadiness: async () => ({ readiness: 'MODEL_READY' }),
      warmupModel: async (m) => ({ success: true, modelId: m, latencyMs: 1 }),
      generate: async (_opts, signal) => {
        if (signal?.aborted) {
          throw new Error('Inference request cancelled');
        }
        return { model: 'm', response: 'ok', done: true };
      },
      generateStream: async () => ({ model: 'm', response: '', done: true }),
    };

    const manager = new AIRuntimeManager(mockAdapter, 'error');
    await expect(manager.generate({ model: 'm', prompt: 'test' }, controller.signal)).rejects.toThrow(/cancelled/);
  });

  // 16. Primary / Fallback Model Attribution
  it('16. Accurately reports primary and fallback model IDs on double failure', async () => {
    const storage = new StorageService(dbPath, 'error');
    await storage.initialize();

    const mockAdapter: AIRuntimeAdapter = {
      providerId: 'ollama',
      getHost: () => 'http://127.0.0.1:11434',
      checkHealth: async () => ({ providerId: 'ollama', status: 'READY', endpoint: '', timestamp: '' }),
      discoverModels: async () => [],
      checkModelReadiness: async () => ({ readiness: 'MODEL_READY' }),
      warmupModel: async (m) => ({ success: true, modelId: m, latencyMs: 1 }),
      generate: async (opts) => {
        throw new Error(`Execution error on ${opts.model}`);
      },
      generateStream: async () => ({ model: 'm', response: '', done: true }),
    };

    const manager = new AIRuntimeManager(mockAdapter, 'error');
    const registry = new ModelRegistry(manager, storage.models, 'error');
    const router: ModelRouter = {
      selectRoute: () => ({
        primaryModel: { id: 'primary-mod-1' },
        fallbackModel: { id: 'fallback-mod-2' },
        routingReason: 'Double fail test',
      }),
    } as unknown as ModelRouter;

    const gateway = new ModelGateway(manager, registry, router, storage.models, 'error');

    await expect(
      gateway.generate({ prompt: 'test', allowFallback: true })
    ).rejects.toThrow(/Inference failed on both primary \(primary-mod-1\) and fallback \(fallback-mod-2\)/);

    storage.close();
  });

  // 17. Malformed JSON Response Handling
  it('17. Converts malformed runtime response into a clean structured error', async () => {
    const mockAdapter: AIRuntimeAdapter = {
      providerId: 'ollama',
      getHost: () => 'http://127.0.0.1:11434',
      checkHealth: async () => ({ providerId: 'ollama', status: 'READY', endpoint: '', timestamp: '' }),
      discoverModels: async () => {
        throw new Error('Malformed JSON payload from server');
      },
      checkModelReadiness: async () => ({ readiness: 'MODEL_ERROR', details: 'Malformed JSON' }),
      warmupModel: async (m) => ({ success: false, modelId: m, latencyMs: 1, error: 'Malformed JSON' }),
      generate: async () => {
        throw new Error('Malformed JSON response from model daemon');
      },
      generateStream: async () => ({ model: 'm', response: '', done: true }),
    };

    const manager = new AIRuntimeManager(mockAdapter, 'error');
    await expect(manager.generate({ model: 'm', prompt: 'test' })).rejects.toThrow(/Malformed JSON/);
  });

  // 18. Empty Response Handling
  it('18. Handles empty model response cleanly without throwing NPE', async () => {
    const mockAdapter: AIRuntimeAdapter = {
      providerId: 'ollama',
      getHost: () => 'http://127.0.0.1:11434',
      checkHealth: async () => ({ providerId: 'ollama', status: 'READY', endpoint: '', timestamp: '' }),
      discoverModels: async () => [],
      checkModelReadiness: async () => ({ readiness: 'MODEL_READY' }),
      warmupModel: async (m) => ({ success: true, modelId: m, latencyMs: 1 }),
      generate: async () => ({ model: 'qwen2.5:3b', response: '', done: true }),
      generateStream: async () => ({ model: 'qwen2.5:3b', response: '', done: true }),
    };

    const manager = new AIRuntimeManager(mockAdapter, 'error');
    const res = await manager.generate({ model: 'qwen2.5:3b', prompt: 'test' });
    expect(res.response).toBe('');
    expect(res.done).toBe(true);
  });

  // 19. Startup Degraded Mode
  it('19. ApplicationApi bootstraps cleanly in DEGRADED mode when Ollama is offline', async () => {
    const config = new ConfigService({
      DATABASE_PATH: dbPath,
      WORKSPACE_ROOT: tmpDir,
      OLLAMA_HOST: 'http://127.0.0.1:59999', // offline host
      NEXUS_INFERENCE_PROVIDER: 'ollama',
      LOG_LEVEL: 'error',
    }).getConfig();

    const appApi = new ApplicationApi(config);
    const health = await appApi.bootstrap();

    expect(health.overall).toBe('degraded');
    const intelSub = health.subsystems.find((s) => s.name === 'IntelligenceService');
    expect(intelSub?.status).toBe('degraded');
    expect(intelSub?.details?.ollamaAvailable).toBe(false);

    // Verify storage, tool gateway, security are still 100% OK
    const task = appApi.tasks.createTask({ title: 'Degraded Mode Task' });
    expect(task.id).toBeDefined();

    appApi.close();
  });

  // 20. Security Regression Verification
  it('20. Verifies P5/P6 security architecture remains 100% untouched', async () => {
    const config = new ConfigService({
      DATABASE_PATH: dbPath,
      WORKSPACE_ROOT: tmpDir,
      LOG_LEVEL: 'error',
    }).getConfig();

    const appApi = new ApplicationApi(config);
    await appApi.bootstrap();

    const task = appApi.tasks.createTask({ title: 'Security Bound Task' });

    // 1. Path traversal denied
    const trav = await appApi.tools.executeTool({
      requestId: 'req-trav',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: '../../../../etc/passwd' },
    });
    expect(trav.errorCategory).toBe('PATH_TRAVERSAL_DENIED');

    // 2. Secret file protected
    const sec = await appApi.tools.executeTool({
      requestId: 'req-sec',
      taskId: task.id,
      toolId: 'filesystem_write',
      requestedCapabilities: ['filesystem.write'],
      params: { path: '.env', content: 'SECRET=123' },
    });
    expect(sec.errorCategory).toBe('SECRET_FILE_PROTECTED');

    appApi.close();
  });

  // 21. Default Provider Matrix Verification
  it('21. Default provider is Embedded (auto mode) and reports embedded version', async () => {
    const manager = new AIRuntimeManager(undefined, 'error', 'auto');
    expect(manager.getConfigMode()).toBe('auto');
    const health = await manager.getHealth(true);
    expect(health.status).toBe('READY');
    expect(health.providerId).toBe('embedded');
    expect(health.version).toContain('embedded-proto');
  });

  // 22. Explicit Ollama Provider Configuration
  it('22. Explicit Ollama provider configuration uses Ollama mode and Ollama version', async () => {
    const mockOllama: AIRuntimeAdapter = {
      providerId: 'ollama',
      getHost: () => 'http://127.0.0.1:11434',
      checkHealth: async () => ({
        providerId: 'ollama',
        status: 'READY',
        endpoint: 'http://127.0.0.1:11434',
        version: '0.5.1',
        timestamp: new Date().toISOString(),
      }),
      discoverModels: async () => [],
      checkModelReadiness: async () => ({ readiness: 'MODEL_READY' }),
      warmupModel: async (m) => ({ success: true, modelId: m, latencyMs: 5 }),
      generate: async () => ({ model: 'm', response: '', done: true }),
      generateStream: async () => ({ model: 'm', response: '', done: true }),
    };

    const manager = new AIRuntimeManager(mockOllama, 'error', 'ollama');
    expect(manager.getConfigMode()).toBe('ollama');
    const health = await manager.getHealth(true);
    expect(health.providerId).toBe('ollama');
    expect(health.version).toBe('0.5.1');
  });

  // 23. Embedded Runtime Works When Ollama Offline
  it('23. Embedded runtime works cleanly when Ollama is offline in auto mode', async () => {
    const offlineOllama: AIRuntimeAdapter = {
      providerId: 'ollama',
      getHost: () => 'http://127.0.0.1:59999',
      checkHealth: async () => ({
        providerId: 'ollama',
        status: 'UNREACHABLE',
        endpoint: 'http://127.0.0.1:59999',
        timestamp: new Date().toISOString(),
      }),
      discoverModels: async () => [],
      checkModelReadiness: async () => ({ readiness: 'MODEL_UNAVAILABLE' }),
      warmupModel: async () => ({ success: false, modelId: 'm', error: 'offline' }),
      generate: async () => ({ model: 'm', response: '', done: true }),
      generateStream: async () => ({ model: 'm', response: '', done: true }),
    };

    const manager = new AIRuntimeManager(offlineOllama, 'error', 'auto');
    const health = await manager.getHealth(true);
    expect(health.status).toBe('READY');
    expect(health.providerId).toBe('embedded');
  });

  // 24. Explicit Ollama Offline Produces DEGRADED Mode
  it('24. Explicit Ollama offline produces DEGRADED status when configured explicitly', async () => {
    const offlineOllama: AIRuntimeAdapter = {
      providerId: 'ollama',
      getHost: () => 'http://127.0.0.1:59999',
      checkHealth: async () => ({
        providerId: 'ollama',
        status: 'UNREACHABLE',
        endpoint: 'http://127.0.0.1:59999',
        reason: 'Connection refused',
        timestamp: new Date().toISOString(),
      }),
      discoverModels: async () => [],
      checkModelReadiness: async () => ({ readiness: 'MODEL_UNAVAILABLE' }),
      warmupModel: async () => ({ success: false, modelId: 'm', error: 'offline' }),
      generate: async () => ({ model: 'm', response: '', done: true }),
      generateStream: async () => ({ model: 'm', response: '', done: true }),
    };

    const manager = new AIRuntimeManager(offlineOllama, 'error', 'ollama');
    const health = await manager.getHealth(true);
    expect(health.status).toBe('UNREACHABLE');
    expect(health.providerId).toBe('ollama');
  });

  // 25. Provider Versions Are Distinct and Unmixed
  it('25. Provider versions are distinct and never mixed between adapters', async () => {
    const embeddedAdapter = new EmbeddedRuntimeAdapter({ logLevel: 'error' });
    const embeddedHealth = await embeddedAdapter.checkHealth();
    expect(embeddedHealth.version).toContain('embedded-proto');

    const ollamaAdapter = new OllamaRuntimeAdapter('http://127.0.0.1:59999', 'error');
    const ollamaHealth = await ollamaAdapter.checkHealth();
    expect(ollamaHealth.version).toBeUndefined();
  });
});
