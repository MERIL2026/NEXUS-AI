import os from 'os';
import path from 'path';
import fs from 'fs';

export class ModelStorageManager {
  private baseDir: string;

  constructor(customBaseDir?: string) {
    if (customBaseDir) {
      this.baseDir = customBaseDir;
    } else {
      this.baseDir = this.resolveDefaultStorageDir();
    }
  }

  resolveDefaultStorageDir(): string {
    const platform = os.platform();
    const home = os.homedir();

    if (platform === 'win32') {
      const appData = process.env.LOCALAPPDATA || process.env.APPDATA || path.join(home, 'AppData', 'Local');
      return path.join(appData, 'nexus', 'models');
    }

    if (platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', 'nexus', 'models');
    }

    // Linux & BSD
    return path.join(home, '.nexus', 'models');
  }

  getStorageDir(): string {
    return this.baseDir;
  }

  ensureStorageDir(): string {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    return this.baseDir;
  }

  getModelPath(modelId: string): string {
    // Path traversal sanitization: basename only
    const safeName = path.basename(modelId).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const filename = safeName.endsWith('.gguf') ? safeName : `${safeName}.gguf`;
    return path.join(this.baseDir, filename);
  }

  getTempModelPath(modelId: string): string {
    const mainPath = this.getModelPath(modelId);
    return `${mainPath}.tmp-${Date.now()}`;
  }

  listInstalledModels(): string[] {
    if (!fs.existsSync(this.baseDir)) return [];
    try {
      const files = fs.readdirSync(this.baseDir);
      return files.filter((f) => f.endsWith('.gguf'));
    } catch {
      return [];
    }
  }

  deleteModel(modelId: string): boolean {
    const target = this.getModelPath(modelId);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      return true;
    }
    return false;
  }
}
