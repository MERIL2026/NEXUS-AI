import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StorageService } from '../storage/index.js';
import { AgentTaskService } from '../orchestration/agentTaskService.js';
import { ToolGateway } from '../tools/index.js';
import type { ToolDefinition, ToolInvocationRequest, ToolCapability } from '../tools/types.js';

describe('P5-B — Tool Registry & Permission Engine Foundation', () => {
  let storage: StorageService;
  let taskService: AgentTaskService;
  let toolGateway: ToolGateway;

  const sampleTool: ToolDefinition = {
    id: 'fs_read_tool',
    name: 'File System Reader',
    description: 'Reads local file contents safely within workspace',
    version: '1.0.0',
    category: 'filesystem',
    riskLevel: 'low',
    requiredPermissions: ['filesystem.read'],
    inputSchema: { path: { type: 'string' } },
    enabled: true,
  };

  beforeEach(async () => {
    storage = new StorageService(':memory:', 'error');
    await storage.initialize();
    taskService = new AgentTaskService(storage.agentTasks, 'error');
    toolGateway = new ToolGateway(undefined, 'error');
    await toolGateway.initialize(taskService);
  });

  afterEach(() => {
    storage.close();
  });

  // 1. Register tool
  it('1. registers a tool and stores structured metadata', () => {
    toolGateway.registerTool(sampleTool);
    expect(toolGateway.registry.isRegistered('fs_read_tool')).toBe(true);
  });

  // 2. Retrieve registered tool
  it('2. retrieves a registered tool by ID', () => {
    toolGateway.registerTool(sampleTool);
    const retrieved = toolGateway.getTool('fs_read_tool');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.name).toBe('File System Reader');
    expect(retrieved?.requiredPermissions).toEqual(['filesystem.read']);
  });

  // 3. Duplicate tool registration
  it('3. rejects duplicate tool registration with clear error', () => {
    toolGateway.registerTool(sampleTool);
    expect(() => toolGateway.registerTool(sampleTool)).toThrow(/duplicate tool ID/i);
  });

  // 4. Disabled tool
  it('4. denies authorization for a disabled tool', () => {
    toolGateway.registerTool({ ...sampleTool, id: 'disabled_tool', enabled: false });
    const task = taskService.createTask({ title: 'Test Task' });

    const request: ToolInvocationRequest = {
      requestId: 'req-101',
      taskId: task.id,
      toolId: 'disabled_tool',
      requestedCapabilities: ['filesystem.read'],
    };

    const result = toolGateway.authorizeInvocation(request);
    expect(result.authorized).toBe(false);
    expect(result.decision).toBe('DENIED');
    expect(result.reason).toContain('DISABLED_TOOL');
  });

  // 5. Unknown tool
  it('5. denies authorization for an unregistered/unknown tool', () => {
    const task = taskService.createTask({ title: 'Test Task' });

    const request: ToolInvocationRequest = {
      requestId: 'req-102',
      taskId: task.id,
      toolId: 'non_existent_tool',
      requestedCapabilities: ['filesystem.read'],
    };

    const result = toolGateway.authorizeInvocation(request);
    expect(result.authorized).toBe(false);
    expect(result.decision).toBe('DENIED');
    expect(result.reason).toContain('UNKNOWN_TOOL');
  });

  // 6. Valid capability
  it('6. authorizes request with valid declared capability', () => {
    toolGateway.registerTool(sampleTool);
    const task = taskService.createTask({ title: 'Valid Task' });

    const request: ToolInvocationRequest = {
      requestId: 'req-103',
      taskId: task.id,
      toolId: 'fs_read_tool',
      requestedCapabilities: ['filesystem.read'],
    };

    const result = toolGateway.authorizeInvocation(request);
    expect(result.authorized).toBe(true);
    expect(result.decision).toBe('ALLOWED');
    expect(result.reason).toContain('Invocation authorized');
  });

  // 7. Unknown capability
  it('7. denies authorization for an unrecognized/unknown capability', () => {
    toolGateway.registerTool(sampleTool);
    const task = taskService.createTask({ title: 'Task' });

    const request: ToolInvocationRequest = {
      requestId: 'req-104',
      taskId: task.id,
      toolId: 'fs_read_tool',
      requestedCapabilities: ['invalid.capability' as ToolCapability],
    };

    const result = toolGateway.authorizeInvocation(request);
    expect(result.authorized).toBe(false);
    expect(result.decision).toBe('DENIED');
    expect(result.reason).toContain('UNKNOWN_CAPABILITY');
  });

  // 8. Missing permission (undeclared capability by tool)
  it('8. denies authorization when requested capability is not declared by tool', () => {
    toolGateway.registerTool(sampleTool); // only has filesystem.read
    const task = taskService.createTask({ title: 'Task' });

    const request: ToolInvocationRequest = {
      requestId: 'req-105',
      taskId: task.id,
      toolId: 'fs_read_tool',
      requestedCapabilities: ['filesystem.write'],
    };

    const result = toolGateway.authorizeInvocation(request);
    expect(result.authorized).toBe(false);
    expect(result.decision).toBe('DENIED');
    expect(result.reason).toContain('MISSING_PERMISSION');
  });

  // 9. Authorized request
  it('9. returns complete authorized result contract for valid request', () => {
    toolGateway.registerTool(sampleTool);
    const task = taskService.createTask({ title: 'Authorized Task' });

    const request: ToolInvocationRequest = {
      requestId: 'req-106',
      taskId: task.id,
      toolId: 'fs_read_tool',
      requestedCapabilities: ['filesystem.read'],
    };

    const result = toolGateway.authorizeInvocation(request);
    expect(result).toMatchObject({
      requestId: 'req-106',
      taskId: task.id,
      toolId: 'fs_read_tool',
      authorized: true,
      decision: 'ALLOWED',
      executed: false,
    });
  });

  // 10. Denied request
  it('10. returns complete denied result contract for invalid policy request', () => {
    toolGateway.registerTool(sampleTool);
    const task = taskService.createTask({ title: 'Denied Task' });

    // Set custom strict policy that disallows filesystem.read
    toolGateway.permissionEngine.setPolicy({
      id: 'strict_policy',
      name: 'No File Policy',
      allowedCapabilities: ['terminal.execute'],
      maxRiskLevel: 'low',
      allowDisabledTools: false,
    });

    const request: ToolInvocationRequest = {
      requestId: 'req-107',
      taskId: task.id,
      toolId: 'fs_read_tool',
      requestedCapabilities: ['filesystem.read'],
    };

    const result = toolGateway.authorizeInvocation(request);
    expect(result.authorized).toBe(false);
    expect(result.decision).toBe('DENIED');
    expect(result.reason).toContain('MISSING_PERMISSION');
  });

  // 11. Invalid invocation request
  it('11. denies authorization for malformed/invalid invocation request structure', () => {
    const invalidRequest = {
      requestId: '',
      taskId: 'task-1',
      toolId: 'fs_read_tool',
      requestedCapabilities: ['filesystem.read'],
    } as ToolInvocationRequest;

    const result = toolGateway.authorizeInvocation(invalidRequest);
    expect(result.authorized).toBe(false);
    expect(result.decision).toBe('DENIED');
    expect(result.reason).toContain('INVALID_REQUEST');
  });

  // 12. Task-aware authorization
  it('12. denies authorization if referenced task ID does not exist', () => {
    toolGateway.registerTool(sampleTool);

    const request: ToolInvocationRequest = {
      requestId: 'req-108',
      taskId: 'non_existent_task_999',
      toolId: 'fs_read_tool',
      requestedCapabilities: ['filesystem.read'],
    };

    const result = toolGateway.authorizeInvocation(request);
    expect(result.authorized).toBe(false);
    expect(result.decision).toBe('DENIED');
    expect(result.reason).toContain('UNKNOWN_TASK');
  });

  // 13. Authorization does not execute tools
  it('13. authorization contract guarantees executed: false and causes no side effects', () => {
    toolGateway.registerTool(sampleTool);
    const task = taskService.createTask({ title: 'Non-execution Test' });

    const request: ToolInvocationRequest = {
      requestId: 'req-109',
      taskId: task.id,
      toolId: 'fs_read_tool',
      requestedCapabilities: ['filesystem.read'],
      inputMetadata: { path: 'C:/secret.txt' },
    };

    const result = toolGateway.authorizeInvocation(request);
    expect(result.executed).toBe(false); // NO TOOL EXECUTION IN P5-B
    expect(taskService.getTask(task.id).state).toBe('created'); // Task state remains unchanged
  });

  // 14. Deterministic authorization result
  it('14. produces identical deterministic authorization decisions for identical requests', () => {
    toolGateway.registerTool(sampleTool);
    const task = taskService.createTask({ title: 'Deterministic Task' });

    const request: ToolInvocationRequest = {
      requestId: 'req-110',
      taskId: task.id,
      toolId: 'fs_read_tool',
      requestedCapabilities: ['filesystem.read'],
    };

    const res1 = toolGateway.authorizeInvocation(request);
    const res2 = toolGateway.authorizeInvocation(request);

    expect(res1.authorized).toBe(res2.authorized);
    expect(res1.decision).toBe(res2.decision);
    expect(res1.reason).toBe(res2.reason);
  });

  // 15. Deny-by-default behavior
  it('15. strictly enforces deny-by-default for unhandled policy edge cases', () => {
    toolGateway.registerTool({
      ...sampleTool,
      id: 'critical_tool',
      riskLevel: 'critical',
    });
    const task = taskService.createTask({ title: 'Critical Task' });

    const request: ToolInvocationRequest = {
      requestId: 'req-111',
      taskId: task.id,
      toolId: 'critical_tool',
      requestedCapabilities: ['filesystem.read'],
    };

    // Default policy maxRisk is 'high'. 'critical' tool exceeds max risk level.
    const result = toolGateway.authorizeInvocation(request);
    expect(result.authorized).toBe(false);
    expect(result.decision).toBe('DENIED');
    expect(result.reason).toContain('EXCEEDS_POLICY_RISK');
  });
});
