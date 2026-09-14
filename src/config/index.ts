import { Logger, LogLevel } from '../common/logger.js';
import { resolveProductionPaths } from './productionPaths.js';

export { resolveProductionPaths, getBaseUserDataDir } from './productionPaths.js';
export type { ResolvedAppPaths } from './productionPaths.js';

/** Current configuration schema version. Bump when AppConfig gains breaking new fields. */
export const CONFIG_VERSION = 1;

export interface AppConfig {
  port: number;
  environment: 'development' | 'production' | 'test';
  ollamaHost: string;
  databasePath: string;
  workspaceRoot: string;
  logLevel: LogLevel;
  /** Pinned primary model ID (optional — ModelRouter falls back to registry order if absent). */
  primaryModel?: string;
  /** Pinned fallback model ID (optional). */
  fallbackModel?: string;
  /** Explicit inference provider config mode (embedded | ollama | auto). */
  nexusInferenceProvider?: 'embedded' | 'ollama' | 'auto';
  /** Configuration schema version — used for future migration detection. */
  configVersion: number;
}

export class ConfigService {
  private config: AppConfig;
  private logger = new Logger('ConfigService');

  constructor(env: Record<string, string | undefined> = process.env) {
    this.config = this.parseAndValidate(env);
    this.logger.info('Configuration successfully loaded', {
      environment: this.config.environment,
      port: this.config.port,
      databasePath: this.config.databasePath,
      workspaceRoot: this.config.workspaceRoot,
      logLevel: this.config.logLevel,
    });
  }

  private parseAndValidate(env: Record<string, string | undefined>): AppConfig {
    const rawPort = env.PORT || '3000';
    const port = parseInt(rawPort, 10);
    if (isNaN(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid PORT configuration value: "${rawPort}". Must be integer between 0 and 65535.`);
    }

    const rawEnv = env.NODE_ENV || 'development';
    if (!['development', 'production', 'test'].includes(rawEnv)) {
      throw new Error(`Invalid NODE_ENV configuration value: "${rawEnv}". Allowed: development, production, test.`);
    }

    const rawLogLevel = (env.LOG_LEVEL || 'info').toLowerCase();
    if (!['debug', 'info', 'warn', 'error'].includes(rawLogLevel)) {
      throw new Error(`Invalid LOG_LEVEL configuration value: "${rawLogLevel}". Allowed: debug, info, warn, error.`);
    }

    const resolvedPaths = resolveProductionPaths(env);
    const ollamaHost = env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    const databasePath = resolvedPaths.databasePath;
    const workspaceRoot = resolvedPaths.workspaceRoot;

    // Optional model pins — no error if absent; ModelRouter handles missing gracefully
    const primaryModel = env.PRIMARY_MODEL?.trim() || undefined;
    const fallbackModel = env.FALLBACK_MODEL?.trim() || undefined;

    const envProvider = env.NEXUS_INFERENCE_PROVIDER || env.NEXUS_PROVIDER;
    const nexusInferenceProvider: 'embedded' | 'ollama' | 'auto' | undefined = ['embedded', 'ollama', 'auto'].includes(envProvider as string)
      ? (envProvider as 'embedded' | 'ollama' | 'auto')
      : undefined;

    return Object.freeze({
      port,
      environment: rawEnv as AppConfig['environment'],
      ollamaHost,
      databasePath,
      workspaceRoot,
      logLevel: rawLogLevel as LogLevel,
      primaryModel,
      fallbackModel,
      nexusInferenceProvider,
      configVersion: CONFIG_VERSION,
    });
  }

  getConfig(): AppConfig {
    return this.config;
  }
}

export function loadConfig(env?: Record<string, string | undefined>): AppConfig {
  const service = new ConfigService(env);
  return service.getConfig();
}
