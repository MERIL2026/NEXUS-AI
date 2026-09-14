/**
 * NEXUS AI — P6-D: Coding Agent Service
 *
 * Orchestrates the full coding-agent lifecycle:
 *   Discovery -> Plan Synthesis -> Plan Validation -> Permission & Approval Evaluation
 *   -> Execution -> Validation Commands -> Verification -> Bounded Repair Loop -> Completion.
 *
 * SECURITY INVARIANTS:
 *  - Orchestrator ONLY. Does NOT bypass PlanValidator, PermissionEngine, ApprovalGate, or ToolExecutor.
 *  - Non-repairable security errors (PERMISSION_DENIED, PATH_TRAVERSAL_DENIED, etc.) stop repair loops immediately.
 *  - Strict repair attempt budget (default 3 retries max) prevents infinite loops.
 *  - APPROVAL != PERMISSION: Human approval never grants permission if policy denies it.
 */

import type { AgentTaskService } from './agentTaskService.js';
import type { AgentExecutionService } from './agentExecutionService.js';
import type { PlanSynthesisService } from './planner.js';
import type { PlanValidator } from './planner.js';
import type { ToolGateway } from '../tools/index.js';
import type { FileChangeDiff } from '../tools/adapters/filesystemAdapter.js';
import type {
  CodingAgentTaskOptions,
  CodingAgentRunResult,
  CodebaseEvidence,
  CodingVerificationResult,
  RepairContext,
} from './codingAgentTypes.js';
import { NON_REPAIRABLE_SECURITY_ERRORS } from './codingAgentTypes.js';
import { CodingAgentDiscovery } from './codingAgentDiscovery.js';
import { CodingAgentVerifier } from './codingAgentVerifier.js';
import { CodingRepairService } from './codingRepairService.js';
import { AgentStateMachine } from './agentStateMachine.js';
import { Logger, LogLevel } from '../common/logger.js';

export class CodingAgentService {
  private discovery: CodingAgentDiscovery;
  private verifier: CodingAgentVerifier;
  private repairService?: CodingRepairService;
  private logger: Logger;

  constructor(
    private taskService: AgentTaskService,
    private toolGateway: ToolGateway,
    private executionService?: AgentExecutionService,
    private planner?: PlanSynthesisService,
    private planValidator?: PlanValidator,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('CodingAgentService', logLevel);
    this.discovery = new CodingAgentDiscovery(toolGateway, logLevel);
    this.verifier = new CodingAgentVerifier(toolGateway, logLevel);

    if (planner && planValidator) {
      this.repairService = new CodingRepairService(planner, planValidator, toolGateway, logLevel);
    }
  }

  /**
   * Run a full coding task with bounded discovery, planning, execution, validation, and repair loop.
   *
   * @param options Coding agent task configuration options.
   * @returns Deterministic CodingAgentRunResult.
   */
  async runCodingTask(options: CodingAgentTaskOptions): Promise<CodingAgentRunResult> {
    const { taskGoal, maxRepairAttempts = 3, validationCommands } = options;
    const runId = `run-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const startTime = Date.now();

    this.logger.info(`Starting coding task run`, { runId, goal: taskGoal, maxRepairAttempts });

    // STEP 1: Task Creation
    const task = this.taskService.createTask({
      title: `Coding Task: ${taskGoal.slice(0, 50)}`,
    });

    const taskId = task.id;
    const diffsCollected: FileChangeDiff[] = [];

    // STEP 2: Codebase Discovery
    let evidence: CodebaseEvidence | undefined;
    try {
      evidence = await this.discovery.discoverCodebase(taskId, taskGoal);
    } catch (err) {
      this.logger.warn(`Codebase discovery warning`, { taskId, error: String(err) });
    }

    // STEP 3: Initial Plan Synthesis & Validation
    if (!this.planner || !this.planValidator || !this.executionService) {
      this.logger.warn(`Execution subsystems uninitialized for task`, { taskId });
      const failedTask = this.taskService.failTask(taskId, {
        errorCategory: 'EXECUTOR_UNINITIALIZED',
        currentStep: 'initialization',
      });
      return {
        success: false,
        taskId,
        runId,
        state: failedTask.state,
        repairAttemptsCount: 0,
        maxRepairAttempts,
        evidence,
        diffs: [],
        errorCategory: 'EXECUTOR_UNINITIALIZED',
        errorMessage: 'Planner, PlanValidator, or AgentExecutionService is uninitialized.',
      };
    }

    const synthResult = await this.planner.synthesize(taskId, {
      taskGoal,
      temperature: 0.2,
      maxSteps: 10,
    });

    if (!synthResult.success || !synthResult.plan) {
      const failedTask = this.taskService.failTask(taskId, {
        errorCategory: synthResult.errorCategory || 'PLAN_SYNTHESIS_FAILED',
        currentStep: 'planning',
      });

      return {
        success: false,
        taskId,
        runId,
        state: failedTask.state,
        repairAttemptsCount: 0,
        maxRepairAttempts,
        evidence,
        diffs: [],
        errorCategory: synthResult.errorCategory || 'PLAN_SYNTHESIS_FAILED',
        errorMessage: synthResult.errorMessage || 'Plan synthesis failed.',
      };
    }

    const valResult = this.planValidator.validate(synthResult.plan, taskId, 10);
    if (!valResult.valid) {
      const failedTask = this.taskService.failTask(taskId, {
        errorCategory: 'PLAN_VALIDATION_FAILED',
        currentStep: 'planning',
      });

      return {
        success: false,
        taskId,
        runId,
        state: failedTask.state,
        repairAttemptsCount: 0,
        maxRepairAttempts,
        evidence,
        diffs: [],
        errorCategory: 'PLAN_VALIDATION_FAILED',
        errorMessage: `Initial plan validation failed: ${valResult.errors.map((e) => e.message).join('; ')}`,
      };
    }

    // Save synthesized plan into SQLite task record so PreviewService can inspect it
    this.taskService.setTaskPlan(taskId, JSON.stringify(synthResult.plan));

    // STEP 4: Initial Plan Execution
    let currentTaskState = this.taskService.getTask(taskId);
    currentTaskState = await this.executionService.runExecutionLoop(taskId, synthResult.plan.steps, {
      maxSteps: 10,
      stepTimeoutMs: options.stepTimeoutMs ?? 30_000,
      autoComplete: false, // CodingAgentService controls task completion
    });

    if (currentTaskState.state === 'failed' || currentTaskState.state === 'cancelled') {
      return {
        success: false,
        taskId,
        runId,
        state: currentTaskState.state,
        repairAttemptsCount: 0,
        maxRepairAttempts,
        evidence,
        diffs: diffsCollected,
        errorCategory: currentTaskState.errorCategory || 'EXECUTION_FAILED',
        errorMessage: `Initial plan execution ended in state '${currentTaskState.state}'.`,
      };
    }

    // STEP 5: Initial Validation & Verification
    let verificationRes: CodingVerificationResult = await this.verifier.verify(taskId, diffsCollected, validationCommands);
    let repairAttemptsCount = 0;

    // STEP 6: Bounded Repair Loop
    while (!verificationRes.verified) {
      repairAttemptsCount++;
      const lastVal = verificationRes.validationResult;
      const failureErrCategory = verificationRes.errorCategory || lastVal?.errorCategory;

      this.logger.warn(`Verification failed on attempt ${repairAttemptsCount}/${maxRepairAttempts}`, {
        taskId,
        reason: verificationRes.reason,
        errorCategory: failureErrCategory,
      });

      // 6a. Non-repairable security check
      if (failureErrCategory && NON_REPAIRABLE_SECURITY_ERRORS.has(failureErrCategory)) {
        this.logger.warn(`Halting repair loop: non-repairable security failure category '${failureErrCategory}'`, { taskId });
        const failedTask = this.taskService.failTask(taskId, {
          errorCategory: failureErrCategory,
          currentStep: 'verification',
        });

        return {
          success: false,
          taskId,
          runId,
          state: failedTask.state,
          repairAttemptsCount,
          maxRepairAttempts,
          evidence,
          diffs: diffsCollected,
          validation: lastVal,
          verification: verificationRes,
          errorCategory: failureErrCategory,
          errorMessage: verificationRes.reason,
        };
      }

      // 6b. Budget check
      if (repairAttemptsCount > maxRepairAttempts) {
        this.logger.warn(`Halting repair loop: repair retry budget exhausted (${maxRepairAttempts})`, { taskId });
        const failedTask = this.taskService.failTask(taskId, {
          errorCategory: 'REPAIR_BUDGET_EXHAUSTED',
          currentStep: 'verification',
        });

        return {
          success: false,
          taskId,
          runId,
          state: failedTask.state,
          repairAttemptsCount: maxRepairAttempts,
          maxRepairAttempts,
          evidence,
          diffs: diffsCollected,
          validation: lastVal,
          verification: verificationRes,
          errorCategory: 'REPAIR_BUDGET_EXHAUSTED',
          errorMessage: `Repair retry budget (${maxRepairAttempts}) exhausted without passing validation.`,
        };
      }

      // 6c. Check repair service availability
      if (!this.repairService) {
        const failedTask = this.taskService.failTask(taskId, {
          errorCategory: 'REPAIR_UNAVAILABLE',
          currentStep: 'verification',
        });

        return {
          success: false,
          taskId,
          runId,
          state: failedTask.state,
          repairAttemptsCount,
          maxRepairAttempts,
          evidence,
          diffs: diffsCollected,
          validation: lastVal,
          verification: verificationRes,
          errorCategory: 'REPAIR_UNAVAILABLE',
          errorMessage: 'CodingRepairService is uninitialized.',
        };
      }

      // 6d. Synthesize Repair Plan
      const repairContext: RepairContext = {
        taskGoal,
        previousPlan: synthResult.plan,
        changedFiles: diffsCollected.map((d) => d.path),
        diffs: diffsCollected,
        failedValidationCommand: lastVal ? `${lastVal.command} ${lastVal.args.join(' ')}` : 'validation',
        exitCode: lastVal?.exitCode ?? null,
        stdout: lastVal?.stdout || '',
        stderr: lastVal?.stderr || verificationRes.reason,
        errorCategory: failureErrCategory,
        repairAttempt: repairAttemptsCount,
        maxRepairAttempts,
      };

      const repairSynthResult = await this.repairService.synthesizeRepairPlan(taskId, repairContext);
      if (!repairSynthResult.repairable || !repairSynthResult.repairPlan) {
        const failedTask = this.taskService.failTask(taskId, {
          errorCategory: repairSynthResult.errorCategory || 'REPAIR_PLAN_FAILED',
          currentStep: 'repair_planning',
        });

        return {
          success: false,
          taskId,
          runId,
          state: failedTask.state,
          repairAttemptsCount,
          maxRepairAttempts,
          evidence,
          diffs: diffsCollected,
          validation: lastVal,
          verification: verificationRes,
          errorCategory: repairSynthResult.errorCategory || 'REPAIR_PLAN_FAILED',
          errorMessage: repairSynthResult.reason,
        };
      }

      // 6e. Transition task verifying -> planning for repair
      currentTaskState = this.taskService.getTask(taskId);
      if (currentTaskState.state === 'verifying') {
        this.taskService.transitionTask(taskId, { targetState: 'planning', currentStep: `repair-attempt-${repairAttemptsCount}` });
      }

      // 6f. Execute Repair Plan
      currentTaskState = await this.executionService.runExecutionLoop(taskId, repairSynthResult.repairPlan.steps, {
        maxSteps: 5,
        stepTimeoutMs: options.stepTimeoutMs ?? 30_000,
        autoComplete: false, // CodingAgentService controls task completion
      });

      if (currentTaskState.state === 'failed' || currentTaskState.state === 'cancelled') {
        return {
          success: false,
          taskId,
          runId,
          state: currentTaskState.state,
          repairAttemptsCount,
          maxRepairAttempts,
          evidence,
          diffs: diffsCollected,
          validation: lastVal,
          verification: verificationRes,
          errorCategory: currentTaskState.errorCategory || 'REPAIR_EXECUTION_FAILED',
          errorMessage: `Repair execution attempt ${repairAttemptsCount} ended in state '${currentTaskState.state}'.`,
        };
      }

      // 6g. Re-verify
      verificationRes = await this.verifier.verify(taskId, diffsCollected, validationCommands);
    }

    // STEP 7: Successful Completion
    const completedTask = this.taskService.getTask(taskId);
    if (!AgentStateMachine.isTerminal(completedTask.state)) {
      this.taskService.completeTask(taskId);
    }

    this.logger.info(`Coding task completed successfully!`, {
      taskId,
      runId,
      repairAttemptsCount,
      durationMs: Date.now() - startTime,
    });

    return {
      success: true,
      taskId,
      runId,
      state: 'completed',
      repairAttemptsCount,
      maxRepairAttempts,
      evidence,
      diffs: diffsCollected,
      validation: verificationRes.validationResult,
      verification: verificationRes,
    };
  }
}
