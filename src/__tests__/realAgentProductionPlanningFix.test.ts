import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PlanSynthesisService } from '../orchestration/planner.js';
import { EmbeddedInferenceProvider } from '../intelligence/providers/embeddedInferenceProvider.js';
import { ModelRegistry } from '../intelligence/modelRegistry.js';
import { ModelRouter } from '../intelligence/modelRouter.js';
import { ApplicationApi } from '../api/index.js';
import { AgentRunner } from '../cli/agentRunner.js';
import { loadConfig } from '../config/index.js';

describe('NEXUS Real Agent Production Planning & Model Selection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-plan-fix-test-'));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore temporary file lock on Windows
    }
  });

  it('1. ModelRegistry infers lightweight capability for 0.5b/proto and does NOT assign planning capability to prototype models', async () => {
    const mockRepo = {
      upsert: (r: unknown) => r,
      markAllUnavailableExcept: () => {},
      listAvailable: () => [],
      findById: () => null,
    } as unknown as import('../storage/repositories/modelsRepository.js').ModelsRepository;

    const mockManager = {
      listModels: async () => [
        { id: 'nexus-embedded-proto-0.5b', name: 'nexus-embedded-proto-0.5b' },
        { id: 'qwen2.5-coder-1.5b', name: 'qwen2.5-coder-1.5b' },
      ],
    } as unknown as import('../intelligence/ollamaAdapter.js').OllamaAdapter;

    const registry = new ModelRegistry(mockManager, mockRepo, 'error');
    const records = await registry.syncDiscoveredModels();

    const protoRecord = records.find((r) => r.id === 'nexus-embedded-proto-0.5b');
    const prodRecord = records.find((r) => r.id === 'qwen2.5-coder-1.5b');

    expect(protoRecord).toBeDefined();
    expect(protoRecord!.capabilities).toContain('lightweight');
    expect(protoRecord!.capabilities).not.toContain('planning');

    expect(prodRecord).toBeDefined();
    expect(prodRecord!.capabilities).toContain('planning');
    expect(prodRecord!.capabilities).toContain('coding');
  });

  it('2. ModelRouter routes planning task to qwen2.5-coder-1.5b production model instead of 0.5b prototype model', () => {
    const mockRepo = {
      listAvailable: () => [
        { id: 'nexus-embedded-proto-0.5b', name: 'nexus-embedded-proto-0.5b', capabilities: ['lightweight', 'general'], isAvailable: true },
        { id: 'qwen2.5-coder-1.5b', name: 'qwen2.5-coder-1.5b', capabilities: ['coding', 'planning', 'general'], isAvailable: true },
      ],
    } as unknown as import('../storage/repositories/modelsRepository.js').ModelsRepository;

    const registry = new ModelRegistry({} as unknown as import('../intelligence/ollamaAdapter.js').OllamaAdapter, mockRepo, 'error');
    const router = new ModelRouter(registry, 'error');

    const route = router.selectRoute(undefined, 'planning');
    expect(route.primaryModel.id).toBe('qwen2.5-coder-1.5b');
  });

  it('3. EmbeddedInferenceProvider generates valid structured JSON plan for NEXUS planner requests', async () => {
    const provider = new EmbeddedInferenceProvider();
    await provider.initialize();

    const res = await provider.generate({
      prompt: 'TASK GOAL: Create a folder nexus-test containing index.html, style.css, script.js for a calculator.',
      system: 'You are a deterministic task planner for the NEXUS AI Agent Runtime. REQUIRED OUTPUT FORMAT: JSON',
    });

    expect(res.response).toBeDefined();
    const parsed = JSON.parse(res.response);
    expect(parsed.reasoning).toBeDefined();
    expect(Array.isArray(parsed.steps)).toBe(true);
    expect(parsed.steps.length).toBeGreaterThanOrEqual(3);
    expect(parsed.steps[0].toolId).toBe('filesystem_write');
  });

  it('4. PlanSynthesisService recovers from malformed model output (trailing commas, unescaped newlines)', async () => {
    const malformedOutput = `{
      "reasoning": "Create files with unescaped\\nnewline and trailing comma",
      "steps": [
        {
          "stepId": "step-1",
          "toolId": "filesystem_write",
          "requestedCapabilities": ["filesystem.write"],
          "params": {
            "path": "test.txt",
            "content": "Line 1\\nLine 2",
          },
        },
      ],
    }`;

    const mockGateway = {
      generate: async () => ({
        text: malformedOutput,
        modelId: 'qwen2.5-coder-1.5b',
        latencyMs: 10,
      }),
    } as unknown as import('../intelligence/modelGateway.js').ModelGateway;

    const mockToolGateway = {
      getTool: () => ({ enabled: true, requiredPermissions: ['filesystem.write'] }),
      listTools: () => [],
    } as unknown as import('../tools/index.js').ToolGateway;

    const service = new PlanSynthesisService(mockGateway, mockToolGateway, 'error');
    const result = await service.synthesize('task-malformed', { taskGoal: 'Create test.txt' });

    expect(result.success).toBe(true);
    expect(result.plan).toBeDefined();
    expect(result.plan!.steps).toHaveLength(1);
    expect(result.plan!.steps[0].params['path']).toBe('test.txt');
  });

  it('5. Real AgentRunner executes end-to-end task creating nexus-test calculator app', async () => {
    const baseConfig = loadConfig();
    const config = Object.assign({}, baseConfig, {
      workspaceRoot: tmpDir,
      databasePath: path.join(tmpDir, 'test.sqlite'),
    });

    const api = new ApplicationApi(config);
    await api.bootstrap();
    api.intelligence.router.setGlobalOverride('qwen2.5-coder-1.5b');

    try {
      const runner = new AgentRunner(api, 'error');
      let output = await runner.runCommand(
        'Create a folder nexus-test containing index.html, style.css, script.js to build a working calculator'
      );

      while (runner.currentTask && runner.currentTask.state === 'awaiting_approval') {
        output = await runner.runCommand('/approve');
      }

      expect(output).toBeDefined();
      expect(output.toLowerCase()).not.toContain('plan_parse_failed');

      const calcDir = path.join(tmpDir, 'nexus-test');
      expect(fs.existsSync(calcDir)).toBe(true);

      const htmlFile = path.join(calcDir, 'index.html');
      const cssFile = path.join(calcDir, 'style.css');
      const jsFile = path.join(calcDir, 'script.js');

      expect(fs.existsSync(htmlFile)).toBe(true);
      expect(fs.existsSync(cssFile)).toBe(true);
      expect(fs.existsSync(jsFile)).toBe(true);

      const htmlContent = fs.readFileSync(htmlFile, 'utf-8');
      const cssContent = fs.readFileSync(cssFile, 'utf-8');
      const jsContent = fs.readFileSync(jsFile, 'utf-8');

      expect(htmlContent).toContain('style.css');
      expect(htmlContent).toContain('script.js');
      expect(htmlContent).toContain('calculator');

      expect(cssContent).toContain('.calculator');
      expect(cssContent).toContain('#121212'); // Dark UI theme

      expect(jsContent).toContain('appendNumber');
      expect(jsContent).toContain('calculateResult');
    } finally {
      api.close();
    }
  }, 30000);
});
