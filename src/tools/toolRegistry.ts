import type { ToolDefinition } from './types.js';
import { VALID_CAPABILITIES } from './types.js';
import { Logger, LogLevel } from '../common/logger.js';

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  private logger: Logger;

  constructor(logLevel: LogLevel = 'info') {
    this.logger = new Logger('ToolRegistry', logLevel);
  }

  /**
   * Register a new tool definition into the registry.
   * Throws an error if tool metadata is invalid or if a tool with the same ID already exists.
   */
  registerTool(definition: ToolDefinition): void {
    if (!definition.id || typeof definition.id !== 'string' || definition.id.trim() === '') {
      throw new Error('Tool registration failed: tool ID is required and must be a non-empty string.');
    }

    if (!definition.name || typeof definition.name !== 'string' || definition.name.trim() === '') {
      throw new Error(`Tool registration failed: tool '${definition.id}' missing required name.`);
    }

    if (this.tools.has(definition.id)) {
      throw new Error(`Tool registration failed: duplicate tool ID '${definition.id}' already registered.`);
    }

    if (!Array.isArray(definition.requiredPermissions)) {
      throw new Error(`Tool registration failed: tool '${definition.id}' requiredPermissions must be an array.`);
    }

    for (const cap of definition.requiredPermissions) {
      if (!VALID_CAPABILITIES.has(cap)) {
        throw new Error(`Tool registration failed: tool '${definition.id}' specifies unknown capability '${cap}'.`);
      }
    }

    const record: ToolDefinition = {
      id: definition.id,
      name: definition.name,
      description: definition.description || '',
      version: definition.version || '1.0.0',
      category: definition.category || 'utility',
      riskLevel: definition.riskLevel || 'low',
      requiredPermissions: [...definition.requiredPermissions],
      inputSchema: definition.inputSchema || {},
      enabled: definition.enabled ?? true,
    };

    this.tools.set(record.id, record);
    this.logger.info(`Registered tool '${record.id}'`, {
      name: record.name,
      category: record.category,
      riskLevel: record.riskLevel,
      enabled: record.enabled,
    });
  }

  /**
   * Retrieve a registered tool by ID. Returns null if not found.
   */
  getTool(id: string): ToolDefinition | null {
    const tool = this.tools.get(id);
    return tool ? { ...tool, requiredPermissions: [...tool.requiredPermissions] } : null;
  }

  /**
   * List all registered tools.
   */
  listTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => ({
      ...tool,
      requiredPermissions: [...tool.requiredPermissions],
    }));
  }

  /**
   * Enable or disable a registered tool.
   * Returns true if updated, false if tool ID was not found.
   */
  setToolEnabled(id: string, enabled: boolean): boolean {
    const tool = this.tools.get(id);
    if (!tool) {
      return false;
    }
    tool.enabled = enabled;
    this.logger.info(`Tool '${id}' state changed`, { enabled });
    return true;
  }

  /**
   * Check if a tool ID is registered.
   */
  isRegistered(id: string): boolean {
    return this.tools.has(id);
  }

  /**
   * Clear all registered tools (used for testing or resetting environment).
   */
  clear(): void {
    this.tools.clear();
  }
}
