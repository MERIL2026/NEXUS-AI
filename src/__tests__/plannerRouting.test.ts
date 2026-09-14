/**
 * NEXUS AI — Planner Model Routing & Timeout Regression Test Suite
 *
 * Verifies:
 *  1. Lightweight planning model (qwen2.5:3b) capability inference and preference.
 *  2. Capability-based model routing for 'planning' task capability.
 *  3. Primary model success and fallback model behavior.
 *  4. Plan synthesis timeout handling (SYNTHESIS_TIMEOUT).
 *  5. Malformed / empty model response handling (PLAN_PARSE_FAILED).
 *  6. End-to-end plan synthesis integration with PlanSynthesisService.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StorageService } from '../storage/index.js';
import { OllamaAdapter } from '../intelligence/ollamaAdapter.js';
import { ModelRegistry } from '../intelligence/modelRegistry.js';
import { ModelRouter } from '../intelligence/modelRouter.js';
import { ModelGateway } from '../intelligence/modelGateway.js';
import { PlanSynthesisService } from '../orchestration/planner.js';
import { ToolGateway } from '../tools/index.js';
import { AgentTaskService } from '../orchestration/agentTaskService.js';

describe('Planner Model Routing & Timeout Regression Tests', () => {
  let storage: StorageService;
  let adapter: OllamaAdapter;
  let registry: ModelRegistry;
  let router: ModelRouter;
  let gateway: ModelGateway;
  let toolGateway: ToolGateway;
  let taskService: AgentTaskService;

  beforeEach(async () => {
    storage = new StorageService(':memory:', 'error');
    await storage.initialize();

    adapter = new OllamaAdapter('http://127.0.0.1:11434', 'error');
    registry = new ModelRegistry(adapter, storage.models, 'error');
    router = new ModelRouter(registry, 'error');
    gateway = new ModelGateway(adapter, registry, router, storage.models, 'error');

    taskService = new AgentTaskService(storage.agentTasks, 'error');
    toolGateway = new ToolGateway(undefined, 'error');
    await toolGateway.initialize(taskService, process.cwd());

    // Register test models in storage repository
    storage.models.upsert({
      id: 'R4C3R/qwen2.5-coder-7b-instruct-heretic:q4_k_m',
      name: 'R4C3R/qwen2.5-coder-7b-instruct-heretic:q4_k_m',
      capabilities: ['coding', 'general'],
    });

    storage.models.upsert({
      id: 'deepseek-r1:8b',
      name: 'deepseek-r1:8b',
      capabilities: ['reasoning', 'planning', 'general'],
    });

    storage.models.upsert({
      id: 'qwen2.5:3b',
      name: 'qwen2.5:3b',
      capabilities: ['lightweight', 'planning', 'summarization', 'general'],
    });
  });

  afterEach(() => {
    storage.close();
  });

  it('1. ModelRegistry infers lightweight and planning capabilities for qwen2.5:3b', async () => {
    const mockAdapter = {
      discoverModels: vi.fn().mockResolvedValue([
        { name: 'qwen2.5:3b', details: { parameter_size: '3B' } },
        { name: 'R4C3R/qwen2.5-coder-7b-instruct-heretic:q4_k_m', details: { parameter_size: '7B' } },
        { name: 'deepseek-r1:8b', details: { parameter_size: '8B' } },
      ]),
    } as unknown as OllamaAdapter;

    const testRegistry = new ModelRegistry(mockAdapter, storage.models, 'error');
    const records = await testRegistry.syncDiscoveredModels();

    const qwen3b = records.find((r) => r.id === 'qwen2.5:3b');
    expect(qwen3b).toBeDefined();
    expect(qwen3b?.capabilities).toContain('lightweight');
    expect(qwen3b?.capabilities).toContain('planning');

    const coder7b = records.find((r) => r.id.includes('coder'));
    expect(coder7b?.capabilities).toContain('coding');
    expect(coder7b?.capabilities).not.toContain('lightweight');
  });

  it('2. ModelRouter routes planning capability to qwen2.5:3b as primary model', () => {
    const route = router.selectRoute(undefined, 'planning');
    expect(route.primaryModel.id).toBe('qwen2.5:3b');
    expect(route.fallbackModel).toBeDefined();
    expect(route.routingReason).toContain("Matched capability 'planning'");
  });

  it('3. ModelRouter uses coding model for coding capability and reasoning model for reasoning capability', () => {
    const codingRoute = router.selectRoute(undefined, 'coding');
    expect(codingRoute.primaryModel.id).toBe('R4C3R/qwen2.5-coder-7b-instruct-heretic:q4_k_m');

    const reasoningRoute = router.selectRoute(undefined, 'reasoning');
    expect(reasoningRoute.primaryModel.id).toBe('deepseek-r1:8b');
  });

  it('4. PlanSynthesisService passes taskCapability planning to ModelGateway and uses primary lightweight model', async () => {
    const spyGenerate = vi.spyOn(gateway, 'generate').mockResolvedValue({
      modelId: 'qwen2.5:3b',
      text: JSON.stringify({
        reasoning: 'Plan to inspect directory',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'filesystem_read',
            requestedCapabilities: ['filesystem.read'],
            params: { relativePath: 'package.json' },
          },
        ],
      }),
      done: true,
      latencyMs: 150,
      usedFallback: false,
      routingReason: "Matched capability 'planning' to model: qwen2.5:3b",
    });

    const planner = new PlanSynthesisService(gateway, toolGateway, 'error');
    const result = await planner.synthesize('task-100', { taskGoal: 'Inspect workspace' });

    expect(spyGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        taskCapability: 'planning',
        temperature: 0.2,
      })
    );
    expect(result.success).toBe(true);
    expect(result.plan?.modelId).toBe('qwen2.5:3b');
  });

  it('5. Fallback behavior when primary model fails during plan synthesis', async () => {
    const mockAdapter = {
      generate: vi
        .fn()
        .mockRejectedValueOnce(new Error('Ollama generate request timed out after 30000ms'))
        .mockResolvedValueOnce({
          model: 'deepseek-r1:8b',
          response: JSON.stringify({
            reasoning: 'Fallback plan',
            steps: [
              {
                stepId: 'step-1',
                toolId: 'filesystem_read',
                requestedCapabilities: ['filesystem.read'],
                params: { relativePath: 'package.json' },
              },
            ],
          }),
          done: true,
        }),
    } as unknown as OllamaAdapter;

    const testGateway = new ModelGateway(mockAdapter, registry, router, storage.models, 'error');
    const planner = new PlanSynthesisService(testGateway, toolGateway, 'error');

    const result = await planner.synthesize('task-200', { taskGoal: 'Inspect workspace' });
    expect(result.success).toBe(true);
    expect(result.plan?.modelId).toBeTruthy();
  });

  it('6. Handles timeout gracefully and returns SYNTHESIS_TIMEOUT', async () => {
    const mockAdapter = {
      generate: vi.fn().mockRejectedValue(new Error('Ollama generate request timed out after 30000ms or was cancelled')),
    } as unknown as OllamaAdapter;

    const testGateway = new ModelGateway(mockAdapter, registry, router, storage.models, 'error');
    const planner = new PlanSynthesisService(testGateway, toolGateway, 'error');

    const result = await planner.synthesize('task-300', { taskGoal: 'Timeout test' });

    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('SYNTHESIS_TIMEOUT');
    expect(result.errorMessage).toContain('timed out');
  });

  it('7. Handles malformed/empty response gracefully and returns PLAN_PARSE_FAILED', async () => {
    const mockAdapter = {
      generate: vi.fn().mockResolvedValue({
        model: 'qwen2.5:3b',
        response: 'Invalid non-JSON response from model',
        done: true,
      }),
    } as unknown as OllamaAdapter;

    const testGateway = new ModelGateway(mockAdapter, registry, router, storage.models, 'error');
    const planner = new PlanSynthesisService(testGateway, toolGateway, 'error');

    const result = await planner.synthesize('task-400', { taskGoal: 'Malformed response test' });

    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('PLAN_PARSE_FAILED');
  });
});
