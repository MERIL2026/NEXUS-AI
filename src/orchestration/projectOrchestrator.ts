/**
 * NEXUS AI — Project Task Orchestrator
 *
 * Coordinates execution of decomposed project tasks with:
 * 1. Minimal context per task unit
 * 2. Strict dependency resolution
 * 3. Incremental file generation
 * 4. Per-task artifact registration and content-aware verification
 * 5. Bounded retries with focused failure context
 * 6. Final end-to-end integration verification
 * 7. Clean restart recovery
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentTaskService } from './agentTaskService.js';
import type { PlanSynthesisService } from './planner.js';
import type { AgentExecutionService } from './agentExecutionService.js';
import type { GoalCompletionVerifier } from './goalCompletionVerifier.js';
import type { HumanApprovalService } from './humanApprovalService.js';
import type { TaskArtifactRepository } from '../storage/repositories/taskArtifactRepository.js';
import type { AgentPlanStep } from './types.js';
import type {
  DecompositionPlan,
  DecomposedTaskUnit,
  ChildTaskExecutionResult,
  ProjectOrchestrationResult,
} from './taskDecompositionTypes.js';
import type { AgentTask } from '../storage/repositories/types.js';
import {
  verifyHtmlContentSubstance,
  verifyChildUnitContentSubstance,
  extractBrandCandidates,
} from './placeholderDetector.js';
import { Logger, LogLevel } from '../common/logger.js';

export interface ProjectOrchestratorOptions {
  maxRetriesPerUnit?: number;
  onProgress?: (progress: {
    unitIndex: number;
    totalUnits: number;
    unit: DecomposedTaskUnit;
    status: 'starting' | 'completed' | 'failed' | 'retrying';
    message?: string;
  }) => void;
}

export class ProjectTaskOrchestrator {
  private logger: Logger;

  constructor(
    private taskService: AgentTaskService,
    private planner: PlanSynthesisService,
    private executionService: AgentExecutionService,
    private goalVerifier: GoalCompletionVerifier,
    private workspaceRoot: string,
    private artifactRepo?: TaskArtifactRepository,
    private approvalService?: HumanApprovalService,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('ProjectTaskOrchestrator', logLevel);
  }

  /**
   * Orchestrates execution of a decomposed project plan.
   */
  async orchestrate(
    parentTaskId: string,
    plan: DecompositionPlan,
    options: ProjectOrchestratorOptions = {}
  ): Promise<ProjectOrchestrationResult> {
    const startTime = Date.now();
    const maxRetries = options.maxRetriesPerUnit ?? 2;
    const parentTask = this.taskService.getTask(parentTaskId);

    this.logger.info(`Starting project orchestration`, {
      parentTaskId,
      totalUnits: plan.units.length,
      goal: plan.parentGoal,
    });

    // 1. Transition parent task to planning -> executing
    if (parentTask.state === 'created') {
      this.taskService.transitionTask(parentTaskId, { targetState: 'planning' });
    }
    this.taskService.transitionTask(parentTaskId, {
      targetState: 'executing',
      plan: JSON.stringify(plan),
    });

    // 2. Persist child tasks in database if not already created (supports restart recovery)
    const existingChildren = this.taskService.getChildTasks(parentTaskId);
    const childTaskMap = new Map<string, AgentTask>();

    if (existingChildren.length === 0) {
      for (let i = 0; i < plan.units.length; i++) {
        const unit = plan.units[i];
        const childTask = this.taskService.createTask({
          title: unit.title,
          parentTaskId,
          taskType: 'child_unit',
          sequence: i + 1,
          dependencies: unit.dependencies,
          expectedOutput: unit.expectedOutput,
          verificationCriteria: unit.verificationCriteria.join('; '),
        });
        childTaskMap.set(unit.id, childTask);
      }
    } else {
      // Resume from existing tasks in database
      for (const child of existingChildren) {
        // Match sequence or ID
        const matchedUnit =
          (child.sequence !== undefined && child.sequence !== null
            ? plan.units[child.sequence - 1]
            : undefined) || plan.units.find((u) => u.title === child.title);
        if (matchedUnit) {
          childTaskMap.set(matchedUnit.id, child);
        }
      }
    }

    const childResults: ChildTaskExecutionResult[] = [];
    const completedUnitSummaries: Record<string, string> = {};
    let projectRootPath = this.workspaceRoot;

    // 3. Sequential Execution Queue with Dependency Enforcement
    for (let i = 0; i < plan.units.length; i++) {
      const unit = plan.units[i];
      let childTask = childTaskMap.get(unit.id) || this.taskService.getChildTasks(parentTaskId).find((c) => c.sequence === i + 1);

      if (!childTask) {
        childTask = this.taskService.createTask({
          title: unit.title,
          parentTaskId,
          taskType: 'child_unit',
          sequence: i + 1,
          dependencies: unit.dependencies,
          expectedOutput: unit.expectedOutput,
          verificationCriteria: unit.verificationCriteria.join('; '),
        });
        childTaskMap.set(unit.id, childTask);
      }

      // Check if already completed from previous run
      if (childTask.state === 'completed') {
        this.logger.info(`Skipping already completed child unit: '${unit.title}'`, { unitId: unit.id, taskId: childTask.id });
        completedUnitSummaries[unit.id] = childTask.summary || `Completed ${unit.title}`;
        childResults.push({
          unitId: unit.id,
          taskId: childTask.id,
          title: unit.title,
          success: true,
          status: 'completed',
          summary: childTask.summary || `Completed ${unit.title}`,
          artifacts: unit.targetFiles,
          attemptCount: childTask.attemptCount || 1,
        });
        continue;
      }

      // ── A. Check Dependencies ──────────────────────────────────────────────
      const missingOrFailedDeps = unit.dependencies.filter((depId) => {
        const depResult = childResults.find((r) => r.unitId === depId);
        return !depResult || !depResult.success;
      });

      if (missingOrFailedDeps.length > 0) {
        const reason = `Blocked: Prerequisite units not satisfied (${missingOrFailedDeps.join(', ')})`;
        this.logger.warn(`Child unit execution blocked: ${reason}`, { unitId: unit.id });
        this.taskService.failTask(childTask.id, {
          errorCategory: 'DEPENDENCY_FAILED',
          summary: reason,
        });

        childResults.push({
          unitId: unit.id,
          taskId: childTask.id,
          title: unit.title,
          success: false,
          status: 'blocked',
          summary: reason,
          artifacts: [],
          error: reason,
          attemptCount: 0,
        });

        // Fail parent task
        this.taskService.failTask(parentTaskId, {
          errorCategory: 'DEPENDENCY_FAILED',
          summary: `Project orchestration halted: Unit '${unit.title}' blocked by failed prerequisites.`,
        });

        return {
          parentTaskId,
          success: false,
          status: 'failed',
          totalUnits: plan.units.length,
          completedUnits: childResults.filter((r) => r.success).length,
          failedUnits: childResults.filter((r) => !r.success).length,
          childResults,
          finalVerificationPassed: false,
          summary: `Orchestration halted: '${unit.title}' blocked by prerequisite failure.`,
          error: reason,
          durationMs: Date.now() - startTime,
        };
      }

      // ── B. Execute Unit with Retries ────────────────────────────────────────
      if (options.onProgress) {
        options.onProgress({
          unitIndex: i + 1,
          totalUnits: plan.units.length,
          unit,
          status: 'starting',
        });
      }

      let attempt = 0;
      let unitSuccess = false;
      let lastError = '';
      let unitSummary = '';

      while (attempt <= maxRetries && !unitSuccess) {
        attempt++;
        this.logger.info(`Executing unit '${unit.title}' (Attempt ${attempt}/${maxRetries + 1})`, { unitId: unit.id });

        if (attempt > 1) {
          this.taskService.resetTaskForRetry(childTask.id, 'planning');
        }

        try {
          // 1. Build Minimal Focused Context
          const prompt = this.buildFocusedPrompt(plan.parentGoal, unit, completedUnitSummaries, lastError);

          // 2. Synthesize Plan Steps for this unit
          const planResult = await this.planner.synthesize(childTask.id, {
            taskGoal: prompt,
            temperature: 0.2,
          });

          if (!planResult.success || !planResult.plan || planResult.plan.steps.length === 0) {
            lastError = planResult.errorMessage || 'Failed to synthesize implementation steps for unit.';
            this.logger.warn(`Plan synthesis failed for unit '${unit.title}'`, { attempt, error: lastError });
            continue;
          }

          // 3. Run Execution Loop for this unit with approval auto-resolution
          let execTask = await this.executionService.runExecutionLoop(childTask.id, planResult.plan.steps, {
            autoComplete: false,
          });

          // If execution paused due to pending approvals, resolve safe approvals and resume
          while (
            this.approvalService &&
            (execTask.state === 'awaiting_approval' ||
              this.approvalService.getApprovalsForTask(childTask.id).some((a) => a.status === 'pending'))
          ) {
            const pending = this.approvalService
              .getApprovalsForTask(childTask.id)
              .filter((a) => a.status === 'pending');
            if (pending.length === 0) break;
            let approvedAny = false;
            for (const appr of pending) {
              if (appr.riskLevel !== 'high') {
                this.approvalService.resolveApproval(
                  appr.approvalId,
                  'approved',
                  'Auto-approved child unit authoring operation'
                );
                approvedAny = true;
              }
            }
            if (!approvedAny) break;
            execTask = await this.executionService.runExecutionLoop(childTask.id, planResult.plan.steps, {
              autoComplete: false,
            });
          }

          if (execTask.state === 'failed' || execTask.state === 'awaiting_approval') {
            lastError = execTask.errorCategory || 'Execution step failed';
            this.logger.warn(`Execution loop failed for unit '${unit.title}'`, { attempt, error: lastError });
            continue;
          }

          // 4. Verify Content & Substance for this unit
          const verif = await this.verifyUnitImplementation(unit, plan.parentGoal);
          if (!verif.valid) {
            lastError = `Content verification failed: ${verif.reason || 'Skeleton or placeholder detected.'}`;
            this.logger.warn(`Unit content verification failed for '${unit.title}'`, { attempt, error: lastError });
            continue;
          }

          // 5. Success: Register unit artifact & update state
          unitSuccess = true;
          unitSummary = `Implemented ${unit.title} (${unit.targetFiles.join(', ')}). Output verified.`;

          // Discover and register artifact
          const discoveredDir = this.findProjectDir(unit.targetFiles);
          if (discoveredDir) {
            projectRootPath = discoveredDir;
            if (this.artifactRepo) {
              this.artifactRepo.create({
                id: `art-${childTask.id}`,
                taskId: childTask.id,
                projectId: null,
                projectRoot: discoveredDir,
                relativeProjectRoot: path.relative(this.workspaceRoot, discoveredDir) || '.',
                entryPoint: 'index.html',
                artifactType: 'web_project',
                workspacePath: this.workspaceRoot,
                files: unit.targetFiles,
                isVerified: true,
              });
            }
          }

          this.taskService.updateTaskSummary(childTask.id, unitSummary);
          this.taskService.completeTask(childTask.id);
          completedUnitSummaries[unit.id] = unitSummary;

          if (options.onProgress) {
            options.onProgress({
              unitIndex: i + 1,
              totalUnits: plan.units.length,
              unit,
              status: 'completed',
              message: unitSummary,
            });
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          this.logger.error(`Exception during unit execution '${unit.title}'`, { attempt, error: lastError });
        }
      }

      if (!unitSuccess) {
        // Child unit failed after retries
        const curChild = this.taskService.getTask(childTask.id);
        if (curChild.state !== 'failed') {
          this.taskService.failTask(childTask.id, {
            errorCategory: 'UNIT_EXECUTION_FAILED',
            summary: `Failed after ${attempt} attempt(s): ${lastError}`,
          });
        } else {
          this.taskService.updateTaskSummary(childTask.id, `Failed after ${attempt} attempt(s): ${lastError}`);
        }

        childResults.push({
          unitId: unit.id,
          taskId: childTask.id,
          title: unit.title,
          success: false,
          status: 'failed',
          summary: `Failed after ${attempt} attempts: ${lastError}`,
          artifacts: [],
          error: lastError,
          attemptCount: attempt,
        });

        if (options.onProgress) {
          options.onProgress({
            unitIndex: i + 1,
            totalUnits: plan.units.length,
            unit,
            status: 'failed',
            message: lastError,
          });
        }

        // Fail parent task
        this.taskService.failTask(parentTaskId, {
          errorCategory: 'CHILD_TASK_FAILED',
          summary: `Project failed at unit '${unit.title}': ${lastError}`,
        });

        return {
          parentTaskId,
          success: false,
          status: 'failed',
          totalUnits: plan.units.length,
          completedUnits: childResults.filter((r) => r.success).length,
          failedUnits: childResults.filter((r) => !r.success).length,
          childResults,
          finalVerificationPassed: false,
          summary: `Project orchestration failed at unit '${unit.title}'.`,
          error: lastError,
          durationMs: Date.now() - startTime,
        };
      }

      childResults.push({
        unitId: unit.id,
        taskId: childTask.id,
        title: unit.title,
        success: true,
        status: 'completed',
        summary: unitSummary,
        artifacts: unit.targetFiles,
        attemptCount: attempt,
      });
    }

    // ── 4. Final Integration & Global Verification ───────────────────────────
    this.logger.info(`All ${plan.units.length} units completed. Running final integration verification.`);

    const finalVerif = await this.verifyFinalIntegration(plan.parentGoal, projectRootPath, plan);

    if (!finalVerif.valid) {
      this.logger.error(`Final integration verification failed`, { reason: finalVerif.reason });
      this.taskService.failTask(parentTaskId, {
        errorCategory: 'INTEGRATION_VERIFICATION_FAILED',
        summary: `Final integration failed: ${finalVerif.reason}`,
      });

      return {
        parentTaskId,
        success: false,
        status: 'failed',
        totalUnits: plan.units.length,
        completedUnits: childResults.filter((r) => r.success).length,
        failedUnits: 1,
        childResults,
        finalVerificationPassed: false,
        summary: `Final integration verification failed: ${finalVerif.reason}`,
        error: finalVerif.reason,
        durationMs: Date.now() - startTime,
      };
    }

    // ── 5. Register Final Verified Parent Artifact ────────────────────────────
    const allFiles = Array.from(new Set(plan.units.flatMap((u) => u.targetFiles)));
    if (this.artifactRepo) {
      this.artifactRepo.create({
        id: `art-${parentTaskId}`,
        taskId: parentTaskId,
        projectId: null,
        projectRoot: projectRootPath,
        relativeProjectRoot: path.relative(this.workspaceRoot, projectRootPath) || '.',
        entryPoint: 'index.html',
        artifactType: 'web_project',
        workspacePath: this.workspaceRoot,
        files: allFiles,
        isVerified: true,
      });
    }

    const finalSummary = `Completed all ${plan.units.length} project units with verified integration.`;
    this.taskService.updateTaskSummary(parentTaskId, finalSummary);
    this.taskService.transitionTask(parentTaskId, { targetState: 'observing' });
    this.taskService.transitionTask(parentTaskId, { targetState: 'verifying' });
    this.taskService.completeTask(parentTaskId);

    this.logger.info(`Project orchestration successfully completed!`, {
      parentTaskId,
      totalUnits: plan.units.length,
      durationMs: Date.now() - startTime,
    });

    return {
      parentTaskId,
      success: true,
      status: 'completed',
      totalUnits: plan.units.length,
      completedUnits: plan.units.length,
      failedUnits: 0,
      childResults,
      finalVerificationPassed: true,
      summary: finalSummary,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Build minimal, highly-focused prompt for a single child task unit.
   */
  private buildFocusedPrompt(
    parentGoal: string,
    unit: DecomposedTaskUnit,
    completedSummaries: Record<string, string>,
    retryError?: string
  ): string {
    const lines: string[] = [];
    const brandCandidates = extractBrandCandidates(parentGoal);
    const brand = brandCandidates.length > 0 ? brandCandidates[0] : null;

    if (brand) {
      lines.push(`Project Brand / Identity: ${brand}`);
    }
    lines.push(`Overall Project: ${parentGoal}`);
    lines.push(`Current Unit (${unit.category.toUpperCase()}): ${unit.title}`);
    lines.push(`Unit Instructions: ${unit.description}`);
    lines.push(`Target Files: ${unit.targetFiles.join(', ')}`);
    lines.push(`Expected Output: ${unit.expectedOutput}`);
    lines.push(`Verification Criteria: ${unit.verificationCriteria.join('; ')}`);
    if (brand) {
      lines.push(`Brand Directive: You must explicitly incorporate the project brand '${brand}' into the code/markup (in <title>, headings, navbar, or body text as appropriate).`);
    }

    // Add concise summaries of prerequisite units
    if (unit.dependencies.length > 0) {
      lines.push('Completed Prerequisites:');
      for (const depId of unit.dependencies) {
        if (completedSummaries[depId]) {
          lines.push(`- ${completedSummaries[depId]}`);
        }
      }
    }

    // Add relevant existing files snippet context
    const existingSnippet = this.getRelevantFilesSnippet(unit.targetFiles);
    if (existingSnippet) {
      lines.push('\nExisting Files State:');
      lines.push(existingSnippet);
    }

    if (retryError) {
      lines.push(`\nIMPORTANT: Previous attempt failed with: "${retryError}". Fix this specific issue and ensure complete, substantive implementation with no empty skeletons or placeholders.`);
    }

    return lines.join('\n');
  }

  /**
   * Reads existing workspace files up to a small bounded snippet for context.
   */
  private getRelevantFilesSnippet(targetFiles: string[]): string {
    const snippets: string[] = [];
    for (const relFile of targetFiles) {
      const fullPath = path.resolve(this.workspaceRoot, relFile);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          // Limit to max 50 lines to keep context tight
          const lines = content.split('\n');
          const preview = lines.slice(0, 50).join('\n');
          snippets.push(`--- ${relFile} (${lines.length} lines) ---\n${preview}${lines.length > 50 ? '\n... (remaining lines omitted)' : ''}`);
        } catch {
          /* ignore read error */
        }
      }
    }
    return snippets.join('\n\n');
  }

  /**
   * Verify implementation of a single child unit.
   */
  private async verifyUnitImplementation(
    unit: DecomposedTaskUnit,
    parentGoal?: string
  ): Promise<{ valid: boolean; reason?: string }> {
    for (const file of unit.targetFiles) {
      const targetAbs = path.resolve(this.workspaceRoot, file);
      const dir = path.dirname(targetAbs);
      const base = path.basename(file);
      const nameVariants = [base];
      if (base === 'styles.css') nameVariants.push('style.css');
      if (base === 'style.css') nameVariants.push('styles.css');
      if (base === 'scripts.js') nameVariants.push('script.js');
      if (base === 'script.js') nameVariants.push('scripts.js');

      const candidates = nameVariants.map((v) => path.join(dir, v));

      const existingFile = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      if (!existingFile) {
        return { valid: false, reason: `Target file '${file}' was not created.` };
      }

      if (file.endsWith('.html')) {
        const content = fs.readFileSync(existingFile, 'utf8');
        const verif = verifyChildUnitContentSubstance(content, {
          unit,
          parentGoal: parentGoal || unit.title,
        });
        if (!verif.valid) {
          return { valid: false, reason: verif.reason };
        }
      } else if (file.endsWith('.css')) {
        const cssContent = fs.readFileSync(existingFile, 'utf8');
        if (cssContent.length > 0 && !/\{[^}]*:[^}]*\}/.test(cssContent)) {
          return { valid: false, reason: `CSS artifact '${file}' does not contain valid CSS style rules.` };
        }
      } else if (file.endsWith('.js')) {
        const jsContent = fs.readFileSync(existingFile, 'utf8');
        if (unit.category === 'logic' && jsContent.trim().length === 0) {
          return { valid: false, reason: `JS artifact '${file}' is empty (0 bytes).` };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Verify final end-to-end integration across all project files.
   */
  private async verifyFinalIntegration(
    parentGoal: string,
    projectRoot: string,
    plan?: DecompositionPlan
  ): Promise<{ valid: boolean; reason?: string }> {
    const indexPath = path.join(projectRoot, 'index.html');
    if (!fs.existsSync(indexPath)) {
      return { valid: false, reason: 'index.html does not exist in project directory.' };
    }

    const htmlContent = fs.readFileSync(indexPath, 'utf8');
    const substanceCheck = verifyHtmlContentSubstance(htmlContent, parentGoal);
    if (!substanceCheck.valid) {
      return { valid: false, reason: substanceCheck.reason };
    }

    // Check goal completion verifier with ONLY this project's target files
    const targetFiles = plan
      ? Array.from(new Set(plan.units.flatMap((u) => u.targetFiles)))
      : ['index.html', 'styles.css', 'scripts.js'];

    const nowIso = new Date().toISOString();
    const syntheticSteps: AgentPlanStep[] = targetFiles.map((f, idx) => ({
      stepId: `integration-step-${idx}`,
      taskId: 'integration-check',
      sequence: idx + 1,
      stepType: 'tool_execution' as const,
      toolId: 'filesystem_write',
      requestedCapabilities: ['filesystem.write'],
      status: 'completed' as const,
      attemptCount: 1,
      maxAttempts: 3,
      params: { relativePath: path.isAbsolute(f) ? path.relative(projectRoot, f) : f },
      createdAt: nowIso,
      updatedAt: nowIso,
    }));
    const goalVerif = this.goalVerifier.verifyGoal(parentGoal, syntheticSteps, projectRoot);

    if (!goalVerif.verified) {
      return { valid: false, reason: goalVerif.errorMessage || 'Goal verification failed' };
    }

    return { valid: true };
  }

  private findProjectDir(targetFiles: string[]): string {
    for (const f of targetFiles) {
      if (f.includes('/') || f.includes('\\')) {
        const dirPart = path.dirname(f);
        if (dirPart && dirPart !== '.') {
          return path.resolve(this.workspaceRoot, dirPart);
        }
      }
    }
    return this.workspaceRoot;
  }
}
