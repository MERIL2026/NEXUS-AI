import os from 'os';
import fs from 'fs';
import type { HardwareProfile } from './types.js';

export class HardwareDetector {
  detectProfile(overrideStoragePath?: string): HardwareProfile {
    const platform = os.platform();
    const arch = os.arch();
    const cpus = os.cpus();
    const totalRamMb = Math.round(os.totalmem() / (1024 * 1024));
    const freeRamMb = Math.round(os.freemem() / (1024 * 1024));

    let freeStorageMb = 20000; // Default conservative 20 GB estimate
    try {
      const targetPath = overrideStoragePath || process.cwd();
      if (fs.existsSync(targetPath)) {
        const stat = fs.statSync(targetPath);
        if (stat) {
          // Approximate available disk space estimation fallback
          freeStorageMb = 25000;
        }
      }
    } catch {
      // Keep default estimate
    }

    // Safe GPU probe heuristic
    let hasGpu = false;
    let gpuName: string | undefined;

    if (platform === 'darwin' && arch === 'arm64') {
      hasGpu = true;
      gpuName = 'Apple Silicon Metal Acceleration';
    } else if (process.env.CUDA_VISIBLE_DEVICES || process.env.CUDA_PATH) {
      hasGpu = true;
      gpuName = 'NVIDIA CUDA GPU';
    }

    return {
      platform,
      arch,
      cpuModel: cpus[0]?.model || 'Standard CPU',
      cpuCores: cpus.length,
      totalRamMb,
      freeRamMb,
      freeStorageMb,
      hasGpu,
      gpuName,
    };
  }
}
