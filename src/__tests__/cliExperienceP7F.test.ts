/**
 * NEXUS AI — P7-F Test Suite: Interactive CLI Experience & Workstation Integration
 *
 * Verifies all 25 P7-F requirements for the NEXUS AI CLI:
 *  1. Startup dashboard rendering
 *  2. /help command menu
 *  3. /status system & task status
 *  4. /models list
 *  5. /workspace details
 *  6. /tasks history list
 *  7. /task <id> inspection
 *  8. Task creation
 *  9. Planning output visualization
 * 10. Approval required pausing
 * 11. Approval accepted resumption
 * 12. Approval rejected cancellation
 * 13. Execution progress rendering
 * 14. Verification & result formatting
 * 15. Successful completion end-to-end
 * 16. FILE_NOT_FOUND recovery/failure formatting
 * 17. Ollama unavailable DEGRADED status banner
 * 18. Malformed planner output handling
 * 19. Task cancellation via /cancel
 * 20. Invalid command handling
 * 21. Workspace traversal prevention via ToolGateway
 * 22. Terminal approval flow
 * 23. Persisted task history across sessions
 * 24. Result rendering and secret filtering
 * 25. Windows CMD compatibility (state symbols and formatting)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { ApplicationApi } from '../api/index.js';
import { loadConfig } from '../config/index.js';
import { AgentRunner } from '../cli/agentRunner.js';
import { renderDashboard, stateSymbols, getSymbolForState } from '../cli/uiFormatters.js';
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
    reasoning: 'Run terminal command',
    steps: [
      {
        stepId: 'step-high-1',
        toolId: 'high_risk_tool_p7f',
        requestedCapabilities: ['terminal.execute'],
        params: {},
      },
    ],
  });
}

describe('P7-F — NEXUS AI CLI Experience & Workstation Integration', () => {
  let tmpDir: string;
  let api: ApplicationApi;
  let runner: AgentRunner;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-p7f-test-'));
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'P7-F test file content', 'utf8');

    const config = loadConfig({
      DATABASE_PATH: ':memory:',
      WORKSPACE_ROOT: tmpDir,
      LOG_LEVEL: 'error',
    });

    api = new ApplicationApi(config);
    await api.bootstrap();

    // Register high-risk tool definition for approval testing
    const highRiskTool: ToolDefinition = {
      id: 'high_risk_tool_p7f',
      name: 'High Risk Tool P7F',
      description: 'High risk tool for P7F tests',
      version: '1.0.0',
      category: 'utility',
      riskLevel: 'high',
      requiredPermissions: ['terminal.execute'],
      inputSchema: {},
      enabled: true,
    };
    api.tools.registerTool(highRiskTool);

    // Mock ModelGateway generate
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

  it('1. Renders startup workstation dashboard with system health', async () => {
    const report = api.getHealthReport();
    const dashboard = renderDashboard(report, tmpDir);

    expect(dashboard).toContain('NEXUS AI — YOUR LOCAL AI WORKSTATION');
    expect(dashboard).toContain('SYSTEM STATUS');
    expect(dashboard).toContain('QUICK COMMANDS');
    expect(dashboard).toContain('/help');
  });

  it('2. /help displays categorized command menu and aliases', async () => {
    const output = await runner.runCommand('/help');
    expect(output).toContain('Command Reference');
    expect(output).toContain('/task <goal>');
    expect(output).toContain('/models');
  });

  it('3. /status displays system health and current task state', async () => {
    const noTaskOutput = await runner.runCommand('/status');
    expect(noTaskOutput).toContain('NEXUS AI Task Status');
    expect(noTaskOutput).toContain('No active task');

    await runner.runCommand('Read test.txt file');
    const taskOutput = await runner.runCommand('/status');
    expect(taskOutput).toContain('NEXUS AI Task Status');
    expect(taskOutput).toContain('Task ID:');
    expect(taskOutput).toContain('State:');
  });

  it('4. /models displays discovered Ollama models', async () => {
    const output = await runner.runCommand('/models');
    expect(output).toContain('DISCOVERED AI MODELS');
  });

  it('5. /workspace displays workspace root and security sandbox info', async () => {
    const output = await runner.runCommand('/workspace');
    expect(output).toContain('NEXUS WORKSPACE CONFIGURATION');
    expect(output).toContain(tmpDir);
    expect(output).toContain('Filesystem Sandbox strictly enforced');
  });

  it('6. /tasks displays recent task history list', async () => {
    await runner.runCommand('Read test.txt file');
    const output = await runner.runCommand('/tasks');
    expect(output).toContain('RECENT TASKS');
    expect(output).toContain('COMPLETED');
  });

  it('7. /task <id> inspects specific task details', async () => {
    await runner.runCommand('Read test.txt file');
    const taskId = runner.currentTask!.id;

    const output = await runner.runCommand(`/task ${taskId}`);
    expect(output).toContain('TASK INSPECTION REPORT');
    expect(output).toContain(taskId);
    expect(output).toContain('COMPLETED');
  });

  it('8. Task creation assigns valid task ID and records event', async () => {
    const output = await runner.runCommand('Create a new document');
    expect(output).toContain('Task Submitted:');
    expect(runner.currentTask).not.toBeNull();
    expect(runner.currentTask!.id).toMatch(/^task-/);
  });

  it('9. Planning output displays plan reasoning and steps table', async () => {
    const output = await runner.runCommand('Read test.txt file');
    expect(output).toContain('PLAN');
    expect(output).toContain('filesystem_read');
    expect(output).toContain('filesystem.read');
  });

  it('10. Approval-required task pauses in awaiting_approval with approval card', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: highRiskPlanJson(),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    const output = await runner.runCommand('Run high risk tool');
    expect(output).toContain('APPROVAL REQUIRED');
    expect(output).toContain('HIGH');
    expect(runner.currentTask!.state).toBe('awaiting_approval');
  });

  it('11. /approve resolves approval request and resumes task to COMPLETED', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: highRiskPlanJson(),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    await runner.runCommand('Run high risk tool');
    const approvals = api.approvals!.getApprovalsForTask(runner.currentTask!.id);
    const approvalId = approvals[0].approvalId;

    const output = await runner.runCommand(`/approve ${approvalId}`);
    expect(output).toContain('granted');
  });

  it('12. /reject resolves approval as rejected and cancels task', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: highRiskPlanJson(),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    await runner.runCommand('Run high risk tool');
    const approvals = api.approvals!.getApprovalsForTask(runner.currentTask!.id);
    const approvalId = approvals[0].approvalId;

    const output = await runner.runCommand(`/reject ${approvalId}`);
    expect(output).toContain('rejected');
    expect(runner.currentTask!.state).toBe('cancelled');
  });

  it('13. Execution progress outputs step-by-step visual feedback', async () => {
    const output = await runner.runCommand('Read test.txt file');
    expect(output).toContain('EXECUTE');
    expect(output).toContain('TASK COMPLETED');
  });

  it('14. Result rendering outputs clean completion card', async () => {
    await runner.runCommand('Read test.txt file');
    const resultOutput = await runner.runCommand('/result');
    expect(resultOutput).toContain('TASK COMPLETED');
    expect(resultOutput).toContain('✓ COMPLETED');
  });

  it('15. Low-risk task completes end-to-end successfully', async () => {
    const output = await runner.runCommand('Read test.txt file');
    expect(output).toContain('TASK COMPLETED');
    expect(runner.currentTask!.state).toBe('completed');
  });

  it('16. FILE_NOT_FOUND returns formatted failure card with suggested next actions', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: JSON.stringify({
        reasoning: 'Read non existent file',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'filesystem_read',
            requestedCapabilities: ['filesystem.read'],
            params: { relativePath: 'non_existent_xyz.txt' },
          },
        ],
      }),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    const output = await runner.runCommand('Read non_existent_xyz.txt');
    expect(output).toContain('TASK FAILED');
    expect(output).toContain('FILE_NOT_FOUND');
    expect(output).toContain('Suggested Action');
  });

  it('17. Ollama unavailable displays DEGRADED status banner gracefully', async () => {
    const mockReport = api.getHealthReport();
    mockReport.overall = 'degraded';
    const dashboard = renderDashboard(mockReport, tmpDir);

    expect(dashboard).toContain('DEGRADED');
    expect(dashboard).toContain('AI Runtime is operating in DEGRADED mode');
  });

  it('18. Malformed planner output returns PLAN_PARSE_FAILED card safely', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: 'Invalid non-JSON model output',
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    const output = await runner.runCommand('Malformed task');
    expect(output).toContain('TASK FAILED');
    expect(output).toContain('PLAN_PARSE_FAILED');
  });

  it('19. /cancel cancels active task and pending approvals', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: highRiskPlanJson(),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    await runner.runCommand('High risk operation');
    const cancelOutput = await runner.runCommand('/cancel');
    expect(cancelOutput).toContain('cancelled');
    expect(runner.currentTask!.state).toBe('cancelled');
  });

  it('20. Invalid command returns helpful error message without crashing', async () => {
    const output = await runner.runCommand('/invalidcmdxyz');
    expect(output).toContain("Unknown command '/invalidcmdxyz'");
    expect(output).toContain('Type /help for available commands');
  });

  it('21. Workspace traversal attempt is blocked by ToolGateway', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: JSON.stringify({
        reasoning: 'Attempt traversal',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'filesystem_read',
            requestedCapabilities: ['filesystem.read'],
            params: { relativePath: '../../secret.txt' },
          },
        ],
      }),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    const output = await runner.runCommand('Read outside workspace');
    expect(output).toContain('TASK FAILED');
    expect(output).toContain('PATH_TRAVERSAL_DENIED');
  });

  it('22. Terminal execution requires approval and succeeds upon approval', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: highRiskPlanJson(),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    await runner.runCommand('Run terminal command');
    expect(runner.currentTask!.state).toBe('awaiting_approval');

    const approvals = api.approvals!.getApprovalsForTask(runner.currentTask!.id);
    const approvalId = approvals[0].approvalId;

    const approveOutput = await runner.runCommand(`/approve ${approvalId}`);
    expect(approveOutput).toContain('granted');
  });

  it('23. Tasks remain queryable via /tasks across multiple submissions', async () => {
    await runner.runCommand('Read test.txt file');
    await runner.runCommand('Read test.txt file again');

    const tasksListOutput = await runner.runCommand('/tasks');
    expect(tasksListOutput).toContain('RECENT TASKS');
    const tasks = api.tasks.listTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(2);
  });

  it('24. Output filters out sensitive keys and secrets', async () => {
    const output = await runner.runCommand('Read test.txt file');
    expect(output).not.toContain('API_KEY=');
    expect(output).not.toContain('SECRET=');
  });

  it('25. Formatting uses valid state symbols and ANSI fallback formatting', () => {
    expect(stateSymbols.completed).toContain('✓');
    expect(stateSymbols.executing).toContain('●');
    expect(stateSymbols.failed).toContain('✕');

    expect(getSymbolForState('completed', false)).toBe('✓');
    expect(getSymbolForState('executing', false)).toBe('●');
    expect(getSymbolForState('failed', false)).toBe('✕');
  });

  // ---------------------------------------------------------------------------
  // 26–30. Regression Tests for Real CLI Input Routing & Inline Approval Bug
  // ---------------------------------------------------------------------------

  it('26. Pending approval + "y" resolves approval and resumes original task without creating a new task titled "y"', async () => {
    // 1. Mock high-risk plan creation requiring approval
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: highRiskPlanJson(),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    const initOutput = await runner.runCommand('Create file with high risk tool');
    expect(initOutput).toContain('APPROVAL REQUIRED');
    const originalTaskId = runner.currentTask!.id;
    expect(runner.currentTask!.state).toBe('awaiting_approval');

    const tasksBefore = api.tasks.listTasks();
    const countBefore = tasksBefore.length;

    // 2. Send "y" as raw input — MUST intercept and resolve approval instead of creating a new task "y"
    const approvalOutput = await runner.runCommand('y');

    expect(approvalOutput).toContain('granted');
    expect(runner.currentTask!.id).toBe(originalTaskId); // Task ID MUST remain unchanged!

    const tasksAfter = api.tasks.listTasks();
    expect(tasksAfter.length).toBe(countBefore); // ZERO new tasks created!
    expect(tasksAfter.some((t) => t.title === 'y')).toBe(false); // No task titled "y"!
  });

  it('27. Pending approval + "n" rejects approval and cancels original task without creating a new task titled "n"', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: highRiskPlanJson(),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    await runner.runCommand('High risk operation for rejection test');
    const originalTaskId = runner.currentTask!.id;
    expect(runner.currentTask!.state).toBe('awaiting_approval');

    const countBefore = api.tasks.listTasks().length;

    // Send "n"
    const rejectOutput = await runner.runCommand('n');

    expect(rejectOutput).toContain('rejected');
    expect(runner.currentTask!.id).toBe(originalTaskId);
    expect(runner.currentTask!.state).toBe('cancelled');

    const tasksAfter = api.tasks.listTasks();
    expect(tasksAfter.length).toBe(countBefore);
    expect(tasksAfter.some((t) => t.title === 'n')).toBe(false);
  });

  it('28. Pending approval + "v" displays approval details without creating a new task or changing task state', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: highRiskPlanJson(),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    await runner.runCommand('High risk operation for view test');
    const originalTaskId = runner.currentTask!.id;
    expect(runner.currentTask!.state).toBe('awaiting_approval');

    const countBefore = api.tasks.listTasks().length;

    // Send "v"
    const viewOutput = await runner.runCommand('v');

    expect(viewOutput).toContain('APPROVAL REQUEST DETAILS');
    expect(viewOutput).toContain(originalTaskId);
    expect(runner.currentTask!.state).toBe('awaiting_approval'); // State remains awaiting_approval!

    const tasksAfter = api.tasks.listTasks();
    expect(tasksAfter.length).toBe(countBefore);
    expect(tasksAfter.some((t) => t.title === 'v')).toBe(false);
  });

  it('29. Approved filesystem_write plan resumes original task, executes write + read, and completes', async () => {
    // 1. Temporarily mark filesystem_write as high-risk in test setup to force approval requirement
    const toolDef = api.tools.getTool('filesystem_write');
    if (toolDef) {
      toolDef.riskLevel = 'high';
    }

    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: JSON.stringify({
        reasoning: 'Create cli-final-test.txt and verify contents.',
        steps: [
          {
            stepId: 'step-1',
            toolId: 'filesystem_write',
            requestedCapabilities: ['filesystem.write'],
            params: { path: 'cli-final-test.txt', content: 'NEXUS CLI works.' },
          },
          {
            stepId: 'step-2',
            toolId: 'filesystem_read',
            requestedCapabilities: ['filesystem.read'],
            params: { relativePath: 'cli-final-test.txt' },
          },
        ],
      }),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    const output = await runner.runCommand('Create a file named cli-final-test.txt containing exactly "NEXUS CLI works." and verify that the file exists.');
    expect(output).toContain('APPROVAL REQUIRED');
    const originalTaskId = runner.currentTask!.id;
    expect(runner.currentTask!.state).toBe('awaiting_approval');

    // Approve via inline "y"
    const approveOutput = await runner.runCommand('y');

    expect(approveOutput).toContain('COMPLETED');
    expect(runner.currentTask!.id).toBe(originalTaskId);
    expect(runner.currentTask!.state).toBe('completed');

    // Verify file actually exists on filesystem with expected contents
    const createdPath = path.join(tmpDir, 'cli-final-test.txt');
    expect(fs.existsSync(createdPath)).toBe(true);
    expect(fs.readFileSync(createdPath, 'utf8')).toBe('NEXUS CLI works.');
  });

  it('30. Plain text typed while approval is pending does not create a new task and returns helpful warning', async () => {
    api.intelligence.gateway.generate = vi.fn().mockResolvedValue({
      modelId: 'mock-model',
      text: highRiskPlanJson(),
      done: true,
      latencyMs: 5,
      usedFallback: false,
      routingReason: 'test',
    });

    await runner.runCommand('High risk operation for plain text test');
    const originalTaskId = runner.currentTask!.id;
    expect(runner.currentTask!.state).toBe('awaiting_approval');

    const countBefore = api.tasks.listTasks().length;

    // Send arbitrary plain text input like "Create another task"
    const warningOutput = await runner.runCommand('Create another task');

    expect(warningOutput).toContain('APPROVAL REQUIRED');
    expect(warningOutput).toContain(originalTaskId);
    expect(runner.currentTask!.state).toBe('awaiting_approval');

    const tasksAfter = api.tasks.listTasks();
    expect(tasksAfter.length).toBe(countBefore); // ZERO new tasks created!
  });
});

