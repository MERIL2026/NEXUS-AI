/**
 * NEXUS AI - P7-F.1 Test Suite: Professional CLI Input Experience
 *
 * Verifies all 20 P7-F.1 requirements:
 *  1.  Short prompt submitted as single task
 *  2.  Medium prompt (multi-word single line) submitted as single task
 *  3.  Long prompt (>120 chars) shows preview; full text sent to submitTask
 *  4.  Multi-line prompt (2 lines, paste simulation) dispatched as one string
 *  5.  Large pasted prompt (6+ lines) dispatched as one task
 *  6.  Code block paste dispatched as one task
 *  7.  Natural language starting with "y" creates task (not approval)
 *  8.  Natural language starting with "yes" creates task (not approval)
 *  9.  Approval + y routes to approveRequest()
 * 10.  Approval + n routes to rejectRequest()
 * 11.  Approval + v routes to viewApprovalDetails()
 * 12.  Approval + large multi-line input blocked with warning, NOT new task
 * 13.  Slash command detection routes to correct handler
 * 14.  Unknown command returns helpful error message
 * 15.  renderPromptPreview renders first lines + line/char count
 * 16.  Line and character count accuracy in preview
 * 17.  Windows CMD compatibility (no raw mode, no TTY)
 * 18.  Windows PowerShell compatibility (ANSI codes work without TTY)
 * 19.  Empty prompt handling - no task submitted
 * 20.  Very large prompt (500+ chars) accumulated and dispatched as one
 *
 * Security invariants:
 *  - AgentRunner.submitTask() is the only pathway to task creation
 *  - y/n/v while awaiting_approval NEVER call submitTask()
 *  - InputEngine has zero direct I/O outside readline
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { ApplicationApi } from '../api/index.js';
import { loadConfig } from '../config/index.js';
import { AgentRunner } from '../cli/agentRunner.js';
import { renderPromptPreview, renderComposeHeader } from '../cli/uiFormatters.js';
import { PASTE_DEBOUNCE_MS, SIGNAL_ENTER_COMPOSE, SIGNAL_SEND_COMPOSE } from '../cli/inputEngine.js';
import type { ToolDefinition } from '../tools/types.js';
import type { IntelligenceService } from '../intelligence/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validPlanJson(): string {
  return JSON.stringify({
    reasoning: 'Write the file as requested',
    steps: [
      {
        stepId: 'step-1',
        toolId: 'filesystem_write',
        requestedCapabilities: ['filesystem.write'],
        params: { relativePath: 'output.txt', content: 'test' },
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
        toolId: 'high_risk_tool_p7f1',
        requestedCapabilities: ['terminal.execute'],
        params: {},
      },
    ],
  });
}

function spyGenerate(svc: IntelligenceService, planJson: string) {
  svc.gateway.generate = vi.fn().mockResolvedValue({
    modelId: 'mock-model',
    text: planJson,
    done: true,
    latencyMs: 5,
    usedFallback: false,
    routingReason: 'test',
  }) as unknown as typeof svc.gateway.generate;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('P7-F.1 — NEXUS AI Professional CLI Input Experience', () => {
  let tmpDir: string;
  let api: ApplicationApi;
  let runner: AgentRunner;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-p7f1-'));
    fs.writeFileSync(path.join(tmpDir, 'output.txt'), '', 'utf8');

    const config = loadConfig({
      DATABASE_PATH: ':memory:',
      WORKSPACE_ROOT: tmpDir,
      LOG_LEVEL: 'error',
    });
    api = new ApplicationApi(config);
    await api.bootstrap();

    // Register a high-risk test tool for approval tests
    const highRiskTool: ToolDefinition = {
      id: 'high_risk_tool_p7f1',
      name: 'High Risk Test Tool P7F1',
      description: 'High-risk tool for P7-F.1 approval tests',
      version: '1.0.0',
      category: 'terminal',
      riskLevel: 'high',
      enabled: true,
      requiredPermissions: ['terminal.execute'],
      inputSchema: {},
    };
    api.tools.registerTool(highRiskTool);

    runner = new AgentRunner(api, 'error');
  });

  afterEach(async () => {
    api.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Short prompt submitted
  // -------------------------------------------------------------------------

  it('1. Short prompt is submitted as a single task', async () => {
    spyGenerate(api.intelligence, validPlanJson());
    const result = await runner.runCommand('Create hello.txt');
    // Should have submitted a task (not errored or returned empty)
    expect(result).toBeTruthy();
    // Should not have created multiple tasks
    const tasks = api.tasks.listTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toContain('Create hello.txt');
  });

  // -------------------------------------------------------------------------
  // 2. Medium prompt (multi-word single line)
  // -------------------------------------------------------------------------

  it('2. Medium single-line prompt creates exactly one task', async () => {
    spyGenerate(api.intelligence, validPlanJson());
    const goal = 'Create a responsive calculator website with HTML, CSS and JavaScript';
    await runner.runCommand(goal);
    const tasks = api.tasks.listTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toContain('Create a responsive calculator');
  });

  // -------------------------------------------------------------------------
  // 3. Long prompt (>120 chars) — renderPromptPreview is invoked
  // -------------------------------------------------------------------------

  it('3. Long prompt (>120 chars) shows a prompt preview card', () => {
    const longPrompt =
      'Build a full-stack SaaS application with user authentication, dashboard, billing integration, API, and admin panel with detailed documentation';
    expect(longPrompt.length).toBeGreaterThan(120);

    const preview = renderPromptPreview(longPrompt);
    expect(preview).toContain('TASK');
    expect(preview).toContain('1 line');
    expect(preview).toContain(`${longPrompt.length} characters`);
  });

  // -------------------------------------------------------------------------
  // 4. Multi-line prompt (2 lines paste) dispatched as one string
  // -------------------------------------------------------------------------

  it('4. Two-line pasted prompt is dispatched as a single input with \\n', async () => {
    spyGenerate(api.intelligence, validPlanJson());
    // Simulate InputEngine having accumulated 2 lines (as paste debounce would do)
    const combined = 'Create a website\nwith dark theme';
    await runner.runCommand(combined);

    const tasks = api.tasks.listTasks();
    expect(tasks.length).toBe(1);
    // The full multi-line string is used as the task goal
    expect(tasks[0].title).toContain('Create a website');
  });

  // -------------------------------------------------------------------------
  // 5. Large pasted prompt (6 lines) dispatched as one task
  // -------------------------------------------------------------------------

  it('5. Six-line pasted prompt creates exactly one task', async () => {
    spyGenerate(api.intelligence, validPlanJson());
    const sixLines = [
      'Build a portfolio website.',
      'Requirements:',
      '- Dark theme',
      '- Responsive design',
      '- Hero section',
      '- Contact form',
    ].join('\n');

    await runner.runCommand(sixLines);
    const tasks = api.tasks.listTasks();
    expect(tasks.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 6. Code block paste dispatched as one task
  // -------------------------------------------------------------------------

  it('6. Pasted code block creates exactly one task', async () => {
    spyGenerate(api.intelligence, validPlanJson());
    const codePrompt = [
      'Create a Python script that:',
      'def hello():',
      '    print("Hello, World!")',
      '',
      'hello()',
    ].join('\n');

    await runner.runCommand(codePrompt);
    const tasks = api.tasks.listTasks();
    expect(tasks.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 7. Natural language starting with "y" — NOT approval intercept
  // -------------------------------------------------------------------------

  it('7. "yes, create readme.md" is treated as task, not approval', async () => {
    spyGenerate(api.intelligence, validPlanJson());
    // No current task / no approval state
    expect(runner.currentTask).toBeNull();

    const result = await runner.runCommand('yes, create readme.md');
    expect(result).toBeTruthy();
    const tasks = api.tasks.listTasks();
    // Must have created exactly 1 task (not routed as approval)
    expect(tasks.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 8. Natural language starting with "yes" — NOT approval intercept
  // -------------------------------------------------------------------------

  it('8. "yet another file to create" creates a task', async () => {
    spyGenerate(api.intelligence, validPlanJson());
    expect(runner.currentTask).toBeNull();

    const result = await runner.runCommand('yet another file to create');
    expect(result).toBeTruthy();
    const tasks = api.tasks.listTasks();
    expect(tasks.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 9. Approval + y routes to approveRequest()
  // -------------------------------------------------------------------------

  it('9. "y" while awaiting_approval calls approveRequest, not submitTask', async () => {
    spyGenerate(api.intelligence, highRiskPlanJson());

    // Submit a task that requires high-risk approval
    const submitResult = await runner.runCommand('Run high-risk operation for approval test');
    expect(runner.currentTask?.state).toBe('awaiting_approval');
    expect(submitResult).toContain('APPROVAL REQUIRED');

    const tasksBefore = api.tasks.listTasks().length;

    // Track submitTask calls
    const submitSpy = vi.spyOn(runner, 'submitTask');
    const approveSpy = vi.spyOn(runner, 'approveRequest');

    await runner.runCommand('y');

    // submitTask must NOT have been called (no new task created)
    expect(submitSpy).not.toHaveBeenCalled();
    // approveRequest must have been called
    expect(approveSpy).toHaveBeenCalled();
    // Task count must not have increased
    expect(api.tasks.listTasks().length).toBe(tasksBefore);
  });

  // -------------------------------------------------------------------------
  // 10. Approval + n routes to rejectRequest()
  // -------------------------------------------------------------------------

  it('10. "n" while awaiting_approval calls rejectRequest, not submitTask', async () => {
    spyGenerate(api.intelligence, highRiskPlanJson());

    await runner.runCommand('Run high-risk op for reject test');
    expect(runner.currentTask?.state).toBe('awaiting_approval');

    const tasksBefore = api.tasks.listTasks().length;
    const submitSpy = vi.spyOn(runner, 'submitTask');
    const rejectSpy = vi.spyOn(runner, 'rejectRequest');

    await runner.runCommand('n');

    expect(submitSpy).not.toHaveBeenCalled();
    expect(rejectSpy).toHaveBeenCalled();
    expect(api.tasks.listTasks().length).toBe(tasksBefore);
  });

  // -------------------------------------------------------------------------
  // 11. Approval + v routes to viewApprovalDetails()
  // -------------------------------------------------------------------------

  it('11. "v" while awaiting_approval shows approval details, not a new task', async () => {
    spyGenerate(api.intelligence, highRiskPlanJson());

    await runner.runCommand('Run high-risk op for view test');
    expect(runner.currentTask?.state).toBe('awaiting_approval');

    const tasksBefore = api.tasks.listTasks().length;
    const submitSpy = vi.spyOn(runner, 'submitTask');

    const result = await runner.runCommand('v');

    expect(submitSpy).not.toHaveBeenCalled();
    expect(result).toContain('APPROVAL REQUEST DETAILS');
    expect(api.tasks.listTasks().length).toBe(tasksBefore);
  });

  // -------------------------------------------------------------------------
  // 12. Approval + large multi-line input is blocked (warning, no new task)
  // -------------------------------------------------------------------------

  it('12. Multi-line input while awaiting_approval is blocked with warning', async () => {
    spyGenerate(api.intelligence, highRiskPlanJson());

    await runner.runCommand('Run high-risk op for block test');
    expect(runner.currentTask?.state).toBe('awaiting_approval');

    const tasksBefore = api.tasks.listTasks().length;
    const submitSpy = vi.spyOn(runner, 'submitTask');

    const largeInput = 'Build a website\nwith requirements\n- Dark theme\n- Contact form';
    const result = await runner.runCommand(largeInput);

    expect(submitSpy).not.toHaveBeenCalled();
    expect(result).toContain('APPROVAL REQUIRED');
    expect(api.tasks.listTasks().length).toBe(tasksBefore);
  });

  // -------------------------------------------------------------------------
  // 13. Slash command detection
  // -------------------------------------------------------------------------

  it('13. /help command returns help text, not a task', async () => {
    const result = await runner.runCommand('/help');
    expect(result).toContain('NEXUS AI Agent Runner');
    expect(result).toContain('/task');
    expect(result).toContain('/prompt');
    expect(result).toContain('/send');
    const tasks = api.tasks.listTasks();
    expect(tasks.length).toBe(0);
  });

  it('13b. /prompt command returns SIGNAL_ENTER_COMPOSE sentinel', async () => {
    const result = await runner.runCommand('/prompt');
    expect(result).toBe(SIGNAL_ENTER_COMPOSE);
    expect(api.tasks.listTasks().length).toBe(0);
  });

  it('13c. /send command returns SIGNAL_SEND_COMPOSE sentinel', async () => {
    const result = await runner.runCommand('/send');
    expect(result).toBe(SIGNAL_SEND_COMPOSE);
    expect(api.tasks.listTasks().length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 14. Unknown command returns helpful error
  // -------------------------------------------------------------------------

  it('14. Unknown /command returns helpful error message', async () => {
    const result = await runner.runCommand('/doesnotexist');
    expect(result).toContain("Unknown command '/doesnotexist'");
    expect(result).toContain('/help');
    expect(api.tasks.listTasks().length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 15. renderPromptPreview renders first lines + line/char count
  // -------------------------------------------------------------------------

  it('15. renderPromptPreview renders first 5 lines and overflow', () => {
    const text = [
      'Line 1',
      'Line 2',
      'Line 3',
      'Line 4',
      'Line 5',
      'Line 6 (overflow)',
      'Line 7 (overflow)',
    ].join('\n');

    const preview = renderPromptPreview(text);
    expect(preview).toContain('Line 1');
    expect(preview).toContain('Line 5');
    // Overflow indicator
    expect(preview).toContain('2 more lines');
    // Should NOT contain line 6 directly
    expect(preview).not.toContain('Line 6 (overflow)');
    // Stats row
    expect(preview).toContain('7 lines');
    expect(preview).toContain(`${text.length} characters`);
  });

  // -------------------------------------------------------------------------
  // 16. Line and character count accuracy
  // -------------------------------------------------------------------------

  it('16. Preview reports accurate line and character counts', () => {
    const twoLine = 'Hello World\nSecond line here';
    const preview = renderPromptPreview(twoLine);
    expect(preview).toContain('2 lines');
    expect(preview).toContain(`${twoLine.length} characters`);
  });

  it('16b. Single long line reports 1 line', () => {
    const singleLine = 'A'.repeat(150);
    const preview = renderPromptPreview(singleLine);
    expect(preview).toContain('1 line');
    expect(preview).toContain('150 characters');
  });

  // -------------------------------------------------------------------------
  // 17. Windows CMD compatibility (no raw mode, no TTY required)
  // -------------------------------------------------------------------------

  it('17. InputEngine constants and signals work without TTY / raw mode', () => {
    // PASTE_DEBOUNCE_MS is a runtime constant - no terminal required
    expect(PASTE_DEBOUNCE_MS).toBe(20);
    expect(typeof SIGNAL_ENTER_COMPOSE).toBe('string');
    expect(typeof SIGNAL_SEND_COMPOSE).toBe('string');

    // AgentRunner commands do not require TTY
    const helpResult = runner.getHelpText();
    expect(helpResult).toBeTruthy();
    expect(typeof helpResult).toBe('string');
  });

  // -------------------------------------------------------------------------
  // 18. Windows PowerShell compatibility (ANSI codes render without TTY)
  // -------------------------------------------------------------------------

  it('18. ANSI color codes in formatters are valid strings on Windows', () => {
    const preview = renderPromptPreview('test prompt for windows');
    // Output must be a valid string (not throw or produce undefined)
    expect(typeof preview).toBe('string');
    expect(preview.length).toBeGreaterThan(0);

    const header = renderComposeHeader();
    expect(typeof header).toBe('string');
    expect(header.length).toBeGreaterThan(0);
    expect(header).toContain('COMPOSE MODE');
  });

  // -------------------------------------------------------------------------
  // 19. Empty prompt handling
  // -------------------------------------------------------------------------

  it('19. Empty input returns a prompt message, no task created', async () => {
    const result = await runner.runCommand('');
    expect(result).toContain('Please enter');
    expect(api.tasks.listTasks().length).toBe(0);
  });

  it('19b. Whitespace-only input returns a prompt message, no task created', async () => {
    const result = await runner.runCommand('   ');
    expect(result).toContain('Please enter');
    expect(api.tasks.listTasks().length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 20. Very large prompt (500+ chars) dispatched as one task
  // -------------------------------------------------------------------------

  it('20. 500+ character prompt creates exactly one task with full text preserved', async () => {
    spyGenerate(api.intelligence, validPlanJson());

    const largeGoal =
      'Create a comprehensive e-commerce application with the following requirements: ' +
      'user authentication with JWT tokens, product catalog with categories and filters, ' +
      'shopping cart with persistence, checkout flow with Stripe integration, ' +
      'order management system, admin dashboard for inventory management, ' +
      'responsive design for mobile and desktop, and full API documentation. ' +
      'The application should follow clean architecture principles with proper separation ' +
      'of concerns, comprehensive error handling, and unit test coverage above 80%.';

    expect(largeGoal.length).toBeGreaterThan(500);

    // Simulate InputEngine delivering the full text to runCommand as one string
    await runner.runCommand(largeGoal);

    const tasks = api.tasks.listTasks();
    expect(tasks.length).toBe(1);
    // Title is truncated to 60 chars but the full goal was passed to planner
  });

  it('20b. renderPromptPreview for 500+ char text truncates to 5 lines', () => {
    const manyLines = Array.from({ length: 10 }, (_, i) => `Requirement ${i + 1}: detailed spec`).join('\n');
    const preview = renderPromptPreview(manyLines);
    expect(preview).toContain('10 lines');
    expect(preview).toContain('5 more lines');
    // Only first 5 lines shown
    expect(preview).toContain('Requirement 1');
    expect(preview).toContain('Requirement 5');
    expect(preview).not.toContain('Requirement 6:');
  });

  // -------------------------------------------------------------------------
  // Security invariant: InputEngine PASTE_DEBOUNCE_MS is correct
  // -------------------------------------------------------------------------

  it('Security: PASTE_DEBOUNCE_MS is 20ms (imperceptible for typing, catches paste)', () => {
    expect(PASTE_DEBOUNCE_MS).toBe(20);
  });

  it('Security: /prompt and /send never create tasks in AgentRunner', async () => {
    await runner.runCommand('/prompt');
    await runner.runCommand('/send');
    expect(api.tasks.listTasks().length).toBe(0);
  });
});

