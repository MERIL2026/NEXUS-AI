import type { ToolRegistry } from './toolRegistry.js';
import type {
  ToolInvocationRequest,
  AuthorizationResult,
  PermissionPolicy,
  ToolCapability,
} from './types.js';
import {
  DEFAULT_PERMISSION_POLICY,
  VALID_CAPABILITIES,
  RISK_LEVEL_ORDER,
} from './types.js';
import { Logger, LogLevel } from '../common/logger.js';

export class PermissionEngine {
  private logger: Logger;
  private policy: PermissionPolicy;

  constructor(
    private registry: ToolRegistry,
    policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('PermissionEngine', logLevel);
    this.policy = policy;
  }

  /**
   * Get current active permission policy.
   */
  getPolicy(): PermissionPolicy {
    return { ...this.policy, allowedCapabilities: [...this.policy.allowedCapabilities] };
  }

  /**
   * Update active permission policy.
   */
  setPolicy(policy: PermissionPolicy): void {
    this.policy = { ...policy, allowedCapabilities: [...policy.allowedCapabilities] };
    this.logger.info(`Updated permission policy`, { policyId: policy.id, maxRisk: policy.maxRiskLevel });
  }

  /**
   * Authorize a tool invocation request against the registry and security policy.
   *
   * @param request The tool invocation request.
   * @param taskExistsFn Optional callback to verify if the referenced task ID exists.
   * @returns Deterministic AuthorizationResult.
   */
  authorize(
    request: ToolInvocationRequest,
    taskExistsFn?: (taskId: string) => boolean
  ): AuthorizationResult {
    const timestamp = new Date().toISOString();

    // 1. Structure validation
    if (
      !request ||
      !request.requestId ||
      !request.taskId ||
      !request.toolId ||
      !Array.isArray(request.requestedCapabilities)
    ) {
      return this.deny(
        request?.requestId || 'unknown',
        request?.taskId || 'unknown',
        request?.toolId || 'unknown',
        request?.requestedCapabilities || [],
        'INVALID_REQUEST: Invocation request is missing required fields (requestId, taskId, toolId, or requestedCapabilities).',
        timestamp
      );
    }

    // 2. Task identity verification
    if (taskExistsFn && !taskExistsFn(request.taskId)) {
      return this.deny(
        request.requestId,
        request.taskId,
        request.toolId,
        request.requestedCapabilities,
        `UNKNOWN_TASK: Agent task '${request.taskId}' does not exist or is invalid.`,
        timestamp
      );
    }

    // 3. Unknown capability check
    for (const cap of request.requestedCapabilities) {
      if (!VALID_CAPABILITIES.has(cap)) {
        return this.deny(
          request.requestId,
          request.taskId,
          request.toolId,
          request.requestedCapabilities,
          `UNKNOWN_CAPABILITY: Requested capability '${cap}' is not a recognized system capability.`,
          timestamp
        );
      }
    }

    // 4. Tool registration check
    const tool = this.registry.getTool(request.toolId);
    if (!tool) {
      return this.deny(
        request.requestId,
        request.taskId,
        request.toolId,
        request.requestedCapabilities,
        `UNKNOWN_TOOL: Tool '${request.toolId}' is not registered in the ToolRegistry.`,
        timestamp
      );
    }

    // 5. Tool enabled state check
    if (!tool.enabled && !this.policy.allowDisabledTools) {
      return this.deny(
        request.requestId,
        request.taskId,
        request.toolId,
        request.requestedCapabilities,
        `DISABLED_TOOL: Tool '${request.toolId}' is currently disabled.`,
        timestamp,
        tool.riskLevel
      );
    }

    // 6. Risk level check against policy
    const toolRisk = RISK_LEVEL_ORDER[tool.riskLevel] ?? 4;
    const policyMaxRisk = RISK_LEVEL_ORDER[this.policy.maxRiskLevel] ?? 3;
    if (toolRisk > policyMaxRisk) {
      return this.deny(
        request.requestId,
        request.taskId,
        request.toolId,
        request.requestedCapabilities,
        `EXCEEDS_POLICY_RISK: Tool risk level '${tool.riskLevel}' exceeds policy limit '${this.policy.maxRiskLevel}'.`,
        timestamp,
        tool.riskLevel
      );
    }

    // 7. Permission policy allowed capabilities check
    const policyAllowedSet = new Set(this.policy.allowedCapabilities);
    for (const cap of request.requestedCapabilities) {
      if (!policyAllowedSet.has(cap)) {
        return this.deny(
          request.requestId,
          request.taskId,
          request.toolId,
          request.requestedCapabilities,
          `MISSING_PERMISSION: Capability '${cap}' is not allowed under policy '${this.policy.id}'.`,
          timestamp,
          tool.riskLevel
        );
      }
    }

    // 8. Tool declared capabilities check (requested capability must be declared by tool AND request must satisfy tool required permissions)
    const toolDeclaredSet = new Set(tool.requiredPermissions);
    for (const cap of request.requestedCapabilities) {
      if (!toolDeclaredSet.has(cap)) {
        return this.deny(
          request.requestId,
          request.taskId,
          request.toolId,
          request.requestedCapabilities,
          `MISSING_PERMISSION: Capability '${cap}' is not declared in tool '${tool.id}' required permissions.`,
          timestamp,
          tool.riskLevel
        );
      }
    }

    const requestedSet = new Set(request.requestedCapabilities);
    for (const reqCap of tool.requiredPermissions) {
      if (!requestedSet.has(reqCap)) {
        return this.deny(
          request.requestId,
          request.taskId,
          request.toolId,
          request.requestedCapabilities,
          `MISSING_PERMISSION: Request is missing required capability '${reqCap}' for tool '${tool.id}'.`,
          timestamp,
          tool.riskLevel
        );
      }
    }

    // All checks passed — ALLOW
    const result: AuthorizationResult = {
      requestId: request.requestId,
      taskId: request.taskId,
      toolId: request.toolId,
      allowed: true,
      decision: 'ALLOWED',
      reason: `Invocation authorized for task '${request.taskId}' and tool '${request.toolId}'.`,
      requestedCapabilities: [...request.requestedCapabilities],
      riskLevel: tool.riskLevel,
      timestamp,
    };

    this.logger.info(`Security decision: ALLOWED`, {
      requestId: result.requestId,
      taskId: result.taskId,
      toolId: result.toolId,
      decision: result.decision,
      capabilities: result.requestedCapabilities,
    });

    return result;
  }

  private deny(
    requestId: string,
    taskId: string,
    toolId: string,
    requestedCapabilities: ToolCapability[],
    reason: string,
    timestamp: string,
    riskLevel?: AuthorizationResult['riskLevel']
  ): AuthorizationResult {
    const result: AuthorizationResult = {
      requestId,
      taskId,
      toolId,
      allowed: false,
      decision: 'DENIED',
      reason,
      requestedCapabilities: [...requestedCapabilities],
      riskLevel,
      timestamp,
    };

    this.logger.warn(`Security decision: DENIED`, {
      requestId: result.requestId,
      taskId: result.taskId,
      toolId: result.toolId,
      decision: result.decision,
      reason: result.reason,
    });

    return result;
  }
}
