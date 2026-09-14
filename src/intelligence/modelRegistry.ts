import type { ModelsRepository, ModelRecord } from '../storage/repositories/modelsRepository.js';
import type { OllamaAdapter, OllamaModelItem } from './ollamaAdapter.js';
import { Logger, LogLevel } from '../common/logger.js';

import type { AIRuntimeManager } from './runtime/runtimeManager.js';
import type { RuntimeModelInfo } from './runtime/types.js';

export type ModelRoleCapability = 'coding' | 'reasoning' | 'planning' | 'lightweight' | 'summarization' | 'general' | 'chat';

export class ModelRegistry {
  private logger: Logger;

  constructor(
    private adapterOrManager: OllamaAdapter | AIRuntimeManager,
    private modelsRepo: ModelsRepository,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('ModelRegistry', logLevel);
  }

  public inferCapabilities(modelName: string): ModelRoleCapability[] {
    const lower = modelName.toLowerCase();
    const caps: Set<ModelRoleCapability> = new Set();

    const isProtoOrMicro = lower.includes('0.5b') || lower.includes('proto') || lower.includes('micro');

    if (isProtoOrMicro) {
      caps.add('lightweight');
      caps.add('general');
      if (lower.includes('coder') || lower.includes('code')) {
        caps.add('coding');
      }
      return Array.from(caps);
    }

    if (lower.includes('1.5b') || lower === 'qwen2.5-coder-1.5b') {
      caps.add('planning');
      caps.add('coding');
      caps.add('lightweight');
      caps.add('general');
    }

    if (lower.includes('coder') || lower.includes('code') || lower.includes('heretic')) {
      caps.add('coding');
      caps.add('planning');
    }

    if (lower.includes('deepseek') || lower.includes('r1') || lower.includes('reasoning')) {
      caps.add('reasoning');
      caps.add('planning');
    }

    if (lower.includes('3b') || lower.includes('mini') || lower.includes('small') || lower.includes('fast')) {
      caps.add('lightweight');
      caps.add('planning');
      caps.add('general');
    }

    if (lower.includes('llama') || lower.includes('chat')) {
      caps.add('chat');
      caps.add('planning');
      caps.add('general');
    }

    if (lower.includes('qwen')) {
      caps.add('planning');
      caps.add('general');
    }

    if (caps.size === 0) {
      caps.add('general');
    }

    return Array.from(caps);
  }

  async syncDiscoveredModels(): Promise<ModelRecord[]> {
    this.logger.info('Discovering local models for ModelRegistry');

    try {
      const discoveredItems: Array<{ id: string; provider: string; parameterSize?: string; digest?: string }> = [];

      const target = this.adapterOrManager as unknown as Record<string, (arg?: unknown) => Promise<unknown>>;

      if (typeof target.discoverAllModels === 'function') {
        const allDiscovered = (await target.discoverAllModels()) as Array<{ model: RuntimeModelInfo; provider: string }>;
        for (const entry of allDiscovered) {
          discoveredItems.push({
            id: entry.model.id || entry.model.name,
            provider: entry.provider,
            parameterSize: entry.model.parameterSize,
            digest: entry.model.digest,
          });
        }
      } else if (typeof target.listModels === 'function') {
        const items = (await target.listModels(true)) as Array<OllamaModelItem | RuntimeModelInfo>;
        for (const item of items) {
          const id = 'id' in item ? (item as RuntimeModelInfo).id : (item as OllamaModelItem).name;
          const parameterSize = 'parameterSize' in item ? (item as RuntimeModelInfo).parameterSize : (item as OllamaModelItem).details?.parameter_size;
          const digest = 'digest' in item ? item.digest : undefined;
          discoveredItems.push({ id, provider: 'ollama', parameterSize, digest });
        }
      } else if (typeof target.discoverModels === 'function') {
        const items = (await target.discoverModels()) as Array<OllamaModelItem | RuntimeModelInfo>;
        for (const item of items) {
          const id = 'id' in item ? (item as RuntimeModelInfo).id : (item as OllamaModelItem).name;
          const parameterSize = 'parameterSize' in item ? (item as RuntimeModelInfo).parameterSize : (item as OllamaModelItem).details?.parameter_size;
          const digest = 'digest' in item ? item.digest : undefined;
          discoveredItems.push({ id, provider: 'ollama', parameterSize, digest });
        }
      }

      const discoveredIds: string[] = [];
      const updatedRecords: ModelRecord[] = [];

      for (const item of discoveredItems) {
        discoveredIds.push(item.id);
        const capabilities = this.inferCapabilities(item.id);
        const versionTag = item.parameterSize || item.digest?.substring(0, 12) || 'latest';

        const record = this.modelsRepo.upsert({
          id: item.id,
          name: item.id,
          provider: item.provider,
          versionTag,
          capabilities,
          contextLimit: 4096,
          isAvailable: true,
        });

        updatedRecords.push(record);
      }

      // Mark models no longer detected across providers as unavailable
      this.modelsRepo.markAllUnavailableExcept(discoveredIds);

      this.logger.info(`ModelRegistry sync complete. Discovered ${updatedRecords.length} model(s).`);
      return updatedRecords;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`ModelRegistry sync failed: ${message}`);
      return this.modelsRepo.listAvailable();
    }
  }

  getAvailableModels(): ModelRecord[] {
    return this.modelsRepo.listAvailable();
  }

  getModel(id: string): ModelRecord | null {
    return this.modelsRepo.findById(id);
  }

  findModelsByCapability(capability: ModelRoleCapability): ModelRecord[] {
    const available = this.getAvailableModels();
    return available.filter((m) => m.capabilities.includes(capability));
  }
}
