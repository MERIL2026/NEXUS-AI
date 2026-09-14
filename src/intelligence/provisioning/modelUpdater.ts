import fs from 'fs';
import type { ModelManifest } from './types.js';
import { ModelStorageManager } from './modelStorage.js';
import { ModelVerifier } from './modelVerifier.js';
import { ModelDownloader } from './modelDownloader.js';

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion?: string;
  latestVersion: string;
  manifest: ModelManifest;
}

export interface UpdateProcessResult {
  success: boolean;
  modelId: string;
  newVersion: string;
  rolledBack?: boolean;
  error?: string;
}

export class ModelUpdateManager {
  private storage: ModelStorageManager;
  private verifier: ModelVerifier;
  private downloader: ModelDownloader;

  constructor(
    storage?: ModelStorageManager,
    verifier?: ModelVerifier,
    downloader?: ModelDownloader
  ) {
    this.storage = storage || new ModelStorageManager();
    this.verifier = verifier || new ModelVerifier();
    this.downloader = downloader || new ModelDownloader({ storageManager: this.storage, verifier: this.verifier });
  }

  checkForUpdates(installedModelId: string, installedVersion: string, latestManifest: ModelManifest): UpdateCheckResult {
    const updateAvailable = latestManifest.version !== installedVersion;
    return {
      updateAvailable,
      currentVersion: installedVersion,
      latestVersion: latestManifest.version,
      manifest: latestManifest,
    };
  }

  /**
   * Performs atomic model update with backup and automatic rollback on failure.
   */
  async updateModel(
    manifest: ModelManifest,
    onProgress?: (progress: import('./types.js').DownloadProgress) => void,
    signal?: AbortSignal
  ): Promise<UpdateProcessResult> {
    const finalPath = this.storage.getModelPath(manifest.id);
    const backupPath = `${finalPath}.bak`;
    const hasExisting = fs.existsSync(finalPath);

    // 1. Backup existing model if present
    if (hasExisting) {
      try {
        fs.copyFileSync(finalPath, backupPath);
      } catch (err) {
        return {
          success: false,
          modelId: manifest.id,
          newVersion: manifest.version,
          error: `Failed to create backup copy: ${(err as Error).message}`,
        };
      }
    }

    try {
      // 2. Download and verify update file
      const downloadRes = await this.downloader.downloadModel(manifest, onProgress, signal);
      if (!downloadRes.success) {
        throw new Error('Download failed verification');
      }

      // Cleanup backup on successful update completion
      if (fs.existsSync(backupPath)) {
        try {
          fs.unlinkSync(backupPath);
        } catch {
          // Ignore unlink backup error
        }
      }

      return {
        success: true,
        modelId: manifest.id,
        newVersion: manifest.version,
      };
    } catch (err) {
      // 3. ROLLBACK: Restore existing model from backup if available
      let rolledBack = false;
      if (fs.existsSync(backupPath)) {
        try {
          if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
          fs.renameSync(backupPath, finalPath);
          rolledBack = true;
        } catch {
          // Rollback error
        }
      }

      return {
        success: false,
        modelId: manifest.id,
        newVersion: manifest.version,
        rolledBack,
        error: `Model update failed: ${(err as Error).message}${rolledBack ? ' (Rolled back to previous version)' : ''}`,
      };
    }
  }
}
