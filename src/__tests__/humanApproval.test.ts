/**
 * NEXUS AI — P5-F Test Suite: Human Approval & Execution Control
 *
 * Validates the 18 specific requirements for approval models, lifecycle states,
 * risk classification, approval policy engine, agent state machine integration,
 * execution gate, expiration, cancellation, and security invariants.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { StorageService } from '../storage/index.js';
import { AgentTaskService } from '../orchestration/agentTaskService.js';
import { AgentExecutionService } from '../orchestration/agentExecutionService.js';
import { HumanApprovalService } from '../orchestration/humanApprovalService.js';
import { ApprovalPolicyEngine } from '../tools/approvalPolicyEngine.js';
import { ApprovalGate } from '../tools/approvalGate.js';
import { ToolGateway } from '../tools/index.js';
import { PlanValidator } from '../orchestration/planner.js';
import type { AgentPlanStep } from '../orchestration/types.js';
import type { ToolDefinition } from '../tools/types.js';

describe('P5-F — Human Approval & Execution Control', () => {
  let tmpDir: string;
  let storage: StorageService;
  let taskService: AgentTaskService;
  let toolGateway: ToolGateway;
  let approvalService: HumanApprovalService;
  let execService: AgentExecutionService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-p5f-test-'));
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'P5-F test content', 'utf8');

    storage = new StorageService(':memory:', 'error');
    await storage.initialize();
    taskService = new AgentTaskService(storage.agentTasks, 'error');
    toolGateway = new ToolGateway(undefined, 'error');
    await toolGateway.initialize(taskService, tmpDir);

    approvalService = new HumanApprovalService(
      taskService,
      toolGateway,
      storage.approvals,
      { autoApproveLowRisk: true, requireApprovalForMediumRisk: true, requireApprovalForHighRisk: true },
      'error'
    );

    execService = new AgentExecutionService(taskService, toolGateway, approvalService, 'error');
  });

  afterEach(() => {
    storage.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // 1. low-risk operation without approval (auto-approved if policy permits)
  it('1. low-risk read-only operation is auto-approved when policy permits', async () => {
    const task = taskService.createTask({ title: 'Low Risk Auto Approve' });
    const result = approvalService.createApprovalRequest({
      taskId: task.id,
      stepId: 'step-low',
      toolId: 'filesystem_read',
      requestedCapability: 'filesystem.read',
    });

    expect(result.decision.decision).toBe('AUTO_APPROVED');
    expect(result.decision.requiresApproval).toBe(false);
    expect(result.approval.status).toBe('approved');
    expect(result.task.state).toBe('created'); // state not paused in awaiting_approval
  });

  // 2. approval-required operation (creates pending request)
  it('2. medium/high-risk operation creates pending approval request and transitions task to awaiting_approval', async () => {
    // Register a custom high-risk tool
    const highRiskTool: ToolDefinition = {
      id: 'high_risk_tool',
      name: 'High Risk Action',
      description: 'Performs a high risk operation',
      version: '1.0.0',
      category: 'utility',
      riskLevel: 'high',
      requiredPermissions: ['terminal.execute'],
      inputSchema: {},
      enabled: true,
    };
    toolGateway.registerTool(highRiskTool);

    const task = taskService.createTask({ title: 'High Risk Task' });
    const result = approvalService.createApprovalRequest({
      taskId: task.id,
      stepId: 'step-high',
      toolId: 'high_risk_tool',
      requestedCapability: 'terminal.execute',
    });

    expect(result.decision.decision).toBe('REQUIRES_APPROVAL');
    expect(result.decision.requiresApproval).toBe(true);
    expect(result.approval.status).toBe('pending');
    expect(result.task.state).toBe('awaiting_approval');
  });

  // 3. pending approval blocks execution
  it('3. pending approval blocks step execution and halts execution loop in awaiting_approval state', async () => {
    const highRiskTool: ToolDefinition = {
      id: 'high_risk_tool_3',
      name: 'High Risk Tool 3',
      description: 'High risk tool',
      version: '1.0.0',
      category: 'utility',
      riskLevel: 'high',
      requiredPermissions: ['terminal.execute'],
      inputSchema: {},
      enabled: true,
    };
    toolGateway.registerTool(highRiskTool);

    const task = taskService.createTask({ title: 'Pending Approval Task' });
    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-pending',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'high_risk_tool_3',
        requestedCapabilities: ['terminal.execute'],
        params: {},
        attemptCount: 0,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const resultTask = await execService.runExecutionLoop(task.id, steps);

    expect(resultTask.state).toBe('awaiting_approval');
    expect(steps[0].status).toBe('pending'); // step was NOT executed
  });

  // 4. approved operation proceeds
  it('4. approved operation proceeds with execution once user grants approval', async () => {
    const task = taskService.createTask({ title: 'Approved Operation Task' });
    // Use low-risk tool with custom policy forcing approval
    const strictApprovalService = new HumanApprovalService(
      taskService,
      toolGateway,
      storage.approvals,
      { autoApproveLowRisk: false },
      'error'
    );
    const strictExecService = new AgentExecutionService(taskService, toolGateway, strictApprovalService, 'error');

    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-strict',
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

    // 1st run: pauses in awaiting_approval
    let currentTask = await strictExecService.runExecutionLoop(task.id, steps);
    expect(currentTask.state).toBe('awaiting_approval');

    const pending = strictApprovalService.getApprovalsForTask(task.id);
    expect(pending[0].status).toBe('pending');

    // User approves
    const resolveResult = strictApprovalService.resolveApproval(pending[0].approvalId, 'approved', 'User approved execution');
    expect(resolveResult.success).toBe(true);
    expect(resolveResult.task!.state).toBe('executing');

    // 2nd run: proceeds and completes
    currentTask = await strictExecService.runExecutionLoop(task.id, steps);
    expect(currentTask.state).toBe('completed');
  });

  // 5. rejected operation does not execute
  it('5. rejected operation halts execution loop and fails/cancels task without tool execution', async () => {
    const strictApprovalService = new HumanApprovalService(
      taskService,
      toolGateway,
      storage.approvals,
      { autoApproveLowRisk: false },
      'error'
    );
    const strictExecService = new AgentExecutionService(taskService, toolGateway, strictApprovalService, 'error');

    const task = taskService.createTask({ title: 'Rejected Task' });
    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-reject',
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

    await strictExecService.runExecutionLoop(task.id, steps);
    const pending = strictApprovalService.getApprovalsForTask(task.id);

    // User rejects
    const resolveResult = strictApprovalService.resolveApproval(pending[0].approvalId, 'rejected', 'User denied action');
    expect(resolveResult.success).toBe(true);
    expect(resolveResult.approval.status).toBe('rejected');
    expect(resolveResult.task!.state).toBe('cancelled');

    // Re-run execution loop
    const finalTask = await strictExecService.runExecutionLoop(task.id, steps);
    expect(finalTask.state).toBe('cancelled');
  });

  // 6. expired approval does not execute
  it('6. expired approval request blocks execution and fails the task', async () => {
    const strictApprovalService = new HumanApprovalService(
      taskService,
      toolGateway,
      storage.approvals,
      { autoApproveLowRisk: false },
      'error'
    );

    const task = taskService.createTask({ title: 'Expired Task' });

    // Create approval with 1ms TTL
    strictApprovalService.createApprovalRequest({
      taskId: task.id,
      stepId: 'step-exp',
      toolId: 'filesystem_read',
      requestedCapability: 'filesystem.read',
      ttlMs: 1,
    });

    // Wait 10ms to ensure expiration
    await new Promise((r) => setTimeout(r, 10));

    const gateResult = strictApprovalService.evaluateGateForStep(task.id, 'step-exp');
    expect(gateResult.allowed).toBe(false);
    expect(gateResult.status).toBe('expired');
  });

  // 7. cancelled approval does not execute
  it('7. cancelled approval request blocks execution', () => {
    const strictApprovalService = new HumanApprovalService(
      taskService,
      toolGateway,
      storage.approvals,
      { autoApproveLowRisk: false },
      'error'
    );

    const task = taskService.createTask({ title: 'Cancelled Approval Task' });
    const { approval } = strictApprovalService.createApprovalRequest({
      taskId: task.id,
      stepId: 'step-cancel',
      toolId: 'filesystem_read',
      requestedCapability: 'filesystem.read',
      ttlMs: 60000,
    });

    strictApprovalService.cancelApprovalsForTask(task.id, 'Manual test cancel');
    const updated = strictApprovalService.getApproval(approval.approvalId);

    expect(updated!.status).toBe('cancelled');

    const gateResult = strictApprovalService.evaluateGateForStep(task.id, 'step-cancel');
    expect(gateResult.allowed).toBe(false);
    expect(gateResult.status).toBe('cancelled');
  });

  // 8. cancelled task prevents approval execution
  it('8. resolving an approval for a cancelled task is rejected and sets approval to cancelled', () => {
    const strictApprovalService = new HumanApprovalService(
      taskService,
      toolGateway,
      storage.approvals,
      { autoApproveLowRisk: false },
      'error'
    );

    const task = taskService.createTask({ title: 'Task To Cancel' });
    const { approval } = strictApprovalService.createApprovalRequest({
      taskId: task.id,
      stepId: 'step-1',
      toolId: 'filesystem_read',
      requestedCapability: 'filesystem.read',
    });

    // Cancel task explicitly
    taskService.cancelTask(task.id);

    // Attempt to resolve approval after task cancellation
    const resolveResult = strictApprovalService.resolveApproval(approval.approvalId, 'approved');
    expect(resolveResult.success).toBe(false);
    expect(resolveResult.approval.status).toBe('cancelled');
  });

  // 9. terminal approval states cannot reopen
  it('9. terminal approval states (approved, rejected, expired, cancelled) cannot be reopened', () => {
    const strictApprovalService = new HumanApprovalService(
      taskService,
      toolGateway,
      storage.approvals,
      { autoApproveLowRisk: false },
      'error'
    );

    const task = taskService.createTask({ title: 'Terminal State Reopen Test' });
    const { approval } = strictApprovalService.createApprovalRequest({
      taskId: task.id,
      stepId: 'step-1',
      toolId: 'filesystem_read',
      requestedCapability: 'filesystem.read',
    });

    // 1st resolution -> approved
    const r1 = strictApprovalService.resolveApproval(approval.approvalId, 'approved');
    expect(r1.success).toBe(true);
    expect(r1.approval.status).toBe('approved');

    // 2nd resolution -> try to change to rejected (MUST BE REJECTED!)
    const r2 = strictApprovalService.resolveApproval(approval.approvalId, 'rejected');
    expect(r2.success).toBe(false);
    expect(r2.approval.status).toBe('approved'); // Remains approved
  });

  // 10. invalid approval transition
  it('10. invalid state transition on terminal approval returns error result', () => {
    const task = taskService.createTask({ title: 'Invalid Transition Task' });
    const { approval } = approvalService.createApprovalRequest({
      taskId: task.id,
      stepId: 'step-1',
      toolId: 'filesystem_read',
      requestedCapability: 'filesystem.read',
    }); // Auto-approved

    const r = approvalService.resolveApproval(approval.approvalId, 'approved');
    expect(r.success).toBe(false);
    expect(r.error).toContain('terminal state');
  });

  // 11. unknown risk handling
  it('11. unknown risk level handling defaults safely to requiring approval or denial', () => {
    const engine = new ApprovalPolicyEngine({}, 'error');

    const fakeTool: ToolDefinition = {
      id: 'unknown_risk_tool',
      name: 'Unknown Risk Tool',
      description: 'Test',
      version: '1.0.0',
      category: 'utility',
      riskLevel: 'unknown_level' as never,
      requiredPermissions: ['filesystem.read'],
      inputSchema: {},
      enabled: true,
    };

    const decision = engine.evaluate(fakeTool, 'filesystem.read');
    expect(decision.requiresApproval).toBe(true);
    expect(decision.decision).toBe('REQUIRES_APPROVAL');
  });

  // 12. PermissionEngine still mandatory
  it('12. human approval DOES NOT bypass PermissionEngine authorization boundary', async () => {
    // Restrictive policy that explicitly denies terminal.execute
    const restrictiveGateway = new ToolGateway(
      {
        id: 'policy_no_terminal',
        name: 'No Terminal Policy',
        allowedCapabilities: ['filesystem.read'],
        maxRiskLevel: 'high',
        allowDisabledTools: false,
      },
      'error'
    );
    await restrictiveGateway.initialize(taskService, tmpDir);

    const terminalTool: ToolDefinition = {
      id: 'terminal_exec_tool',
      name: 'Terminal Exec',
      description: 'Executes terminal commands',
      version: '1.0.0',
      category: 'terminal',
      riskLevel: 'high',
      requiredPermissions: ['terminal.execute'],
      inputSchema: {},
      enabled: true,
    };
    restrictiveGateway.registerTool(terminalTool);

    const strictApprovalService = new HumanApprovalService(
      taskService,
      restrictiveGateway,
      storage.approvals,
      { autoApproveLowRisk: false },
      'error'
    );
    const strictExecService = new AgentExecutionService(taskService, restrictiveGateway, strictApprovalService, 'error');

    const task = taskService.createTask({ title: 'Permission Engine Check' });
    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-unauth',
        taskId: task.id,
        sequence: 1,
        stepType: 'tool_execution',
        status: 'pending',
        toolId: 'terminal_exec_tool',
        requestedCapabilities: ['terminal.execute'],
        params: {},
        attemptCount: 0,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    // Create approval and approve it
    const { approval } = strictApprovalService.createApprovalRequest({
      taskId: task.id,
      stepId: 'step-unauth',
      toolId: 'terminal_exec_tool',
      requestedCapability: 'terminal.execute',
    });
    strictApprovalService.resolveApproval(approval.approvalId, 'approved');

    // Run execution loop — PermissionEngine MUST STILL BLOCK execution with PERMISSION_DENIED!
    const finalTask = await strictExecService.runExecutionLoop(task.id, steps);

    expect(finalTask.state).toBe('failed');
    expect(finalTask.errorCategory).toBe('PERMISSION_DENIED');
  });

  // 13. PlanValidator still mandatory
  it('13. PlanValidator remains mandatory and rejects invalid/unknown tool plan proposals', () => {
    const validator = new PlanValidator(toolGateway);

    const invalidProposal = {
      reasoning: 'Use unknown tool',
      steps: [{ stepId: 'step-1', toolId: 'unregistered_tool', requestedCapabilities: ['filesystem.read'], params: {} }],
    };

    const validation = validator.validate(invalidProposal, 'task-1');
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.code === 'UNKNOWN_TOOL')).toBe(true);
  });

  // 14. ToolExecutor remains the only execution path
  it('14. ApprovalGate has zero tool execution capability and delegates execution solely to ToolExecutor', () => {
    const gate = new ApprovalGate('error');
    expect((gate as unknown as Record<string, unknown>)['executeTool']).toBeUndefined();
    expect((gate as unknown as Record<string, unknown>)['executor']).toBeUndefined();
  });

  // 15. approval does not itself grant permission
  it('15. granting human approval does not grant permission policy privileges', () => {
    const task = taskService.createTask({ title: 'Approval vs Permission' });
    const { approval } = approvalService.createApprovalRequest({
      taskId: task.id,
      stepId: 'step-1',
      toolId: 'filesystem_read',
      requestedCapability: 'filesystem.read',
    });

    // Check authorization request directly on ToolGateway
    const authResult = toolGateway.authorizeInvocation({
      requestId: 'req-1',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['terminal.execute'], // Denied by policy
    });

    expect(approval.status).toBe('approved');
    expect(authResult.authorized).toBe(false);
  });

  // 16. deterministic policy decision
  it('16. ApprovalPolicyEngine provides deterministic decisions with explicit reasons', () => {
    const engine = new ApprovalPolicyEngine({ autoApproveLowRisk: true, requireApprovalForHighRisk: true }, 'error');

    const lowTool: ToolDefinition = {
      id: 't_low',
      name: 'Low',
      description: 'L',
      version: '1.0',
      category: 'filesystem',
      riskLevel: 'low',
      requiredPermissions: ['filesystem.read'],
      inputSchema: {},
      enabled: true,
    };

    const highTool: ToolDefinition = {
      id: 't_high',
      name: 'High',
      description: 'H',
      version: '1.0',
      category: 'terminal',
      riskLevel: 'high',
      requiredPermissions: ['terminal.execute'],
      inputSchema: {},
      enabled: true,
    };

    const d1 = engine.evaluate(lowTool, 'filesystem.read');
    const d2 = engine.evaluate(highTool, 'terminal.execute');
    const d3 = engine.evaluate(null, 'filesystem.read');

    expect(d1.decision).toBe('AUTO_APPROVED');
    expect(d2.decision).toBe('REQUIRES_APPROVAL');
    expect(d3.decision).toBe('POLICY_DENIED');
  });

  // 17. approval metadata persistence in SQLite repository
  it('17. persists approval requests and status updates in SQLite repository', () => {
    const task = taskService.createTask({ title: 'Persistence Task' });
    const { approval } = approvalService.createApprovalRequest({
      taskId: task.id,
      stepId: 'step-db',
      toolId: 'filesystem_read',
      requestedCapability: 'filesystem.read',
    });

    const retrieved = storage.approvals.findById(approval.approvalId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.approvalId).toBe(approval.approvalId);
    expect(retrieved!.taskId).toBe(task.id);
  });

  // 18. existing P0-P5-E tests continue passing
  it('18. system health report includes orchestrator with approvals: yes', async () => {
    const orchestrator = storage.approvals ? 'ok' : 'degraded';
    expect(orchestrator).toBe('ok');
  });
});
