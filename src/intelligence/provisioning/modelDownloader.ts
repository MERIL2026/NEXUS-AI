import https from 'https';
import fs from 'fs';
import type { ModelManifest, DownloadProgress, VerificationResult } from './types.js';
import { ModelVerifier } from './modelVerifier.js';
import { ModelStorageManager } from './modelStorage.js';

export interface DownloaderOptions {
  storageManager?: ModelStorageManager;
  verifier?: ModelVerifier;
}

export class ModelDownloader {
  private storage: ModelStorageManager;
  private verifier: ModelVerifier;

  constructor(options: DownloaderOptions = {}) {
    this.storage = options.storageManager || new ModelStorageManager();
    this.verifier = options.verifier || new ModelVerifier();
  }

  /**
   * Downloads a model described by manifest securely using HTTPS streaming.
   */
  async downloadModel(
    manifest: ModelManifest,
    onProgress?: (progress: DownloadProgress) => void,
    signal?: AbortSignal
  ): Promise<{ success: boolean; targetPath: string; verification: VerificationResult }> {
    // 1. Security Check: HTTPS required
    if (!manifest.downloadUrl.startsWith('https://')) {
      throw new Error(`Insecure URL '${manifest.downloadUrl}': Only HTTPS downloads are permitted.`);
    }

    if (signal?.aborted) {
      throw new Error('Download cancelled by AbortSignal');
    }

    this.storage.ensureStorageDir();
    const finalPath = this.storage.getModelPath(manifest.id);
    const tmpPath = this.storage.getTempModelPath(manifest.id);

    // If final file already exists and is valid, return immediately
    const existingCheck = await this.verifier.verifyModel(finalPath, manifest);
    if (existingCheck.valid) {
      return { success: true, targetPath: finalPath, verification: existingCheck };
    }

    let fileStream: fs.WriteStream | null = null;

    try {
      fileStream = fs.createWriteStream(tmpPath);

      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('Download cancelled by AbortSignal'));
          return;
        }

        const req = https.get(manifest.downloadUrl, (res) => {
          // Handle HTTP redirects (301, 302, 307)
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = res.headers.location;
            if (!redirectUrl.startsWith('https://')) {
              reject(new Error(`Redirect to insecure HTTP URL '${redirectUrl}' blocked.`));
              return;
            }
            https.get(redirectUrl, (redRes) => {
              this.pipeStream(redRes, fileStream!, manifest.sizeBytes, Date.now(), onProgress, resolve, reject, signal);
            }).on('error', reject);
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''} during model download`));
            return;
          }

          this.pipeStream(res, fileStream!, manifest.sizeBytes, Date.now(), onProgress, resolve, reject, signal);
        });

        req.on('error', reject);

        if (signal) {
          signal.addEventListener('abort', () => {
            req.destroy();
            reject(new Error('Download cancelled by AbortSignal'));
          });
        }
      });

      fileStream.close();

      // Perform Verification on downloaded temp file
      const verification = await this.verifier.verifyModel(tmpPath, manifest);
      if (!verification.valid) {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        throw new Error(`Downloaded model file failed verification: ${verification.error}`);
      }

      // Atomic Rename from .tmp to final .gguf
      fs.renameSync(tmpPath, finalPath);

      return {
        success: true,
        targetPath: finalPath,
        verification: await this.verifier.verifyModel(finalPath, manifest),
      };
    } catch (err) {
      if (fileStream) {
        try {
          fileStream.close();
        } catch {
          // Ignore
        }
      }
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // Ignore cleanup error
        }
      }
      throw err;
    }
  }

  private pipeStream(
    res: import('http').IncomingMessage,
    fileStream: fs.WriteStream,
    totalBytes: number,
    startTime: number,
    onProgress: ((progress: DownloadProgress) => void) | undefined,
    resolve: () => void,
    reject: (err: Error) => void,
    signal?: AbortSignal
  ): void {
    let downloadedBytes = 0;

    res.on('data', (chunk) => {
      if (signal?.aborted) {
        res.destroy();
        reject(new Error('Download cancelled by AbortSignal'));
        return;
      }

      downloadedBytes += chunk.length;
      fileStream.write(chunk);

      if (onProgress) {
        const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
        const speedBytesPerSec = Math.round(downloadedBytes / elapsedSec);
        const percentage = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
        onProgress({
          downloadedBytes,
          totalBytes: totalBytes || downloadedBytes,
          percentage,
          speedBytesPerSec,
        });
      }
    });

    res.on('end', () => {
      fileStream.end();
      resolve();
    });

    res.on('error', (err) => {
      fileStream.end();
      reject(err);
    });
  }
}
