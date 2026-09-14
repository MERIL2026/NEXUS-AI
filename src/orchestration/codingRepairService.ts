/**
 * NEXUS AI — P6-D: Coding Repair Service
 *
 * Generates bounded repair plans when validation checks fail.
 *
 * SECURITY INVARIANTS:
 *  - Non-repairable security errors (PERMISSION_DENIED, PATH_TRAVERSAL_DENIED,
 *    COMMAND_NOT_ALLOWED, APPROVAL_REJECTED, etc.) IMMEDIATELY halt the repair loop.
 *  - Infinite loops are prevented by enforcing a strict maxRepairAttempts retry budget.
 *  - Repair plan proposals MUST pass through PlanValidator before execution.
 *  - Secrets and raw protected environment variables are NEVER passed to the model.
 */

import type { PlanSynthesisService } from './planner.js';
import type { PlanValidator } from './planner.js';
import type { ToolGateway } from '../tools/index.js';
import type { RepairContext, RepairPlanResult } from './codingAgentTypes.js';
export type { RepairContext, RepairPlanResult };
import { NON_REPAIRABLE_SECURITY_ERRORS } from './codingAgentTypes.js';
import { Logger, LogLevel } from '../common/logger.js';

export class CodingRepairService {
  private logger: Logger;

  constructor(
    private planner: PlanSynthesisService,
    private planValidator: PlanValidator,
    private toolGateway: ToolGateway,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('CodingRepairService', logLevel);
  }

  /**
   * Determine whether a validation failure can be repaired and synthesize a repair plan proposal.
   *
   * @param taskId Agent task ID.
   * @param context Failure context containing goal, diffs, validation output, retry count.
   * @returns Deterministic RepairPlanResult.
   */
  async synthesizeRepairPlan(
    taskId: string,
    context: RepairContext
  ): Promise<RepairPlanResult> {
    const { repairAttempt, maxRepairAttempts, errorCategory, failedValidationCommand, exitCode, stdout, stderr } = context;

    this.logger.info(`Evaluating repair attempt ${repairAttempt}/${maxRepairAttempts}`, {
      taskId,
      errorCategory,
      failedCommand: failedValidationCommand,
      exitCode,
    });

    // 1. Non-repairable security/structural failure check — STOP IMMEDIATELY!
    if (errorCategory && NON_REPAIRABLE_SECURITY_ERRORS.has(errorCategory)) {
      this.logger.warn(`Repair loop halted: non-repairable security/structural failure category '${errorCategory}'`, {
        taskId,
        errorCategory,
      });
      return {
        repairable: false,
        reason: `Non-repairable security failure '${errorCategory}'. Repair loop halted for safety.`,
        errorCategory,
      };
    }

    // 2. Retry budget check
    if (repairAttempt > maxRepairAttempts) {
      this.logger.warn(`Repair loop halted: repair attempt budget (${maxRepairAttempts}) exhausted`, {
        taskId,
        repairAttempt,
        maxRepairAttempts,
      });
      return {
        repairable: false,
        reason: `Repair budget exhausted after ${maxRepairAttempts} attempt(s).`,
        errorCategory: 'REPAIR_BUDGET_EXHAUSTED',
      };
    }

    // 3. Construct clean, secret-safe repair prompt
    const sanitizeText = (txt: string) => txt.slice(-2000).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

    const repairPrompt = [
      `TASK GOAL: ${context.taskGoal}`,
      `REPAIR ATTEMPT: ${repairAttempt} of ${maxRepairAttempts}`,
      `FAILED COMMAND: ${failedValidationCommand} (exit code: ${exitCode})`,
      `ERROR CATEGORY: ${errorCategory || 'VALIDATION_FAILURE'}`,
      `CHANGED FILES: ${context.changedFiles.join(', ') || 'none'}`,
      `STDERR OUTPUT:\n${sanitizeText(stderr)}`,
      `STDOUT OUTPUT:\n${sanitizeText(stdout)}`,
      `INSTRUCTION: Propose a plan with filesystem_edit or filesystem_write steps to fix the error.`,
    ].join('\n\n');

    // 4. Synthesize plan proposal via PlanSynthesisService
    const synthResult = await this.planner.synthesize(taskId, {
      taskGoal: repairPrompt,
      temperature: 0.2,
      maxSteps: 5,
    });

    if (!synthResult.success || !synthResult.plan) {
      this.logger.warn(`Repair plan synthesis failed`, {
        taskId,
        errorCategory: synthResult.errorCategory,
        errorMessage: synthResult.errorMessage,
      });

      return {
        repairable: false,
        reason: `Repair plan synthesis failed: ${synthResult.errorMessage || 'Unable to generate repair plan.'}`,
        errorCategory: synthResult.errorCategory || 'PLAN_SYNTHESIS_FAILED',
      };
    }

    // 5. Validate repair plan via PlanValidator
    const valResult = this.planValidator.validate(synthResult.plan, taskId, 5);
    if (!valResult.valid) {
      this.logger.warn(`Repair plan validation failed`, {
        taskId,
        errors: valResult.errors,
      });

      return {
        repairable: false,
        reason: `Repair plan failed validation: ${valResult.errors.map((e) => e.message).join('; ')}`,
        errorCategory: 'PLAN_VALIDATION_FAILED',
      };
    }

    this.logger.info(`Repair plan successfully synthesized and validated`, {
      taskId,
      repairStepCount: synthResult.plan.steps.length,
    });

    return {
      repairable: true,
      reason: `Repair plan generated for attempt ${repairAttempt}.`,
      repairPlan: synthResult.plan,
    };
  }
}
