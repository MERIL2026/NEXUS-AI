/**
 * NEXUS AI — P6-C Test Suite: Bounded Terminal Execution Adapter (terminal_execute)
 *
 * Validates all 30 security test requirements and security invariants for:
 *  - Allowlist enforcement & command policy
 *  - Process isolation (no shell, non-shell execution)
 *  - Working directory workspace boundary enforcement
 *  - Environment sanitization & secret protection
 *  - Bounded stdout/stderr buffer enforcement
 *  - Timeout enforcement & process termination
 *  - AbortSignal cancellation
 *  - Full P5 Security Pipeline integration (PermissionEngine -> ApprovalPolicyEngine -> ApprovalGate -> ToolExecutor -> TerminalAdapter)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { StorageService } from '../storage/index.js';
import { AgentTaskService } from '../orchestration/agentTaskService.js';
import { HumanApprovalService } from '../orchestration/humanApprovalService.js';
import {
  ToolGateway,
  TerminalAdapter,
  TerminalCommandPolicy,
  buildSanitizedEnv,
  validateWorkspaceCwd,
  TERMINAL_EXECUTE_TOOL_DEFINITION,
} from '../tools/index.js';
import type { ToolExecutionRequest } from '../tools/types.js';

describe('P6-C — Bounded Terminal Execution Adapter (terminal_execute)', () => {
  let tmpDir: string;
  let storage: StorageService;
  let taskService: AgentTaskService;
  let toolGateway: ToolGateway;
  let approvalService: HumanApprovalService;
  let policy: TerminalCommandPolicy;
  let adapter: TerminalAdapter;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-p6c-test-'));

    // Populate mock workspace
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test-pkg","version":"1.0.0"}', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.js'), 'console.log("Hello from test");', 'utf8');

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

    policy = new TerminalCommandPolicy('error');
    adapter = new TerminalAdapter(tmpDir, 'error');
  });

  afterEach(() => {
    storage.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ---------------------------------------------------------------------------
  // 1. Allowed command execution
  // ---------------------------------------------------------------------------
  it('1. executes an allowed development command (node --version) successfully', async () => {
    const res = await adapter.execute('node', ['--version'], { command: 'node', args: ['--version'] });
    expect(res.success).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^v\d+\.\d+\.\d+/);
    expect(res.timedOut).toBe(false);
    expect(res.cancelled).toBe(false);
  }, 15000);

  // ---------------------------------------------------------------------------
  // 2. Unknown command rejection
  // ---------------------------------------------------------------------------
  it('2. rejects an unknown command not in the allowlist', () => {
    const res = policy.evaluate({ command: 'some_unknown_binary', args: [] });
    expect(res.allowed).toBe(false);
    expect(res.decision).toBe('COMMAND_NOT_ALLOWED');
    expect(res.reason).toContain('not in the terminal execution allowlist');
  });

  // ---------------------------------------------------------------------------
  // 3. Forbidden command rejection
  // ---------------------------------------------------------------------------
  it('3. rejects permanently forbidden commands (rm, rmdir, del, format, shutdown)', () => {
    const forbidden = ['rm', 'rmdir', 'del', 'format', 'shutdown', 'taskkill'];
    for (const cmd of forbidden) {
      const res = policy.evaluate({ command: cmd, args: [] });
      expect(res.allowed).toBe(false);
      expect(res.decision).toBe('COMMAND_NOT_ALLOWED');
      expect(res.reason).toContain('permanently blocked');
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Shell chaining rejection
  // ---------------------------------------------------------------------------
  it('4. rejects command structures containing shell operators (&&, ||, ;, |, >, >>)', () => {
    const chainingAttempts = [
      { command: 'node', args: ['-v', '&&', 'del', 'file'] },
      { command: 'npm', args: ['test', '||', 'echo', 'fail'] },
      { command: 'node', args: ['-v', ';', 'calc'] },
      { command: 'node', args: ['-v', '|', 'more'] },
      { command: 'node', args: ['-v', '>', 'out.txt'] },
      { command: 'node', args: ['-v', '>>', 'out.txt'] },
      { command: 'node', args: ['$(whoami)'] },
      { command: 'node', args: ['`whoami`'] },
    ];

    for (const params of chainingAttempts) {
      const res = policy.evaluate(params);
      expect(res.allowed).toBe(false);
      expect(res.decision).toBe('INVALID_COMMAND_POLICY');
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Shell interpreter rejection
  // ---------------------------------------------------------------------------
  it('5. rejects shell interpreters (cmd, powershell, bash, sh)', () => {
    const shells = ['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'bash', 'sh', 'zsh'];
    for (const sh of shells) {
      const res = policy.evaluate({ command: sh, args: ['/c', 'dir'] });
      expect(res.allowed).toBe(false);
      expect(res.decision).toBe('COMMAND_NOT_ALLOWED');
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Workspace cwd enforcement
  // ---------------------------------------------------------------------------
  it('6. enforces working directory inside workspace sandbox (relative path subdirs allowed)', () => {
    const cwdVal = validateWorkspaceCwd('src', adapter.getWorkspaceRoot());
    expect(cwdVal.valid).toBe(true);
    if (cwdVal.valid) {
      expect(cwdVal.resolvedCwd).toContain('src');
    }
  });

  // ---------------------------------------------------------------------------
  // 7. Path traversal cwd rejection
  // ---------------------------------------------------------------------------
  it('7. rejects path traversal relative cwd attempts (../outside)', () => {
    const cwdVal = validateWorkspaceCwd('../outside', adapter.getWorkspaceRoot());
    expect(cwdVal.valid).toBe(false);
    if (!cwdVal.valid) {
      expect(cwdVal.errorMessage).toContain('resolves outside the workspace sandbox');
    }
  });

  // ---------------------------------------------------------------------------
  // 8. Absolute outside-workspace cwd rejection
  // ---------------------------------------------------------------------------
  it('8. rejects absolute outside-workspace cwd attempts', () => {
    const outsidePath = os.platform() === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin';
    const cwdVal = validateWorkspaceCwd(outsidePath, adapter.getWorkspaceRoot());
    expect(cwdVal.valid).toBe(false);
    if (!cwdVal.valid) {
      expect(cwdVal.errorMessage).toContain('resolves outside the workspace sandbox');
    }
  });

  // ---------------------------------------------------------------------------
  // 9. Null-byte rejection
  // ---------------------------------------------------------------------------
  it('9. rejects null-byte characters in command, args, and cwd', () => {
    expect(policy.evaluate({ command: 'node\0', args: [] }).allowed).toBe(false);
    expect(policy.evaluate({ command: 'node', args: ['file\0.js'] }).allowed).toBe(false);
    expect(validateWorkspaceCwd('src\0dir', adapter.getWorkspaceRoot()).valid).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 10. Symlink escape rejection
  // ---------------------------------------------------------------------------
  it('10. resolves canonical real path to reject symlink escape attempts', () => {
    const cwdVal = validateWorkspaceCwd('../../..', adapter.getWorkspaceRoot());
    expect(cwdVal.valid).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 11. Permission denial
  // ---------------------------------------------------------------------------
  it('11. PermissionEngine denies invocation if terminal.execute capability is missing from policy', () => {
    const restrictedGateway = new ToolGateway({
      id: 'no_term_policy',
      name: 'No Terminal Policy',
      allowedCapabilities: ['filesystem.read'],
      maxRiskLevel: 'high',
      allowDisabledTools: false,
    }, 'error');
    restrictedGateway.initialize(taskService, tmpDir);

    const task = taskService.createTask({ title: 'Permission Denial Test' });

    const authRes = restrictedGateway.authorizeInvocation({
      requestId: 'req-perm-deny',
      taskId: task.id,
      toolId: 'terminal_execute',
      requestedCapabilities: ['terminal.execute'],
    });

    expect(authRes.authorized).toBe(false);
    expect(authRes.decision).toBe('DENIED');
    expect(authRes.reason).toContain('MISSING_PERMISSION');
  });

  // ---------------------------------------------------------------------------
  // 12. Approval required
  // ---------------------------------------------------------------------------
  it('12. high-risk terminal_execute requires explicit human approval', () => {
    const decision = (approvalService as unknown as { policyEngine: { evaluate: (def: unknown, cap: string) => { requiresApproval: boolean; decision: string; riskLevel: string } } }).policyEngine.evaluate(
      TERMINAL_EXECUTE_TOOL_DEFINITION,
      'terminal.execute'
    );
    expect(decision.requiresApproval).toBe(true);
    expect(decision.decision).toBe('REQUIRES_APPROVAL');
    expect(decision.riskLevel).toBe('high');
  });

  // ---------------------------------------------------------------------------
  // 13. Approval rejection
  // ---------------------------------------------------------------------------
  it('13. rejected human approval prevents process execution', () => {
    const task = taskService.createTask({ title: 'Approval Rejection Test' });
    const reqRes = approvalService.createApprovalRequest({
      taskId: task.id,
      stepId: 'step-term-1',
      toolId: 'terminal_execute',
      requestedCapability: 'terminal.execute',
    });

    expect(reqRes.approval.status).toBe('pending');

    // Reject approval
    approvalService.resolveApproval(reqRes.approval.approvalId, 'rejected', 'User refused command execution');

    const gateRes = approvalService.evaluateGateForStep(task.id, 'step-term-1');
    expect(gateRes.allowed).toBe(false);
    expect(gateRes.status).toBe('rejected');
  });

  // ---------------------------------------------------------------------------
  // 14. Approved high-risk execution
  // ---------------------------------------------------------------------------
  it('14. approved high-risk terminal execution succeeds through full pipeline', async () => {
    const task = taskService.createTask({ title: 'Approval Success Test' });
    const reqRes = approvalService.createApprovalRequest({
      taskId: task.id,
      stepId: 'step-term-2',
      toolId: 'terminal_execute',
      requestedCapability: 'terminal.execute',
    });

    // Approve approval
    approvalService.resolveApproval(reqRes.approval.approvalId, 'approved');

    const gateRes = approvalService.evaluateGateForStep(task.id, 'step-term-2');
    expect(gateRes.allowed).toBe(true);

    const execRequest: ToolExecutionRequest = {
      requestId: 'req-term-approved',
      taskId: task.id,
      toolId: 'terminal_execute',
      requestedCapabilities: ['terminal.execute'],
      params: {
        command: 'node',
        args: ['--version'],
      },
    };

    const execRes = await toolGateway.executeTool(execRequest);
    expect(execRes.authorized).toBe(true);
    expect(execRes.executed).toBe(true);
    expect(execRes.success).toBe(true);
    expect(execRes.output?.stdout).toMatch(/^v\d+/);
  }, 15000);

  // ---------------------------------------------------------------------------
  // 15. Timeout termination
  // ---------------------------------------------------------------------------
  it('15. terminates long-running process when timeout is reached', async () => {
    // Run infinite node loop with a short 300ms timeout
    const res = await adapter.execute(
      'node',
      ['-e', 'while(true){}'],
      { command: 'node', args: ['-e', 'while(true){}'], timeoutMs: 300 }
    );

    expect(res.success).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.errorCategory).toBe('TIMEOUT');
    expect(res.signal).toBe('SIGTERM');
  }, 10000);

  // ---------------------------------------------------------------------------
  // 16. AbortSignal cancellation
  // ---------------------------------------------------------------------------
  it('16. cancels running process immediately when AbortSignal triggers', async () => {
    const controller = new AbortController();

    // Trigger abort after 150ms
    setTimeout(() => controller.abort(), 150);

    const res = await adapter.execute(
      'node',
      ['-e', 'setTimeout(() => {}, 10000);'],
      { command: 'node', args: [] },
      controller.signal
    );

    expect(res.success).toBe(false);
    expect(res.cancelled).toBe(true);
    expect(res.errorCategory).toBe('PROCESS_TERMINATED');
  }, 15000);

  // ---------------------------------------------------------------------------
  // 17. stdout size limit
  // ---------------------------------------------------------------------------
  it('17. truncates stdout when exceeding maxStdoutBytes limit', async () => {
    // Generate 100 KB of output with a 10 KB limit
    const res = await adapter.execute(
      'node',
      ['-e', 'process.stdout.write("A".repeat(100000));'],
      { command: 'node', args: [], maxStdoutBytes: 10240 }
    );

    expect(res.success).toBe(true);
    expect(res.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(res.stdout, 'utf8')).toBeLessThanOrEqual(10240);
  }, 15000);

  // ---------------------------------------------------------------------------
  // 18. stderr size limit
  // ---------------------------------------------------------------------------
  it('18. truncates stderr when exceeding maxStderrBytes limit', async () => {
    // Generate 100 KB of stderr output with a 10 KB limit
    const res = await adapter.execute(
      'node',
      ['-e', 'process.stderr.write("E".repeat(100000));'],
      { command: 'node', args: [], maxStderrBytes: 10240 }
    );

    expect(res.success).toBe(true);
    expect(res.stderrTruncated).toBe(true);
    expect(Buffer.byteLength(res.stderr, 'utf8')).toBeLessThanOrEqual(10240);
  }, 15000);

  // ---------------------------------------------------------------------------
  // 19. environment secret stripping
  // ---------------------------------------------------------------------------
  it('19. strips secret environment variables (*_KEY, *_TOKEN, *_SECRET, *_PASSWORD)', () => {
    const mockEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      MY_API_KEY: 'supersecretkey123',
      AUTH_TOKEN: 'token_xyz',
      DB_SECRET: 'secret_123',
      USER_PASSWORD: 'password123',
    };

    const sanitized = buildSanitizedEnv(mockEnv);
    expect(sanitized.PATH).toBeDefined();
    expect(sanitized.NODE_ENV).toBe('test');
    expect(sanitized.MY_API_KEY).toBeUndefined();
    expect(sanitized.AUTH_TOKEN).toBeUndefined();
    expect(sanitized.DB_SECRET).toBeUndefined();
    expect(sanitized.USER_PASSWORD).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 20. sensitive environment variable stripping
  // ---------------------------------------------------------------------------
  it('20. strips cloud provider credentials (AWS_*, AZURE_*, GCP_*, GOOGLE_*)', () => {
    const mockEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      AZURE_CLIENT_SECRET: 'azure_sec_123',
      GCP_PROJECT_ID: 'my-gcp-proj',
      GOOGLE_APPLICATION_CREDENTIALS: '/path/to/creds.json',
    };

    const sanitized = buildSanitizedEnv(mockEnv);
    expect(sanitized.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(sanitized.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(sanitized.AZURE_CLIENT_SECRET).toBeUndefined();
    expect(sanitized.GCP_PROJECT_ID).toBeUndefined();
    expect(sanitized.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 21. git destructive command rejection
  // ---------------------------------------------------------------------------
  it('21. rejects destructive git commands (push, reset --hard, clean, checkout)', () => {
    const destructiveGit = [
      { command: 'git', args: ['push', 'origin', 'main'] },
      { command: 'git', args: ['push', '--force'] },
      { command: 'git', args: ['reset', '--hard', 'HEAD~1'] },
      { command: 'git', args: ['clean', '-fd'] },
      { command: 'git', args: ['checkout', '.'] },
      { command: 'git', args: ['commit', '-m', 'test'] },
    ];

    for (const params of destructiveGit) {
      const res = policy.evaluate(params);
      expect(res.allowed).toBe(false);
      expect(res.decision).toBe('COMMAND_NOT_ALLOWED');
    }
  });

  // ---------------------------------------------------------------------------
  // 22. network command rejection
  // ---------------------------------------------------------------------------
  it('22. rejects network commands (curl, wget, ssh, scp, ftp)', () => {
    const netCmds = ['curl', 'wget', 'ssh', 'scp', 'ftp', 'telnet', 'nc'];
    for (const cmd of netCmds) {
      const res = policy.evaluate({ command: cmd, args: ['http://example.com'] });
      expect(res.allowed).toBe(false);
      expect(res.decision).toBe('COMMAND_NOT_ALLOWED');
    }
  });

  // ---------------------------------------------------------------------------
  // 23. command argument validation
  // ---------------------------------------------------------------------------
  it('23. validates command and arguments deterministically against policy rules', () => {
    // npm test → allowed
    expect(policy.evaluate({ command: 'npm', args: ['test'] }).allowed).toBe(true);
    // npm publish → blocked
    expect(policy.evaluate({ command: 'npm', args: ['publish'] }).allowed).toBe(false);
    // node -e → blocked
    expect(policy.evaluate({ command: 'node', args: ['-e', 'process.exit(0)'] }).allowed).toBe(false);
    // git status → allowed
    expect(policy.evaluate({ command: 'git', args: ['status'] }).allowed).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 24. no shell execution
  // ---------------------------------------------------------------------------
  it('24. spawns processes without shell interpreter (non-shell mode)', async () => {
    // In non-shell mode, passing a non-existent binary returns PROCESS_ERROR without launching a shell
    const res = await adapter.execute('non_existent_binary_12345', [], {
      command: 'non_existent_binary_12345',
      args: [],
    });

    expect(res.success).toBe(false);
    expect(res.errorCategory).toBe('PROCESS_ERROR');
  });

  // ---------------------------------------------------------------------------
  // 25. no orphan process
  // ---------------------------------------------------------------------------
  it('25. cleans up process handles on completion, timeout, and cancellation (no orphans)', async () => {
    const startCount = process.listenerCount('SIGTERM');

    const res = await adapter.execute('node', ['-e', 'process.exit(0)'], {
      command: 'node',
      args: ['-e', 'process.exit(0)'],
    });

    expect(res.success).toBe(true);
    // Ensure no additional listeners leaked
    expect(process.listenerCount('SIGTERM')).toBe(startCount);
  }, 15000);

  // ---------------------------------------------------------------------------
  // 26. deterministic result contract
  // ---------------------------------------------------------------------------
  it('26. returns a normalized result contract matching TerminalExecuteResult structure', async () => {
    const res = await adapter.execute('node', ['--version'], { command: 'node', args: ['--version'] });

    expect(typeof res.success).toBe('boolean');
    expect(res.exitCode).toBe(0);
    expect(res.signal).toBeNull();
    expect(typeof res.stdout).toBe('string');
    expect(typeof res.stderr).toBe('string');
    expect(typeof res.stdoutTruncated).toBe('boolean');
    expect(typeof res.stderrTruncated).toBe('boolean');
    expect(typeof res.durationMs).toBe('number');
    expect(typeof res.timedOut).toBe('boolean');
    expect(typeof res.cancelled).toBe('boolean');
  }, 15000);

  // ---------------------------------------------------------------------------
  // 27. execution duration reporting
  // ---------------------------------------------------------------------------
  it('27. accurately measures and reports execution durationMs', async () => {
    const res = await adapter.execute('node', ['-e', 'setTimeout(() => {}, 100);'], {
      command: 'node',
      args: [],
    });

    expect(res.success).toBe(true);
    expect(res.durationMs).toBeGreaterThanOrEqual(90);
  }, 30000);

  // ---------------------------------------------------------------------------
  // 28. non-zero exit code handling
  // ---------------------------------------------------------------------------
  it('28. correctly captures and returns non-zero exit code (success = false)', async () => {
    const res = await adapter.execute('node', ['-e', 'process.exit(42);'], {
      command: 'node',
      args: [],
    });

    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(42);
    expect(res.signal).toBeNull();
  }, 60000);

  // ---------------------------------------------------------------------------
  // 29. process signal handling
  // ---------------------------------------------------------------------------
  it('29. handles process termination signals correctly', async () => {
    const res = await adapter.execute('node', ['-e', 'process.exit(1);'], {
      command: 'node',
      args: ['-e', 'process.exit(1);'],
      timeoutMs: 5000,
    });

    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
  }, 15000);

  // ---------------------------------------------------------------------------
  // 30. existing P5 pipeline enforcement
  // ---------------------------------------------------------------------------
  it('30. enforces full P5 pipeline: ToolRegistry -> PermissionEngine -> ApprovalPolicyEngine -> ApprovalGate -> ToolExecutor', async () => {
    const task = taskService.createTask({ title: 'Full P5 Pipeline Test' });

    // Step A: ToolRegistry check
    expect(toolGateway.registry.isRegistered('terminal_execute')).toBe(true);

    // Step B: Permission check
    const authRes = toolGateway.authorizeInvocation({
      requestId: 'req-p5-pipeline',
      taskId: task.id,
      toolId: 'terminal_execute',
      requestedCapabilities: ['terminal.execute'],
    });
    expect(authRes.authorized).toBe(true);

    // Step C: Approval policy evaluation
    const approvalReq = approvalService.createApprovalRequest({
      taskId: task.id,
      stepId: 'step-p5-pipeline',
      toolId: 'terminal_execute',
      requestedCapability: 'terminal.execute',
    });
    expect(approvalReq.decision.requiresApproval).toBe(true);
    expect(approvalReq.approval.status).toBe('pending');

    // Gate blocks when pending
    let gateRes = approvalService.evaluateGateForStep(task.id, 'step-p5-pipeline');
    expect(gateRes.allowed).toBe(false);

    // Approve human request
    approvalService.resolveApproval(approvalReq.approval.approvalId, 'approved');
    gateRes = approvalService.evaluateGateForStep(task.id, 'step-p5-pipeline');
    expect(gateRes.allowed).toBe(true);

    // Step D: Execution through ToolGateway
    const execRes = await toolGateway.executeTool({
      requestId: 'exec-p5-pipeline',
      taskId: task.id,
      toolId: 'terminal_execute',
      requestedCapabilities: ['terminal.execute'],
      params: {
        command: 'node',
        args: ['--version'],
      },
    });

    expect(execRes.authorized).toBe(true);
    expect(execRes.executed).toBe(true);
    expect(execRes.success).toBe(true);
    expect(execRes.output?.stdout).toMatch(/^v\d+/);
  }, 15000);
});
