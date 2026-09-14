import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SetupState } from './types.js';

export class SetupStateManager {
  private stateFilePath: string;

  constructor(customPath?: string) {
    if (customPath) {
      this.stateFilePath = customPath;
    } else {
      const home = os.homedir();
      const dir = path.join(home, '.nexus');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.stateFilePath = path.join(dir, 'setup_state.json');
    }
  }

  getStateFilePath(): string {
    return this.stateFilePath;
  }

  loadState(): SetupState {
    if (!fs.existsSync(this.stateFilePath)) {
      return {
        runtimeReady: false,
        modelInstalled: false,
        modelVerified: false,
      };
    }

    try {
      const data = fs.readFileSync(this.stateFilePath, 'utf-8');
      return JSON.parse(data) as SetupState;
    } catch {
      return {
        runtimeReady: false,
        modelInstalled: false,
        modelVerified: false,
      };
    }
  }

  saveState(state: Partial<SetupState>): SetupState {
    const current = this.loadState();
    const updated: SetupState = {
      ...current,
      ...state,
      lastVerifiedAt: new Date().toISOString(),
    };

    const dir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(this.stateFilePath, JSON.stringify(updated, null, 2), 'utf-8');
    return updated;
  }

  isFirstRunRequired(): boolean {
    const state = this.loadState();
    return !(state.modelInstalled && state.modelVerified);
  }
}
