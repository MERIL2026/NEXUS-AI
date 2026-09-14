import type { AgentTaskService } from './agentTaskService.js';
import type { AgentTask } from '../storage/repositories/types.js';
import type { ToolGateway } from '../tools/index.js';
import type { ToolExecutionRequest, ToolExecutionResult } from '../tools/types.js';
import type {
  AgentPlanStep,
  AgentObservation,
  VerificationResult,
  ExecutionLoopOptions,
} from './types.js';
import { NON_RETRYABLE_ERROR_CATEGORIES } from './types.js';
import { AgentStateMachine } from './agentStateMachine.js';
import { Logger, LogLevel } from '../common/logger.js';

import type { HumanApprovalService } from './humanApprovalService.js';
import { GoalCompletionVerifier } from './goalCompletionVerifier.js';

export class AgentExecutionService {
  private logger: Logger;
  private approvalService?: HumanApprovalService;

  constructor(
    private taskService: AgentTaskService,
    private toolGateway: ToolGateway,
    approvalServiceOrLogLevel?: HumanApprovalService | LogLevel,
    logLevel: LogLevel = 'info'
  ) {
    if (typeof approvalServiceOrLogLevel === 'string') {
      this.approvalService = undefined;
      this.logger = new Logger('AgentExecutionService', approvalServiceOrLogLevel);
    } else {
      this.approvalService = approvalServiceOrLogLevel;
      this.logger = new Logger('AgentExecutionService', logLevel);
    }
  }

  /**
   * Execute a sequence of plan steps within a controlled, bounded, and deterministic execution loop.
   *
   * Lifecycle:
   * TASK -> PLANNING -> STEP CREATED -> TOOL REQUEST -> AUTHORIZATION -> EXECUTION -> OBSERVATION -> VERIFICATION -> COMPLETE
   */
  async runExecutionLoop(
    taskId: string,
    steps: AgentPlanStep[],
    options: ExecutionLoopOptions = {}
  ): Promise<AgentTask> {
    const maxSteps = options.maxSteps ?? 10;
    const defaultMaxAttempts = options.maxAttemptsPerStep ?? 3;
    const timeoutMs = options.stepTimeoutMs ?? 5000;

    let task = this.taskService.getTask(taskId);

    // 1. Initial State Check — verify task is not already terminal
    if (AgentStateMachine.isTerminal(task.state)) {
      this.logger.warn(`Execution loop rejected: task is in terminal state '${task.state}'`, { taskId });
      return task;
    }

    // Move task to planning state if created
    if (task.state === 'created') {
      task = this.taskService.transitionTask(taskId, { targetState: 'planning' });
    }

    if (!task.plan && steps.length > 0) {
      this.taskService.setTaskPlan(taskId, JSON.stringify({ steps }));
    }

    this.logger.info(`Starting execution loop`, {
      taskId,
      stepCount: steps.length,
      maxSteps,
    });

    let completedStepCount = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // Re-fetch fresh task state before step
      task = this.taskService.getTask(taskId);
      if (AgentStateMachine.isTerminal(task.state)) {
        this.logger.info(`Execution loop halted: task became terminal ('${task.state}')`, { taskId });
        return task;
      }

      // Step limit check
      if (completedStepCount >= maxSteps) {
        this.logger.error(`Execution loop halted: maximum step limit reached`, {
          taskId,
          completedStepCount,
          maxSteps,
        });
        return this.taskService.failTask(taskId, {
          errorCategory: 'STEP_LIMIT_EXCEEDED',
          currentStep: step.stepId,
        });
      }

      // Human Approval Gate Check (P5-F)
      if (this.approvalService) {
        const toolId = step.toolId || 'unknown_tool';
        const capability = step.requestedCapabilities?.[0] || 'filesystem.read';

        let approval = this.approvalService.getApprovalsForTask(taskId).find((a) => a.stepId === step.stepId);
        if (!approval) {
          const created = this.approvalService.createApprovalRequest({
            taskId,
            stepId: step.stepId,
            toolId,
            requestedCapability: capability as import('../tools/types.js').ToolCapability,
          });
          approval = created.approval;
        }

        const gateResult = this.approvalService.evaluateGateForStep(taskId, step.stepId);

        if (!gateResult.allowed) {
          if (gateResult.status === 'pending') {
            this.logger.info(`Step '${step.stepId}' requires human approval. Execution loop paused.`, { taskId, stepId: step.stepId });
            return this.taskService.getTask(taskId);
          }

          if (gateResult.status === 'rejected') {
            this.logger.warn(`Step '${step.stepId}' human approval was rejected. Halting execution.`, { taskId, stepId: step.stepId });
            return this.taskService.failTask(taskId, {
              errorCategory: 'APPROVAL_REJECTED',
              currentStep: step.stepId,
            });
          }

          if (gateResult.status === 'expired') {
            this.logger.warn(`Step '${step.stepId}' human approval expired. Halting execution.`, { taskId, stepId: step.stepId });
            return this.taskService.failTask(taskId, {
              errorCategory: 'APPROVAL_EXPIRED',
              currentStep: step.stepId,
            });
          }

          if (gateResult.status === 'cancelled') {
            this.logger.warn(`Step '${step.stepId}' human approval was cancelled. Halting execution.`, { taskId, stepId: step.stepId });
            return this.taskService.getTask(taskId);
          }
        }
      }

      // Move task to executing state
      if (task.state !== 'executing') {
        task = this.taskService.transitionTask(taskId, {
          targetState: 'executing',
          currentStep: step.stepId,
        });
      }

      const maxAttempts = step.maxAttempts || defaultMaxAttempts;
      let stepSuccess = false;
      let lastResult: ToolExecutionResult | null = null;
      let lastErrorCategory = 'STEP_FAILED';

      // Bounded Attempt Retry Loop
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Re-check cancellation before starting attempt
        task = this.taskService.getTask(taskId);
        if (task.state === 'cancelled' || AgentStateMachine.isTerminal(task.state)) {
          this.logger.info(`Attempt ${attempt} cancelled: task state is '${task.state}'`, { taskId });
          return task;
        }

        step.attemptCount = attempt;
        const requestId = `req-${taskId}-${step.stepId}-att${attempt}`;
        const startTime = Date.now();

        this.logger.info(`Executing step attempt ${attempt}/${maxAttempts}`, {
          taskId,
          stepId: step.stepId,
          requestId,
          toolId: step.toolId,
        });

        // Prepare tool execution request
        const execRequest: ToolExecutionRequest = {
          requestId,
          taskId,
          toolId: step.toolId || 'unknown_tool',
          requestedCapabilities: step.requestedCapabilities || [],
          params: step.params || {},
        };

        // Execute tool with timeout protection
        let result: ToolExecutionResult;
        try {
          result = await this.executeWithTimeout(execRequest, timeoutMs);
        } catch (err) {
          result = {
            requestId,
            taskId,
            toolId: step.toolId || 'unknown_tool',
            authorized: true,
            executed: false,
            success: false,
            decision: 'ALLOWED',
            errorCategory: 'TIMEOUT',
            errorMessage: `Step execution timed out after ${timeoutMs}ms (${String(err)})`,
            timestamp: new Date().toISOString(),
          };
        }

        lastResult = result;
        const durationMs = Date.now() - startTime;

        // Observation normalization
        const observation: AgentObservation = {
          stepId: step.stepId,
          taskId,
          toolId: result.toolId,
          requestId: result.requestId,
          success: result.success,
          errorCategory: result.errorCategory,
          errorMessage: result.errorMessage,
          outputSummary: result.output
            ? {
                bytes: typeof result.output.bytes === 'number' ? result.output.bytes : undefined,
                relativePath: typeof result.output.relativePath === 'string' ? result.output.relativePath : undefined,
                hasContent: !!result.output.content,
              }
            : undefined,
          durationMs,
          timestamp: result.timestamp,
        };

        this.logger.info(`Observation recorded for step '${observation.stepId}'`, {
          taskId: observation.taskId,
          stepId: observation.stepId,
          toolId: observation.toolId,
          authorized: result.authorized,
          executed: result.executed,
          success: observation.success,
          durationMs: observation.durationMs,
        });

        // Verification Stage
        const verification: VerificationResult = {
          stepId: step.stepId,
          taskId,
          verified: result.authorized && result.executed && result.success,
          reason: result.success
            ? 'Tool execution verified successfully'
            : result.errorMessage || 'Execution verification failed',
          timestamp: new Date().toISOString(),
        };

        if (verification.verified) {
          stepSuccess = true;
          step.status = 'completed';
          completedStepCount++;

          // State transition: observing -> verifying
          task = this.taskService.transitionTask(taskId, { targetState: 'observing', currentStep: step.stepId });
          task = this.taskService.transitionTask(taskId, { targetState: 'verifying', currentStep: step.stepId });
          break; // Exit attempt loop on success
        }

        // Handle verification failure
        lastErrorCategory = result.errorCategory || 'VERIFICATION_FAILED';

        // NON-RETRYABLE SECURITY / AUTHORIZATION FAILURES: Stop immediately!
        if (lastErrorCategory && NON_RETRYABLE_ERROR_CATEGORIES.has(lastErrorCategory)) {
          this.logger.warn(`Non-retryable security/structural failure encountered. Bypassing retries.`, {
            taskId,
            stepId: step.stepId,
            errorCategory: lastErrorCategory,
          });
          break;
        }

        // Retryable failure: brief pause before next attempt
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 10));
        }
      }

      // If step failed after all attempts / non-retryable failure
      if (!stepSuccess) {
        step.status = 'failed';
        step.errorCategory = lastErrorCategory;
        step.errorMessage = lastResult?.errorMessage || 'Step execution failed';

        this.logger.error(`Step failed. Failing task.`, {
          taskId,
          stepId: step.stepId,
          errorCategory: lastErrorCategory,
        });

        return this.taskService.failTask(taskId, {
          errorCategory: lastErrorCategory,
          currentStep: step.stepId,
        });
      }
    }

    // Complete task when all steps succeed and goal verification passes
    if (options.autoComplete !== false) {
      const workspaceRoot = this.toolGateway.getWorkspaceRoot();
      const verifier = new GoalCompletionVerifier();
      const verification = verifier.verifyGoal(task.title, steps, workspaceRoot);

      if (!verification.verified) {
        this.logger.error(`Goal verification failed for task '${taskId}'`, {
          errorCategory: verification.errorCategory,
          errorMessage: verification.errorMessage,
        });
        return this.taskService.failTask(taskId, {
          errorCategory: verification.errorCategory || 'GOAL_VERIFICATION_FAILED',
        });
      }

      // Automatically register verified artifact in persistence layer
      if (verification.artifactInfo) {
        try {
          this.taskService.registerArtifact({
            taskId,
            projectId: task.projectId,
            projectRoot: verification.artifactInfo.projectRoot,
            relativeProjectRoot: verification.artifactInfo.relativeProjectRoot,
            entryPoint: verification.artifactInfo.entryPoint,
            files: verification.artifactInfo.files,
            artifactType: verification.artifactInfo.artifactType,
            workspacePath: verification.artifactInfo.workspacePath,
            isVerified: true,
          });
        } catch (artErr) {
          this.logger.warn(`Failed persisting artifact record for task '${taskId}' (non-fatal)`, { error: String(artErr) });
        }
      }

      this.logger.info(`All execution loop steps & goal verification succeeded. Completing task.`, { taskId });
      return this.taskService.completeTask(taskId);
    }

    // autoComplete=false: caller controls task state — just return current task
    this.logger.info(`All execution loop steps completed successfully. Leaving task in current state (autoComplete=false).`, { taskId });
    return this.taskService.getTask(taskId);
  }

  /**
   * Cancel execution of a task.
   */
  cancelExecution(taskId: string): AgentTask {
    this.logger.info(`Cancelling task execution loop`, { taskId });
    return this.taskService.cancelTask(taskId);
  }

  /**
   * Helper to execute tool with a strict timeout boundary.
   */
  private async executeWithTimeout(request: ToolExecutionRequest, timeoutMs: number): Promise<ToolExecutionResult> {
    if (timeoutMs <= 0) {
      return {
        requestId: request.requestId,
        taskId: request.taskId,
        toolId: request.toolId,
        authorized: true,
        executed: false,
        success: false,
        decision: 'ALLOWED',
        errorCategory: 'TIMEOUT',
        errorMessage: `Step execution timed out after ${timeoutMs}ms`,
        timestamp: new Date().toISOString(),
      };
    }

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Tool execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        const result = this.toolGateway.executeTool(request);
        clearTimeout(timer);
        resolve(result);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }
}
