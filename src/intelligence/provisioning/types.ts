export interface ModelManifest {
  id: string;
  displayName: string;
  version: string;
  format: 'gguf' | 'onnx';
  downloadUrl: string;
  sizeBytes: number;
  sha256: string;
  capabilities: string[];
  minimumRamMb: number;
  recommendedRamMb: number;
  tier: 'low' | 'standard' | 'high';
  license: string;
  description: string;
}

export interface HardwareProfile {
  platform: NodeJS.Platform;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalRamMb: number;
  freeRamMb: number;
  freeStorageMb: number;
  hasGpu: boolean;
  gpuName?: string;
}

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  percentage: number;
  speedBytesPerSec: number;
}

export interface VerificationResult {
  valid: boolean;
  modelId: string;
  fileExist: boolean;
  sizeMatches: boolean;
  checksumMatches: boolean;
  formatValid: boolean;
  error?: string;
}

export interface SetupState {
  runtimeReady: boolean;
  modelInstalled: boolean;
  modelVerified: boolean;
  activeModelId?: string;
  installedPath?: string;
  version?: string;
  lastVerifiedAt?: string;
}
