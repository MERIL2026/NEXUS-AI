/**
 * NEXUS AI — P5-F: Human Approval & Execution Control Types
 *
 * Provides normalized data contracts, states, policy configurations,
 * and decision structures for the human approval system.
 */

import type { ToolCapability, ToolRiskLevel } from './types.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

/**
 * Terminal approval states that must never be reopened.
 */
export const TERMINAL_APPROVAL_STATES: ReadonlySet<ApprovalStatus> = new Set([
  'approved',
  'rejected',
  'expired',
  'cancelled',
]);

/**
 * Structured approval request metadata.
 * Note: Secrets, full prompts, model responses, and raw document contents are EXCLUDED.
 */
export interface ApprovalRequest {
  approvalId: string;
  taskId: string;
  planId?: string;
  stepId: string;
  toolId: string;
  riskLevel: ToolRiskLevel;
  requestedCapability: ToolCapability;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
  expiresAt: string;
  decisionReason?: string;
}

export interface CreateApprovalRequestDto {
  taskId: string;
  planId?: string;
  stepId: string;
  toolId: string;
  riskLevel?: ToolRiskLevel;
  requestedCapability: ToolCapability;
  ttlMs?: number;
}

export interface ApprovalPolicyConfig {
  /** If true, low-risk operations (e.g. read-only filesystem) are auto-approved. Default: true. */
  autoApproveLowRisk: boolean;
  /** Require explicit approval for medium-risk operations. Default: true. */
  requireApprovalForMediumRisk: boolean;
  /** Require explicit approval for high-risk operations. Default: true. */
  requireApprovalForHighRisk: boolean;
  /** Require explicit approval for critical-risk operations. Default: true. */
  requireApprovalForCriticalRisk: boolean;
  /** Default lifetime of a pending approval request in milliseconds. Default: 300,000 (5 minutes). */
  defaultTtlMs: number;
}

export const DEFAULT_APPROVAL_POLICY_CONFIG: ApprovalPolicyConfig = {
  autoApproveLowRisk: true,
  requireApprovalForMediumRisk: true,
  requireApprovalForHighRisk: true,
  requireApprovalForCriticalRisk: true,
  defaultTtlMs: 5 * 60 * 1000, // 5 minutes
};

export type ApprovalPolicyDecisionCode = 'AUTO_APPROVED' | 'REQUIRES_APPROVAL' | 'POLICY_DENIED';

export interface ApprovalDecision {
  requiresApproval: boolean;
  decision: ApprovalPolicyDecisionCode;
  reason: string;
  riskLevel: ToolRiskLevel;
}

export interface ApprovalGateResult {
  allowed: boolean;
  reason: string;
  approvalId?: string;
  status: ApprovalStatus;
  requiresUserAction: boolean;
}
