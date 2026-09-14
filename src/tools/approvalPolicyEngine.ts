/**
 * NEXUS AI — Approval Policy Engine
 *
 * Deterministically classifies planned tool actions according to risk and policy
 * rules to determine whether explicit human approval is required before execution.
 *
 * Security Invariant:
 *  - Default behavior is SAFE.
 *  - Unknown tools, disabled tools, or unrecognized risk levels default to POLICY_DENIED or REQUIRES_APPROVAL.
 *  - No permissive fallbacks exist.
 */

import type { ToolDefinition, ToolCapability, ToolRiskLevel } from './types.js';
import type {
  ApprovalDecision,
  ApprovalPolicyConfig,
} from './approvalTypes.js';
import { DEFAULT_APPROVAL_POLICY_CONFIG } from './approvalTypes.js';
import { Logger, LogLevel } from '../common/logger.js';

export class ApprovalPolicyEngine {
  private config: ApprovalPolicyConfig;
  private logger: Logger;

  constructor(config?: Partial<ApprovalPolicyConfig>, logLevel: LogLevel = 'info') {
    this.config = { ...DEFAULT_APPROVAL_POLICY_CONFIG, ...config };
    this.logger = new Logger('ApprovalPolicyEngine', logLevel);
  }

  /**
   * Deterministically evaluate whether a requested tool action requires human approval.
   */
  evaluate(
    toolDef: ToolDefinition | null,
    requestedCapability: ToolCapability
  ): ApprovalDecision {
    // 1. Tool availability check
    if (!toolDef) {
      this.logger.warn(`Approval policy evaluation failed: tool definition is null`);
      return {
        requiresApproval: false,
        decision: 'POLICY_DENIED',
        reason: 'Tool is not registered in the system tool registry.',
        riskLevel: 'high',
      };
    }

    if (!toolDef.enabled) {
      this.logger.warn(`Approval policy evaluation failed: tool '${toolDef.id}' is disabled`);
      return {
        requiresApproval: false,
        decision: 'POLICY_DENIED',
        reason: `Tool '${toolDef.id}' is disabled in the system tool registry.`,
        riskLevel: toolDef.riskLevel || 'high',
      };
    }

    // 2. Capability verification
    if (!toolDef.requiredPermissions.includes(requestedCapability)) {
      this.logger.warn(`Approval policy evaluation failed: tool '${toolDef.id}' does not support capability '${requestedCapability}'`);
      return {
        requiresApproval: false,
        decision: 'POLICY_DENIED',
        reason: `Tool '${toolDef.id}' does not declare requested capability '${requestedCapability}'.`,
        riskLevel: toolDef.riskLevel || 'high',
      };
    }

    const riskLevel: ToolRiskLevel = toolDef.riskLevel;

    // 3. Risk-based deterministic policy decision
    switch (riskLevel) {
      case 'low':
        if (this.config.autoApproveLowRisk) {
          return {
            requiresApproval: false,
            decision: 'AUTO_APPROVED',
            reason: 'Low-risk operation automatically approved by security policy.',
            riskLevel: 'low',
          };
        }
        return {
          requiresApproval: true,
          decision: 'REQUIRES_APPROVAL',
          reason: 'Low-risk operation requires explicit human approval per current policy configuration.',
          riskLevel: 'low',
        };

      case 'medium':
        if (this.config.requireApprovalForMediumRisk) {
          return {
            requiresApproval: true,
            decision: 'REQUIRES_APPROVAL',
            reason: 'Medium-risk tool action requires explicit human approval.',
            riskLevel: 'medium',
          };
        }
        return {
          requiresApproval: false,
          decision: 'AUTO_APPROVED',
          reason: 'Medium-risk operation auto-approved by custom policy configuration.',
          riskLevel: 'medium',
        };

      case 'high':
        if (this.config.requireApprovalForHighRisk) {
          return {
            requiresApproval: true,
            decision: 'REQUIRES_APPROVAL',
            reason: 'High-risk tool action requires explicit human approval.',
            riskLevel: 'high',
          };
        }
        return {
          requiresApproval: false,
          decision: 'AUTO_APPROVED',
          reason: 'High-risk operation auto-approved by custom policy configuration.',
          riskLevel: 'high',
        };

      case 'critical':
        if (this.config.requireApprovalForCriticalRisk) {
          return {
            requiresApproval: true,
            decision: 'REQUIRES_APPROVAL',
            reason: 'Critical-risk tool action requires explicit human approval.',
            riskLevel: 'critical',
          };
        }
        return {
          requiresApproval: false,
          decision: 'POLICY_DENIED',
          reason: 'Critical-risk operation denied by default policy.',
          riskLevel: 'critical',
        };

      default:
        // Unknown risk level handling — default safe policy is DENY or REQUIRE APPROVAL
        this.logger.warn(`Unknown risk level '${String(riskLevel)}' encountered for tool '${toolDef.id}'`);
        return {
          requiresApproval: true,
          decision: 'REQUIRES_APPROVAL',
          reason: `Unknown risk level '${String(riskLevel)}' requires explicit human approval.`,
          riskLevel: 'high',
        };
    }
  }

  /**
   * Get current approval policy configuration.
   */
  getConfig(): Readonly<ApprovalPolicyConfig> {
    return { ...this.config };
  }

  /**
   * Update approval policy configuration.
   */
  updateConfig(config: Partial<ApprovalPolicyConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
