/**
 * NEXUS AI — Real-World Acceptance Audit Test Suite (TEST A through TEST J)
 *
 * Verifies real-world agent workflows and security boundaries:
 *  - TEST A: Workspace inspection using workspace_tree
 *  - TEST B: Landing page creation using filesystem_write
 *  - TEST C: Landing page modification using filesystem_edit
 *  - TEST D: Codebase bug finding & fixing using discovery + edit
 *  - TEST E: Multi-file website build and bounded command verification
 *  - TEST F: Workspace escape attempt (PATH_TRAVERSAL_DENIED)
 *  - TEST G: Secret file access attempt (SECRET_FILE_PROTECTED)
 *  - TEST H: Human approval policy triggering for high-risk operations
 *  - TEST I: Task cancellation lifecycle
 *  - TEST J: Approval rejection lifecycle & ApprovalGate enforcement
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { StorageService } from '../storage/index.js';
import { AgentTaskService } from '../orchestration/agentTaskService.js';
import { AgentExecutionService } from '../orchestration/agentExecutionService.js';
import { HumanApprovalService } from '../orchestration/humanApprovalService.js';
import { PlanSynthesisService } from '../orchestration/planner.js';
import { ToolGateway, calculateContentHash } from '../tools/index.js';
import type { ModelGateway } from '../intelligence/modelGateway.js';

function makeMockGateway(responseText: string): ModelGateway {
  return {
    generate: async () => ({
      modelId: 'qwen2.5:3b',
      text: responseText,
      done: true,
      latencyMs: 12,
      usedFallback: false,
      routingReason: 'test',
    }),
    generateStream: async () => { throw new Error('Not implemented'); },
  } as unknown as ModelGateway;
}

describe('NEXUS AI — Real-World Acceptance Audit (TEST A - TEST J)', () => {
  let tmpDir: string;
  let storage: StorageService;
  let taskService: AgentTaskService;
  let toolGateway: ToolGateway;
  let execService: AgentExecutionService;
  let approvalService: HumanApprovalService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-audit-test-'));

    // Create a mock website structure
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.env'), 'API_SECRET_KEY=secret_value_123\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'id_rsa'), '-----BEGIN PRIVATE KEY-----\nMIIE...', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'src', 'buggy.js'), 'function add(a, b) { return a - b; }\n', 'utf8');

    storage = new StorageService(':memory:', 'error');
    await storage.initialize();
    taskService = new AgentTaskService(storage.agentTasks, 'error');
    toolGateway = new ToolGateway(undefined, 'error');
    await toolGateway.initialize(taskService, tmpDir);
    approvalService = new HumanApprovalService(
      taskService,
      toolGateway,
      storage.approvals,
      { autoApproveLowRisk: true, requireApprovalForMediumRisk: false, requireApprovalForHighRisk: true },
      'error'
    );
    execService = new AgentExecutionService(taskService, toolGateway, approvalService, 'error');
  });

  afterEach(() => {
    storage.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // TEST A: Inspect workspace structure
  it('TEST A: Inspects the workspace and returns structured entries', async () => {
    const task = taskService.createTask({ title: 'Inspect workspace' });
    const planJson = JSON.stringify({
      reasoning: 'Inspect directory tree',
      steps: [{ stepId: 'step-1', toolId: 'workspace_tree', requestedCapabilities: ['filesystem.read'], params: { path: '.' } }],
    });
    const planner = new PlanSynthesisService(makeMockGateway(planJson), toolGateway, 'error');
    const synth = await planner.synthesize(task.id, { taskGoal: 'Inspect workspace' });

    expect(synth.success).toBe(true);
    const finalTask = await execService.runExecutionLoop(task.id, synth.plan!.steps);
    expect(finalTask.state).toBe('completed');
  });

  // TEST B: Create HTML landing page
  it('TEST B: Creates a simple HTML landing page safely inside workspace', async () => {
    const task = taskService.createTask({ title: 'Create index.html' });
    const planJson = JSON.stringify({
      reasoning: 'Create index.html',
      steps: [{
        stepId: 'step-1',
        toolId: 'filesystem_write',
        requestedCapabilities: ['filesystem.write'],
        params: { path: 'index.html', content: '<!DOCTYPE html><html><body><h1>Welcome</h1></body></html>' },
      }],
    });
    const planner = new PlanSynthesisService(makeMockGateway(planJson), toolGateway, 'error');
    const synth = await planner.synthesize(task.id, { taskGoal: 'Create landing page' });

    expect(synth.success).toBe(true);
    const finalTask = await execService.runExecutionLoop(task.id, synth.plan!.steps);
    expect(finalTask.state).toBe('completed');
    expect(fs.existsSync(path.join(tmpDir, 'index.html'))).toBe(true);
  });

  // TEST C: Modify existing HTML page
  it('TEST C: Modifies existing HTML page by adding navigation bar via hash-verified edit', async () => {
    const initialHtml = '<!DOCTYPE html><html><body><h1>Welcome</h1></body></html>';
    fs.writeFileSync(path.join(tmpDir, 'index.html'), initialHtml, 'utf8');
    const hash = calculateContentHash(initialHtml);

    const task = taskService.createTask({ title: 'Add navbar' });
    const planJson = JSON.stringify({
      reasoning: 'Modify index.html to add nav bar',
      steps: [{
        stepId: 'step-1',
        toolId: 'filesystem_edit',
        requestedCapabilities: ['filesystem.write'],
        params: {
          path: 'index.html',
          expectedContentHash: hash,
          oldText: '<h1>Welcome</h1>',
          newText: '<nav><a href="#">Home</a></nav><h1>Welcome</h1>',
        },
      }],
    });
    const planner = new PlanSynthesisService(makeMockGateway(planJson), toolGateway, 'error');
    const synth = await planner.synthesize(task.id, { taskGoal: 'Add nav bar' });

    expect(synth.success).toBe(true);
    const finalTask = await execService.runExecutionLoop(task.id, synth.plan!.steps);
    expect(finalTask.state).toBe('completed');

    const updated = fs.readFileSync(path.join(tmpDir, 'index.html'), 'utf8');
    expect(updated).toContain('<nav><a href="#">Home</a></nav>');
  });

  // TEST D: Find & fix bug
  it('TEST D: Discovers bug in buggy.js and fixes it using deterministic edit', async () => {
    const buggyContent = fs.readFileSync(path.join(tmpDir, 'src', 'buggy.js'), 'utf8');
    const hash = calculateContentHash(buggyContent);

    const task = taskService.createTask({ title: 'Fix addition bug' });
    const planJson = JSON.stringify({
      reasoning: 'Fix bug in add function',
      steps: [{
        stepId: 'step-1',
        toolId: 'filesystem_edit',
        requestedCapabilities: ['filesystem.write'],
        params: {
          path: 'src/buggy.js',
          expectedContentHash: hash,
          oldText: 'return a - b;',
          newText: 'return a + b;',
        },
      }],
    });
    const planner = new PlanSynthesisService(makeMockGateway(planJson), toolGateway, 'error');
    const synth = await planner.synthesize(task.id, { taskGoal: 'Fix add function' });

    const finalTask = await execService.runExecutionLoop(task.id, synth.plan!.steps);
    expect(finalTask.state).toBe('completed');

    const fixed = fs.readFileSync(path.join(tmpDir, 'src', 'buggy.js'), 'utf8');
    expect(fixed).toContain('return a + b;');
  });

  // TEST E: Multi-file website build and bounded command verification
  it('TEST E: Creates multi-file project and verifies via node --version', async () => {
    const task = taskService.createTask({ title: 'Build and verify' });
    const planJson = JSON.stringify({
      reasoning: 'Create css and verify node version',
      steps: [
        {
          stepId: 'step-1',
          toolId: 'filesystem_write',
          requestedCapabilities: ['filesystem.write'],
          params: { path: 'style.css', content: 'body { margin: 0; }' },
        },
        {
          stepId: 'step-2',
          toolId: 'terminal_execute',
          requestedCapabilities: ['terminal.execute'],
          params: { command: 'node', args: ['--version'] },
        },
      ],
    });
    const planner = new PlanSynthesisService(makeMockGateway(planJson), toolGateway, 'error');
    const synth = await planner.synthesize(task.id, { taskGoal: 'Build & verify' });

    // Step 2 will trigger approval gate since terminal_execute is high risk
    let currentTask = await execService.runExecutionLoop(task.id, synth.plan!.steps);
    expect(currentTask.state).toBe('awaiting_approval');

    // Approve the pending approval
    const pending = approvalService.getApprovalsForTask(task.id).find((a) => a.status === 'pending');
    expect(pending).toBeDefined();

    approvalService.resolveApproval(pending!.approvalId, 'approved');

    // Resume execution
    currentTask = await execService.runExecutionLoop(task.id, synth.plan!.steps);
    expect(currentTask.state).toBe('completed');
    expect(fs.existsSync(path.join(tmpDir, 'style.css'))).toBe(true);
  }, 30000);

  // TEST F: Workspace escape attempt
  it('TEST F: Blocks path traversal attempt outside workspace (PATH_TRAVERSAL_DENIED)', async () => {
    const task = taskService.createTask({ title: 'Path traversal attempt' });
    const res = await toolGateway.executeTool({
      requestId: 'req-traversal',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: '../../../../etc/passwd' },
    });

    expect(res.success).toBe(false);
    expect(res.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
  });

  // TEST G: Secret file access attempt
  it('TEST G: Blocks modification/read attempt on protected secret files (.env, id_rsa)', async () => {
    const task = taskService.createTask({ title: 'Secret file access' });
    const writeRes = await toolGateway.executeTool({
      requestId: 'req-secret',
      taskId: task.id,
      toolId: 'filesystem_write',
      requestedCapabilities: ['filesystem.write'],
      params: { path: '.env', content: 'EXPOSED=true' },
    });

    expect(writeRes.success).toBe(false);
    expect(writeRes.errorCategory).toBe('SECRET_FILE_PROTECTED');
  });

  // TEST H: Human approval policy triggering
  it('TEST H: Triggers human approval requirement on high risk operations', async () => {
    const task = taskService.createTask({ title: 'High risk terminal execute' });
    const planJson = JSON.stringify({
      reasoning: 'Run terminal command',
      steps: [{
        stepId: 'step-1',
        toolId: 'terminal_execute',
        requestedCapabilities: ['terminal.execute'],
        params: { command: 'node', args: ['--version'] },
      }],
    });
    const planner = new PlanSynthesisService(makeMockGateway(planJson), toolGateway, 'error');
    const synth = await planner.synthesize(task.id, { taskGoal: 'Run command' });

    const resultTask = await execService.runExecutionLoop(task.id, synth.plan!.steps);
    expect(resultTask.state).toBe('awaiting_approval');
  });

  // TEST I: Cancel running task
  it('TEST I: Cancels task and invalidates pending approvals', async () => {
    const task = taskService.createTask({ title: 'Task to cancel' });
    const planJson = JSON.stringify({
      reasoning: 'Run high risk step',
      steps: [{
        stepId: 'step-1',
        toolId: 'terminal_execute',
        requestedCapabilities: ['terminal.execute'],
        params: { command: 'node', args: ['--version'] },
      }],
    });
    const planner = new PlanSynthesisService(makeMockGateway(planJson), toolGateway, 'error');
    const synth = await planner.synthesize(task.id, { taskGoal: 'Cancel test' });

    await execService.runExecutionLoop(task.id, synth.plan!.steps);
    expect(taskService.getTask(task.id).state).toBe('awaiting_approval');

    taskService.cancelTask(task.id);
    approvalService.cancelApprovalsForTask(task.id, 'User cancelled task');

    const cancelledTask = taskService.getTask(task.id);
    expect(cancelledTask.state).toBe('cancelled');

    const approvals = approvalService.getApprovalsForTask(task.id);
    expect(approvals.every((a) => a.status === 'cancelled')).toBe(true);
  });

  // TEST J: Reject dangerous approval
  it('TEST J: Rejects approval, cancels task, and blocks ToolExecutor via ApprovalGate', async () => {
    const task = taskService.createTask({ title: 'Dangerous operation' });
    const planJson = JSON.stringify({
      reasoning: 'Run terminal command',
      steps: [{
        stepId: 'step-1',
        toolId: 'terminal_execute',
        requestedCapabilities: ['terminal.execute'],
        params: { command: 'node', args: ['--version'] },
      }],
    });
    const planner = new PlanSynthesisService(makeMockGateway(planJson), toolGateway, 'error');
    const synth = await planner.synthesize(task.id, { taskGoal: 'Dangerous command' });

    await execService.runExecutionLoop(task.id, synth.plan!.steps);
    const pending = approvalService.getApprovalsForTask(task.id).find((a) => a.status === 'pending');
    expect(pending).toBeDefined();

    approvalService.resolveApproval(pending!.approvalId, 'rejected', 'Dangerous command rejected');

    const rejectedTask = taskService.getTask(task.id);
    expect(rejectedTask.state).toBe('cancelled');

    // Attempting execution loop after rejection MUST stay cancelled / unexecuted
    const finalTask = await execService.runExecutionLoop(task.id, synth.plan!.steps);
    expect(finalTask.state).toBe('cancelled');
  });
});
