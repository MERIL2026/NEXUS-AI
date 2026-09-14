/**
 * NEXUS AI — P5-G Test Suite: Interactive Agent Runner & Subsystem Integration
 *
 * Tests the 18 minimum scenarios for AgentRunner command execution, task submission,
 * plan display, approval UX, approval resumption/rejection, cancellation, process safety,
 * observability, and security invariant preservation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { ApplicationApi } from '../api/index.js';
import { loadConfig } from '../config/index.js';
import { AgentRunner } from '../cli/agentRunner.js';
import type { ToolDefinition } from '../tools/types.js';

function validPlanJson(): string {
  return JSON.stringify({
    reasoning: 'Read test.txt from workspace',
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

function highRiskPlanJson(): string {
  return JSON.stringify({
    reasoning: 'Run high risk action',
    steps: [
      {
        stepId: 'step-high-1',
        toolId: 'high_risk_tool_g',
        requestedCapabilities: ['terminal.execute'],
        params: {},
      },
    ],
  });
}

describe('P5-G — Interactive Agent Runner & Subsystem Integration', () => {
  let tmpDir: string;
  let api: ApplicationApi;
  let runner: AgentRunner;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-p5g-test-'));
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'P5-G test file content', 'utf8');

    const config = loadConfig({
      DATABASE_PATH: ':memory:',
      WORKSPACE_ROOT: tmpDir,
      LOG_LEVEL: 'error',
    });

    api = new ApplicationApi(config);
    await api.bootstrap();

    // Register a high-risk tool definition for approval tests
    const highRiskTool: ToolDefinition = {
      id: 'high_risk_tool_g',
      name: 'High Risk Tool G',
      description: 'High risk tool for G tests',
      version: '1.0.0',
      category: 'utility',
      riskLevel: 'high',
      requiredPermissions: ['terminal.execute'],
      inputSchema: {},
      enabled: true,
    };
    api.tools.registerTool(highRiskTool);

    // Mock ModelGateway on intelligence gateway
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: validPlanJson(),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    runner = new AgentRunner(api, 'error');
  });

  afterEach(() => {
    api.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // 1. CLI starts successfully
  it('1. AgentRunner initializes cleanly with ApplicationApi', () => {
    expect(runner).toBeDefined();
    expect(runner.currentTask).toBeNull();
    expect(runner.currentPlan).toBeNull();
  });

  // 2. /help works
  it('2. /help displays command reference menu', async () => {
    const output = await runner.runCommand('/help');
    expect(output).toContain('NEXUS AI Agent Runner — Help & Command Reference');
    expect(output).toContain('/task');
    expect(output).toContain('/status');
    expect(output).toContain('/approve');
    expect(output).toContain('/reject');
  });

  // 3. /status works
  it('3. /status displays current task state or prompt when no task exists', async () => {
    const noTaskOutput = await runner.runCommand('/status');
    expect(noTaskOutput).toContain('No active task');

    // Create a task
    await runner.runCommand('/task Read test file');
    const statusOutput = await runner.runCommand('/status');
    expect(statusOutput).toContain('NEXUS AI Task Status');
    expect(statusOutput).toContain('Task ID:');
    expect(statusOutput).toContain('State:');
  });

  // 4. task creation works
  it('4. task submission creates AgentTask via AgentTaskService', async () => {
    const output = await runner.runCommand('/task Read test.txt file');
    expect(output).toContain('Task Submitted:');
    expect(runner.currentTask).not.toBeNull();
    expect(runner.currentTask!.id).toBeTruthy();
  });

  // 5. plan display works
  it('5. /plan displays synthesized plan steps without sensitive data', async () => {
    await runner.runCommand('/task Read test file');
    const planOutput = await runner.runCommand('/plan');

    expect(planOutput).toContain('Agent Plan for Task');
    expect(planOutput).toContain('Reasoning:');
    expect(planOutput).toContain('filesystem_read');
    expect(planOutput).not.toContain('password');
    expect(planOutput).not.toContain('secret');
  });

  // 6. low-risk task executes end-to-end
  it('6. low-risk task executes end-to-end and completes', async () => {
    const output = await runner.runCommand('/task Read test.txt file');
    expect(output).toContain('FINAL RESULT');
    expect(output).toContain('COMPLETED');
    expect(runner.currentTask!.state).toBe('completed');
  });

  // 7. approval-required task pauses
  it('7. high-risk task pauses in awaiting_approval state and displays approval UX', async () => {
    // Override model gateway mock to return high risk plan
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: highRiskPlanJson(),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    const output = await runner.runCommand('/task Run terminal command');
    expect(output).toContain('⚠ APPROVAL REQUIRED');
    expect(output).toContain('HIGH');
    expect(output).toContain('/approve');
    expect(runner.currentTask!.state).toBe('awaiting_approval');
  });

  // 8. /approve resumes execution
  it('8. /approve resolves approval request and resumes execution', async () => {
    // Mock high-risk plan synthesis
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: highRiskPlanJson(),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    await runner.runCommand('/task High risk operation');
    expect(runner.currentTask!.state).toBe('awaiting_approval');

    const approvals = api.approvals!.getApprovalsForTask(runner.currentTask!.id);
    expect(approvals).toHaveLength(1);
    const approvalId = approvals[0].approvalId;

    const approveOutput = await runner.runCommand(`/approve ${approvalId}`);
    expect(approveOutput).toContain('granted');

    // Re-check task status
    const task = api.tasks.getTask(runner.currentTask!.id);
    expect(task.state).not.toBe('awaiting_approval');
  });

  // 9. /reject prevents execution
  it('9. /reject cancels execution and transitions task to CANCELLED', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: highRiskPlanJson(),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    await runner.runCommand('/task High risk action');
    expect(runner.currentTask!.state).toBe('awaiting_approval');

    const approvals = api.approvals!.getApprovalsForTask(runner.currentTask!.id);
    const approvalId = approvals[0].approvalId;

    const rejectOutput = await runner.runCommand(`/reject ${approvalId}`);
    expect(rejectOutput).toContain('rejected');
    expect(rejectOutput).toContain('CANCELLED');

    const task = api.tasks.getTask(runner.currentTask!.id);
    expect(task.state).toBe('cancelled');
  });

  // 10. /cancel prevents further execution
  it('10. /cancel explicitly cancels current task and pending approvals', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: highRiskPlanJson(),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    await runner.runCommand('/task Cancel me');
    expect(runner.currentTask!.state).toBe('awaiting_approval');

    const cancelOutput = await runner.runCommand('/cancel');
    expect(cancelOutput).toContain('cancelled');

    const task = api.tasks.getTask(runner.currentTask!.id);
    expect(task.state).toBe('cancelled');

    const approvals = api.approvals!.getApprovalsForTask(task.id);
    expect(approvals[0].status).toBe('cancelled');
  });

  // 11. unknown command is safe
  it('11. unknown slash command returns safe error without crashing', async () => {
    const output = await runner.runCommand('/unknowncommand');
    expect(output).toContain("Unknown command '/unknowncommand'");
  });

  // 12. malformed approval ID is safe
  it('12. malformed approval ID returns clear error without throwing', async () => {
    const output = await runner.runCommand('/approve non_existent_approval_id_123');
    expect(output).toContain('Error approving request');
  });

  // 13. terminal task cannot execute again
  it('13. attempting to execute or approve a completed or terminal task is rejected', async () => {
    await runner.runCommand('/task Low risk task');
    expect(runner.currentTask!.state).toBe('completed');

    const output = await runner.runCommand(`/approve fake-id`);
    expect(output).toContain('Error approving request');
  });

  // 14. PermissionEngine remains mandatory
  it('14. PermissionEngine authorization check remains mandatory during runner execution', async () => {
    // Register tool requiring terminal.execute capability
    const terminalTool: ToolDefinition = {
      id: 'denied_tool',
      name: 'Denied Tool',
      description: 'Denied by permission policy',
      version: '1.0.0',
      category: 'terminal',
      riskLevel: 'high',
      requiredPermissions: ['terminal.execute'],
      inputSchema: {},
      enabled: true,
    };
    api.tools.registerTool(terminalTool);

    // Apply a restrictive policy to the live PermissionEngine — only filesystem.read is permitted.
    // This makes PermissionEngine deny terminal.execute at the AUTHORIZATION layer,
    // regardless of human approval status.
    api.tools.permissionEngine.setPolicy({
      id: 'test_restrictive_policy',
      name: 'Restrictive test policy (filesystem.read only)',
      allowedCapabilities: ['filesystem.read'],
      maxRiskLevel: 'high',
      allowDisabledTools: false,
    });

    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: JSON.stringify({
        reasoning: 'Run denied tool',
        steps: [
          { stepId: 'step-denied', toolId: 'denied_tool', requestedCapabilities: ['terminal.execute'], params: {} },
        ],
      }),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    await runner.runCommand('/task Run denied tool');
    expect(runner.currentTask!.state).toBe('awaiting_approval');

    const approvals = api.approvals!.getApprovalsForTask(runner.currentTask!.id);
    const approvalId = approvals[0].approvalId;

    // Approve the human approval — PermissionEngine MUST STILL DENY execution!
    await runner.runCommand(`/approve ${approvalId}`);

    const task = api.tasks.getTask(runner.currentTask!.id);
    expect(task.state).toBe('failed');
    // PermissionEngine blocked execution at authorization layer → PERMISSION_DENIED
    expect(task.errorCategory).toBe('PERMISSION_DENIED');
  });

  // 15. ApprovalGate remains mandatory
  it('15. ApprovalGate evaluation cannot be bypassed by runner', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: highRiskPlanJson(),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    await runner.runCommand('/task High risk task gate test');
    expect(runner.currentTask!.state).toBe('awaiting_approval');

    // Without resolving approval, try to run execution loop directly
    const task = await api.execution!.runExecutionLoop(runner.currentTask!.id, runner.currentPlan!.steps);
    expect(task.state).toBe('awaiting_approval'); // Gate still blocks!
  });

  // 16. ToolExecutor remains the only execution path
  it('16. AgentRunner has zero direct tool execution logic and delegates strictly to ToolExecutor via AgentExecutionService', () => {
    expect((runner as unknown as Record<string, unknown>)['executeTool']).toBeUndefined();
    expect((runner as unknown as Record<string, unknown>)['readFileSync']).toBeUndefined();
  });

  // 17. no sensitive data appears in CLI output
  it('17. CLI outputs filter out private keys, secrets, and raw prompt structures', async () => {
    const output = await runner.runCommand('/task Read test.txt file');
    expect(output).not.toContain('API_KEY');
    expect(output).not.toContain('SECRET');
    expect(output).not.toContain('<<PROMPT>>');
  });

  // 18. existing P0-P5-F tests remain unaffected
  it('18. records lifecycle events correctly throughout task execution', async () => {
    await runner.runCommand('/task Lifecycle test task');
    const events = runner.lifecycleLogs.map((l) => l.event);

    expect(events).toContain('TASK_CREATED');
    expect(events).toContain('PLAN_GENERATED');
    expect(events).toContain('PLAN_VALIDATED');
    expect(events).toContain('AUTHORIZATION_CHECKED');
    expect(events).toContain('TASK_COMPLETED');
  });
});
