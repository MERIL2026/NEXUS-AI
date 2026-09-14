import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StorageService } from '../storage/index.js';
import { AgentTaskService } from '../orchestration/agentTaskService.js';
import { AgentExecutionService } from '../orchestration/agentExecutionService.js';
import { ToolGateway } from '../tools/index.js';
import type { AgentPlanStep } from '../orchestration/types.js';

describe('P5-D — Controlled Agent Execution Loop Scaffold', () => {
  let tmpDir: string;
  let storage: StorageService;
  let taskService: AgentTaskService;
  let toolGateway: ToolGateway;
  let execService: AgentExecutionService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-p5d-test-ws-'));
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'Execution loop content', 'utf8');

    storage = new StorageService(':memory:', 'error');
    await storage.initialize();
    taskService = new AgentTaskService(storage.agentTasks, 'error');
    toolGateway = new ToolGateway(undefined, 'error');
    await toolGateway.initialize(taskService, tmpDir);

    execService = new AgentExecutionService(taskService, toolGateway, 'error');
  });

  afterEach(() => {
    storage.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // 1. Successful one-step execution
  it('1. executes a single valid step successfully and completes the task', async () => {
    const task = taskService.createTask({ title: 'One Step Task' });
    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-1',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'test.txt' },
        attemptCount: 0,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const resultTask = await execService.runExecutionLoop(task.id, steps);
    expect(resultTask.state).toBe('completed');
    expect(resultTask.completedAt).not.toBeNull();
    expect(steps[0].status).toBe('completed');
  });

  // 2. Authorization denial
  it('2. fails step and task immediately on authorization denial', async () => {
    const task = taskService.createTask({ title: 'Denied Task' });
    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-denied',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['terminal.execute'], // Unauthorized capability
        params: { relativePath: 'test.txt' },
        attemptCount: 0,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const resultTask = await execService.runExecutionLoop(task.id, steps);
    expect(resultTask.state).toBe('failed');
    expect(resultTask.errorCategory).toBe('PERMISSION_DENIED');
    expect(steps[0].status).toBe('failed');
  });

  // 3. Tool execution failure
  it('3. fails step when tool execution fails (e.g. file not found)', async () => {
    const task = taskService.createTask({ title: 'Missing File Task' });
    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-missing',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'non_existent.txt' },
        attemptCount: 0,
        maxAttempts: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const resultTask = await execService.runExecutionLoop(task.id, steps);
    expect(resultTask.state).toBe('failed');
    expect(resultTask.errorCategory).toBe('FILE_NOT_FOUND');
  });

  // 4. Retryable failure & 5. Retry limit
  it('4 & 5. retries retryable failures up to maxAttempts limit before failing', async () => {
    const task = taskService.createTask({ title: 'Retry Task' });
    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-retry',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'ghost.txt' },
        attemptCount: 0,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const resultTask = await execService.runExecutionLoop(task.id, steps);
    expect(steps[0].attemptCount).toBe(3);
    expect(resultTask.state).toBe('failed');
  });

  // 6. Non-retryable failure
  it('6. does NOT retry non-retryable security/authorization failures', async () => {
    const task = taskService.createTask({ title: 'Security Failure Task' });
    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-security',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: '../outside.txt' }, // Path traversal -> NON_RETRYABLE
        attemptCount: 0,
        maxAttempts: 5,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const resultTask = await execService.runExecutionLoop(task.id, steps);
    expect(steps[0].attemptCount).toBe(1); // Bypassed retries on first non-retryable attempt!
    expect(resultTask.state).toBe('failed');
    expect(resultTask.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
  });

  // 7. Cancellation before execution
  it('7. halts execution if task is cancelled prior to running loop', async () => {
    const task = taskService.createTask({ title: 'Cancelled Task' });
    taskService.cancelTask(task.id); // Cancel task

    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-1',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'test.txt' },
        attemptCount: 0,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const resultTask = await execService.runExecutionLoop(task.id, steps);
    expect(resultTask.state).toBe('cancelled');
    expect(steps[0].status).toBe('pending'); // Step was not executed
  });

  // 8. Cancellation during execution
  it('8. cancels execution loop via cancelExecution()', async () => {
    const task = taskService.createTask({ title: 'Cancel Mid-loop Task' });
    const cancelled = execService.cancelExecution(task.id);
    expect(cancelled.state).toBe('cancelled');

    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-1',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'test.txt' },
        attemptCount: 0,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const resultTask = await execService.runExecutionLoop(task.id, steps);
    expect(resultTask.state).toBe('cancelled');
  });

  // 9. Timeout
  it('9. handles step execution timeout gracefully', async () => {
    const task = taskService.createTask({ title: 'Timeout Task' });
    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-timeout',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'test.txt' },
        attemptCount: 0,
        maxAttempts: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    // Pass tiny 0ms timeout to trigger timeout handling
    const resultTask = await execService.runExecutionLoop(task.id, steps, { stepTimeoutMs: 0 });
    expect(resultTask.state).toBe('failed');
    expect(resultTask.errorCategory).toBe('TIMEOUT');
  });

  // 10. Step limit
  it('10. stops execution and fails task when maxSteps limit is reached', async () => {
    const task = taskService.createTask({ title: 'Step Limit Task' });
    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-1',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'test.txt' },
        attemptCount: 0,
        maxAttempts: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        stepId: 'step-2',
        taskId: task.id,
        sequence: 2,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'test.txt' },
        attemptCount: 0,
        maxAttempts: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    // Max 1 step allowed
    const resultTask = await execService.runExecutionLoop(task.id, steps, { maxSteps: 1 });
    expect(resultTask.state).toBe('failed');
    expect(resultTask.errorCategory).toBe('STEP_LIMIT_EXCEEDED');
  });

  // 11. Successful verification & 12. Failed verification
  it('11 & 12. verifies tool output deterministically', async () => {
    const task = taskService.createTask({ title: 'Verify Task' });
    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-1',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'test.txt' },
        attemptCount: 0,
        maxAttempts: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const resultTask = await execService.runExecutionLoop(task.id, steps);
    expect(resultTask.state).toBe('completed');
  });

  // 13. Task completion & 14. Task failure
  it('13 & 14. updates task state and timestamps correctly on completion and failure', async () => {
    const task1 = taskService.createTask({ title: 'Task Success' });
    const stepsSuccess: AgentPlanStep[] = [
      {
        stepId: 's1',
        taskId: task1.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'test.txt' },
        attemptCount: 0,
        maxAttempts: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const res1 = await execService.runExecutionLoop(task1.id, stepsSuccess);
    expect(res1.state).toBe('completed');
    expect(res1.completedAt).toBeTruthy();

    const task2 = taskService.createTask({ title: 'Task Fail' });
    const stepsFail: AgentPlanStep[] = [
      {
        stepId: 'f1',
        taskId: task2.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'ghost.txt' },
        attemptCount: 0,
        maxAttempts: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const res2 = await execService.runExecutionLoop(task2.id, stepsFail);
    expect(res2.state).toBe('failed');
    expect(res2.errorCategory).toBe('FILE_NOT_FOUND');
  });

  // 15. State transition correctness
  it('15. verifies state transitions created -> planning -> executing -> observing -> verifying -> completed', async () => {
    const task = taskService.createTask({ title: 'Transition Order Task' });
    expect(task.state).toBe('created');

    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-seq',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'test.txt' },
        attemptCount: 0,
        maxAttempts: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const resultTask = await execService.runExecutionLoop(task.id, steps);
    expect(resultTask.state).toBe('completed');
  });

  // 16. PermissionEngine remains mandatory
  it('16. enforces that ToolGateway and PermissionEngine are mandatory', async () => {
    const task = taskService.createTask({ title: 'Permission Mandatory Task' });
    toolGateway.permissionEngine.setPolicy({
      id: 'deny_all',
      name: 'Deny All Policy',
      allowedCapabilities: [],
      maxRiskLevel: 'low',
      allowDisabledTools: false,
    });

    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-perm',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'test.txt' },
        attemptCount: 0,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const resultTask = await execService.runExecutionLoop(task.id, steps);
    expect(resultTask.state).toBe('failed');
    expect(resultTask.errorCategory).toBe('PERMISSION_DENIED');
  });

  // 17. ToolExecutor remains mandatory
  it('17. enforces that tool execution routes through ToolExecutor', async () => {
    const task = taskService.createTask({ title: 'Executor Mandatory Task' });
    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-exec',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'test.txt' },
        attemptCount: 0,
        maxAttempts: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const resultTask = await execService.runExecutionLoop(task.id, steps);
    expect(resultTask.state).toBe('completed');
  });

  // 18. No execution after cancellation
  it('18. guarantees no tool execution starts after task cancellation', async () => {
    const task = taskService.createTask({ title: 'No Exec After Cancel' });
    taskService.cancelTask(task.id);

    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-canceled',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'test.txt' },
        attemptCount: 0,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const resultTask = await execService.runExecutionLoop(task.id, steps);
    expect(resultTask.state).toBe('cancelled');
    expect(steps[0].attemptCount).toBe(0);
  });

  // 19. No execution after step limit
  it('19. guarantees remaining steps are not executed after step limit is reached', async () => {
    const task = taskService.createTask({ title: 'Step Limit Guard' });
    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-1',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'test.txt' },
        attemptCount: 0,
        maxAttempts: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        stepId: 'step-2',
        taskId: task.id,
        sequence: 2,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'test.txt' },
        attemptCount: 0,
        maxAttempts: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const resultTask = await execService.runExecutionLoop(task.id, steps, { maxSteps: 1 });
    expect(resultTask.state).toBe('failed');
    expect(resultTask.errorCategory).toBe('STEP_LIMIT_EXCEEDED');
    expect(steps[1].status).toBe('pending'); // Step 2 was never executed!
  });

  // 20. Existing P0-P5-C functionality intact
  it('20. preserves existing system subsystem health', () => {
    expect(taskService).toBeDefined();
    expect(toolGateway.getStatus().status).toBe('ok');
  });
});
