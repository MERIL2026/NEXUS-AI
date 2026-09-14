/**
 * NEXUS AI — P7-B AI Runtime & Model Management Abstraction Types
 *
 * Defines runtime-agnostic abstractions for AI inference runtimes (Ollama, Embedded, Cloud).
 */

import type { GenerateOptions, GenerateResult, StreamChunk } from '../ollamaAdapter.js';

export type RuntimeProviderId = 'ollama' | 'embedded' | 'cloud';

export type RuntimeStatusState =
  | 'NOT_CONFIGURED'
  | 'UNAVAILABLE'
  | 'UNREACHABLE'
  | 'READY'
  | 'DEGRADED'
  | 'ERROR';

export type ModelReadinessState =
  | 'MODEL_NOT_INSTALLED'
  | 'MODEL_AVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_LOADING'
  | 'MODEL_READY'
  | 'MODEL_ERROR';

export interface RuntimeHealth {
  providerId: RuntimeProviderId;
  status: RuntimeStatusState;
  endpoint: string;
  version?: string;
  reason?: string;
  suggestedAction?: string;
  timestamp: string;
}

export interface RuntimeCapabilities {
  supportsStreaming: boolean;
  supportsSystemPrompt: boolean;
  supportsEmbeddings: boolean;
  maxContextLength?: number;
}

export interface RuntimeModelInfo {
  id: string;
  name: string;
  sizeBytes?: number;
  modifiedAt?: string;
  digest?: string;
  format?: string;
  family?: string;
  parameterSize?: string;
  quantizationLevel?: string;
  readiness: ModelReadinessState;
}

export interface WarmupResult {
  success: boolean;
  modelId: string;
  latencyMs: number;
  error?: string;
}

export interface AIRuntimeAdapter {
  readonly providerId: RuntimeProviderId;
  getHost(): string;
  checkHealth(timeoutMs?: number): Promise<RuntimeHealth>;
  discoverModels(timeoutMs?: number): Promise<RuntimeModelInfo[]>;
  checkModelReadiness(modelId: string, timeoutMs?: number): Promise<{ readiness: ModelReadinessState; details?: string }>;
  warmupModel(modelId: string, timeoutMs?: number, externalSignal?: AbortSignal): Promise<WarmupResult>;
  generate(options: GenerateOptions, externalSignal?: AbortSignal): Promise<GenerateResult>;
  generateStream(
    options: GenerateOptions,
    onChunk: (chunk: StreamChunk) => void,
    externalSignal?: AbortSignal
  ): Promise<GenerateResult>;
}
