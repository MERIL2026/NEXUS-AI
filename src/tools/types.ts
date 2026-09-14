/**
 * NEXUS AI — Tool System & Permission Types
 *
 * Provides normalized contracts for tool definitions, capabilities, permission
 * policy enforcement, authorization requests, and non-executing invocation contracts.
 */

export type ToolCapability =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'terminal.execute'
  | 'network.access'
  | 'process.execute';

export const VALID_CAPABILITIES: ReadonlySet<ToolCapability> = new Set([
  'filesystem.read',
  'filesystem.write',
  'terminal.execute',
  'network.access',
  'process.execute',
]);

export type ToolCapabilityCategory =
  | 'filesystem'
  | 'terminal'
  | 'network'
  | 'process'
  | 'utility';

export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const RISK_LEVEL_ORDER: Record<ToolRiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  category: ToolCapabilityCategory;
  riskLevel: ToolRiskLevel;
  requiredPermissions: ToolCapability[];
  inputSchema: Record<string, unknown>;
  enabled: boolean;
}

export interface ToolInvocationRequest {
  requestId: string;
  taskId: string;
  toolId: string;
  requestedCapabilities: ToolCapability[];
  inputMetadata?: Record<string, unknown>;
  timestamp?: string;
}

export type AuthorizationDecision = 'ALLOWED' | 'DENIED';

export interface AuthorizationResult {
  requestId: string;
  taskId: string;
  toolId: string;
  allowed: boolean;
  decision: AuthorizationDecision;
  reason: string;
  requestedCapabilities: ToolCapability[];
  riskLevel?: ToolRiskLevel;
  timestamp: string;
}

export interface ToolInvocationResult {
  requestId: string;
  taskId: string;
  toolId: string;
  authorized: boolean;
  decision: AuthorizationDecision;
  reason: string;
  timestamp: string;
  executed: boolean; // false during P5-B auth-only, true/false depending on auth outcome in P5-C
}

export interface ToolExecutionRequest {
  requestId: string;
  taskId: string;
  toolId: string;
  requestedCapabilities: ToolCapability[];
  params: Record<string, unknown>;
  timestamp?: string;
}

export interface ToolExecutionResult {
  requestId: string;
  taskId: string;
  toolId: string;
  authorized: boolean;
  executed: boolean;
  success: boolean;
  decision: AuthorizationDecision;
  errorCategory?: string;
  errorMessage?: string;
  output?: Record<string, unknown>;
  timestamp: string;
}

export interface PermissionPolicy {
  id: string;
  name: string;
  allowedCapabilities: ToolCapability[];
  maxRiskLevel: ToolRiskLevel;
  allowDisabledTools: boolean;
}

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  id: 'default_nexus_policy',
  name: 'Default NEXUS Security Policy',
  allowedCapabilities: [
    'filesystem.read',
    'filesystem.write',
    'terminal.execute',
    'network.access',
    'process.execute',
  ],
  maxRiskLevel: 'high',
  allowDisabledTools: false,
};
