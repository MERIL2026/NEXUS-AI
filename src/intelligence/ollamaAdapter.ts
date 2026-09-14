import { Logger, LogLevel } from '../common/logger.js';

export interface OllamaModelItem {
  name: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: {
    format?: string;
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface OllamaTagsResponse {
  models: OllamaModelItem[];
}

export interface GenerateOptions {
  model: string;
  prompt: string;
  system?: string;
  temperature?: number;
  timeoutMs?: number;
}

export interface GenerateResult {
  model: string;
  response: string;
  done: boolean;
  totalDurationMs?: number;
  evalCount?: number;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
}

export class OllamaAdapter {
  private logger: Logger;

  constructor(
    private host: string = 'http://127.0.0.1:11434',
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('OllamaAdapter', logLevel);
  }

  getHost(): string {
    return this.host;
  }

  async checkHealth(timeoutMs: number = 3000): Promise<{ available: boolean; version?: string; error?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.host}/api/version`, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        return { available: false, error: `HTTP ${res.status} ${res.statusText}` };
      }

      const data = (await res.json()) as { version?: string };
      return { available: true, version: data.version || 'unknown' };
    } catch (err: unknown) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Ollama health check failed at ${this.host}: ${message}`);
      return { available: false, error: message };
    }
  }

  async discoverModels(timeoutMs: number = 5000): Promise<OllamaModelItem[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.host}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`Failed to list models from Ollama: HTTP ${res.status}`);
      }

      const data = (await res.json()) as OllamaTagsResponse;
      return data.models || [];
    } catch (err: unknown) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed discovering models from Ollama: ${message}`);
      throw new Error(`Ollama model discovery error: ${message}`);
    }
  }

  async generate(options: GenerateOptions, externalSignal?: AbortSignal): Promise<GenerateResult> {
    const timeoutMs = options.timeoutMs || 30000;
    const controller = new AbortController();

    if (externalSignal) {
      externalSignal.addEventListener('abort', () => controller.abort());
    }

    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startTime = Date.now();

    try {
      const body: Record<string, unknown> = {
        model: options.model,
        prompt: options.prompt,
        stream: false,
        options: {
          temperature: options.temperature ?? 0.7,
        },
      };

      if (options.system) {
        body.system = options.system;
      }

      const res = await fetch(`${this.host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`Ollama generate error (HTTP ${res.status}): ${errorText || res.statusText}`);
      }

      const data = (await res.json()) as {
        model: string;
        response: string;
        done: boolean;
        error?: string;
        total_duration?: number;
        eval_count?: number;
      };

      // Ollama v0.3+ can return HTTP 200 with a body-level error field
      // (e.g. when a tool-capable model produces no text and no tool calls).
      if (data.error) {
        throw new Error(`Ollama model error: ${data.error}`);
      }

      const totalDurationMs = data.total_duration ? Math.round(data.total_duration / 1e6) : Date.now() - startTime;

      return {
        model: data.model || options.model,
        response: data.response || '',
        done: data.done ?? true,
        totalDurationMs,
        evalCount: data.eval_count,
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new Error(`Ollama generate request timed out after ${timeoutMs}ms or was cancelled`);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Ollama generate failure: ${message}`);
    }
  }

  async generateStream(
    options: GenerateOptions,
    onChunk: (chunk: StreamChunk) => void,
    externalSignal?: AbortSignal
  ): Promise<GenerateResult> {
    const timeoutMs = options.timeoutMs || 60000;
    const controller = new AbortController();

    if (externalSignal) {
      externalSignal.addEventListener('abort', () => controller.abort());
    }

    let timer = setTimeout(() => controller.abort(), timeoutMs);
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), timeoutMs);
    };

    const startTime = Date.now();

    try {
      const body: Record<string, unknown> = {
        model: options.model,
        prompt: options.prompt,
        stream: true,
        options: {
          temperature: options.temperature ?? 0.7,
        },
      };

      if (options.system) {
        body.system = options.system;
      }

      const res = await fetch(`${this.host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        clearTimeout(timer);
        const errorText = await res.text().catch(() => '');
        throw new Error(`Ollama stream error (HTTP ${res.status}): ${errorText || res.statusText}`);
      }

      if (!res.body) {
        clearTimeout(timer);
        throw new Error('Ollama stream response body is null');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let fullResponse = '';
      let buffer = '';

      while (true) {
        resetTimer();
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed) as { response?: string; done?: boolean; error?: string };

            // Ollama v0.3+ may emit an error chunk mid-stream (e.g. empty tool output).
            if (parsed.error) {
              throw new Error(`Ollama model error: ${parsed.error}`);
            }

            const delta = parsed.response || '';
            fullResponse += delta;
            const isDone = Boolean(parsed.done);

            onChunk({ delta, done: isDone });
          } catch (parseErr: unknown) {
            // Re-throw Ollama model errors; ignore partial JSON parse failures.
            if (parseErr instanceof Error && parseErr.message.startsWith('Ollama model error:')) {
              throw parseErr;
            }
          }
        }
      }

      clearTimeout(timer);
      return {
        model: options.model,
        response: fullResponse,
        done: true,
        totalDurationMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new Error(`Ollama stream request timed out after ${timeoutMs}ms or was cancelled`);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Ollama stream failure: ${message}`);
    }
  }
}
