import type { SubsystemStatus } from '../storage/index.js';
import type { ModelsRepository } from '../storage/repositories/modelsRepository.js';
import { OllamaAdapter } from './ollamaAdapter.js';
import { ModelRegistry } from './modelRegistry.js';
import { ModelRouter } from './modelRouter.js';
import { ModelGateway } from './modelGateway.js';
import { Logger, LogLevel } from '../common/logger.js';
import { AIRuntimeManager, type InferenceProviderConfigMode } from './runtime/runtimeManager.js';
import { OllamaRuntimeAdapter } from './runtime/ollamaRuntimeAdapter.js';
import { EmbeddedRuntimeAdapter } from './runtime/embeddedRuntimeAdapter.js';
import type { RuntimeHealth } from './runtime/types.js';

export interface IIntelligenceService {
  initialize(modelsRepo?: ModelsRepository): Promise<SubsystemStatus>;
  getStatus(): SubsystemStatus;
}

export class IntelligenceService implements IIntelligenceService {
  private initialized = false;
  private logger: Logger;
  public adapter: OllamaAdapter;
  public ollamaRuntimeAdapter: OllamaRuntimeAdapter;
  public embeddedRuntimeAdapter: EmbeddedRuntimeAdapter;
  public runtimeManager: AIRuntimeManager;
  public registry!: ModelRegistry;
  public router!: ModelRouter;
  public gateway!: ModelGateway;

  private runtimeHealth: RuntimeHealth | null = null;
  private modelsCount = 0;
  private installedModels: string[] = [];

  constructor(
    private ollamaHost: string = 'http://127.0.0.1:11434',
    logLevel: LogLevel = 'info',
    providerMode?: InferenceProviderConfigMode
  ) {
    this.logger = new Logger('IntelligenceService', logLevel);
    this.adapter = new OllamaAdapter(this.ollamaHost, logLevel);
    this.ollamaRuntimeAdapter = new OllamaRuntimeAdapter(this.ollamaHost, logLevel, this.adapter);
    this.embeddedRuntimeAdapter = new EmbeddedRuntimeAdapter({ logLevel });

    const providerEnv = providerMode || (process.env.NEXUS_INFERENCE_PROVIDER as InferenceProviderConfigMode) || 'auto';
    this.runtimeManager = new AIRuntimeManager(this.ollamaRuntimeAdapter, logLevel, providerEnv);
  }

  async initialize(modelsRepo?: ModelsRepository): Promise<SubsystemStatus> {
    const providerMode = this.runtimeManager.getConfigMode();
    this.logger.info(`Initializing IntelligenceService [Provider Mode: ${providerMode.toUpperCase()}]`);

    this.runtimeHealth = await this.runtimeManager.getHealth(true);

    if (modelsRepo) {
      this.registry = new ModelRegistry(this.runtimeManager, modelsRepo, 'info');
      this.router = new ModelRouter(this.registry, 'info');
      this.gateway = new ModelGateway(this.runtimeManager, this.registry, this.router, modelsRepo, 'info');

      if (this.runtimeHealth.status === 'READY') {
        const models = await this.registry.syncDiscoveredModels();
        this.modelsCount = models.length;
        this.installedModels = models.map((m) => m.id);
      } else {
        this.installedModels = this.registry.getAvailableModels().map((m) => m.id);
        this.modelsCount = this.installedModels.length;
      }
    }

    this.initialized = true;
    return this.getStatus();
  }

  getStatus(): SubsystemStatus {
    const latestHealth = this.runtimeManager?.getCachedHealth() ?? this.runtimeHealth;
    const activeProvider = this.runtimeManager?.getActiveProviderId() || 'embedded';
    const isReady = latestHealth?.status === 'READY';

    const providerLabel = activeProvider === 'embedded' ? 'Embedded (Local)' : `Ollama (${this.ollamaHost})`;
    const message = isReady
      ? `AI Runtime Active [Provider: ${providerLabel}] (v${latestHealth?.version || '0.1.0'}), ${this.modelsCount} model(s) ready`
      : `AI Runtime Degraded [Provider: ${providerLabel}] (${latestHealth?.reason || 'Offline mode ready'})`;

    return {
      name: 'IntelligenceService',
      initialized: this.initialized,
      status: this.initialized ? (isReady ? 'ok' : 'degraded') : 'error',
      message,
      details: {
        activeProvider,
        providerMode: this.runtimeManager?.getConfigMode() || 'auto',
        ollamaHost: this.ollamaHost,
        runtimeStatus: latestHealth?.status || 'UNAVAILABLE',
        aiAvailable: isReady,
        ollamaAvailable: activeProvider === 'ollama' ? isReady : false,
        runtimeVersion: latestHealth?.version || null,
        reason: latestHealth?.reason,
        suggestedAction: latestHealth?.suggestedAction,
        modelsCount: this.modelsCount,
        installedModels: this.installedModels,
      },
    };
  }
}
