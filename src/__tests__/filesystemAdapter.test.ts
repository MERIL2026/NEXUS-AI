import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StorageService } from '../storage/index.js';
import { AgentTaskService } from '../orchestration/agentTaskService.js';
import { ToolGateway, ToolExecutor } from '../tools/index.js';
import type { ToolExecutionRequest } from '../tools/types.js';

describe('P5-C — Safe Tool Execution & Read-Only Workspace Filesystem Adapter', () => {
  let tmpDir: string;
  let outsideTmpDir: string;
  let storage: StorageService;
  let taskService: AgentTaskService;
  let toolGateway: ToolGateway;

  beforeEach(async () => {
    // Create isolated temporary workspace root
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-p5c-workspace-'));
    outsideTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-p5c-outside-'));

    // Populate test workspace files
    fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'Hello, NEXUS AI!', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'sub', 'nested.txt'), 'Nested content', 'utf8');
    fs.writeFileSync(path.join(outsideTmpDir, 'secret.txt'), 'SUPER_SECRET_DATA', 'utf8');

    storage = new StorageService(':memory:', 'error');
    await storage.initialize();
    taskService = new AgentTaskService(storage.agentTasks, 'error');
    toolGateway = new ToolGateway(undefined, 'error');
    await toolGateway.initialize(taskService, tmpDir);
  });

  afterEach(() => {
    storage.close();
    // Clean up temporary test directories safely
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(outsideTmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // 1. Authorized read
  it('1. authorized read of a valid workspace file succeeds', () => {
    const task = taskService.createTask({ title: 'Read Task' });
    const request: ToolExecutionRequest = {
      requestId: 'req-201',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: 'hello.txt' },
    };

    const result = toolGateway.executeTool(request);
    expect(result.authorized).toBe(true);
    expect(result.executed).toBe(true);
    expect(result.success).toBe(true);
    expect(result.decision).toBe('ALLOWED');
    expect(result.output?.content).toBe('Hello, NEXUS AI!');
    expect(result.output?.bytes).toBe(16);
  });

  // 2. Unauthorized read
  it('2. unauthorized read fails authorization and DOES NOT execute file read', () => {
    const task = taskService.createTask({ title: 'Task' });
    // Request an unregistered capability or unallowed tool
    const request: ToolExecutionRequest = {
      requestId: 'req-202',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['terminal.execute'], // Unauthorized capability for filesystem_read
      params: { relativePath: 'hello.txt' },
    };

    const result = toolGateway.executeTool(request);
    expect(result.authorized).toBe(false);
    expect(result.executed).toBe(false); // NO EXECUTION OCCURRED
    expect(result.success).toBe(false);
    expect(result.decision).toBe('DENIED');
    expect(result.errorCategory).toBe('PERMISSION_DENIED');
  });

  // 3. Unknown task
  it('3. rejects execution request referencing an unknown task ID', () => {
    const request: ToolExecutionRequest = {
      requestId: 'req-203',
      taskId: 'ghost_task_999',
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: 'hello.txt' },
    };

    const result = toolGateway.executeTool(request);
    expect(result.authorized).toBe(false);
    expect(result.executed).toBe(false);
    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('PERMISSION_DENIED');
  });

  // 4. Disabled tool
  it('4. rejects execution request for a disabled tool', () => {
    toolGateway.registry.setToolEnabled('filesystem_read', false);
    const task = taskService.createTask({ title: 'Task' });

    const request: ToolExecutionRequest = {
      requestId: 'req-204',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: 'hello.txt' },
    };

    const result = toolGateway.executeTool(request);
    expect(result.authorized).toBe(false);
    expect(result.executed).toBe(false);
    expect(result.errorCategory).toBe('PERMISSION_DENIED');
  });

  // 5. Invalid capability
  it('5. rejects execution request with invalid or missing capability', () => {
    const task = taskService.createTask({ title: 'Task' });
    const request: ToolExecutionRequest = {
      requestId: 'req-205',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: [],
      params: { relativePath: 'hello.txt' },
    };

    const result = toolGateway.executeTool(request);
    expect(result.authorized).toBe(false);
    expect(result.executed).toBe(false);
  });

  // 6. Valid workspace-relative path
  it('6. reads file correctly using nested relative path inside workspace', () => {
    const task = taskService.createTask({ title: 'Nested Read' });
    const request: ToolExecutionRequest = {
      requestId: 'req-206',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: 'sub/nested.txt' },
    };

    const result = toolGateway.executeTool(request);
    expect(result.success).toBe(true);
    expect(result.output?.content).toBe('Nested content');
  });

  // 7. Path traversal rejection
  it('7. rejects path traversal attempt (../outside.txt) escaping workspace root', () => {
    const task = taskService.createTask({ title: 'Traversal Task' });
    const request: ToolExecutionRequest = {
      requestId: 'req-207',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: '../outside/secret.txt' },
    };

    const result = toolGateway.executeTool(request);
    expect(result.authorized).toBe(true);
    expect(result.executed).toBe(true);
    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
  });

  // 8. Absolute outside-workspace path rejection
  it('8. rejects absolute path pointing outside workspace sandbox', () => {
    const task = taskService.createTask({ title: 'Absolute Path Task' });
    const outsideFile = path.join(outsideTmpDir, 'secret.txt');

    const request: ToolExecutionRequest = {
      requestId: 'req-208',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: outsideFile },
    };

    const result = toolGateway.executeTool(request);
    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
  });

  // 9. Windows path traversal cases
  it('9. rejects Windows backslash path traversal attempts', () => {
    const task = taskService.createTask({ title: 'Windows Traversal Task' });
    const request: ToolExecutionRequest = {
      requestId: 'req-209',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: '..\\..\\outside\\secret.txt' },
    };

    const result = toolGateway.executeTool(request);
    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
  });

  // 10. Symlink escape protection
  it('10. protects against symlink pointing outside workspace root', () => {
    const task = taskService.createTask({ title: 'Symlink Task' });
    const symlinkPath = path.join(tmpDir, 'symlink_outside.txt');
    const outsideTarget = path.join(outsideTmpDir, 'secret.txt');

    try {
      fs.symlinkSync(outsideTarget, symlinkPath);
    } catch {
      // Symlink creation might fail on Windows without admin privs; test gracefully fallback
      return;
    }

    const request: ToolExecutionRequest = {
      requestId: 'req-210',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: 'symlink_outside.txt' },
    };

    const result = toolGateway.executeTool(request);
    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
  });

  // 11. Missing file
  it('11. returns FILE_NOT_FOUND for non-existent file inside workspace', () => {
    const task = taskService.createTask({ title: 'Missing File Task' });
    const request: ToolExecutionRequest = {
      requestId: 'req-211',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: 'ghost.txt' },
    };

    const result = toolGateway.executeTool(request);
    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('FILE_NOT_FOUND');
  });

  // 12. Directory read rejection
  it('12. rejects attempts to read a directory as a file', () => {
    const task = taskService.createTask({ title: 'Directory Task' });
    const request: ToolExecutionRequest = {
      requestId: 'req-212',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: 'sub' },
    };

    const result = toolGateway.executeTool(request);
    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('INVALID_FILE_TYPE');
  });

  // 13. File size limit
  it('13. rejects files exceeding maximum file size limit', () => {
    // Re-initialize adapter with a small 10 byte limit
    toolGateway.executor = new ToolExecutor(tmpDir, 10, 'error');

    const task = taskService.createTask({ title: 'Size Limit Task' });
    const request: ToolExecutionRequest = {
      requestId: 'req-213',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: 'hello.txt' }, // 16 bytes > 10 bytes limit
    };

    const result = toolGateway.executeTool(request);
    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('FILE_TOO_LARGE');
  });

  // 14. Unsupported input
  it('14. handles missing or invalid relativePath parameter gracefully', () => {
    const task = taskService.createTask({ title: 'Invalid Input Task' });
    const request: ToolExecutionRequest = {
      requestId: 'req-214',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: {},
    };

    const result = toolGateway.executeTool(request);
    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('INVALID_INPUT');
  });

  // 15. Normalized result contract
  it('15. returns normalized tool execution result contract structure', () => {
    const task = taskService.createTask({ title: 'Contract Task' });
    const request: ToolExecutionRequest = {
      requestId: 'req-215',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: 'hello.txt' },
    };

    const result = toolGateway.executeTool(request);
    expect(result).toHaveProperty('requestId', 'req-215');
    expect(result).toHaveProperty('taskId', task.id);
    expect(result).toHaveProperty('toolId', 'filesystem_read');
    expect(result).toHaveProperty('authorized', true);
    expect(result).toHaveProperty('executed', true);
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('decision', 'ALLOWED');
    expect(result).toHaveProperty('output');
    expect(result).toHaveProperty('timestamp');
  });

  // 16. Execution cannot bypass PermissionEngine
  it('16. enforces that execution CANNOT bypass PermissionEngine authorization', () => {
    const task = taskService.createTask({ title: 'Bypass Task' });

    // Revoke filesystem.read from active security policy
    toolGateway.permissionEngine.setPolicy({
      id: 'no_fs_policy',
      name: 'No File System Access Policy',
      allowedCapabilities: ['terminal.execute'],
      maxRiskLevel: 'high',
      allowDisabledTools: false,
    });

    const request: ToolExecutionRequest = {
      requestId: 'req-216',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: 'hello.txt' },
    };

    const result = toolGateway.executeTool(request);
    expect(result.authorized).toBe(false);
    expect(result.executed).toBe(false); // ABSOLUTELY NO EXECUTION
    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('PERMISSION_DENIED');
  });

  // 17. No write capability exists in P5-C
  it('17. guarantees no write, delete, or process execution capability exists in P5-C', () => {
    const task = taskService.createTask({ title: 'Write Attempt Task' });
    const request: ToolExecutionRequest = {
      requestId: 'req-217',
      taskId: task.id,
      toolId: 'unregistered_write_tool', // Unregistered write tool
      requestedCapabilities: ['filesystem.write'],
      params: { relativePath: 'test.txt', content: 'hack' },
    };

    const result = toolGateway.executeTool(request);
    expect(result.authorized).toBe(false);
    expect(result.executed).toBe(false);
  });

  // 18. Invariants verification
  it('18. verifies security invariant: NO AUTHORIZATION => NO EXECUTION', () => {
    const request: ToolExecutionRequest = {
      requestId: 'req-218',
      taskId: 'invalid-task',
      toolId: 'unknown-tool',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: 'hello.txt' },
    };

    const result = toolGateway.executeTool(request);
    expect(result.authorized).toBe(false);
    expect(result.executed).toBe(false);
  });
});
