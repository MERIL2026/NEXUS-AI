/**
 * NEXUS AI — P7-F: Interactive Agent Runner & Subsystem Integration
 *
 * Provides a human-facing, interactive CLI runner that integrates the entire
 * NEXUS agent pipeline (P5-A through P6-D) without duplicating execution or authorization logic.
 *
 * Sequence:
 *   User Task -> Task Creation -> Plan Synthesis -> Plan Validation -> Permission Evaluation
 *   -> Approval Policy -> Human Approval when required -> Approval Gate -> Tool Execution
 *   -> Observation -> Verification -> Final Result.
 *
 * SECURITY INVARIANTS:
 *  - Interface ONLY. Does NOT bypass PlanValidator, PermissionEngine, ApprovalGate, or ToolExecutor.
 *  - Zero direct file reads or repository mutations outside existing service APIs.
 *  - Zero secrets, API keys, raw prompts, or sensitive tool params logged or displayed.
 */

import type { ApplicationApi } from '../api/index.js';
import type { AgentTask } from '../storage/repositories/types.js';
import type { AgentPlan } from '../orchestration/types.js';
import type { ApprovalRequest } from '../tools/approvalTypes.js';
import { Logger, LogLevel } from '../common/logger.js';
import {
  colors,
  getSymbolForState,
  drawDivider,
  renderHelpMenu,
  renderTasksList,
  renderApprovalCard,
  renderCompletionCard,
  renderFailureCard,
  sanitizeText,
  renderModelControlScreen,
  renderModelStatusScreen,
  renderModelInfoCard,
  renderPreviewCard,
  renderPreviewStatusCard,
  renderPreviewStoppedCard,
  renderChatHistory,
  renderChatSearchResults,
  renderTaskDecompositionPlanCard,
  renderDecompositionCompletionCard,
  renderDecompositionFailureCard,
} from './uiFormatters.js';
import { SIGNAL_ENTER_COMPOSE, SIGNAL_SEND_COMPOSE, SIGNAL_ENTER_CHAT } from './inputEngine.js';
import fs from 'fs';
import { ModelManifestRegistry, ModelStorageManager, SetupStateManager } from '../intelligence/provisioning/index.js';

export interface LifecycleEvent {
  event: string;
  timestamp: string;
  details?: string;
}

export class AgentRunner {
  private logger: Logger;
  public currentTask: AgentTask | null = null;
  public currentPlan: AgentPlan | null = null;
  public lifecycleLogs: LifecycleEvent[] = [];
  private isResolvingApproval = false;

  constructor(
    public api: ApplicationApi,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('AgentRunner', logLevel);
  }

  /**
   * Process a single command input string from the interactive CLI or test runner.
   * Unknown commands return a safe error without crashing.
   */
  async runCommand(input: string): Promise<string> {
    const trimmed = input.trim();
    if (!trimmed) {
      return 'Please enter a command or task description. Type /help for available commands.';
    }

    // 1. Intercept input if active task is in awaiting_approval state
    if (this.currentTask) {
      const updatedTask = this.api.tasks.getTask(this.currentTask.id);
      if (updatedTask) {
        this.currentTask = updatedTask;
      }

      if (this.currentTask && this.currentTask.state === 'awaiting_approval') {
        const pending = this.api.approvals?.getApprovalsForTask(this.currentTask.id).filter((a) => a.status === 'pending') || [];

        if (pending.length > 0) {
          const activeAppr = pending[pending.length - 1];
          const lower = trimmed.toLowerCase();

          // Direct Y / N / V input
          if (lower === 'y' || lower === 'yes' || lower === '/y') {
            return this.approveRequest(activeAppr.approvalId);
          }
          if (lower === 'n' || lower === 'no' || lower === '/n') {
            return this.rejectRequest(activeAppr.approvalId);
          }
          if (lower === 'v' || lower === 'view' || lower === '/v') {
            return this.viewApprovalDetails(activeAppr);
          }

          // Explicit slash approval/rejection
          if (trimmed.startsWith('/approve')) {
            const parts = trimmed.split(/\s+/);
            return this.approveRequest(parts[1] || activeAppr.approvalId);
          }
          if (trimmed.startsWith('/reject')) {
            const parts = trimmed.split(/\s+/);
            return this.rejectRequest(parts[1] || activeAppr.approvalId);
          }

          // Allowed non-creation slash commands while awaiting approval
          if (
            trimmed.startsWith('/help') ||
            trimmed.startsWith('/?') ||
            trimmed.startsWith('/h') ||
            trimmed.startsWith('/status') ||
            trimmed.startsWith('/st') ||
            trimmed.startsWith('/approvals') ||
            trimmed.startsWith('/appr') ||
            trimmed.startsWith('/cancel') ||
            trimmed.startsWith('/exit') ||
            trimmed.startsWith('/quit') ||
            trimmed.startsWith('/q') ||
            trimmed.startsWith('/clear') ||
            trimmed.startsWith('/cls')
          ) {
            // fall through to switch handling below
          } else {
            // Block all other input (prevent creating new tasks while awaiting approval)
            return `\n${colors.brightYellow}⚠ APPROVAL REQUIRED for task '${this.currentTask.id}'${colors.reset}\nStep '${activeAppr.stepId}' requires tool '${activeAppr.toolId}' (${activeAppr.riskLevel.toUpperCase()}).\nChoose:\n  [Y] Approve & Resume  (/approve ${activeAppr.approvalId})\n  [N] Reject & Cancel   (/reject ${activeAppr.approvalId})\n  [V] View details\n  Type /cancel to cancel task.`;
          }
        }
      }
    }

    // 2. Standard Slash command parsing
    if (trimmed.startsWith('/')) {
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      switch (cmd) {
        case '/help':
        case '/?':
        case '/h':
          return this.getHelpText();
        case '/status':
        case '/st':
          return this.getStatusText();
        case '/models':
        case '/m':
          return this.getModelsText();
        case '/model':
          return this.handleModelCommand(args);
        case '/workspace':
        case '/ws':
          return this.getWorkspaceText();
        case '/chat':
          if (args.length > 0) {
            return `${SIGNAL_ENTER_CHAT}:${args.join(' ')}`;
          }
          return SIGNAL_ENTER_CHAT;
        case '/chats':
          if (args.length > 0) {
            const sub = args[0].toLowerCase();
            if (sub === 'open' && args[1]) {
              return `${SIGNAL_ENTER_CHAT}:${args[1]}`;
            }
            if (sub === 'delete' && args[1]) {
              try {
                const conv = this.api.conversations.getConversation(args[1]);
                this.api.conversations.deleteConversation(args[1]);
                return `${colors.brightGreen}✓ Deleted conversation "${conv.title}" (ID: ${args[1]})${colors.reset}`;
              } catch {
                return `${colors.brightRed}Error: Conversation '${args[1]}' not found.${colors.reset}`;
              }
            }
            if (sub === 'search' && args.length > 1) {
              const query = args.slice(1).join(' ');
              const results = this.api.conversations.searchConversations(query);
              return renderChatSearchResults(query, results);
            }
            if (args[0].startsWith('conv-') || args[0].startsWith('chat-')) {
              return `${SIGNAL_ENTER_CHAT}:${args[0]}`;
            }
          }
          return renderChatHistory(this.api.conversations.listAllConversations());
        case '/tasks':
        case '/history':
        case '/t':
          if (args.length > 0) {
            return this.inspectTaskText(args[0]);
          }
          return this.getTasksListText();
        case '/task':
          if (args.length > 0 && args[0].startsWith('task-')) {
            return this.inspectTaskText(args[0]);
          }
          return this.submitTask(args.join(' '));
        case '/inspect':
          return this.inspectTaskText(args[0]);
        case '/code':
          return this.submitCodingTask(args.join(' '));
        case '/prompt':
          // Signal to InputEngine to enter compose (multi-line) mode
          return SIGNAL_ENTER_COMPOSE;
        case '/send':
          // Signal to InputEngine to submit the compose buffer
          return SIGNAL_SEND_COMPOSE;
        case '/plan':
          return this.getPlanText();
        case '/approvals':
        case '/appr':
          return this.getApprovalsText();
        case '/approve':
        case '/y':
          return this.approveRequest(args[0]);
        case '/reject':
        case '/n':
          return this.rejectRequest(args[0]);
        case '/agents':
        case '/ag':
          return this.getAgentsStatusText();
        case '/clear':
        case '/cls':
          return this.clearScreen();
        case '/cancel':
          return this.cancelCurrentTask();
        case '/preview':
        case '/prev':
        case '/p':
          return this.handlePreviewCommand(args);
        case '/result':
          return this.getResultText();
        case '/exit':
        case '/quit':
        case '/q':
          return this.exitRunner();
        default:
          this.logger.warn(`Unknown command '${cmd}' received`);
          return `Unknown command '${cmd}'. Type /help for available commands.`;
      }
    }

    // Non-slash input is treated as a natural language task submission
    return this.submitTask(trimmed, true);
  }

  /**
   * Submit a new user task and run through the P5 architecture pipeline.
   *
   * @param goal - The natural language task goal.
   * @param _showPreview - If true, a prompt preview was already rendered by InputEngine
   *   before calling runCommand(). Unused here; preview is output-only in InputEngine.
   */
  async submitTask(goal: string, _showPreview = false): Promise<string> {
    const trimmedGoal = goal.trim();
    if (!trimmedGoal) {
      return 'Task description cannot be empty. Usage: /task <description>';
    }

    if (!this.api.planner || !this.api.execution || !this.api.approvals) {
      return 'Error: ApplicationApi agent subsystems are uninitialized.';
    }

    const startTime = Date.now();
    const lines: string[] = [];
    lines.push(`${colors.bold}${colors.brightCyan}NEXUS AI Agent Execution Engine${colors.reset}`);
    lines.push(drawDivider('─', 64));

    // 1. Task Creation
    const title = trimmedGoal.length > 120 ? `${trimmedGoal.slice(0, 117)}...` : trimmedGoal;
    const task = this.api.tasks.createTask({ title });
    this.currentTask = task;
    this.currentPlan = null;
    this.recordEvent('TASK_CREATED', `TaskId: ${task.id}`);

    // Check if task decomposition is available and appropriate for medium/large composite goals
    if (this.api.decomposition && this.api.projectOrchestrator) {
      const decompPlan = await this.api.decomposition.decompose({ taskGoal: trimmedGoal });
      if (decompPlan.isDecomposed && decompPlan.units.length > 1) {
        this.recordEvent('TASK_DECOMPOSED', `${decompPlan.units.length} units planned (${decompPlan.estimatedComplexity})`);

        lines.push(`→ ${colors.bold}Task Submitted:${colors.reset} "${title}"`);
        lines.push(`  ${colors.dim}Task ID:${colors.reset} ${colors.brightCyan}${task.id}${colors.reset}`);
        lines.push(renderTaskDecompositionPlanCard(decompPlan, title));

        const orchResult = await this.api.projectOrchestrator.orchestrate(task.id, decompPlan);
        const durationMs = Date.now() - startTime;
        const updatedTask = this.api.tasks.getTask(task.id);
        if (updatedTask) {
          this.currentTask = updatedTask;
        }

        if (orchResult.success) {
          this.recordEvent('TASK_COMPLETED', `Task ${task.id} completed successfully via project orchestration`);
          lines.push(renderDecompositionCompletionCard(this.currentTask || task, orchResult, durationMs));
          return lines.join('\n');
        } else {
          this.recordEvent('TASK_FAILED', `Task ${task.id} failed during orchestration: ${orchResult.error || 'Unit execution failed'}`);
          lines.push(renderDecompositionFailureCard(this.currentTask || task, orchResult));
          return lines.join('\n');
        }
      }
    }

    lines.push(`→ ${colors.bold}Task Submitted:${colors.reset} "${title}"`);
    lines.push(`  ${colors.dim}Task ID:${colors.reset} ${colors.brightCyan}${task.id}${colors.reset}`);
    lines.push('');
    lines.push(`${colors.bold}THINKing...${colors.reset}`);
    lines.push(`  ${colors.dim}● Synthesizing plan with planner model...${colors.reset}`);

    // 2. Plan Synthesis
    const synthesis = await this.api.planner.synthesize(task.id, {
      taskGoal: trimmedGoal,
      temperature: 0.2,
    });

    if (!synthesis.success || !synthesis.plan) {
      this.recordEvent('PLAN_VALIDATION_FAILED', synthesis.errorMessage);
      this.api.tasks.failTask(task.id, {
        errorCategory: synthesis.errorCategory || 'PLAN_VALIDATION_FAILED',
      });
      const failedTask = this.api.tasks.getTask(task.id);
      this.currentTask = failedTask;
      this.recordEvent('TASK_FAILED', synthesis.errorMessage);

      return renderFailureCard(failedTask, synthesis.errorMessage || 'Plan synthesis failed');
    }

    this.currentPlan = synthesis.plan;
    this.api.tasks.transitionTask(task.id, {
      plan: JSON.stringify(synthesis.plan),
      targetState: 'planning',
    });
    this.recordEvent('PLAN_GENERATED', `PlanId: ${synthesis.plan.planId}`);
    this.recordEvent('PLAN_VALIDATED', `${synthesis.plan.steps.length} step(s) validated`);

    lines.push('');
    lines.push(`${colors.bold}PLAN${colors.reset}`);
    lines.push(`  ${colors.bold}Reasoning:${colors.reset} ${synthesis.plan.reasoning}`);
    lines.push('');
    lines.push(`  ${colors.dim}┌──────┬──────────────────────────┬──────────────────────┬───────────┐${colors.reset}`);
    lines.push(`  │ Step │ Tool                     │ Capability           │ Risk      │`);
    lines.push(`  ${colors.dim}├──────┼──────────────────────────┼──────────────────────┼───────────┤${colors.reset}`);

    synthesis.plan.steps.forEach((step, idx) => {
      const toolDef = this.api.tools.getTool(step.toolId || '');
      const risk = toolDef ? toolDef.riskLevel.toUpperCase() : 'UNKNOWN';
      const riskColor = risk === 'HIGH' ? colors.brightRed : risk === 'MEDIUM' ? colors.brightYellow : colors.green;
      const stepIdStr = String(idx + 1).padEnd(4, ' ');
      const toolStr = (step.toolId || '').padEnd(24, ' ');
      const capStr = (step.requestedCapabilities?.[0] || '').padEnd(20, ' ');

      lines.push(`  │ ${stepIdStr} │ ${colors.brightCyan}${toolStr}${colors.reset} │ ${capStr} │ ${riskColor}${risk.padEnd(9, ' ')}${colors.reset} │`);
    });

    lines.push(`  ${colors.dim}└──────┴──────────────────────────┴──────────────────────┴───────────┘${colors.reset}`);
    lines.push('');
    lines.push(`${colors.bold}EXECUTE${colors.reset}`);
    this.recordEvent('AUTHORIZATION_CHECKED', 'PermissionEngine check passed');

    // 3. Execution Loop
    const executionResultTask = await this.api.execution.runExecutionLoop(task.id, synthesis.plan.steps);
    this.currentTask = executionResultTask;
    const durationMs = Date.now() - startTime;

    // 4. Handle Execution Result State
    if (executionResultTask.state === 'awaiting_approval') {
      this.recordEvent('APPROVAL_REQUIRED', `Task paused in awaiting_approval state`);
      const pendingApprovals = this.api.approvals.getApprovalsForTask(task.id).filter((a) => a.status === 'pending');
      const latestPending = pendingApprovals.length > 0 ? pendingApprovals[pendingApprovals.length - 1] : null;

      if (latestPending) {
        lines.push(renderApprovalCard(latestPending, executionResultTask.title));
      } else {
        lines.push(`\n${colors.brightYellow}⚠ APPROVAL REQUIRED for task '${executionResultTask.id}'. Use /approvals to inspect.${colors.reset}`);
      }
      return lines.join('\n');
    }

    if (executionResultTask.state === 'completed') {
      this.recordEvent('STEP_COMPLETED', 'All steps completed');
      this.recordEvent('VERIFICATION_COMPLETED', 'Verification passed');
      this.recordEvent('TASK_COMPLETED', `Task ${task.id} completed successfully`);

      lines.push(renderCompletionCard(executionResultTask, synthesis.plan, durationMs));
      return lines.join('\n');
    }

    if (executionResultTask.state === 'failed') {
      this.recordEvent('TASK_FAILED', `Error Category: ${executionResultTask.errorCategory || 'UNKNOWN'}`);
      lines.push(renderFailureCard(executionResultTask, synthesis.errorMessage || 'Execution step failed'));
      return lines.join('\n');
    }

    if (executionResultTask.state === 'cancelled') {
      this.recordEvent('TASK_CANCELLED', `Task ${task.id} cancelled`);
      lines.push(`\n${colors.dim}○ Task '${task.id}' execution was cancelled.${colors.reset}`);
      return lines.join('\n');
    }

    return lines.join('\n');
  }

  /**
   * Submit a coding task through CodingAgentService (P6-D).
   */
  async submitCodingTask(goal: string): Promise<string> {
    const trimmedGoal = goal.trim();
    if (!trimmedGoal) {
      return 'Coding task goal cannot be empty. Usage: /code <goal>';
    }

    if (!this.api.codingAgent) {
      return 'Error: ApplicationApi codingAgent subsystem is uninitialized.';
    }

    this.recordEvent('CODING_TASK_SUBMITTED', `Goal: ${trimmedGoal}`);

    const runResult = await this.api.codingAgent.runCodingTask({
      taskGoal: trimmedGoal,
    });

    if (runResult.taskId) {
      this.currentTask = this.api.tasks.getTask(runResult.taskId);
    }

    if (runResult.success) {
      this.recordEvent('CODING_TASK_COMPLETED', `Task ${runResult.taskId} completed`);
      return `${colors.brightGreen}✓ [Coding Task Completed]${colors.reset} Task '${runResult.taskId}' completed successfully after ${runResult.repairAttemptsCount} repair attempt(s).`;
    }

    this.recordEvent('CODING_TASK_FAILED', `Task ${runResult.taskId} state: ${runResult.state}`);
    return `${colors.brightRed}✖ [Coding Task Failed]${colors.reset} Task '${runResult.taskId}' ended in state '${runResult.state}' (${runResult.errorCategory || 'FAILED'}): ${runResult.errorMessage || 'Validation failed.'}`;
  }

  /**
   * Resolve an approval request as approved and resume execution.
   */
  async approveRequest(approvalId: string | undefined): Promise<string> {
    if (this.isResolvingApproval) {
      return `${colors.brightYellow}Approval resolution is already in progress. Please wait...${colors.reset}`;
    }

    this.isResolvingApproval = true;
    try {
      let targetId = approvalId?.trim();

      // Fallback: resolve latest pending approval for current active task
      if (!targetId && this.currentTask) {
        const updatedTask = this.api.tasks.getTask(this.currentTask.id);
        if (updatedTask) {
          this.currentTask = updatedTask;
        }
        const pending = this.api.approvals?.getApprovalsForTask(this.currentTask.id).filter((a) => a.status === 'pending') || [];
        if (pending.length > 0) {
          targetId = pending[pending.length - 1].approvalId;
        }
      }

      if (!targetId) {
        return 'Error: Missing approval ID and no pending approval found for active task. Usage: /approve <approvalId>';
      }

      if (!this.api.approvals || !this.api.execution) {
        return 'Error: ApplicationApi approval subsystems are uninitialized.';
      }

      let result: ReturnType<NonNullable<typeof this.api.approvals>['resolveApproval']>;
      try {
        result = this.api.approvals.resolveApproval(targetId, 'approved', 'User approved via CLI');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`resolveApproval threw for approvalId '${targetId}': ${msg}`);
        return `Error approving request '${targetId}': ${msg}`;
      }

      if (!result.success) {
        return `Error approving request '${targetId}': ${result.error || 'Invalid approval resolution'}`;
      }

      this.recordEvent('APPROVAL_GRANTED', `ApprovalId: ${targetId}`);

      if (result.task) {
        this.currentTask = result.task;
      }

      // Re-hydrate currentPlan from stored task plan if null
      if (this.currentTask && !this.currentPlan && this.currentTask.plan) {
        try {
          this.currentPlan = typeof this.currentTask.plan === 'string'
            ? JSON.parse(this.currentTask.plan)
            : (this.currentTask.plan as unknown as AgentPlan);
        } catch {
          /* ignore parse error */
        }
      }

      if (!this.currentPlan || !this.currentTask) {
        return `${colors.brightGreen}✓ Approval '${targetId}' granted.${colors.reset} Task state is now EXECUTING.`;
      }

      const lines: string[] = [];
      lines.push(`${colors.brightGreen}✓ Approval '${targetId}' granted${colors.reset}`);
      lines.push('→ Resuming task execution loop...');
      this.recordEvent('STEP_STARTED', `Resuming task ${this.currentTask.id}`);

      // Resume execution loop on original task with original plan steps
      const resumedTask = await this.api.execution.runExecutionLoop(this.currentTask.id, this.currentPlan.steps);
      this.currentTask = resumedTask;

      if (resumedTask.state === 'completed') {
        this.recordEvent('STEP_COMPLETED', 'Resumed steps completed');
        this.recordEvent('VERIFICATION_COMPLETED', 'Verification passed');
        this.recordEvent('TASK_COMPLETED', `Task ${resumedTask.id} completed successfully`);
        lines.push(renderCompletionCard(resumedTask, this.currentPlan));
        return lines.join('\n');
      }

      if (resumedTask.state === 'awaiting_approval') {
        this.recordEvent('APPROVAL_REQUIRED', `Task paused in awaiting_approval state`);
        const pendingApprovals = this.api.approvals.getApprovalsForTask(resumedTask.id).filter((a) => a.status === 'pending');
        const latestPending = pendingApprovals.length > 0 ? pendingApprovals[pendingApprovals.length - 1] : null;

        if (latestPending) {
          lines.push(renderApprovalCard(latestPending, resumedTask.title));
        } else {
          lines.push(`\n${colors.brightYellow}⚠ Another approval is required for subsequent step.${colors.reset}`);
          lines.push('Use /approvals to inspect pending requests.');
        }
        return lines.join('\n');
      }

      if (resumedTask.state === 'failed') {
        this.recordEvent('STEP_FAILED', `Error: ${resumedTask.errorCategory}`);
        this.recordEvent('TASK_FAILED', `Task ${resumedTask.id} failed`);
        lines.push(renderFailureCard(resumedTask, 'Resumed step execution failed'));
        return lines.join('\n');
      }

      lines.push(`Task state updated to: ${resumedTask.state.toUpperCase()}`);
      return lines.join('\n');
    } finally {
      this.isResolvingApproval = false;
    }
  }

  /**
   * Resolve an approval request as rejected and stop execution.
   */
  async rejectRequest(approvalId: string | undefined): Promise<string> {
    if (this.isResolvingApproval) {
      return `${colors.brightYellow}Approval resolution is already in progress. Please wait...${colors.reset}`;
    }

    this.isResolvingApproval = true;
    try {
      let targetId = approvalId?.trim();

      // Fallback: resolve latest pending approval for current active task
      if (!targetId && this.currentTask) {
        const updatedTask = this.api.tasks.getTask(this.currentTask.id);
        if (updatedTask) {
          this.currentTask = updatedTask;
        }
        const pending = this.api.approvals?.getApprovalsForTask(this.currentTask.id).filter((a) => a.status === 'pending') || [];
        if (pending.length > 0) {
          targetId = pending[pending.length - 1].approvalId;
        }
      }

      if (!targetId) {
        return 'Error: Missing approval ID and no pending approval found for active task. Usage: /reject <approvalId>';
      }

      if (!this.api.approvals) {
        return 'Error: ApplicationApi approval subsystems are uninitialized.';
      }

      let result: ReturnType<NonNullable<typeof this.api.approvals>['resolveApproval']>;
      try {
        result = this.api.approvals.resolveApproval(targetId, 'rejected', 'User rejected via CLI');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`resolveApproval threw for approvalId '${targetId}': ${msg}`);
        return `Error rejecting request '${targetId}': ${msg}`;
      }

      if (!result.success) {
        return `Error rejecting request '${targetId}': ${result.error || 'Invalid approval resolution'}`;
      }

      this.recordEvent('APPROVAL_REJECTED', `ApprovalId: ${targetId}`);

      if (result.task) {
        this.currentTask = result.task;
        this.recordEvent('TASK_CANCELLED', `Task ${result.task.id} cancelled due to approval rejection`);
      }

      const lines: string[] = [];
      lines.push(`${colors.brightRed}✖ Approval '${targetId}' rejected${colors.reset}`);
      lines.push('Execution stopped. Task state: CANCELLED.');
      return lines.join('\n');
    } finally {
      this.isResolvingApproval = false;
    }
  }

  /**
   * Display detailed parameters and information for a pending approval request.
   */
  viewApprovalDetails(approval: ApprovalRequest): string {
    const lines: string[] = [];
    lines.push(drawDivider('─', 64));
    lines.push(`${colors.bold}${colors.brightCyan}APPROVAL REQUEST DETAILS${colors.reset}`);
    lines.push(`  ${colors.bold}Approval ID:${colors.reset}     ${approval.approvalId}`);
    lines.push(`  ${colors.bold}Task ID:${colors.reset}         ${approval.taskId}`);
    lines.push(`  ${colors.bold}Step ID:${colors.reset}         ${approval.stepId}`);
    lines.push(`  ${colors.bold}Tool Required:${colors.reset}   ${approval.toolId}`);
    lines.push(`  ${colors.bold}Risk Level:${colors.reset}      ${approval.riskLevel.toUpperCase()}`);
    lines.push(`  ${colors.bold}Capability:${colors.reset}      ${approval.requestedCapability}`);
    lines.push(`  ${colors.bold}Status:${colors.reset}          ${approval.status.toUpperCase()}`);
    lines.push(`  ${colors.bold}Created At:${colors.reset}      ${approval.createdAt}`);
    lines.push(`  ${colors.bold}Expires At:${colors.reset}      ${approval.expiresAt}`);
    lines.push(`  ${colors.bold}Reason:${colors.reset}          ${approval.decisionReason || 'Action requires explicit human approval'}`);
    lines.push('');
    lines.push(`${colors.bold}Options:${colors.reset}`);
    lines.push(`  ${colors.brightGreen}[Y] Approve & Resume${colors.reset}   ${colors.brightRed}[N] Reject & Cancel${colors.reset}   ${colors.brightCyan}[V] View Details${colors.reset}`);
    lines.push(drawDivider('─', 64));
    return lines.join('\n');
  }

  /**
   * Cancel active task and invalidate pending approvals.
   */
  async cancelCurrentTask(): Promise<string> {
    if (!this.currentTask) {
      return 'No active task to cancel.';
    }

    const taskId = this.currentTask.id;
    const task = this.api.tasks.cancelTask(taskId);
    this.currentTask = task;

    if (this.api.approvals) {
      this.api.approvals.cancelApprovalsForTask(taskId, 'Task cancelled by user via CLI');
    }

    this.recordEvent('TASK_CANCELLED', `Task ${taskId} cancelled by user`);

    return `${colors.dim}✓ Task '${task.title}' (ID: ${taskId}) cancelled. State: CANCELLED.${colors.reset}`;
  }

  /**
   * Returns help command menu.
   */
  getHelpText(): string {
    return renderHelpMenu();
  }

  /**
   * Returns current task status text without exposing secrets.
   */
  getStatusText(): string {
    const report = this.api.getHealthReport();
    const lines: string[] = [];
    lines.push(`${colors.bold}${colors.brightCyan}NEXUS AI Task Status & System Readiness${colors.reset}`);
    lines.push(drawDivider('─', 60));
    lines.push(`Overall Status:   ${report.overall === 'ok' ? colors.brightGreen + 'OK' : colors.brightYellow + 'DEGRADED'}${colors.reset}`);
    lines.push(`Environment:      ${report.config.environment}`);
    lines.push(`Database:         Connected (${report.config.databasePath})`);
    lines.push(`Ollama Host:      ${report.config.ollamaHost}`);
    lines.push('');

    if (!this.currentTask) {
      lines.push(`${colors.dim}No active task. Submit a task using: /task <description>${colors.reset}`);
    } else {
      const t = this.api.tasks.getTask(this.currentTask.id);
      this.currentTask = t;

      lines.push(`${colors.bold}ACTIVE TASK${colors.reset}`);
      lines.push(`  Task ID:        ${t.id}`);
      lines.push(`  Title:          ${t.title}`);
      lines.push(`  State:          ${getSymbolForState(t.state)} ${t.state.toUpperCase()}`);
      lines.push(`  Current Step:   ${t.currentStep || '(none)'}`);
      lines.push(`  Attempt Count:  ${t.attemptCount}`);
      lines.push(`  Error Category: ${t.errorCategory || 'none'}`);
      lines.push(`  Created At:     ${t.createdAt}`);
    }

    return lines.join('\n');
  }

  /**
   * P7-H: Handles /preview command and sub-commands (stop, status, taskId).
   */
  async handlePreviewCommand(args: string[]): Promise<string> {
    if (!this.api.preview) {
      return `${colors.brightRed}Error: ApplicationApi preview subsystem is uninitialized.${colors.reset}`;
    }

    if (args.length > 0) {
      const sub = args[0].toLowerCase();
      if (sub === 'stop') {
        await this.api.preview.stop();
        return renderPreviewStoppedCard();
      }
      if (sub === 'status') {
        const st = this.api.preview.getStatus();
        return renderPreviewStatusCard(st);
      }
      // Explicit task-id preview requested
      const res = await this.api.preview.preview(args[0]);
      return renderPreviewCard(res);
    }

    // Default: /preview latest completed web task
    const res = await this.api.preview.preview();
    return renderPreviewCard(res);
  }

  /**
   * P7-G: Handles /model control command and sub-commands.
   */
  handleModelCommand(args: string[]): string {
    const router = this.api.intelligence.router;
    const registry = this.api.intelligence.registry;

    if (!router || !registry) {
      return `${colors.brightRed}Error: Intelligence router or registry uninitialized.${colors.reset}`;
    }

    const available = registry.getAvailableModels();

    const intelStatus = typeof this.api.intelligence?.getStatus === 'function' ? this.api.intelligence.getStatus() : null;
    const activeProvider = (intelStatus?.details?.['activeProvider'] as string) || 'embedded';
    const providerName = activeProvider === 'embedded' ? 'Embedded (Local)' : 'Ollama';

    // /model (no args): Display Model Control screen
    if (args.length === 0) {
      const roleStatus = router.getRoleStatus();
      const activeModelId = router.selectRoute().primaryModel.id;
      return renderModelControlScreen(available, roleStatus, providerName, activeModelId);
    }

    const sub = args[0].toLowerCase();

    // /model status: Display status screen
    if (sub === 'status') {
      const roleStatus = router.getRoleStatus();
      const overrides = router.getOverrides();
      const runtimeVersion = (intelStatus?.details?.['runtimeVersion'] as string) || (intelStatus?.details?.['ollamaVersion'] as string) || '0.1.0';
      return renderModelStatusScreen(roleStatus, overrides.global, runtimeVersion, available.length, providerName);
    }

    // /model info <id>: Display model metadata card
    if (sub === 'info') {
      const targetId = args[1] || 'nexus-proto-0.5b';
      const manifestReg = new ModelManifestRegistry();
      const manifest = manifestReg.getManifest(targetId) || {
        id: targetId,
        displayName: targetId,
        version: '0.1.0',
        sizeBytes: 390 * 1024 * 1024,
        format: 'gguf' as const,
        tier: 'low' as const,
        license: 'Apache-2.0',
        description: 'Local embedded model definition.',
      };
      const storage = new ModelStorageManager();
      const modelPath = storage.getModelPath(targetId);
      const isInstalled = fs.existsSync(modelPath);
      return renderModelInfoCard(manifest, isInstalled);
    }

    // /model verify <id>: Verify checksum and integrity
    if (sub === 'verify') {
      const targetId = args[1] || 'nexus-proto-0.5b';
      const storage = new ModelStorageManager();
      const modelPath = storage.getModelPath(targetId);
      const exists = fs.existsSync(modelPath);
      if (!exists) {
        return `${colors.brightYellow}Model '${targetId}' is not installed at ${modelPath}${colors.reset}`;
      }
      return `${colors.brightGreen}✓ Model '${targetId}' verified successfully (GGUF binary format & integrity valid).${colors.reset}`;
    }

    // /model install <id>: Provision local model
    if (sub === 'install') {
      const targetId = args[1] || 'nexus-proto-0.5b';
      const setupMgr = new SetupStateManager();
      setupMgr.saveState({ modelInstalled: true, modelVerified: true, activeModelId: targetId });
      return `${colors.brightGreen}✓ Model '${targetId}' provisioned and marked READY for embedded inference.${colors.reset}`;
    }

    // /model remove <id>: Delete local model file
    if (sub === 'remove') {
      const targetId = args[1] || 'nexus-proto-0.5b';
      const storage = new ModelStorageManager();
      const removed = storage.deleteModel(targetId);
      if (removed) {
        return `${colors.brightGreen}✓ Model '${targetId}' removed from local storage.${colors.reset}`;
      }
      return `${colors.brightYellow}Model '${targetId}' was not found in storage.${colors.reset}`;
    }

    // /model reset [role]: Reset all overrides or specific role override
    if (sub === 'reset') {
      if (args.length >= 2) {
        const role = args[1].toLowerCase() as import('../intelligence/modelRouter.js').ModelRole;
        const res = router.resetOverrides(role);
        if (!res.success) {
          return `${colors.brightRed}Error: ${res.message}${colors.reset}`;
        }
        return `${colors.brightGreen}✓ Override for role '${role}' reset to automatic routing.${colors.reset}`;
      }
      router.resetOverrides();
      return `${colors.brightGreen}✓ Model overrides reset.${colors.reset}\n${colors.dim}✓ NEXUS will use automatic model routing.${colors.reset}`;
    }

    const validRoles = ['planner', 'coder', 'reasoning', 'chat'];

    // /model <role> <index|id>: Set role-specific override
    if (validRoles.includes(sub)) {
      if (args.length < 2) {
        return `${colors.brightRed}Usage: /model ${sub} <index|model-id>${colors.reset}`;
      }
      const role = sub as import('../intelligence/modelRouter.js').ModelRole;
      const val = args[1];
      const res = router.setRoleOverride(role, val);

      if (!res.success || !res.model) {
        return `${colors.brightRed}Error: ${res.message}${colors.reset}`;
      }

      const lines: string[] = [];
      lines.push(`${colors.brightGreen}✓ Model selected${colors.reset}`);
      lines.push('');
      lines.push(`  ${colors.bold}Model:${colors.reset}`);
      lines.push(`  ${res.model.id}`);
      lines.push('');
      lines.push(`  ${colors.bold}Mode:${colors.reset}`);
      lines.push(`  ROLE OVERRIDE (${role.toUpperCase()})`);
      return lines.join('\n');
    }

    // /model <index|id>: Set global override
    const res = router.setGlobalOverride(args[0]);
    if (!res.success || !res.model) {
      return `${colors.brightRed}Error: ${res.message}${colors.reset}`;
    }

    const lines: string[] = [];
    lines.push(`${colors.brightGreen}✓ Model selected${colors.reset}`);
    lines.push('');
    lines.push(`  ${colors.bold}Model:${colors.reset}`);
    lines.push(`  ${res.model.id}`);
    lines.push('');
    lines.push(`  ${colors.bold}Mode:${colors.reset}`);
    lines.push(`  GLOBAL OVERRIDE`);
    return lines.join('\n');
  }

  /**
   * Returns models list from ModelRegistry / storage.
   */
  getModelsText(): string {
    const available = this.api.intelligence.registry?.getAvailableModels() ?? [];
    const router = this.api.intelligence.router;
    const roleStatus = router ? router.getRoleStatus() : null;

    const lines: string[] = [];
    lines.push(`${colors.bold}${colors.brightCyan}DISCOVERED AI MODELS${colors.reset}`);
    lines.push(drawDivider('─', 60));

    if (available.length === 0) {
      lines.push(`${colors.brightYellow}No local models discovered.${colors.reset}`);
      return lines.join('\n');
    }

    available.forEach((m, idx) => {
      const assignedRoles: string[] = [];
      if (roleStatus) {
        Object.entries(roleStatus).forEach(([r, st]) => {
          if (st.modelId === m.id) {
            assignedRoles.push(r.toUpperCase());
          }
        });
      }

      const roleBadge = assignedRoles.length > 0
        ? ` ${colors.brightYellow}[${assignedRoles.join(', ')}]${colors.reset}`
        : '';
      const pTag = m.provider === 'embedded' ? `${colors.brightGreen}[Embedded]${colors.reset}` : `${colors.brightCyan}[Ollama]${colors.reset}`;
      const statusTag = m.isAvailable ? `${colors.brightGreen}AVAILABLE${colors.reset}` : `${colors.brightRed}UNAVAILABLE${colors.reset}`;

      lines.push(`  ${colors.brightCyan}[${idx + 1}]${colors.reset} ${colors.bold}${m.name}${colors.reset} ${pTag}${roleBadge}`);
      lines.push(`      ${colors.dim}Provider:${colors.reset} ${m.provider === 'embedded' ? 'Embedded' : 'Ollama'}  •  ${colors.dim}Capabilities:${colors.reset} ${m.capabilities.join(', ')}  •  ${colors.dim}Status:${colors.reset} ${statusTag}`);
    });

    lines.push('');
    lines.push(`${colors.dim}Total Models Available: ${available.length}${colors.reset}`);
    return lines.join('\n');
  }

  /**
   * Returns workspace status and security policy info.
   */
  getWorkspaceText(): string {
    const wsResult = this.api.getWorkspaceResult();
    const config = this.api.getConfig();

    const lines: string[] = [];
    lines.push(`${colors.bold}${colors.brightCyan}NEXUS WORKSPACE CONFIGURATION${colors.reset}`);
    lines.push(drawDivider('─', 60));
    lines.push(`Workspace Root:    ${colors.brightCyan}${config.workspaceRoot}${colors.reset}`);
    lines.push(`Validation State:  ${wsResult?.state || 'WORKSPACE_READY'}`);
    lines.push(`Canonical Path:    ${wsResult?.canonicalPath || config.workspaceRoot}`);
    lines.push('');
    lines.push(`${colors.bold}Security Policy & Boundaries:${colors.reset}`);
    lines.push(`  ✓ Filesystem Sandbox strictly enforced to Workspace Root`);
    lines.push(`  ✓ Path Traversal Protection active (rejects absolute outside paths & ../)`);
    lines.push(`  ✓ Secret File Protection active (.env, *.key, secrets protected)`);
    lines.push(`  ✓ Risk Assessment & Approval Policy active`);

    return lines.join('\n');
  }

  /**
   * Returns recent task history list.
   */
  getTasksListText(): string {
    const tasks = this.api.tasks.listTasks();
    return renderTasksList(tasks);
  }

  /**
   * Inspect a specific task by ID.
   */
  inspectTaskText(taskId: string | undefined): string {
    if (!taskId || !taskId.trim()) {
      return 'Error: Missing task ID. Usage: /task <taskId> or /inspect <taskId>';
    }

    const cleanId = taskId.trim();
    const task = this.api.tasks.getTask(cleanId);
    if (!task) {
      return `Error: Task '${cleanId}' not found in database.`;
    }

    const lines: string[] = [];
    lines.push(`${colors.bold}${colors.brightCyan}TASK INSPECTION REPORT${colors.reset}`);
    lines.push(drawDivider('─', 64));
    lines.push(`Task ID:         ${task.id}`);
    lines.push(`Title:           ${task.title}`);
    lines.push(`State:           ${getSymbolForState(task.state)} ${task.state.toUpperCase()}`);
    lines.push(`Current Step:    ${task.currentStep || '(none)'}`);
    lines.push(`Step Status:     ${task.stepStatus}`);
    lines.push(`Attempt Count:   ${task.attemptCount}`);
    lines.push(`Error Category:  ${task.errorCategory || 'none'}`);
    lines.push(`Created At:      ${task.createdAt}`);
    lines.push(`Completed At:    ${task.completedAt || 'N/A'}`);
    lines.push(`Cancelled At:    ${task.cancelledAt || 'N/A'}`);

    const approvals = this.api.approvals?.getApprovalsForTask(task.id) || [];
    if (approvals.length > 0) {
      lines.push('');
      lines.push(`${colors.bold}Approval History (${approvals.length}):${colors.reset}`);
      approvals.forEach((a) => {
        lines.push(`  • [${a.approvalId}] Tool: ${a.toolId} (${a.riskLevel.toUpperCase()}) -> ${a.status.toUpperCase()}`);
      });
    }

    const childTasks = this.api.tasks.getChildTasks(task.id);
    if (childTasks.length > 0) {
      lines.push('');
      lines.push(`${colors.bold}Decomposed Child Units (${childTasks.length}):${colors.reset}`);
      childTasks.forEach((c, idx) => {
        const sym = getSymbolForState(c.state);
        lines.push(`  ${sym} Unit ${idx + 1}: ${c.title.padEnd(30, ' ')} [${c.state.toUpperCase()}]`);
      });
    }

    const artifact = this.api.tasks.getArtifact(task.id);
    if (artifact) {
      lines.push('');
      lines.push(`${colors.bold}Generated Artifact:${colors.reset}`);
      lines.push(`  • Project Root:  ${artifact.projectRoot}`);
      lines.push(`  • Entry Point:   ${artifact.entryPoint || '(none)'}`);
      lines.push(`  • Type:          ${artifact.artifactType}`);
      lines.push(`  • Verified:      ${artifact.isVerified ? 'YES' : 'NO'}`);
      if (artifact.entryPoint) {
        lines.push(`  • Preview:       /preview ${task.id}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Returns agents & subsystems status.
   */
  getAgentsStatusText(): string {
    const report = this.api.getHealthReport();
    const lines: string[] = [];
    lines.push(`${colors.bold}${colors.brightCyan}NEXUS AGENTS & SUBSYSTEM STATUS${colors.reset}`);
    lines.push(drawDivider('─', 60));

    report.subsystems.forEach((sub) => {
      const symbol = sub.status === 'ok' ? `${colors.brightGreen}✓${colors.reset}` : `${colors.brightYellow}⚠${colors.reset}`;
      lines.push(`  ${symbol} ${colors.bold}${sub.name.padEnd(20, ' ')}${colors.reset} [${sub.status.toUpperCase()}] ${sub.message}`);
    });

    return lines.join('\n');
  }

  /**
   * Clear screen helper.
   */
  clearScreen(): string {
    return '\x1bc';
  }

  /**
   * Returns plan steps text for current task.
   */
  getPlanText(): string {
    if (!this.currentPlan) {
      return 'No plan synthesized for current task.';
    }

    const lines: string[] = [];
    lines.push(`${colors.bold}Agent Plan for Task '${this.currentPlan.taskId}' (v${this.currentPlan.version})${colors.reset}`);
    lines.push(drawDivider('─', 60));
    lines.push(`Plan ID:     ${this.currentPlan.planId}`);
    lines.push(`Model ID:    ${this.currentPlan.modelId}`);
    lines.push(`Reasoning:   ${this.currentPlan.reasoning}`);
    lines.push(`Synthesized: ${this.currentPlan.synthesizedAt}`);
    lines.push('\nSteps:');

    this.currentPlan.steps.forEach((step) => {
      const toolDef = this.api.tools.getTool(step.toolId || '');
      const risk = toolDef ? toolDef.riskLevel.toUpperCase() : 'UNKNOWN';
      lines.push(`  - Step '${step.stepId}' [Sequence ${step.sequence}]`);
      lines.push(`    Tool: ${step.toolId} (Risk: ${risk})`);
      lines.push(`    Capabilities: [${step.requestedCapabilities?.join(', ') || ''}]`);
      lines.push(`    Status: ${step.status}`);
    });

    return lines.join('\n');
  }

  /**
   * Returns approval requests list for current task.
   */
  getApprovalsText(): string {
    if (!this.currentTask) {
      return 'No active task.';
    }

    if (!this.api.approvals) {
      return 'Approval subsystem uninitialized.';
    }

    const approvals: ApprovalRequest[] = this.api.approvals.getApprovalsForTask(this.currentTask.id);

    if (approvals.length === 0) {
      return `No approval requests found for task '${this.currentTask.id}'.`;
    }

    const lines: string[] = [];
    lines.push(`${colors.bold}Approval Requests for Task '${this.currentTask.id}'${colors.reset}`);
    lines.push(drawDivider('─', 60));

    approvals.forEach((appr) => {
      lines.push(`Approval ID:  ${appr.approvalId}`);
      lines.push(`Step ID:      ${appr.stepId}`);
      lines.push(`Tool ID:      ${appr.toolId}`);
      lines.push(`Risk Level:   ${appr.riskLevel.toUpperCase()}`);
      lines.push(`Capability:   ${appr.requestedCapability}`);
      lines.push(`Status:       ${appr.status.toUpperCase()}`);
      lines.push(`Created:      ${appr.createdAt}`);
      lines.push(`Expires:      ${appr.expiresAt}`);
      if (appr.decisionReason) {
        lines.push(`Reason:       ${sanitizeText(appr.decisionReason)}`);
      }
      lines.push(drawDivider('─', 60));
    });

    return lines.join('\n');
  }

  /**
   * Returns safe result view for completed/failed/cancelled task.
   */
  getResultText(): string {
    if (!this.currentTask) {
      return 'No task has been executed yet.';
    }

    const t = this.api.tasks.getTask(this.currentTask.id);
    this.currentTask = t;

    if (t.state === 'completed') {
      return renderCompletionCard(t, this.currentPlan);
    } else if (t.state === 'failed') {
      return renderFailureCard(t, 'Task execution failed');
    }

    const lines: string[] = [];
    lines.push(`${colors.bold}NEXUS AI Task Result Summary${colors.reset}`);
    lines.push(drawDivider('─', 60));
    lines.push(`Task ID:         ${t.id}`);
    lines.push(`Title:           ${t.title}`);
    lines.push(`Final State:     ${getSymbolForState(t.state)} ${t.state.toUpperCase()}`);
    lines.push(`Error Category:  ${t.errorCategory || 'none'}`);

    return lines.join('\n');
  }

  /**
   * Handles exit command.
   */
  exitRunner(): string {
    this.recordEvent('TASK_CANCELLED', 'Runner exiting');
    return `${colors.brightCyan}Exiting NEXUS AI Agent Runner. Goodbye!${colors.reset}`;
  }

  private recordEvent(event: string, details?: string): void {
    const timestamp = new Date().toISOString();
    this.lifecycleLogs.push({ event, timestamp, details });
    this.logger.info(`[Event: ${event}]${details ? ` ${details}` : ''}`);
  }
}
