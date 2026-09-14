/**
 * NEXUS AI — Approval Gate
 *
 * Deterministic execution gate positioned immediately before tool execution.
 * Evaluates human approval status for a given task step.
 *
 * Pipeline sequence:
 *   Plan -> PlanValidator -> PermissionEngine -> ApprovalPolicyEngine -> ApprovalGate -> ToolExecutor
 *
 * SECURITY GUARANTEES:
 *  - Missing, pending, rejected, expired, or cancelled approvals BLOCK execution completely.
 *  - Approval DOES NOT grant authorization — PermissionEngine remains mandatory.
 */

import type { ApprovalRequest, ApprovalGateResult } from './approvalTypes.js';
import { Logger, LogLevel } from '../common/logger.js';

export class ApprovalGate {
  private logger: Logger;

  constructor(logLevel: LogLevel = 'info') {
    this.logger = new Logger('ApprovalGate', logLevel);
  }

  /**
   * Evaluate whether execution is permitted according to the approval request state.
   */
  evaluateGate(approvalRequest: ApprovalRequest | null): ApprovalGateResult {
    if (!approvalRequest) {
      this.logger.warn('Approval gate evaluation rejected: no approval request provided');
      return {
        allowed: false,
        reason: 'No approval request found for step execution.',
        status: 'rejected',
        requiresUserAction: false,
      };
    }

    const { approvalId, taskId, stepId, toolId, status, expiresAt } = approvalRequest;

    // Check expiration if pending
    if (status === 'pending') {
      const nowIso = new Date().toISOString();
      if (expiresAt <= nowIso) {
        this.logger.warn(`Approval gate evaluation rejected: approval request '${approvalId}' expired`, {
          approvalId,
          taskId,
          stepId,
          toolId,
          expiresAt,
        });
        return {
          allowed: false,
          reason: `Human approval request '${approvalId}' expired at ${expiresAt}.`,
          approvalId,
          status: 'expired',
          requiresUserAction: false,
        };
      }

      this.logger.info(`Approval gate evaluation halted: approval request '${approvalId}' is pending user decision`, {
        approvalId,
        taskId,
        stepId,
        toolId,
      });
      return {
        allowed: false,
        reason: `Human approval is pending for step '${stepId}' using tool '${toolId}'.`,
        approvalId,
        status: 'pending',
        requiresUserAction: true,
      };
    }

    if (status === 'approved') {
      this.logger.info(`Approval gate evaluation passed: approval request '${approvalId}' is approved`, {
        approvalId,
        taskId,
        stepId,
        toolId,
      });
      return {
        allowed: true,
        reason: 'Human approval granted.',
        approvalId,
        status: 'approved',
        requiresUserAction: false,
      };
    }

    if (status === 'rejected') {
      this.logger.warn(`Approval gate evaluation rejected: approval request '${approvalId}' was rejected`, {
        approvalId,
        taskId,
        stepId,
        toolId,
      });
      return {
        allowed: false,
        reason: `Human approval was rejected for step '${stepId}'.`,
        approvalId,
        status: 'rejected',
        requiresUserAction: false,
      };
    }

    if (status === 'expired') {
      this.logger.warn(`Approval gate evaluation rejected: approval request '${approvalId}' is expired`, {
        approvalId,
        taskId,
        stepId,
        toolId,
      });
      return {
        allowed: false,
        reason: `Human approval request '${approvalId}' has expired.`,
        approvalId,
        status: 'expired',
        requiresUserAction: false,
      };
    }

    if (status === 'cancelled') {
      this.logger.warn(`Approval gate evaluation rejected: approval request '${approvalId}' was cancelled`, {
        approvalId,
        taskId,
        stepId,
        toolId,
      });
      return {
        allowed: false,
        reason: `Human approval request '${approvalId}' was cancelled.`,
        approvalId,
        status: 'cancelled',
        requiresUserAction: false,
      };
    }

    this.logger.error(`Approval gate evaluation failed: invalid approval status '${String(status)}'`, { approvalId });
    return {
      allowed: false,
      reason: `Invalid approval status '${String(status)}'.`,
      approvalId,
      status,
      requiresUserAction: false,
    };
  }
}
