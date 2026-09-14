/**
 * NEXUS AI — P7-G Test Suite: Model Control & Routing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { StorageService } from '../storage/index.js';
import { ModelRegistry } from '../intelligence/modelRegistry.js';
import { ModelRouter } from '../intelligence/modelRouter.js';
import { ModelGateway } from '../intelligence/modelGateway.js';
import { AgentTaskService } from '../orchestration/agentTaskService.js';
import { ToolGateway } from '../tools/index.js';
import { AgentRunner } from '../cli/agentRunner.js';
import type { AIRuntimeManager } from '../intelligence/runtime/runtimeManager.js';

describe('P7-G — Model Control & Routing', () => {
  let tmpDir: string;
  let storage: StorageService;
  let registry: ModelRegistry;
  let router: ModelRouter;
  let gateway: ModelGateway;
  let mockRuntimeManager: AIRuntimeManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-p7g-test-'));

    storage = new StorageService(':memory:', 'error');
    await storage.initialize();

    // Register 5 mock models matching user environment inventory
    storage.models.upsert({ id: 'R4C3R/qwen2.5-coder-7b-instruct-heretic:q4_k_m', name: 'R4C3R/qwen2.5-coder-7b-instruct-heretic:q4_k_m', provider: 'ollama', versionTag: '7b', capabilities: ['general', 'coding', 'summarization'], isAvailable: true });
    storage.models.upsert({ id: 'deepseek-r1:8b', name: 'deepseek-r1:8b', provider: 'ollama', versionTag: '8b', capabilities: ['general', 'reasoning', 'planning'], isAvailable: true });
    storage.models.upsert({ id: 'llama3.1:8b', name: 'llama3.1:8b', provider: 'ollama', versionTag: '8b', capabilities: ['general', 'summarization', 'planning'], isAvailable: true });
    storage.models.upsert({ id: 'qwen2.5-coder:7b', name: 'qwen2.5-coder:7b', provider: 'ollama', versionTag: '7b', capabilities: ['general', 'coding', 'summarization'], isAvailable: true });
    storage.models.upsert({ id: 'qwen2.5:3b', name: 'qwen2.5:3b', provider: 'ollama', versionTag: '3b', capabilities: ['general', 'lightweight', 'planning', 'summarization'], isAvailable: true });

    mockRuntimeManager = {
      discoverModels: vi.fn().mockResolvedValue([]),
      generate: vi.fn().mockResolvedValue({ response: 'Mock output', done: true }),
    } as unknown as AIRuntimeManager;

    registry = new ModelRegistry(mockRuntimeManager, storage.models, 'error');
    router = new ModelRouter(registry, 'error');
    gateway = new ModelGateway(mockRuntimeManager, registry, router, storage.models, 'error');
  });

  afterEach(() => {
    storage.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // ModelRouter Core Unit Tests
  // -------------------------------------------------------------------------

  describe('ModelRouter Core Unit Tests', () => {
    it('1. resolves 1-based index to ModelRecord', () => {
      const m1 = router.resolveModel(1);
      const m4 = router.resolveModel(4);
      const invalid = router.resolveModel(99);

      expect(m1?.id).toBe('R4C3R/qwen2.5-coder-7b-instruct-heretic:q4_k_m');
      expect(m4?.id).toBe('qwen2.5-coder:7b');
      expect(invalid).toBeNull();
    });

    it('2. sets global override by 1-based index or model ID', () => {
      const res1 = router.setGlobalOverride(4);
      expect(res1.success).toBe(true);
      expect(res1.model?.id).toBe('qwen2.5-coder:7b');

      const route1 = router.selectRoute();
      expect(route1.primaryModel.id).toBe('qwen2.5-coder:7b');
      expect(route1.routingReason).toContain('GLOBAL_OVERRIDE');

      const res2 = router.setGlobalOverride('deepseek-r1:8b');
      expect(res2.success).toBe(true);
      expect(res2.model?.id).toBe('deepseek-r1:8b');

      const route2 = router.selectRoute();
      expect(route2.primaryModel.id).toBe('deepseek-r1:8b');
    });

    it('3. sets role-specific override for planner, coder, reasoning, chat', () => {
      router.setRoleOverride('planner', 2); // deepseek-r1:8b
      router.setRoleOverride('coder', 4);   // qwen2.5-coder:7b

      const plannerRoute = router.selectRoute(undefined, 'planning', 'planner');
      expect(plannerRoute.primaryModel.id).toBe('deepseek-r1:8b');
      expect(plannerRoute.routingReason).toContain('USER_OVERRIDE');

      const coderRoute = router.selectRoute(undefined, 'coding', 'coder');
      expect(coderRoute.primaryModel.id).toBe('qwen2.5-coder:7b');
      expect(coderRoute.routingReason).toContain('USER_OVERRIDE');
    });

    it('4. enforces precedence: Role Override > Global Override > Automatic Routing', () => {
      // 1. Set global override to model 5 (qwen2.5:3b)
      router.setGlobalOverride(5);

      // 2. Set coder role override to model 4 (qwen2.5-coder:7b)
      router.setRoleOverride('coder', 4);

      // Coder role should use Role Override (qwen2.5-coder:7b)
      const coderRoute = router.selectRoute(undefined, 'coding', 'coder');
      expect(coderRoute.primaryModel.id).toBe('qwen2.5-coder:7b');

      // Planner role should fall back to Global Override (qwen2.5:3b)
      const plannerRoute = router.selectRoute(undefined, 'planning', 'planner');
      expect(plannerRoute.primaryModel.id).toBe('qwen2.5:3b');
    });

    it('5. resets specific role override or all overrides', () => {
      router.setRoleOverride('planner', 2);
      router.setRoleOverride('coder', 4);

      // Reset planner only
      router.resetOverrides('planner');
      expect(router.getOverrides().roles.planner).toBeUndefined();
      expect(router.getOverrides().roles.coder).toBe('qwen2.5-coder:7b');

      // Reset all
      router.resetOverrides();
      expect(router.getOverrides().global).toBeUndefined();
      expect(router.getOverrides().roles.coder).toBeUndefined();
    });

    it('6. handles invalid model numbers, IDs, and roles gracefully', () => {
      const res1 = router.setGlobalOverride(999);
      expect(res1.success).toBe(false);
      expect(res1.message).toContain('Invalid model index');

      const res2 = router.setGlobalOverride('non-existent-model');
      expect(res2.success).toBe(false);
      expect(res2.message).toContain('Unknown model');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res3 = router.setRoleOverride('invalidrole' as any, 1);
      expect(res3.success).toBe(false);
      expect(res3.message).toContain('Unknown role');
    });
  });

  // -------------------------------------------------------------------------
  // AgentRunner / CLI /model Command Tests
  // -------------------------------------------------------------------------

  describe('AgentRunner CLI /model commands', () => {
    let runner: AgentRunner;

    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mockApi: any = {
        intelligence: {
          registry,
          router,
          gateway,
          getStatus: () => ({ name: 'IntelligenceService', initialized: true, status: 'ok', message: 'ready', details: { ollamaVersion: '0.33.1' } }),
        },
        tasks: new AgentTaskService(storage.agentTasks, 'error'),
        tools: new ToolGateway(undefined, 'error'),
        getHealthReport: () => ({
          overall: 'ok',
          config: { environment: 'test', databasePath: ':memory:', ollamaHost: 'http://127.0.0.1:11434' },
        }),
        getConfig: () => ({ primaryModel: 'qwen2.5:3b', fallbackModel: 'llama3.1:8b' }),
      };

      runner = new AgentRunner(mockApi, 'error');
    });

    it('7. /model renders model control screen with available models and role statuses', async () => {
      const out = await runner.runCommand('/model');
      expect(out).toContain('NEXUS MODEL CONTROL');
      expect(out).toContain('R4C3R/qwen2.5-coder-7b-instruct-heretic:q4_k_m');
      expect(out).toContain('qwen2.5-coder:7b');
      expect(out).toContain('[1]');
      expect(out).toContain('[4]');
      expect(out).toContain('MODEL ROLES');
    });

    it('8. /model 4 sets global model override', async () => {
      const out = await runner.runCommand('/model 4');
      expect(out).toContain('Model selected');
      expect(out).toContain('qwen2.5-coder:7b');
      expect(out).toContain('GLOBAL OVERRIDE');

      expect(router.getOverrides().global).toBe('qwen2.5-coder:7b');
    });

    it('9. /model coder 4 sets role-specific override', async () => {
      const out = await runner.runCommand('/model coder 4');
      expect(out).toContain('Model selected');
      expect(out).toContain('qwen2.5-coder:7b');
      expect(out).toContain('ROLE OVERRIDE (CODER)');

      expect(router.getOverrides().roles.coder).toBe('qwen2.5-coder:7b');
    });

    it('10. /model status renders model status screen', async () => {
      router.setRoleOverride('coder', 4);
      const out = await runner.runCommand('/model status');

      expect(out).toContain('NEXUS MODEL CONFIGURATION');
      expect(out).toContain('qwen2.5-coder:7b');
      expect(out).toContain('[USER]');
    });

    it('11. /model reset clears all overrides', async () => {
      router.setRoleOverride('coder', 4);
      const out = await runner.runCommand('/model reset');

      expect(out).toContain('Model overrides reset');
      expect(router.getOverrides().roles.coder).toBeUndefined();
    });

    it('12. /model reset planner resets only planner role', async () => {
      router.setRoleOverride('planner', 2);
      router.setRoleOverride('coder', 4);
      const out = await runner.runCommand('/model reset planner');

      expect(out).toContain("Override for role 'planner' reset to automatic routing");
      expect(router.getOverrides().roles.planner).toBeUndefined();
      expect(router.getOverrides().roles.coder).toBe('qwen2.5-coder:7b');
    });

    it('13. /models displays index numbers and active role badges', async () => {
      router.setRoleOverride('coder', 4);
      const out = await runner.runCommand('/models');

      expect(out).toContain('qwen2.5-coder:7b');
      expect(out).toContain('[CODER]');
    });
  });
});
