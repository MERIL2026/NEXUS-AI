/**
 * NEXUS AI — FirstRunService (P7-C)
 *
 * Deterministic first-run detection and readiness state machine.
 * Persists non-sensitive state in the existing SettingsRepository (SQLite).
 *
 * Privacy: NEVER stores secrets, API keys, tokens, or private keys.
 */

import type { SettingsRepository } from '../storage/repositories/settingsRepository.js';
import { Logger, LogLevel } from '../common/logger.js';
import { CONFIG_VERSION } from './index.js';

export type FirstRunState =
  | 'FIRST_RUN'
  | 'CONFIGURED'
  | 'PARTIALLY_CONFIGURED'
  | 'READY'
  | 'DEGRADED'
  | 'BLOCKED'
  | 'CONFIGURATION_ERROR';

export interface FirstRunPersistence {
  firstRunCompleted: boolean;
  lastCheckTimestamp: string | null;
  configVersion: number | null;
  workspacePath: string | null;
}

// SettingsRepository key constants
const KEY_FIRST_RUN_COMPLETED = 'nexus.firstrun.completed';
const KEY_LAST_CHECK = 'nexus.firstrun.lastCheck';
const KEY_CONFIG_VERSION = 'nexus.config.version';
const KEY_WORKSPACE_PATH = 'nexus.workspace.path';

export class FirstRunService {
  private logger: Logger;

  constructor(
    private settings: SettingsRepository,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('FirstRunService', logLevel);
  }

  /**
   * Read persisted first-run state from settings DB.
   */
  readPersistence(): FirstRunPersistence {
    const completed = this.settings.get(KEY_FIRST_RUN_COMPLETED);
    const lastCheck = this.settings.get(KEY_LAST_CHECK);
    const configVer = this.settings.get(KEY_CONFIG_VERSION);
    const workspacePath = this.settings.get(KEY_WORKSPACE_PATH);

    return {
      firstRunCompleted: completed === 'true',
      lastCheckTimestamp: lastCheck,
      configVersion: configVer !== null ? parseInt(configVer, 10) : null,
      workspacePath,
    };
  }

  /**
   * Persist successful first-run completion.
   * workspacePath is the canonical, validated workspace path (non-secret).
   */
  markFirstRunCompleted(canonicalWorkspacePath: string): void {
    const now = new Date().toISOString();
    this.settings.set(KEY_FIRST_RUN_COMPLETED, 'true');
    this.settings.set(KEY_LAST_CHECK, now);
    this.settings.set(KEY_CONFIG_VERSION, String(CONFIG_VERSION));
    this.settings.set(KEY_WORKSPACE_PATH, canonicalWorkspacePath);
    this.logger.info(`First-run state persisted (configVersion=${CONFIG_VERSION})`);
  }

  /**
   * Update the last health-check timestamp without resetting first-run state.
   */
  recordHealthCheck(): void {
    this.settings.set(KEY_LAST_CHECK, new Date().toISOString());
  }

  /**
   * Determine the current first-run / readiness state from persisted data
   * and the provided subsystem readiness indicators.
   *
   * @param configOk    - AppConfig parsed without error
   * @param dbOk        - StorageService initialized and healthy
   * @param workspaceOk - WorkspaceService returned READY or CREATED
   * @param runtimeReady - AIRuntimeManager status === READY
   * @param hasUsableModel - At least one model ready in ModelRegistry
   */
  determineState(params: {
    configOk: boolean;
    dbOk: boolean;
    workspaceOk: boolean;
    runtimeReady: boolean;
    hasUsableModel: boolean;
  }): FirstRunState {
    const { configOk, dbOk, workspaceOk, runtimeReady, hasUsableModel } = params;

    if (!configOk) {
      return 'CONFIGURATION_ERROR';
    }

    if (!dbOk || !workspaceOk) {
      return 'BLOCKED';
    }

    const persistence = this.readPersistence();
    const isFirstRun = !persistence.firstRunCompleted;
    const configMigrated = persistence.configVersion !== null && persistence.configVersion < CONFIG_VERSION;

    const coreReady = runtimeReady && hasUsableModel;

    if (coreReady) {
      if (isFirstRun) return 'FIRST_RUN';
      if (configMigrated) return 'PARTIALLY_CONFIGURED';
      return 'READY';
    }

    // Runtime or model unavailable
    if (isFirstRun) return 'FIRST_RUN';
    if (configMigrated) return 'PARTIALLY_CONFIGURED';
    return 'DEGRADED';
  }
}
