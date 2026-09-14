import type { OllamaAdapter, GenerateResult, StreamChunk } from './ollamaAdapter.js';
import type { ModelRegistry, ModelRoleCapability } from './modelRegistry.js';
import type { ModelRouter } from './modelRouter.js';
import type { ModelsRepository } from '../storage/repositories/modelsRepository.js';
import { Logger, LogLevel } from '../common/logger.js';

export interface InferenceRequestOptions {
  prompt: string;
  system?: string;
  modelId?: string;
  taskCapability?: ModelRoleCapability;
  temperature?: number;
  timeoutMs?: number;
  allowFallback?: boolean;
}

export interface InferenceResponse {
  modelId: string;
  text: string;
  done: boolean;
  latencyMs: number;
  usedFallback: boolean;
  routingReason: string;
}

import type { AIRuntimeManager } from './runtime/runtimeManager.js';

export class ModelGateway {
  private logger: Logger;

  constructor(
    private adapterOrManager: OllamaAdapter | AIRuntimeManager,
    private registry: ModelRegistry,
    private router: ModelRouter,
    private modelsRepo: ModelsRepository,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('ModelGateway', logLevel);
  }

  private resolveProviderName(modelId: string): string {
    const manager = this.adapterOrManager as unknown as Record<string, unknown>;
    if (typeof manager.getAdapterForModel === 'function') {
      const ad = (manager.getAdapterForModel as (id: string) => { providerId?: string })(modelId);
      return ad?.providerId || 'ollama';
    }
    return (manager.providerId as string) || 'ollama';
  }

  async generate(options: InferenceRequestOptions, externalSignal?: AbortSignal): Promise<InferenceResponse> {
    const route = this.router.selectRoute(options.modelId, options.taskCapability);
    const startTime = Date.now();
    let targetModel = route.primaryModel;
    let usedFallback = false;

    this.logger.info(`[ModelGateway] Provider: ${this.resolveProviderName(targetModel.id)}`);
    this.logger.info(`[ModelGateway] Model: ${targetModel.id}`);
    this.logger.info(`[ModelGateway] Request started`);

    try {
      const res: GenerateResult = await this.adapterOrManager.generate(
        {
          model: targetModel.id,
          prompt: options.prompt,
          system: options.system,
          temperature: options.temperature,
          timeoutMs: options.timeoutMs,
        },
        externalSignal
      );

      const latencyMs = Date.now() - startTime;
      this.recordTelemetry(targetModel.id, 'success', latencyMs);
      this.logger.info(`[ModelGateway] Response received (${latencyMs}ms)`);

      return {
        modelId: targetModel.id,
        text: res.response,
        done: res.done,
        latencyMs,
        usedFallback,
        routingReason: route.routingReason,
      };
    } catch (primaryErr: unknown) {
      const primaryModelId = targetModel.id;
      const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      const latencyMs = Date.now() - startTime;
      this.recordTelemetry(primaryModelId, 'error', latencyMs, 'PRIMARY_MODEL_FAILED');
      this.logger.warn(`Primary model '${primaryModelId}' failed: ${primaryMsg}`);

      if (options.allowFallback && route.fallbackModel) {
        this.logger.info(`Attempting fallback to model '${route.fallbackModel.id}'`);
        targetModel = route.fallbackModel;
        usedFallback = true;

        this.logger.info(`[ModelGateway] Provider: ${this.resolveProviderName(targetModel.id)}`);
        this.logger.info(`[ModelGateway] Model: ${targetModel.id}`);
        this.logger.info(`[ModelGateway] Request started`);

        const fbStartTime = Date.now();
        try {
          const fbRes: GenerateResult = await this.adapterOrManager.generate(
            {
              model: targetModel.id,
              prompt: options.prompt,
              system: options.system,
              temperature: options.temperature,
              timeoutMs: options.timeoutMs,
            },
            externalSignal
          );

          const fbLatencyMs = Date.now() - fbStartTime;
          this.recordTelemetry(targetModel.id, 'success', fbLatencyMs);
          this.logger.info(`[ModelGateway] Response received (${fbLatencyMs}ms)`);

          return {
            modelId: targetModel.id,
            text: fbRes.response,
            done: fbRes.done,
            latencyMs: Date.now() - startTime,
            usedFallback: true,
            routingReason: `${route.routingReason} -> Fallback to ${targetModel.id}`,
          };
        } catch (fbErr: unknown) {
          const fbMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
          this.recordTelemetry(targetModel.id, 'error', Date.now() - fbStartTime, 'FALLBACK_MODEL_FAILED');
          throw new Error(`Inference failed on both primary (${primaryModelId}) and fallback (${targetModel.id}): ${fbMsg}`);
        }
      }

      throw new Error(`Inference execution failed on model '${primaryModelId}': ${primaryMsg}`);
    }
  }

  async generateStream(
    options: InferenceRequestOptions,
    onChunk: (chunk: StreamChunk) => void,
    externalSignal?: AbortSignal
  ): Promise<InferenceResponse> {
    const route = this.router.selectRoute(options.modelId, options.taskCapability);
    const startTime = Date.now();
    let targetModel = route.primaryModel;
    let usedFallback = false;

    this.logger.info(`[ModelGateway] Provider: ${this.resolveProviderName(targetModel.id)}`);
    this.logger.info(`[ModelGateway] Model: ${targetModel.id}`);
    this.logger.info(`[ModelGateway] Request started`);

    try {
      const res: GenerateResult = await this.adapterOrManager.generateStream(
        {
          model: targetModel.id,
          prompt: options.prompt,
          system: options.system,
          temperature: options.temperature,
          timeoutMs: options.timeoutMs,
        },
        onChunk,
        externalSignal
      );

      const latencyMs = Date.now() - startTime;
      this.recordTelemetry(targetModel.id, 'success', latencyMs);
      this.logger.info(`[ModelGateway] Response received (${latencyMs}ms)`);

      return {
        modelId: targetModel.id,
        text: res.response,
        done: res.done,
        latencyMs,
        usedFallback,
        routingReason: route.routingReason,
      };
    } catch (primaryErr: unknown) {
      const primaryModelId = targetModel.id;
      const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      const latencyMs = Date.now() - startTime;
      this.recordTelemetry(primaryModelId, 'error', latencyMs, 'PRIMARY_STREAM_FAILED');
      this.logger.warn(`Primary model streaming '${primaryModelId}' failed: ${primaryMsg}`);

      if (options.allowFallback && route.fallbackModel) {
        this.logger.info(`Attempting streaming fallback to model '${route.fallbackModel.id}'`);
        targetModel = route.fallbackModel;
        usedFallback = true;

        this.logger.info(`[ModelGateway] Provider: ${this.resolveProviderName(targetModel.id)}`);
        this.logger.info(`[ModelGateway] Model: ${targetModel.id}`);
        this.logger.info(`[ModelGateway] Request started`);

        const fbStartTime = Date.now();

        try {
          const fbRes: GenerateResult = await this.adapterOrManager.generateStream(
            {
              model: targetModel.id,
              prompt: options.prompt,
              system: options.system,
              temperature: options.temperature,
              timeoutMs: options.timeoutMs,
            },
            onChunk,
            externalSignal
          );

          const fbLatencyMs = Date.now() - fbStartTime;
          this.recordTelemetry(targetModel.id, 'success', fbLatencyMs);
          this.logger.info(`[ModelGateway] Response received (${fbLatencyMs}ms)`);

          return {
            modelId: targetModel.id,
            text: fbRes.response,
            done: fbRes.done,
            latencyMs: Date.now() - startTime,
            usedFallback: true,
            routingReason: `${route.routingReason} -> Fallback to ${targetModel.id}`,
          };
        } catch (fbErr: unknown) {
          const fbMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
          this.recordTelemetry(targetModel.id, 'error', Date.now() - fbStartTime, 'FALLBACK_STREAM_FAILED');
          throw new Error(`Inference streaming failed on both primary (${primaryModelId}) and fallback (${targetModel.id}): ${fbMsg}`);
        }
      }

      throw new Error(`Inference execution streaming failed on model '${primaryModelId}': ${primaryMsg}`);
    }
  }

  private recordTelemetry(
    modelId: string,
    status: 'success' | 'error' | 'timeout' | 'cancelled',
    latencyMs: number,
    errorCategory?: string
  ): void {
    try {
      this.modelsRepo.recordTelemetry({
        id: `tel-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        modelId,
        status,
        latencyMs,
        errorCategory: errorCategory || null,
      });
    } catch (err) {
      this.logger.warn(`Failed writing model telemetry: ${String(err)}`);
    }
  }
}
