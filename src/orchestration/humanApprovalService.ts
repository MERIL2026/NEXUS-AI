/**
 * NEXUS AI — Human Approval Service
 *
 * Orchestrates the human approval lifecycle: request creation, policy evaluation,
 * task state machine integration (transition to/from awaiting_approval), expiration,
 * resolution, and privacy-safe audit logging.
 *
 * SECURITY INVARIANTS:
 *  - Terminal approval states (approved, rejected, expired, cancelled) CANNOT be reopened.
 *  - Approval DOES NOT equal permission — authorization remains mandatory via PermissionEngine.
 *  - Privacy-safe logging: Secrets, full prompts, model responses, and raw document contents are NEVER logged.
 */

import type { AgentTaskService } from './agentTaskService.js';
import type { AgentTask } from '../storage/repositories/types.js';
import type { ToolGateway } from '../tools/index.js';
import type { ApprovalRepository } from '../storage/repositories/approvalRepository.js';
import type {
  ApprovalRequest,
  ApprovalStatus,
  CreateApprovalRequestDto,
  ApprovalPolicyConfig,
  ApprovalDecision,
} from '../tools/approvalTypes.js';
import { TERMINAL_APPROVAL_STATES } from '../tools/approvalTypes.js';
import { ApprovalPolicyEngine } from '../tools/approvalPolicyEngine.js';
import { ApprovalGate } from '../tools/approvalGate.js';
import { AgentStateMachine } from './agentStateMachine.js';
import { Logger, LogLevel } from '../common/logger.js';

export interface ResolveApprovalResult {
  success: boolean;
  approval: ApprovalRequest;
  task: AgentTask | null;
  error?: string;
}

export class HumanApprovalService {
  private policyEngine: ApprovalPolicyEngine;
  private approvalGate: ApprovalGate;
  private logger: Logger;

  // In-memory store fallback if repository is not passed
  private memoryStore = new Map<string, ApprovalRequest>();

  constructor(
    private taskService: AgentTaskService,
    private toolGateway: ToolGateway,
    private repository?: ApprovalRepository,
    policyConfig?: Partial<ApprovalPolicyConfig>,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('HumanApprovalService', logLevel);
    this.policyEngine = new ApprovalPolicyEngine(policyConfig, logLevel);
    this.approvalGate = new ApprovalGate(logLevel);
  }

  /**
   * Create an approval request for a task step based on policy evaluation.
   */
  createApprovalRequest(dto: CreateApprovalRequestDto): {
    approval: ApprovalRequest;
    decision: ApprovalDecision;
    task: AgentTask;
  } {
    const { taskId, planId, stepId, toolId, requestedCapability, ttlMs } = dto;
    const nowIso = new Date().toISOString();
    const effectiveTtlMs = ttlMs ?? this.policyEngine.getConfig().defaultTtlMs;
    const expiresAt = new Date(Date.now() + effectiveTtlMs).toISOString();

    // 1. Resolve tool definition from ToolRegistry
    const toolDef = this.toolGateway.getTool(toolId);
    const riskLevel = dto.riskLevel ?? (toolDef ? toolDef.riskLevel : 'high');

    // 2. Evaluate policy
    const decision = this.policyEngine.evaluate(toolDef, requestedCapability);

    let initialStatus: ApprovalStatus = 'pending';
    let decisionReason: string | undefined;

    if (decision.decision === 'AUTO_APPROVED') {
      initialStatus = 'approved';
      decisionReason = decision.reason;
    } else if (decision.decision === 'POLICY_DENIED') {
      initialStatus = 'rejected';
      decisionReason = decision.reason;
    }

    const approvalId = `appr-${taskId}-${stepId}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

    const request: ApprovalRequest = {
      approvalId,
      taskId,
      planId,
      stepId,
      toolId,
      riskLevel,
      requestedCapability,
      status: initialStatus,
      createdAt: nowIso,
      resolvedAt: initialStatus !== 'pending' ? nowIso : undefined,
      expiresAt,
      decisionReason,
    };

    // 3. Persist request
    this.saveApproval(request);

    // 4. Privacy-safe audit log
    this.logger.info(`Approval request created`, {
      approvalId: request.approvalId,
      taskId: request.taskId,
      stepId: request.stepId,
      toolId: request.toolId,
      riskLevel: request.riskLevel,
      status: request.status,
      decision: decision.decision,
      reasonCategory: decision.reason,
      timestamp: request.createdAt,
    });

    // 5. Task state machine integration
    let task = this.taskService.getTask(taskId);

    if (initialStatus === 'pending') {
      // Transition task state to 'awaiting_approval' if not already terminal or awaiting
      if (task.state !== 'awaiting_approval' && !AgentStateMachine.isTerminal(task.state)) {
        if (task.state === 'created' || task.state === 'verifying' || task.state === 'observing' || task.state === 'executing') {
          task = this.taskService.transitionTask(taskId, { targetState: 'planning', currentStep: stepId });
        }
        task = this.taskService.transitionTask(taskId, {
          targetState: 'awaiting_approval',
          currentStep: stepId,
        });
      }
    } else if (initialStatus === 'rejected') {
      // Fail/cancel task on policy denial
      if (!AgentStateMachine.isTerminal(task.state)) {
        task = this.taskService.failTask(taskId, {
          errorCategory: 'POLICY_DENIED',
          currentStep: stepId,
        });
      }
    }

    return { approval: request, decision, task };
  }

  /**
   * Resolve a pending approval request with explicit user decision ('approved' | 'rejected').
   */
  resolveApproval(
    approvalId: string,
    userDecision: 'approved' | 'rejected',
    reason?: string
  ): ResolveApprovalResult {
    let approval = this.getApproval(approvalId);

    if (!approval) {
      this.logger.error(`Failed to resolve approval: approvalId '${approvalId}' not found`);
      throw new Error(`Approval request '${approvalId}' not found.`);
    }

    // 1. Terminal state check — NO SILENT REOPENING OF TERMINAL APPROVALS!
    if (TERMINAL_APPROVAL_STATES.has(approval.status)) {
      const msg = `Transition rejected: approval '${approvalId}' is in terminal state '${approval.status}' and cannot be resolved to '${userDecision}'.`;
      this.logger.warn(msg, { approvalId, status: approval.status });
      return {
        success: false,
        approval,
        task: this.taskService.getTask(approval.taskId),
        error: msg,
      };
    }

    const nowIso = new Date().toISOString();

    // 2. Check expiration
    if (approval.expiresAt <= nowIso) {
      approval.status = 'expired';
      approval.resolvedAt = nowIso;
      approval.decisionReason = 'Approval request expired before decision was submitted.';
      this.saveApproval(approval);

      this.logger.warn(`Approval request '${approvalId}' expired before resolution`, { approvalId });
      return {
        success: false,
        approval,
        task: this.taskService.getTask(approval.taskId),
        error: `Approval request '${approvalId}' has expired.`,
      };
    }

    // 3. Check associated task state — cannot approve if task is terminal or cancelled
    let task = this.taskService.getTask(approval.taskId);
    if (AgentStateMachine.isTerminal(task.state) || task.state === 'cancelled') {
      approval.status = 'cancelled';
      approval.resolvedAt = nowIso;
      approval.decisionReason = `Task '${task.id}' is in terminal state '${task.state}'.`;
      this.saveApproval(approval);

      this.logger.warn(`Cannot resolve approval '${approvalId}': associated task '${task.id}' is in terminal state '${task.state}'`, {
        approvalId,
        taskId: task.id,
        taskState: task.state,
      });

      return {
        success: false,
        approval,
        task,
        error: `Associated task '${task.id}' is in terminal state '${task.state}'.`,
      };
    }

    // 4. Perform resolution transition
    const finalReason = reason ?? (userDecision === 'approved' ? 'User granted approval' : 'User rejected approval');
    approval.status = userDecision;
    approval.resolvedAt = nowIso;
    approval.decisionReason = finalReason;
    this.saveApproval(approval);

    // 5. Privacy-safe audit log
    this.logger.info(`Approval request resolved`, {
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      stepId: approval.stepId,
      toolId: approval.toolId,
      decision: userDecision,
      reasonCategory: finalReason,
      timestamp: nowIso,
    });

    // 6. Integrate with AgentStateMachine
    if (userDecision === 'approved') {
      // Transition task state: awaiting_approval -> executing
      if (task.state === 'awaiting_approval') {
        task = this.taskService.transitionTask(task.id, {
          targetState: 'executing',
          currentStep: approval.stepId,
        });
      }
    } else {
      // Transition task state: awaiting_approval -> cancelled
      if (task.state === 'awaiting_approval') {
        task = this.taskService.cancelTask(task.id);
      }
    }

    return {
      success: true,
      approval,
      task,
    };
  }

  /**
   * Retrieve an approval request by ID, automatically evaluating expiration if pending.
   */
  getApproval(approvalId: string): ApprovalRequest | null {
    let approval: ApprovalRequest | null = null;

    if (this.repository) {
      approval = this.repository.findById(approvalId);
    } else {
      approval = this.memoryStore.get(approvalId) ?? null;
    }

    if (!approval) return null;

    // Auto-expire if pending and past expiration timestamp
    if (approval.status === 'pending') {
      const nowIso = new Date().toISOString();
      if (approval.expiresAt <= nowIso) {
        approval.status = 'expired';
        approval.resolvedAt = nowIso;
        approval.decisionReason = 'Approval request expired.';
        this.saveApproval(approval);
      }
    }

    return approval;
  }

  /**
   * Retrieve all approval requests for a task.
   */
  getApprovalsForTask(taskId: string): ApprovalRequest[] {
    if (this.repository) {
      return this.repository.findByTaskId(taskId);
    }
    return Array.from(this.memoryStore.values()).filter((a) => a.taskId === taskId);
  }

  /**
   * List all pending approval requests.
   */
  listPendingApprovals(): ApprovalRequest[] {
    if (this.repository) {
      return this.repository.listPending();
    }
    return Array.from(this.memoryStore.values()).filter((a) => a.status === 'pending');
  }

  /**
   * Respond to an approval request with decision APPROVED or REJECTED.
   */
  respondToApproval(
    approvalId: string,
    params: { decision: 'APPROVED' | 'REJECTED'; reason?: string }
  ): ApprovalRequest {
    const userDecision = params.decision.toLowerCase() as 'approved' | 'rejected';
    const result = this.resolveApproval(approvalId, userDecision, params.reason);
    if (!result.success) {
      throw new Error(result.error || `Failed to resolve approval request '${approvalId}'`);
    }
    return result.approval;
  }

  /**
   * Evaluate the ApprovalGate for a given task step.
   */
  evaluateGateForStep(taskId: string, stepId: string): ReturnType<ApprovalGate['evaluateGate']> {
    let request: ApprovalRequest | null = null;

    if (this.repository) {
      request = this.repository.findPendingForStep(taskId, stepId);
      if (!request) {
        // Find latest resolved request for this step if not pending
        const all = this.repository.findByTaskId(taskId).filter((a) => a.stepId === stepId);
        if (all.length > 0) {
          request = all[all.length - 1];
        }
      }
    } else {
      const all = Array.from(this.memoryStore.values()).filter((a) => a.taskId === taskId && a.stepId === stepId);
      if (all.length > 0) {
        request = all[all.length - 1];
      }
    }

    return this.approvalGate.evaluateGate(request);
  }

  /**
   * Expire all stale pending approvals.
   */
  expireStaleApprovals(): number {
    const nowIso = new Date().toISOString();

    if (this.repository) {
      return this.repository.expireStaleApprovals(nowIso);
    }

    let count = 0;
    for (const approval of this.memoryStore.values()) {
      if (approval.status === 'pending' && approval.expiresAt <= nowIso) {
        approval.status = 'expired';
        approval.resolvedAt = nowIso;
        approval.decisionReason = 'Approval request expired.';
        count++;
      }
    }
    return count;
  }

  /**
   * Invalidate/cancel all pending approvals for a task (e.g. when task is cancelled).
   */
  cancelApprovalsForTask(taskId: string, reason: string = 'Task cancelled'): number {
    const nowIso = new Date().toISOString();

    if (this.repository) {
      return this.repository.cancelPendingForTask(taskId, nowIso, reason);
    }

    let count = 0;
    for (const approval of this.memoryStore.values()) {
      if (approval.taskId === taskId && approval.status === 'pending') {
        approval.status = 'cancelled';
        approval.resolvedAt = nowIso;
        approval.decisionReason = reason;
        count++;
      }
    }
    return count;
  }

  /**
   * Get policy engine instance.
   */
  getPolicyEngine(): ApprovalPolicyEngine {
    return this.policyEngine;
  }

  /**
   * Get approval gate instance.
   */
  getGate(): ApprovalGate {
    return this.approvalGate;
  }

  private saveApproval(request: ApprovalRequest): void {
    if (this.repository) {
      const existing = this.repository.findById(request.approvalId);
      if (existing) {
        this.repository.updateStatus(
          request.approvalId,
          request.status,
          request.resolvedAt,
          request.decisionReason
        );
      } else {
        this.repository.create(request);
      }
    } else {
      this.memoryStore.set(request.approvalId, request);
    }
  }
}
