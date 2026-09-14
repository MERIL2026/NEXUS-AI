import type { ModelManifest, HardwareProfile } from './types.js';
import { ModelManifestRegistry } from './modelManifest.js';

export interface RecommendationResult {
  recommendedModel: ModelManifest;
  tier: 'low' | 'standard' | 'high';
  warning?: string;
  availableModels: ModelManifest[];
}

export class ModelSelector {
  private registry: ModelManifestRegistry;

  constructor(registry?: ModelManifestRegistry) {
    this.registry = registry || new ModelManifestRegistry();
  }

  recommendModel(profile: HardwareProfile): RecommendationResult {
    const all = this.registry.listManifests();

    // High performance tier: >= 16GB RAM
    if (profile.totalRamMb >= 15000 && profile.freeStorageMb >= 10000) {
      const highModel = all.find((m) => m.tier === 'high') || all[0];
      return {
        recommendedModel: highModel,
        tier: 'high',
        availableModels: all,
      };
    }

    // Standard tier: 8GB - 16GB RAM
    if (profile.totalRamMb >= 7000 && profile.freeStorageMb >= 5000) {
      const stdModel = all.find((m) => m.tier === 'standard') || all[0];
      return {
        recommendedModel: stdModel,
        tier: 'standard',
        availableModels: all,
      };
    }

    // Low resource tier: < 8GB RAM
    const lowModel = all.find((m) => m.tier === 'low') || all[0];
    const warning = profile.totalRamMb < 4000
      ? 'Recommended model may exceed this system\'s RAM resources. A lightweight 0.5B model will be used.'
      : undefined;

    return {
      recommendedModel: lowModel,
      tier: 'low',
      warning,
      availableModels: all,
    };
  }
}
