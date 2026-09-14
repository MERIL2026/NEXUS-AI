    /**
 * NEXUS AI - Goal Completion Guard & False-Completion Prevention Test Suite
 *
 * Verifies all 10 P7-G goal verification requirements:
 *  1. "build calculator" cannot complete after only workspace_tree.
 *  2. Authoring tasks require actual authoring steps during plan validation.
 *  3. Missing expected artifact prevents COMPLETED (fails with MISSING_ARTIFACT).
 *  4. Empty artifact prevents COMPLETED (fails with EMPTY_ARTIFACT).
 *  5. Successful artifact creation reaches COMPLETED.
 *  6. Existing legitimate read-only tasks still work.
 *  7. workspace_tree-only tasks can still complete when actual goal is workspace inspection.
 *  8. Completion verification is goal-aware rather than blindly requiring filesystem writes for every task.
 *  9. Approval -> execution -> verification -> completion pipeline works.
 * 10. A failed verification produces a truthful failure result with correct error category.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { ApplicationApi } from '../api/index.js';
import { loadConfig } from '../config/index.js';
import { AgentRunner } from '../cli/agentRunner.js';
import { GoalCompletionVerifier } from '../orchestration/goalCompletionVerifier.js';
import { PlanValidator, isAuthoringGoal } from '../orchestration/planner.ts';
import type { AgentPlanStep } from '../orchestration/types.js';

describe('Goal Completion Guard & False-Completion Prevention', () => {
  let tmpDir: string;
  let api: ApplicationApi;
  let runner: AgentRunner;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-goal-guard-'));
    const config = loadConfig({
      DATABASE_PATH: ':memory:',
      WORKSPACE_ROOT: tmpDir,
      LOG_LEVEL: 'error',
    });

    api = new ApplicationApi(config);
    await api.bootstrap();
    runner = new AgentRunner(api, 'error');
  });

  afterEach(async () => {
    api.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. "build calculator" cannot complete after only workspace_tree
  // -------------------------------------------------------------------------

  it('1. "build calculator" cannot complete after only workspace_tree (rejected at synthesis)', async () => {
    // Model outputs a 1-step plan with workspace_tree for a build goal
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: JSON.stringify({
        reasoning: 'Inspect directory',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'workspace_tree',
            requestedCapabilities: ['filesystem.read'],
            params: {},
          },
        ],
      }),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    const res = await runner.runCommand('build a working calculator webpage using html css and js');
    expect(res).toMatch(/FAILED/i);
    const tasks = api.tasks.listTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].state).toBe('failed');
    expect(['PLAN_VALIDATION_FAILED', 'CHILD_TASK_FAILED']).toContain(tasks[0].errorCategory);
  });

  // -------------------------------------------------------------------------
  // 2. Authoring tasks require actual authoring steps
  // -------------------------------------------------------------------------

  it('2. Authoring tasks require actual authoring steps during PlanValidator check', () => {
    const validator = new PlanValidator(api.tools);
    const readOnlyProposal = {
      reasoning: 'Inspect workspace',
      steps: [
        {
          stepId: 'step-1',
          toolId: 'workspace_tree',
          requestedCapabilities: ['filesystem.read'],
          params: {},
        },
      ],
    };

    // For a creation goal, validator MUST report UNSUPPORTED_ACTION / authoring error
    const result = validator.validate(
      readOnlyProposal,
      'task-1',
      10,
      'Create a new component button.tsx'
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('file creation/authoring'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. Missing expected artifact prevents COMPLETED
  // -------------------------------------------------------------------------

  it('3. Missing expected artifact prevents task COMPLETED and sets state to failed', () => {
    const verifier = new GoalCompletionVerifier('error');
    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-1',
        taskId: 't-1',
        sequence: 1,
        stepType: 'tool_execution',
        status: 'completed',
        toolId: 'filesystem_write',
        requestedCapabilities: ['filesystem.write'],
        params: { relativePath: 'nonexistent.txt' },
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const result = verifier.verifyGoal('Create nonexistent.txt', steps, tmpDir);
    expect(result.verified).toBe(false);
    expect(result.errorCategory).toBe('MISSING_ARTIFACT');
    expect(result.errorMessage).toContain('nonexistent.txt');
  });

  // -------------------------------------------------------------------------
  // 4. Empty artifact prevents COMPLETED
  // -------------------------------------------------------------------------

  it('4. Empty artifact (0 bytes) prevents COMPLETED and sets state to failed', () => {
    fs.writeFileSync(path.join(tmpDir, 'empty.txt'), '', 'utf8');

    const verifier = new GoalCompletionVerifier('error');
    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-1',
        taskId: 't-1',
        sequence: 1,
        stepType: 'tool_execution',
        status: 'completed',
        toolId: 'filesystem_write',
        requestedCapabilities: ['filesystem.write'],
        params: { relativePath: 'empty.txt' },
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const result = verifier.verifyGoal('Create empty.txt file', steps, tmpDir);
    expect(result.verified).toBe(false);
    expect(result.errorCategory).toBe('EMPTY_ARTIFACT');
    expect(result.errorMessage).toContain('0 bytes');
  });

  // -------------------------------------------------------------------------
  // 5. Successful artifact creation reaches COMPLETED
  // -------------------------------------------------------------------------

  it('5. Successful artifact creation passes verification and completes task', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: JSON.stringify({
        reasoning: 'Create notes.txt',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'filesystem_write',
            requestedCapabilities: ['filesystem.write'],
            params: { relativePath: 'notes.txt', content: 'Meeting notes content' },
          },
        ],
      }),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    // Automatically resolve approval for medium-risk write tool
    vi.spyOn(api.approvals!, 'evaluateGateForStep').mockReturnValue({
      allowed: true,
      status: 'approved',
      approvalId: 'appr-auto-1',
      reason: 'Auto test approval',
    });

    const res = await runner.runCommand('Create notes.txt file containing meeting notes');
    expect(res).toContain('TASK COMPLETED');
    expect(fs.existsSync(path.join(tmpDir, 'notes.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'notes.txt'), 'utf8')).toBe('Meeting notes content');
  });

  // -------------------------------------------------------------------------
  // 6. Existing legitimate read-only tasks still work
  // -------------------------------------------------------------------------

  it('6. Existing legitimate read-only tasks complete cleanly when steps succeed', async () => {
    fs.writeFileSync(path.join(tmpDir, 'existing.txt'), 'Sample content', 'utf8');

    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: JSON.stringify({
        reasoning: 'Read existing.txt',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'filesystem_read',
            requestedCapabilities: ['filesystem.read'],
            params: { relativePath: 'existing.txt' },
          },
        ],
      }),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    const res = await runner.runCommand('read file existing.txt');
    expect(res).toContain('TASK COMPLETED');
  });

  // -------------------------------------------------------------------------
  // 7. workspace_tree-only tasks complete when goal is inspection
  // -------------------------------------------------------------------------

  it('7. workspace_tree-only task completes when goal is workspace inspection', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: JSON.stringify({
        reasoning: 'Inspect directory tree',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'workspace_tree',
            requestedCapabilities: ['filesystem.read'],
            params: {},
          },
        ],
      }),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    const res = await runner.runCommand('show workspace tree');
    expect(res).toContain('TASK COMPLETED');
  });

  // -------------------------------------------------------------------------
  // 8. Completion verification is goal-aware
  // -------------------------------------------------------------------------

  it('8. isAuthoringGoal accurately distinguishes creation vs inspection goals', () => {
    expect(isAuthoringGoal('Create a new README.md')).toBe(true);
    expect(isAuthoringGoal('Build a calculator webpage using HTML, CSS and JS')).toBe(true);
    expect(isAuthoringGoal('Generate PRD document for project')).toBe(true);
    expect(isAuthoringGoal('Write unit test for auth module')).toBe(true);

    expect(isAuthoringGoal('show workspace tree')).toBe(false);
    expect(isAuthoringGoal('inspect workspace structure')).toBe(false);
    expect(isAuthoringGoal('search code for loginUser')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 9. Approval -> execution -> verification -> completion works
  // -------------------------------------------------------------------------

  it('9. Approval -> execution -> goal verification -> completion pipeline works end-to-end', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: JSON.stringify({
        reasoning: 'Create config.json',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'filesystem_write',
            requestedCapabilities: ['filesystem.write'],
            params: { relativePath: 'config.json', content: '{"theme":"dark"}' },
          },
        ],
      }),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    const res1 = await runner.runCommand('Create config.json file');
    expect(runner.currentTask?.state).toBe('awaiting_approval');
    expect(res1).toContain('APPROVAL REQUIRED');

    // User approves via Y
    const res2 = await runner.runCommand('y');
    expect(res2).toContain('TASK COMPLETED');
    expect(runner.currentTask?.state).toBe('completed');
    expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 10. Failed verification produces truthful failure result
  // -------------------------------------------------------------------------

  it('10. Failed goal verification fails task with GOAL_VERIFICATION_FAILED / MISSING_ARTIFACT', async () => {
    // Mock execution service to run a write step that fails to actually write the file
    vi.spyOn(api.tools, 'executeTool').mockReturnValue(Promise.resolve({
      requestId: 'req-1',
      taskId: 'task-1',
      toolId: 'filesystem_write',
      authorized: true,
      executed: true,
      success: true, // tool returns success but file wasn't created in fs
      decision: 'ALLOWED',
      timestamp: new Date().toISOString(),
    }));

    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: JSON.stringify({
        reasoning: 'Create phantom.txt',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'filesystem_write',
            requestedCapabilities: ['filesystem.write'],
            params: { relativePath: 'phantom.txt', content: 'hello' },
          },
        ],
      }),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    vi.spyOn(api.approvals!, 'evaluateGateForStep').mockReturnValue({
      allowed: true,
      status: 'approved',
      approvalId: 'appr-auto-2',
      reason: 'Auto test approval',
    });

    const res = await runner.runCommand('Create phantom.txt file');
    expect(res).toContain('TASK FAILED');
    expect(runner.currentTask?.state).toBe('failed');
    expect(runner.currentTask?.errorCategory).toBe('MISSING_ARTIFACT');
  });
});
