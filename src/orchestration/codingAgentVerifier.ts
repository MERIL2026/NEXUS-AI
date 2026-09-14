/**
 * NEXUS AI — P6-D: Coding Agent Verifier
 *
 * Deterministic validation runner and verifier.
 *
 * SECURITY INVARIANTS:
 *  - Executes validation commands ONLY via terminal_execute through ToolGateway.
 *  - Uses strict TerminalCommandPolicy — no shell interpreters, no arbitrary strings.
 *  - Verification requires explicit zero exit code and zero security errors.
 *  - Does NOT assume success merely because an edit completed.
 */

import type { ToolGateway } from '../tools/index.js';
import type { FileChangeDiff } from '../tools/adapters/filesystemAdapter.js';
import type { CodingValidationResult, CodingVerificationResult } from './codingAgentTypes.js';
import { Logger, LogLevel } from '../common/logger.js';

export interface ValidationCommandSpec {
  command: string;
  args: string[];
}

export class CodingAgentVerifier {
  private logger: Logger;

  constructor(
    private toolGateway: ToolGateway,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('CodingAgentVerifier', logLevel);
  }

  /**
   * Run validation commands and verify the state of the workspace after edits.
   *
   * @param taskId Agent task ID.
   * @param diffs List of file change diffs applied.
   * @param customCommands Optional validation command specs to execute.
   * @returns Deterministic CodingVerificationResult.
   */
  async verify(
    taskId: string,
    diffs: FileChangeDiff[] = [],
    customCommands?: ValidationCommandSpec[]
  ): Promise<CodingVerificationResult> {
    this.logger.info(`Starting code verification`, { taskId, diffCount: diffs.length });

    // Determine commands to run
    const commandsToRun: ValidationCommandSpec[] = customCommands && customCommands.length > 0
      ? customCommands
      : [
          { command: 'npm', args: ['run', 'typecheck'] },
          { command: 'npm', args: ['test'] },
        ];

    let lastValidationResult: CodingValidationResult | null = null;
    let allPassed = true;
    let failureReason = '';
    let failureErrorCategory: string | undefined = undefined;

    for (let i = 0; i < commandsToRun.length; i++) {
      const spec = commandsToRun[i];
      const requestId = `req-val-${taskId}-${i + 1}`;

      this.logger.info(`Running validation command ${i + 1}/${commandsToRun.length}`, {
        taskId,
        command: spec.command,
        args: spec.args,
      });

      const execRes = this.toolGateway.executeTool({
        requestId,
        taskId,
        toolId: 'terminal_execute',
        requestedCapabilities: ['terminal.execute'],
        params: {
          command: spec.command,
          args: spec.args,
          timeoutMs: 30_000,
        },
      });

      const resolved = execRes instanceof Promise ? await execRes : execRes;

      const out = resolved.output as {
        success?: boolean;
        exitCode?: number | null;
        signal?: string | null;
        stdout?: string;
        stderr?: string;
        stdoutTruncated?: boolean;
        stderrTruncated?: boolean;
        durationMs?: number;
        timedOut?: boolean;
        cancelled?: boolean;
      } | undefined;

      const validation: CodingValidationResult = {
        passed: resolved.success && out?.exitCode === 0,
        command: spec.command,
        args: spec.args,
        exitCode: out?.exitCode ?? null,
        stdout: out?.stdout || '',
        stderr: out?.stderr || resolved.errorMessage || '',
        stdoutTruncated: out?.stdoutTruncated ?? false,
        stderrTruncated: out?.stderrTruncated ?? false,
        durationMs: out?.durationMs ?? 0,
        timedOut: out?.timedOut ?? false,
        cancelled: out?.cancelled ?? false,
        errorCategory: resolved.errorCategory,
        errorMessage: resolved.errorMessage,
      };

      lastValidationResult = validation;

      if (!validation.passed) {
        allPassed = false;
        failureErrorCategory = resolved.errorCategory || 'VALIDATION_FAILED';
        failureReason = validation.errorMessage || `Validation command '${spec.command} ${spec.args.join(' ')}' failed with exit code ${validation.exitCode}.`;
        this.logger.warn(`Validation command failed`, {
          taskId,
          command: spec.command,
          exitCode: validation.exitCode,
          errorCategory: failureErrorCategory,
        });
        break; // Stop on first failing validation command
      }
    }

    if (allPassed) {
      this.logger.info(`All validation checks passed successfully`, { taskId });
      return {
        verified: true,
        reason: 'All validation checks passed with zero exit code and no errors.',
        diffsApplied: [...diffs],
        validationResult: lastValidationResult,
      };
    }

    return {
      verified: false,
      reason: failureReason,
      diffsApplied: [...diffs],
      validationResult: lastValidationResult,
      errorCategory: failureErrorCategory,
    };
  }
}
