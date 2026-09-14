/**
 * NEXUS AI — Self-Contained AI Inference Provider Architecture (Phase 2 Prototype)
 *
 * Defines the unified, provider-agnostic InferenceProvider contract.
 * Supports both OllamaInferenceProvider (external daemon) and
 * EmbeddedInferenceProvider (in-process/sidecar embedded inference).
 */

export type ProviderType = 'ollama' | 'embedded' | 'cloud';

export type InferenceStatusState =
  | 'NOT_CONFIGURED'
  | 'UNAVAILABLE'
  | 'READY'
  | 'DEGRADED'
  | 'ERROR';

export interface InferenceHealth {
  providerType: ProviderType;
  status: InferenceStatusState;
  version?: string;
  endpoint?: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface InferenceModelInfo {
  id: string;
  name: string;
  sizeBytes?: number;
  format?: string;
  quantization?: string;
  family?: string;
  contextWindow?: number;
  readiness: 'available' | 'loading' | 'ready' | 'error';
}

export interface InferenceChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface InferenceGenerateOptions {
  model: string;
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface InferenceGenerateResult {
  model: string;
  response: string;
  done: boolean;
  totalDurationMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface InferenceChatOptions {
  model: string;
  messages: InferenceChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface InferenceChatResult {
  model: string;
  message: InferenceChatMessage;
  done: boolean;
  totalDurationMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface InferenceStreamChunk {
  delta: string;
  done: boolean;
}

export interface InferenceProvider {
  readonly providerType: ProviderType;

  /**
   * Health check to inspect runtime status without making heavy LLM calls.
   */
  healthCheck(timeoutMs?: number): Promise<InferenceHealth>;

  /**
   * List available models installed or provisioned in this provider.
   */
  listModels(timeoutMs?: number): Promise<InferenceModelInfo[]>;

  /**
   * Fetch detailed metadata for a specific model ID.
   */
  getModelInfo(modelId: string): Promise<InferenceModelInfo | null>;

  /**
   * Execute a single prompt completion.
   */
  generate(
    options: InferenceGenerateOptions,
    signal?: AbortSignal
  ): Promise<InferenceGenerateResult>;

  /**
   * Execute a multi-turn chat message completion.
   */
  chat(
    options: InferenceChatOptions,
    signal?: AbortSignal
  ): Promise<InferenceChatResult>;

  /**
   * Stream a multi-turn chat message completion chunk-by-chunk.
   */
  streamChat(
    options: InferenceChatOptions,
    onChunk: (chunk: InferenceStreamChunk) => void,
    signal?: AbortSignal
  ): Promise<InferenceChatResult>;

  /**
   * Gracefully shut down active model instances or processes.
   */
  shutdown(): Promise<void>;
}
