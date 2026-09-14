/**
 * NEXUS AI — P5-E Test Suite: Agent Plan Synthesis & Controlled Task Orchestration
 *
 * Tests:
 *  PlanValidator — deterministic, stateless validation
 *  PlanSynthesisService — model-backed plan generation (ModelGateway mocked)
 *  Integration — validated plan fed into AgentExecutionService (P5-D)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { StorageService } from '../storage/index.js';
import { AgentTaskService } from '../orchestration/agentTaskService.js';
import { AgentExecutionService } from '../orchestration/agentExecutionService.js';
import { PlanValidator, PlanSynthesisService } from '../orchestration/planner.js';
import { ToolGateway } from '../tools/index.js';
import type { ModelGateway } from '../intelligence/modelGateway.js';
import type { PlanSynthesisOptions } from '../orchestration/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid plan JSON string for the given taskId */
function validPlanJson(_taskId: string): string {
  return JSON.stringify({
    reasoning: 'Read a known workspace file to verify filesystem tool works.',
    steps: [
      {
        stepId: 'step-1',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'test.txt' },
      },
    ],
  });
}

/** Create a mock ModelGateway that returns a preset response text */
function makeMockGateway(responseText: string, throwError?: string): ModelGateway {
  return {
    generate: throwError
      ? vi.fn().mockRejectedValue(new Error(throwError))
      : vi.fn().mockResolvedValue({
          modelId: 'mock-model',
          text: responseText,
          done: true,
          latencyMs: 10,
          usedFallback: false,
          routingReason: 'test',
        }),
    generateStream: vi.fn(),
  } as unknown as ModelGateway;
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

describe('P5-E — Agent Plan Synthesis & Controlled Task Orchestration', () => {
  let tmpDir: string;
  let storage: StorageService;
  let taskService: AgentTaskService;
  let toolGateway: ToolGateway;
  let execService: AgentExecutionService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-p5e-test-'));
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'P5-E test content', 'utf8');

    storage = new StorageService(':memory:', 'error');
    await storage.initialize();
    taskService = new AgentTaskService(storage.agentTasks, 'error');
    toolGateway = new ToolGateway(undefined, 'error');
    await toolGateway.initialize(taskService, tmpDir);
    execService = new AgentExecutionService(taskService, toolGateway, 'error');
  });

  afterEach(() => {
    storage.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // =========================================================================
  // PlanValidator — deterministic validation tests
  // =========================================================================

  describe('PlanValidator', () => {
    let validator: PlanValidator;

    beforeEach(() => {
      validator = new PlanValidator(toolGateway);
    });

    // 1.
    it('1. accepts a fully valid plan proposal', () => {
      const result = validator.validate(
        {
          reasoning: 'Read a file',
          steps: [
            { stepId: 'step-1', toolId: 'filesystem_read', requestedCapabilities: ['filesystem.read'], params: { relativePath: 'test.txt' } },
          ],
        },
        'task-1'
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    // 2.
    it('2. rejects a non-object proposal (null)', () => {
      const result = validator.validate(null, 'task-1');
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('MALFORMED_OUTPUT');
    });

    // 3.
    it('3. rejects a proposal with no steps array', () => {
      const result = validator.validate({ reasoning: 'ok' }, 'task-1');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'MALFORMED_OUTPUT')).toBe(true);
    });

    // 4.
    it('4. rejects an empty steps array (EMPTY_PLAN)', () => {
      const result = validator.validate({ reasoning: 'empty', steps: [] }, 'task-1');
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('EMPTY_PLAN');
    });

    // 5.
    it('5. rejects a plan that exceeds the step limit', () => {
      const steps = Array.from({ length: 4 }, (_, i) => ({
        stepId: `step-${i + 1}`,
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: {},
      }));
      const result = validator.validate({ reasoning: 'too many', steps }, 'task-1', 3);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('STEP_LIMIT_EXCEEDED');
    });

    // 6.
    it('6. rejects a step referencing an unknown tool (UNKNOWN_TOOL)', () => {
      const result = validator.validate(
        {
          reasoning: 'use unknown tool',
          steps: [
            { stepId: 'step-1', toolId: 'nonexistent_tool', requestedCapabilities: ['filesystem.read'], params: {} },
          ],
        },
        'task-1'
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'UNKNOWN_TOOL')).toBe(true);
    });

    // 7.
    it('7. rejects a step with an unknown capability (UNSUPPORTED_ACTION)', () => {
      const result = validator.validate(
        {
          reasoning: 'bad cap',
          steps: [
            { stepId: 'step-1', toolId: 'filesystem_read', requestedCapabilities: ['INVENTED.action'], params: {} },
          ],
        },
        'task-1'
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'UNSUPPORTED_ACTION')).toBe(true);
    });

    // 8.
    it('8. rejects duplicate stepIds', () => {
      const result = validator.validate(
        {
          reasoning: 'duplicates',
          steps: [
            { stepId: 'step-1', toolId: 'filesystem_read', requestedCapabilities: ['filesystem.read'], params: {} },
            { stepId: 'step-1', toolId: 'filesystem_read', requestedCapabilities: ['filesystem.read'], params: {} },
          ],
        },
        'task-1'
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_STEP_STRUCTURE' && e.message.includes('Duplicate'))).toBe(true);
    });

    // 9.
    it('9. rejects a step with missing stepId', () => {
      const result = validator.validate(
        {
          reasoning: 'no id',
          steps: [
            { stepId: '', toolId: 'filesystem_read', requestedCapabilities: ['filesystem.read'], params: {} },
          ],
        },
        'task-1'
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_STEP_STRUCTURE')).toBe(true);
    });

    // 10.
    it('10. rejects a step where params is not an object', () => {
      const result = validator.validate(
        {
          reasoning: 'bad params',
          steps: [
            { stepId: 'step-1', toolId: 'filesystem_read', requestedCapabilities: ['filesystem.read'], params: 'not-an-object' },
          ],
        },
        'task-1'
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_STEP_STRUCTURE')).toBe(true);
    });

    // 11.
    it('11. collects ALL errors rather than short-circuiting on the first', () => {
      const result = validator.validate(
        {
          reasoning: 'multi-error',
          steps: [
            { stepId: '', toolId: 'nonexistent', requestedCapabilities: ['FAKE.cap'], params: 'nope' },
          ],
        },
        'task-1'
      );
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });

    // 12.
    it('12. rejects a missing reasoning field', () => {
      const result = validator.validate(
        {
          reasoning: '',
          steps: [
            { stepId: 'step-1', toolId: 'filesystem_read', requestedCapabilities: ['filesystem.read'], params: {} },
          ],
        },
        'task-1'
      );
      expect(result.valid).toBe(false);
    });
  });

  // =========================================================================
  // PlanSynthesisService — plan generation tests (ModelGateway mocked)
  // =========================================================================

  describe('PlanSynthesisService', () => {
    // 13.
    it('13. synthesizes a valid plan when the model returns correct JSON', async () => {
      const task = taskService.createTask({ title: 'Read workspace file' });
      const gateway = makeMockGateway(validPlanJson(task.id));
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const opts: PlanSynthesisOptions = {
        taskGoal: 'Read test.txt from the workspace',
        temperature: 0.1,
        maxSteps: 5,
      };

      const result = await service.synthesize(task.id, opts);

      expect(result.success).toBe(true);
      expect(result.plan).toBeDefined();
      expect(result.plan!.taskId).toBe(task.id);
      expect(result.plan!.steps).toHaveLength(1);
      expect(result.plan!.steps[0].toolId).toBe('filesystem_read');
      expect(result.plan!.reasoning).toBeTruthy();
      expect(result.plan!.modelId).toBe('mock-model');
      expect(result.plan!.version).toBe(1);
      expect(result.plan!.planId).toContain(task.id);
    });

    // 14.
    it('14. returns PLAN_VALIDATION_FAILED when model outputs unknown tool', async () => {
      const task = taskService.createTask({ title: 'Bad Tool Task' });
      const badPlan = JSON.stringify({
        reasoning: 'use a bad tool',
        steps: [{ stepId: 'step-1', toolId: 'delete_everything', requestedCapabilities: ['filesystem.write'], params: {} }],
      });
      const gateway = makeMockGateway(badPlan);
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const result = await service.synthesize(task.id, { taskGoal: 'bad goal' });

      expect(result.success).toBe(false);
      expect(result.errorCategory).toBe('PLAN_VALIDATION_FAILED');
      expect(result.validationErrors).toBeDefined();
      expect(result.validationErrors!.some((e) => e.code === 'UNKNOWN_TOOL')).toBe(true);
    });

    // 15.
    it('15. returns PLAN_PARSE_FAILED when model returns non-JSON text', async () => {
      const task = taskService.createTask({ title: 'Bad Output Task' });
      const gateway = makeMockGateway('Sorry, I cannot help with that.');
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const result = await service.synthesize(task.id, { taskGoal: 'anything' });

      expect(result.success).toBe(false);
      expect(result.errorCategory).toBe('PLAN_PARSE_FAILED');
    });

    // 16.
    it('16. returns MODEL_UNAVAILABLE when ModelGateway throws', async () => {
      const task = taskService.createTask({ title: 'Model Failure Task' });
      const gateway = makeMockGateway('', 'Ollama model error: connection refused');
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const result = await service.synthesize(task.id, { taskGoal: 'anything' });

      expect(result.success).toBe(false);
      expect(result.errorCategory).toBe('MODEL_UNAVAILABLE');
    });

    // 17.
    it('17. returns SYNTHESIS_TIMEOUT when ModelGateway throws a timeout error', async () => {
      const task = taskService.createTask({ title: 'Timeout Task' });
      const gateway = makeMockGateway('', 'Ollama generate request timed out after 30000ms');
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const result = await service.synthesize(task.id, { taskGoal: 'anything' });

      expect(result.success).toBe(false);
      expect(result.errorCategory).toBe('SYNTHESIS_TIMEOUT');
    });

    // 18.
    it('18. extracts JSON from a markdown-fenced model response', async () => {
      const task = taskService.createTask({ title: 'Fenced JSON Task' });
      const fenced = [
        'Sure, here is the plan:',
        '```json',
        JSON.stringify({
          reasoning: 'Reads the workspace file',
          steps: [{ stepId: 'step-1', toolId: 'filesystem_read', requestedCapabilities: ['filesystem.read'], params: { relativePath: 'test.txt' } }],
        }),
        '```',
      ].join('\n');
      const gateway = makeMockGateway(fenced);
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const result = await service.synthesize(task.id, { taskGoal: 'read test.txt' });

      expect(result.success).toBe(true);
      expect(result.plan!.steps).toHaveLength(1);
    });

    // 19.
    it('19. increments plan version on each call within the same service instance', async () => {
      const task = taskService.createTask({ title: 'Version Task' });
      const gateway = makeMockGateway(validPlanJson(task.id));
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const r1 = await service.synthesize(task.id, { taskGoal: 'goal 1' });
      const r2 = await service.synthesize(task.id, { taskGoal: 'goal 2' });

      expect(r1.plan!.version).toBe(1);
      expect(r2.plan!.version).toBe(2);
    });

    // 20.
    it('20. rejects a plan exceeding maxSteps even if model produces more', async () => {
      const task = taskService.createTask({ title: 'Too Many Steps Task' });
      const tooManySteps = JSON.stringify({
        reasoning: 'many steps',
        steps: Array.from({ length: 5 }, (_, i) => ({
          stepId: `step-${i + 1}`,
          toolId: 'filesystem_read',
          requestedCapabilities: ['filesystem.read'],
          params: { relativePath: 'test.txt' },
        })),
      });
      const gateway = makeMockGateway(tooManySteps);
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const result = await service.synthesize(task.id, { taskGoal: 'goal', maxSteps: 2 });

      expect(result.success).toBe(false);
      expect(result.errorCategory).toBe('PLAN_VALIDATION_FAILED');
      expect(result.validationErrors!.some((e) => e.code === 'STEP_LIMIT_EXCEEDED')).toBe(true);
    });

    // 21.
    it('21. treats model-generated params as untrusted (no eval/execution)', async () => {
      const task = taskService.createTask({ title: 'Untrusted Params Task' });
      // The plan itself is valid JSON with a harmless param — the test verifies
      // the synthesizer never executes any param value.
      const planWithInjectionAttempt = JSON.stringify({
        reasoning: 'Read with injected path',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'filesystem_read',
            requestedCapabilities: ['filesystem.read'],
            params: { relativePath: '../../../etc/passwd' },
          },
        ],
      });
      const gateway = makeMockGateway(planWithInjectionAttempt);
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const result = await service.synthesize(task.id, { taskGoal: 'injection attempt' });

      // Synthesizer accepts the plan structure — path traversal is enforced at execution
      // time by the PermissionEngine / ToolExecutor (P5-B/C). Validator only checks structure.
      expect(result.success).toBe(true);
      expect(result.plan!.steps[0].params?.['relativePath']).toBe('../../../etc/passwd');
    });
  });

  // =========================================================================
  // Integration: validated plan → AgentExecutionService (P5-D)
  // =========================================================================

  describe('Integration: PlanSynthesisService → AgentExecutionService', () => {
    // 22.
    it('22. a synthesized plan feeds directly into the execution loop and completes', async () => {
      const task = taskService.createTask({ title: 'E2E Plan → Execute' });
      const gateway = makeMockGateway(validPlanJson(task.id));
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const synthesis = await service.synthesize(task.id, { taskGoal: 'Read test.txt' });
      expect(synthesis.success).toBe(true);

      const finalTask = await execService.runExecutionLoop(task.id, synthesis.plan!.steps);
      expect(finalTask.state).toBe('completed');
    });

    // 23.
    it('23. path traversal attempt in plan params is blocked by ToolExecutor, not planner', async () => {
      const task = taskService.createTask({ title: 'Path Traversal Plan' });
      const maliciousPlan = JSON.stringify({
        reasoning: 'Try to escape sandbox',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'filesystem_read',
            requestedCapabilities: ['filesystem.read'],
            params: { relativePath: '../../../etc/passwd' },
          },
        ],
      });
      const gateway = makeMockGateway(maliciousPlan);
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const synthesis = await service.synthesize(task.id, { taskGoal: 'escape' });
      expect(synthesis.success).toBe(true); // Planner does NOT block — structurally valid

      // Now feed into execution — ToolExecutor MUST block path traversal
      const finalTask = await execService.runExecutionLoop(task.id, synthesis.plan!.steps);
      // Task will fail because the executor blocks the path traversal
      expect(finalTask.state).toBe('failed');
    });

    // 24.
    it('24. planner has NO reference to ToolExecutor or PermissionEngine', () => {
      const gateway = makeMockGateway('{}');
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      // Verify that the service does not expose any execution mechanism
      expect((service as unknown as Record<string, unknown>)['executor']).toBeUndefined();
      expect((service as unknown as Record<string, unknown>)['permissionEngine']).toBeUndefined();
      expect((service as unknown as Record<string, unknown>)['executionService']).toBeUndefined();
    });

    // 25.
    it('25. failed synthesis does not create or mutate any agent task state', async () => {
      const task = taskService.createTask({ title: 'No State Mutation on Failure' });
      const stateBefore = taskService.getTask(task.id).state;

      const gateway = makeMockGateway('', 'model offline');
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');
      const result = await service.synthesize(task.id, { taskGoal: 'anything' });

      expect(result.success).toBe(false);
      // Task state must be completely untouched by the planner
      const stateAfter = taskService.getTask(task.id).state;
      expect(stateAfter).toBe(stateBefore);
    });

    // 26.
    it('26. model response with empty steps array is deterministically rejected as EMPTY_PLAN', async () => {
      const task = taskService.createTask({ title: 'Empty Steps Response' });
      const emptyStepsJson = JSON.stringify({
        reasoning: 'The available tools cannot create a development plan.',
        steps: [],
      });
      const gateway = makeMockGateway(emptyStepsJson);
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const result = await service.synthesize(task.id, { taskGoal: 'Plan e-learning site' });

      expect(result.success).toBe(false);
      expect(result.errorCategory).toBe('PLAN_VALIDATION_FAILED');
      expect(result.validationErrors?.[0].code).toBe('EMPTY_PLAN');
    });

    // 27.
    it('27. qwen2.5:3b structured response with workspace_tree step produces a valid plan', async () => {
      const task = taskService.createTask({ title: 'Qwen 3B Plan' });
      const qwenResponseJson = JSON.stringify({
        reasoning: 'Inspect the workspace to understand the current state and structure.',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'workspace_tree',
            requestedCapabilities: ['filesystem.read'],
            params: { path: '.' },
          },
        ],
      });
      const gateway = makeMockGateway(qwenResponseJson);
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const result = await service.synthesize(task.id, { taskGoal: 'Inspect workspace' });

      expect(result.success).toBe(true);
      expect(result.plan).toBeDefined();
      expect(result.plan?.steps).toHaveLength(1);
      expect(result.plan?.steps[0].toolId).toBe('workspace_tree');
    });

    // 28.
    it('28. parses multiple valid plan steps correctly', async () => {
      const task = taskService.createTask({ title: 'Multi Step Plan' });
      const multiStepJson = JSON.stringify({
        reasoning: 'Explore workspace tree and search for main files.',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'workspace_tree',
            requestedCapabilities: ['filesystem.read'],
            params: { path: '.' },
          },
          {
            stepId: 'step-2',
            toolId: 'code_search',
            requestedCapabilities: ['filesystem.read'],
            params: { query: 'main' },
          },
        ],
      });
      const gateway = makeMockGateway(multiStepJson);
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const result = await service.synthesize(task.id, { taskGoal: 'Inspect workspace' });

      expect(result.success).toBe(true);
      expect(result.plan?.steps).toHaveLength(2);
      expect(result.plan?.steps[0].toolId).toBe('workspace_tree');
      expect(result.plan?.steps[1].toolId).toBe('code_search');
    });

    // 29. Markdown-wrapped JSON parsing
    it('29. parses valid JSON wrapped in markdown code fences (```json ... ```)', async () => {
      const task = taskService.createTask({ title: 'Markdown Wrapped Plan' });
      const wrappedJson = [
        'Here is the plan:',
        '```json',
        JSON.stringify({
          reasoning: 'Read a file to inspect content.',
          steps: [
            {
              stepId: 'step-1',
              toolId: 'filesystem_read',
              requestedCapabilities: ['filesystem.read'],
              params: { relativePath: 'test.txt' },
            },
          ],
        }),
        '```',
      ].join('\n');

      const gateway = makeMockGateway(wrappedJson);
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const result = await service.synthesize(task.id, { taskGoal: 'Read file' });

      expect(result.success).toBe(true);
      expect(result.plan?.steps[0].toolId).toBe('filesystem_read');
    });

    // 30. Unescaped raw newlines inside string parameters repaired by sanitizer
    it('30. repairs and parses JSON with unescaped raw newlines in string parameters', async () => {
      const task = taskService.createTask({ title: 'Raw Newline Plan' });
      // Construct raw JSON string with literal newlines inside content string
      const rawJson = '{\n  "reasoning": "Create HTML file",\n  "steps": [\n    {\n      "stepId": "step-1",\n      "toolId": "filesystem_write",\n      "requestedCapabilities": ["filesystem.write"],\n      "params": {\n        "path": "index.html",\n        "content": "<!DOCTYPE html>\n<html>\n<body>Hello</body>\n</html>"\n      }\n    }\n  ]\n}';

      const gateway = makeMockGateway(rawJson);
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const result = await service.synthesize(task.id, { taskGoal: 'Build index.html' });

      expect(result.success).toBe(true);
      expect(result.plan?.steps[0].toolId).toBe('filesystem_write');
      expect(result.plan?.steps[0].params['content']).toContain('<!DOCTYPE html>');
    });

    // 31. Truncated JSON detection and retry
    it('31. detects truncated JSON and retries bounded synthesis call', async () => {
      const task = taskService.createTask({ title: 'Truncated JSON Plan' });
      const truncatedJson = '{\n  "reasoning": "Create index.html",\n  "steps": [\n    {\n      "stepId": "step-1"'; // missing closing braces

      const validJson = JSON.stringify({
        reasoning: 'Create index.html file.',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'filesystem_write',
            requestedCapabilities: ['filesystem.write'],
            params: { path: 'index.html', content: '<h1>Hello</h1>' },
          },
        ],
      });

      const mockGateway = {
        generate: vi.fn()
          .mockResolvedValueOnce({ modelId: 'mock', text: truncatedJson, done: true, latencyMs: 5, usedFallback: false, routingReason: 'test' })
          .mockResolvedValueOnce({ modelId: 'mock', text: validJson, done: true, latencyMs: 5, usedFallback: false, routingReason: 'test' }),
      } as unknown as ModelGateway;

      const service = new PlanSynthesisService(mockGateway, toolGateway, 'error');
      const result = await service.synthesize(task.id, { taskGoal: 'Create index.html' });

      expect(mockGateway.generate).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      expect(result.plan?.steps[0].toolId).toBe('filesystem_write');
    });

    // 32. Bounded retry succeeds on second attempt after parse error
    it('32. bounded retry triggers on initial parse error and succeeds on 2nd attempt', async () => {
      const task = taskService.createTask({ title: 'Retry Success Plan' });
      const badText = 'Invalid non-JSON response from model';
      const goodJson = JSON.stringify({
        reasoning: 'Valid response after retry.',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'filesystem_read',
            requestedCapabilities: ['filesystem.read'],
            params: { relativePath: 'test.txt' },
          },
        ],
      });

      const mockGateway = {
        generate: vi.fn()
          .mockResolvedValueOnce({ modelId: 'mock', text: badText, done: true, latencyMs: 5, usedFallback: false, routingReason: 'test' })
          .mockResolvedValueOnce({ modelId: 'mock', text: goodJson, done: true, latencyMs: 5, usedFallback: false, routingReason: 'test' }),
      } as unknown as ModelGateway;

      const service = new PlanSynthesisService(mockGateway, toolGateway, 'error');
      const result = await service.synthesize(task.id, { taskGoal: 'Inspect test.txt' });

      expect(mockGateway.generate).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });

    // 33. Retry limit enforced (max 2 attempts)
    it('33. retry limit is bounded (stops after 2 attempts and reports failure)', async () => {
      const task = taskService.createTask({ title: 'Retry Limit Plan' });
      const badText = 'Still non-JSON response';

      const mockGateway = {
        generate: vi.fn().mockResolvedValue({
          modelId: 'mock',
          text: badText,
          done: true,
          latencyMs: 5,
          usedFallback: false,
          routingReason: 'test',
        }),
      } as unknown as ModelGateway;

      const service = new PlanSynthesisService(mockGateway, toolGateway, 'error');
      const result = await service.synthesize(task.id, { taskGoal: 'Inspect file' });

      expect(mockGateway.generate).toHaveBeenCalledTimes(2); // strictly max 2 attempts
      expect(result.success).toBe(false);
      expect(result.errorCategory).toBe('PLAN_PARSE_FAILED');
    });

    // 34. Authoring task produces filesystem_write
    it('34. authoring calculator goal produces filesystem_write steps for index.html, style.css, script.js', async () => {
      const task = taskService.createTask({ title: 'Calculator Webpage Plan' });
      const calculatorPlanJson = JSON.stringify({
        reasoning: 'Create final-calculator-test directory and author index.html, style.css, and script.js.',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'filesystem_write',
            requestedCapabilities: ['filesystem.write'],
            params: { path: 'final-calculator-test/index.html', content: '<!DOCTYPE html><html></html>' },
          },
          {
            stepId: 'step-2',
            toolId: 'filesystem_write',
            requestedCapabilities: ['filesystem.write'],
            params: { path: 'final-calculator-test/style.css', content: 'body { margin: 0; }' },
          },
          {
            stepId: 'step-3',
            toolId: 'filesystem_write',
            requestedCapabilities: ['filesystem.write'],
            params: { path: 'final-calculator-test/script.js', content: 'console.log("calc");' },
          },
        ],
      });

      const gateway = makeMockGateway(calculatorPlanJson);
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const goal = 'Build a working calculator webpage using HTML, CSS and JavaScript. Create a folder named final-calculator-test in the NEXUS workspace. Create: index.html, style.css, script.js. Do not use any frameworks.';
      const result = await service.synthesize(task.id, { taskGoal: goal });

      expect(result.success).toBe(true);
      expect(result.plan?.steps).toHaveLength(3);
      expect(result.plan?.steps.map((s) => s.toolId)).toEqual(['filesystem_write', 'filesystem_write', 'filesystem_write']);
    });

    // 35. Read-only task remains valid with read-only tools
    it('35. read-only inspection task remains valid with workspace_tree', async () => {
      const task = taskService.createTask({ title: 'Read Only Plan' });
      const readOnlyJson = JSON.stringify({
        reasoning: 'Explore workspace tree structure.',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'workspace_tree',
            requestedCapabilities: ['filesystem.read'],
            params: { path: '.' },
          },
        ],
      });

      const gateway = makeMockGateway(readOnlyJson);
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const result = await service.synthesize(task.id, { taskGoal: 'Show workspace tree structure' });

      expect(result.success).toBe(true);
      expect(result.plan?.steps[0].toolId).toBe('workspace_tree');
    });

    // 36. Security invariants preserved
    it('36. PlanSynthesisService remains an untrusted generator with zero execution authority', async () => {
      const task = taskService.createTask({ title: 'Security Check' });
      const gateway = makeMockGateway(validPlanJson(task.id));
      const service = new PlanSynthesisService(gateway, toolGateway, 'error');

      const result = await service.synthesize(task.id, { taskGoal: 'Read test.txt' });

      expect(result.success).toBe(true);
      // Synthesized plan steps are all pending — no side effects or tool executions occurred
      expect(result.plan?.steps.every((s) => s.status === 'pending')).toBe(true);
    });
  });
});

