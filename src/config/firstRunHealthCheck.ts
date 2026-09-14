/**
 * NEXUS AI — FirstRunHealthCheck (P7-C)
 *
 * Consolidated 9-check health verification for first-run and repeated startup.
 * Returns a structured FirstRunReport with per-check results and overall readiness state.
 *
 * Privacy: Report NEVER exposes env vars, API keys, tokens, passwords, or raw model prompts.
 */

import type { SubsystemStatus } from '../storage/index.js';
import type { WorkspaceValidationResult } from './workspaceService.js';
import type { RuntimeHealth } from '../intelligence/runtime/types.js';
import type { ModelReadinessState } from '../intelligence/runtime/types.js';
import type { FirstRunState } from './firstRunService.js';

export type CheckStatus = 'OK' | 'DEGRADED' | 'FAIL' | 'SKIP';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  action?: string;
}

export interface FirstRunReport {
  state: FirstRunState;
  checks: CheckResult[];
  primaryModelId?: string;
  primaryModelStatus?: ModelReadinessState;
  fallbackModelId?: string;
  fallbackModelStatus?: ModelReadinessState;
  runtimeVersion?: string;
  runtimeEndpoint?: string;
  workspaceCanonicalPath?: string;
  timestamp: string;
}

export interface FirstRunCheckInputs {
  configOk: boolean;
  configError?: string;
  storageStatus: SubsystemStatus;
  workspaceResult: WorkspaceValidationResult;
  runtimeHealth: RuntimeHealth;
  availableModelIds: string[];
  primaryModelId?: string;
  primaryModelReadiness?: ModelReadinessState;
  fallbackModelId?: string;
  fallbackModelReadiness?: ModelReadinessState;
  toolGatewayStatus: SubsystemStatus;
  orchestratorStatus: SubsystemStatus;
  knowledgeStatus: SubsystemStatus;
  firstRunState: FirstRunState;
}

function subsystemToCheck(name: string, status: SubsystemStatus): CheckResult {
  if (status.status === 'ok') {
    return { name, status: 'OK' };
  } else if (status.status === 'degraded') {
    return { name, status: 'DEGRADED', detail: status.message };
  } else {
    return {
      name,
      status: 'FAIL',
      detail: status.message,
      action: `Check ${name} initialization logs for more details.`,
    };
  }
}

export function buildFirstRunReport(inputs: FirstRunCheckInputs): FirstRunReport {
  const checks: CheckResult[] = [];

  // 1. Configuration
  if (inputs.configOk) {
    checks.push({ name: 'Configuration', status: 'OK' });
  } else {
    checks.push({
      name: 'Configuration',
      status: 'FAIL',
      detail: inputs.configError || 'Configuration validation failed.',
      action: 'Review environment variables (PORT, NODE_ENV, LOG_LEVEL, OLLAMA_HOST, etc.).',
    });
  }

  // 2. Database
  checks.push(subsystemToCheck('Database', inputs.storageStatus));

  // 3. Workspace
  const ws = inputs.workspaceResult;
  if (ws.state === 'WORKSPACE_READY' || ws.state === 'WORKSPACE_CREATED') {
    checks.push({
      name: 'Workspace',
      status: 'OK',
      detail: ws.state === 'WORKSPACE_CREATED' ? `Created: ${ws.canonicalPath}` : ws.canonicalPath,
    });
  } else if (ws.state === 'WORKSPACE_NOT_ACCESSIBLE') {
    checks.push({
      name: 'Workspace',
      status: 'FAIL',
      detail: ws.reason || `Workspace is not accessible: ${ws.canonicalPath}`,
      action: `Verify read/write permissions on the workspace directory.`,
    });
  } else if (ws.state === 'WORKSPACE_INVALID') {
    checks.push({
      name: 'Workspace',
      status: 'FAIL',
      detail: ws.reason || `Workspace path is invalid: ${ws.canonicalPath}`,
      action: 'Set WORKSPACE_ROOT to a valid, accessible directory path without traversal segments.',
    });
  } else {
    checks.push({
      name: 'Workspace',
      status: 'FAIL',
      detail: ws.reason || `Workspace unavailable: ${ws.canonicalPath}`,
      action: 'Check filesystem access and disk availability.',
    });
  }

  // 4. AI Runtime
  const runtime = inputs.runtimeHealth;
  if (runtime.status === 'READY') {
    checks.push({
      name: 'AI Runtime',
      status: 'OK',
      detail: `${runtime.providerId} v${runtime.version || 'unknown'} — ${runtime.endpoint}`,
    });
  } else if (runtime.status === 'NOT_CONFIGURED') {
    checks.push({
      name: 'AI Runtime',
      status: 'FAIL',
      detail: runtime.reason || 'Runtime endpoint is not configured.',
      action: runtime.suggestedAction || 'Set OLLAMA_HOST to a valid http:// endpoint.',
    });
  } else {
    checks.push({
      name: 'AI Runtime',
      status: 'DEGRADED',
      detail: `${runtime.status}: ${runtime.reason || 'Unknown error'}`,
      action: runtime.suggestedAction || 'Start the Ollama runtime and retry.',
    });
  }

  // 5. Primary Model
  if (inputs.primaryModelId) {
    const modelStatus = inputs.primaryModelReadiness;
    if (modelStatus === 'MODEL_READY') {
      checks.push({ name: 'Primary Model', status: 'OK', detail: inputs.primaryModelId });
    } else if (modelStatus === 'MODEL_NOT_INSTALLED') {
      checks.push({
        name: 'Primary Model',
        status: 'FAIL',
        detail: `${inputs.primaryModelId} — NOT INSTALLED`,
        action: `Run: ollama pull ${inputs.primaryModelId}`,
      });
    } else if (modelStatus === 'MODEL_ERROR') {
      checks.push({
        name: 'Primary Model',
        status: 'FAIL',
        detail: `${inputs.primaryModelId} — ERROR`,
        action: 'Check Ollama logs.',
      });
    } else {
      checks.push({
        name: 'Primary Model',
        status: 'DEGRADED',
        detail: `${inputs.primaryModelId} — ${modelStatus || 'UNKNOWN'}`,
        action: 'Verify model installation with: ollama list',
      });
    }
  } else if (inputs.availableModelIds.length > 0) {
    checks.push({
      name: 'Primary Model',
      status: 'OK',
      detail: `Auto-selected: ${inputs.availableModelIds[0]}`,
    });
  } else {
    checks.push({
      name: 'Primary Model',
      status: 'FAIL',
      detail: 'No models installed in local runtime.',
      action: 'Install at least one model: ollama pull qwen2.5:3b',
    });
  }

  // 6. Fallback Model
  if (inputs.fallbackModelId) {
    const fbStatus = inputs.fallbackModelReadiness;
    if (fbStatus === 'MODEL_READY') {
      checks.push({ name: 'Fallback Model', status: 'OK', detail: inputs.fallbackModelId });
    } else if (fbStatus === 'MODEL_NOT_INSTALLED') {
      checks.push({
        name: 'Fallback Model',
        status: 'DEGRADED',
        detail: `${inputs.fallbackModelId} — NOT INSTALLED`,
        action: `Run: ollama pull ${inputs.fallbackModelId}`,
      });
    } else {
      checks.push({
        name: 'Fallback Model',
        status: 'DEGRADED',
        detail: `${inputs.fallbackModelId} — ${fbStatus || 'UNKNOWN'}`,
      });
    }
  } else if (inputs.availableModelIds.length > 1) {
    checks.push({
      name: 'Fallback Model',
      status: 'OK',
      detail: `Auto-selected: ${inputs.availableModelIds[1]}`,
    });
  } else {
    checks.push({ name: 'Fallback Model', status: 'SKIP', detail: 'No fallback model configured' });
  }

  // 7. ToolGateway
  checks.push(subsystemToCheck('ToolGateway', inputs.toolGatewayStatus));

  // 8. Orchestrator
  checks.push(subsystemToCheck('Orchestrator', inputs.orchestratorStatus));

  // 9. Knowledge Engine
  checks.push(subsystemToCheck('Knowledge Engine', inputs.knowledgeStatus));

  return {
    state: inputs.firstRunState,
    checks,
    primaryModelId: inputs.primaryModelId || inputs.availableModelIds[0],
    primaryModelStatus: inputs.primaryModelReadiness,
    fallbackModelId: inputs.fallbackModelId || inputs.availableModelIds[1],
    fallbackModelStatus: inputs.fallbackModelReadiness,
    runtimeVersion: inputs.runtimeHealth.version,
    runtimeEndpoint: inputs.runtimeHealth.endpoint,
    workspaceCanonicalPath: inputs.workspaceResult.canonicalPath || undefined,
    timestamp: new Date().toISOString(),
  };
}
