import type { ModelRegistry, ModelRoleCapability } from './modelRegistry.js';
import type { ModelRecord } from '../storage/repositories/modelsRepository.js';
import { Logger, LogLevel } from '../common/logger.js';

export type ModelRole = 'planner' | 'coder' | 'reasoning' | 'chat';

export interface ModelOverrides {
  global?: string;
  roles: {
    planner?: string;
    coder?: string;
    reasoning?: string;
    chat?: string;
  };
}

export interface ModelOverrideResult {
  success: boolean;
  model?: ModelRecord;
  role?: ModelRole;
  message?: string;
}

export interface RouteSelection {
  primaryModel: ModelRecord;
  fallbackModel: ModelRecord | null;
  routingReason: string;
}

/**
 * Map a ModelRoleCapability to its primary ModelRole.
 */
export function capabilityToRole(capability?: ModelRoleCapability): ModelRole {
  if (!capability) return 'chat';
  switch (capability) {
    case 'planning':
      return 'planner';
    case 'coding':
      return 'coder';
    case 'reasoning':
      return 'reasoning';
    default:
      return 'chat';
  }
}

export class ModelRouter {
  private logger: Logger;
  private overrides: ModelOverrides = {
    roles: {},
  };

  constructor(
    private registry: ModelRegistry,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('ModelRouter', logLevel);
  }

  /**
   * Resolve a model reference (1-based index number or string ID) to a ModelRecord.
   */
  resolveModel(input: string | number): ModelRecord | null {
    const available = this.registry.getAvailableModels();

    if (typeof input === 'number' || (typeof input === 'string' && /^\d+$/.test(input.trim()))) {
      const idx = typeof input === 'number' ? input : parseInt(input.trim(), 10);
      if (idx >= 1 && idx <= available.length) {
        return available[idx - 1];
      }
      return null;
    }

    if (typeof input === 'string') {
      const trimmed = input.trim();
      const match = available.find((m) => m.id === trimmed || m.name === trimmed);
      return match || null;
    }

    return null;
  }

  /**
   * Set a global model override by 1-based index or model ID string.
   */
  setGlobalOverride(input: string | number): ModelOverrideResult {
    const model = this.resolveModel(input);
    if (!model) {
      const availableCount = this.registry.getAvailableModels().length;
      return {
        success: false,
        message: typeof input === 'number' || /^\d+$/.test(String(input))
          ? `Invalid model index [${input}]. Available range is [1..${availableCount}].`
          : `Unknown model '${input}'. Run /models to list available local models.`,
      };
    }

    this.overrides.global = model.id;
    this.logger.info(`Global model override set`, { modelId: model.id });
    return {
      success: true,
      model,
      message: `Global model override set to ${model.id}`,
    };
  }

  /**
   * Set a role-specific model override (planner, coder, reasoning, chat).
   */
  setRoleOverride(role: ModelRole, input: string | number): ModelOverrideResult {
    const validRoles: ModelRole[] = ['planner', 'coder', 'reasoning', 'chat'];
    if (!validRoles.includes(role)) {
      return {
        success: false,
        message: `Unknown role '${role}'. Valid roles are: planner, coder, reasoning, chat.`,
      };
    }

    const model = this.resolveModel(input);
    if (!model) {
      const availableCount = this.registry.getAvailableModels().length;
      return {
        success: false,
        role,
        message: typeof input === 'number' || /^\d+$/.test(String(input))
          ? `Invalid model index [${input}] for role '${role}'. Available range is [1..${availableCount}].`
          : `Unknown model '${input}' for role '${role}'. Run /models to list available local models.`,
      };
    }

    this.overrides.roles[role] = model.id;
    this.logger.info(`Role model override set`, { role, modelId: model.id });
    return {
      success: true,
      role,
      model,
      message: `Role '${role}' model override set to ${model.id}`,
    };
  }

  /**
   * Reset overrides back to automatic capability-based routing.
   * If role is omitted, clears all overrides.
   */
  resetOverrides(role?: ModelRole): { success: boolean; resetRoles: ModelRole[]; message: string } {
    if (role) {
      const validRoles: ModelRole[] = ['planner', 'coder', 'reasoning', 'chat'];
      if (!validRoles.includes(role)) {
        return {
          success: false,
          resetRoles: [],
          message: `Unknown role '${role}'. Valid roles are: planner, coder, reasoning, chat.`,
        };
      }
      delete this.overrides.roles[role];
      this.logger.info(`Role override reset`, { role });
      return {
        success: true,
        resetRoles: [role],
        message: `Override for role '${role}' reset to automatic routing.`,
      };
    }

    this.overrides.global = undefined;
    this.overrides.roles = {};
    this.logger.info(`All model overrides reset to automatic capability routing`);
    return {
      success: true,
      resetRoles: ['planner', 'coder', 'reasoning', 'chat'],
      message: 'All model overrides reset to automatic capability routing.',
    };
  }

  /**
   * Get current model overrides state.
   */
  getOverrides(): ModelOverrides {
    return {
      global: this.overrides.global,
      roles: { ...this.overrides.roles },
    };
  }

  /**
   * Get effective active model for each role.
   */
  getRoleStatus(): Record<ModelRole, { modelId: string; source: 'USER' | 'AUTO' }> {
    const roles: ModelRole[] = ['planner', 'coder', 'reasoning', 'chat'];
    const result: Record<ModelRole, { modelId: string; source: 'USER' | 'AUTO' }> = {
      planner: { modelId: 'AUTO', source: 'AUTO' },
      coder: { modelId: 'AUTO', source: 'AUTO' },
      reasoning: { modelId: 'AUTO', source: 'AUTO' },
      chat: { modelId: 'AUTO', source: 'AUTO' },
    };

    for (const role of roles) {
      if (this.overrides.roles[role]) {
        result[role] = { modelId: this.overrides.roles[role]!, source: 'USER' };
      } else if (this.overrides.global) {
        result[role] = { modelId: this.overrides.global, source: 'USER' };
      } else {
        const cap = role === 'planner' ? 'planning' : role === 'coder' ? 'coding' : role === 'reasoning' ? 'reasoning' : 'general';
        const route = this.selectRouteInternal(undefined, cap, role, false);
        result[role] = { modelId: route.primaryModel.id, source: 'AUTO' };
      }
    }

    return result;
  }

  /**
   * Select a route for inference based on precedence hierarchy:
   * 1. Explicit modelId parameter passed directly to call
   * 2. Role-specific explicit override
   * 3. Global explicit override
   * 4. Automatic capability-based routing
   */
  selectRoute(explicitModelId?: string, taskCapability?: ModelRoleCapability, role?: ModelRole): RouteSelection {
    return this.selectRouteInternal(explicitModelId, taskCapability, role, true);
  }

  private selectRouteInternal(
    explicitModelId?: string,
    taskCapability?: ModelRoleCapability,
    role?: ModelRole,
    logSelection = true
  ): RouteSelection {
    const available = this.registry.getAvailableModels();

    if (available.length === 0) {
      throw new Error('No available local AI models registered in ModelRegistry.');
    }

    const effectiveRole = role || capabilityToRole(taskCapability);
    let primary: ModelRecord | null = null;
    let routingReason = '';

    // 1. Explicit model parameter requested in function call
    if (explicitModelId) {
      const match = this.resolveModel(explicitModelId);
      if (match) {
        primary = match;
        routingReason = `Explicit model requested: ${match.id}`;
      } else {
        this.logger.warn(`Explicit model '${explicitModelId}' requested but not available. Falling back.`);
      }
    }

    // 2. Role-specific explicit user override
    if (!primary && this.overrides.roles[effectiveRole]) {
      const overrideId = this.overrides.roles[effectiveRole]!;
      const match = available.find((m) => m.id === overrideId);
      if (match) {
        primary = match;
        routingReason = `[USER_OVERRIDE] Role '${effectiveRole}' set to ${match.id}`;
        if (logSelection) {
          this.logger.info(`ModelRouter selection: USER_OVERRIDE for role '${effectiveRole}' -> ${match.id}`);
        }
      }
    }

    // 3. Global explicit user override
    if (!primary && this.overrides.global) {
      const globalId = this.overrides.global;
      const match = available.find((m) => m.id === globalId);
      if (match) {
        primary = match;
        routingReason = `[GLOBAL_OVERRIDE] Global override set to ${match.id}`;
        if (logSelection) {
          this.logger.info(`ModelRouter selection: GLOBAL_OVERRIDE -> ${match.id}`);
        }
      }
    }

    // 4. Automatic capability-based routing
    if (!primary && (taskCapability || role)) {
      const cap = taskCapability || (role === 'planner' ? 'planning' : role === 'coder' ? 'coding' : role === 'reasoning' ? 'reasoning' : 'chat');
      const candidates = available.filter((m) => m.capabilities.includes(cap) || m.capabilities.includes('general'));

      if (cap === 'planning' || role === 'planner') {
        primary =
          available.find((m) => m.id === 'qwen2.5-coder-1.5b') ||
          available.find((m) => m.id === 'qwen2.5:3b') ||
          candidates.find((m) => m.capabilities.includes('lightweight')) ||
          candidates.find((m) => m.capabilities.includes('planning')) ||
          candidates[0] ||
          null;
      } else if (cap === 'coding' || role === 'coder') {
        primary =
          available.find((m) => m.id === 'qwen2.5-coder:7b') ||
          available.find((m) => m.id.includes('heretic')) ||
          available.find((m) => m.id === 'qwen2.5-coder-1.5b') ||
          candidates.find((m) => m.capabilities.includes('coding')) ||
          candidates[0] ||
          null;
      } else if (cap === 'reasoning' || role === 'reasoning') {
        primary =
          available.find((m) => m.id.includes('deepseek') || m.id.includes('r1')) ||
          candidates.find((m) => m.capabilities.includes('reasoning')) ||
          available.find((m) => m.id === 'qwen2.5-coder-1.5b') ||
          candidates[0] ||
          null;
      } else if (cap === 'lightweight') {
        primary =
          available.find((m) => m.id === 'qwen2.5:3b') ||
          available.find((m) => m.id === 'qwen2.5-coder-1.5b') ||
          candidates.find((m) => m.capabilities.includes('lightweight')) ||
          candidates[0] ||
          null;
      } else if (cap === 'chat' || role === 'chat') {
        primary =
          available.find((m) => m.id === 'llama3.1:8b') ||
          available.find((m) => m.id.includes('llama3.1')) ||
          available.find((m) => m.id.includes('llama')) ||
          available.find((m) => m.id === 'qwen2.5:3b') ||
          available.find((m) => m.id === 'qwen2.5-coder-1.5b') ||
          candidates.find((m) => m.capabilities.includes('chat') || m.capabilities.includes('general')) ||
          candidates[0] ||
          null;
      }

      if (primary) {
        routingReason = `Matched capability '${cap}' to model: ${primary.id}`;
      }
    }

    // 5. Default fallback primary model
    if (!primary) {
      primary = available.find((m) => m.id === 'qwen2.5-coder-1.5b') || available[0];
      routingReason = `Default fallback model selected: ${primary.id}`;
    }

    // Find fallback candidate (prefer qwen2.5-coder-1.5b or embedded model)
    let fallbackModel: ModelRecord | null = null;
    const fallbackCandidates = available.filter((m) => m.id !== primary?.id);
    if (fallbackCandidates.length > 0) {
      const qwenFallback = fallbackCandidates.find((m) => m.id === 'qwen2.5-coder-1.5b');
      const embeddedFallback = fallbackCandidates.find((m) => m.provider === 'embedded');
      fallbackModel = qwenFallback || embeddedFallback || fallbackCandidates[0];
    }

    if (logSelection) {
      const capStr = taskCapability || (role === 'planner' ? 'planning' : role === 'coder' ? 'coding' : role === 'reasoning' ? 'reasoning' : 'chat');
      this.logger.info(`[ModelRouter] Capability: ${capStr}`);
      this.logger.info(`[ModelRouter] Selected model: ${primary.id}`);
      this.logger.info(`[ModelRouter] Selected: ${primary.id}`, {
        primary: primary.id,
        fallback: fallbackModel ? fallbackModel.id : null,
        reason: routingReason,
      });
    }

    return {
      primaryModel: primary,
      fallbackModel,
      routingReason,
    };
  }
}
