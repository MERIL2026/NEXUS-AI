import os from 'os';

export type PlatformTargetKey =
  | 'win32-x64'
  | 'win32-arm64'
  | 'darwin-x64'
  | 'darwin-arm64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'unsupported';

export interface PlatformDescriptor {
  key: PlatformTargetKey;
  platform: NodeJS.Platform;
  arch: string;
  isSupported: boolean;
  displayName: string;
  hasMetal: boolean;
  hasCuda: boolean;
  note?: string;
}

export class PlatformDetector {
  detectPlatform(): PlatformDescriptor {
    const platform = os.platform();
    const arch = os.arch();
    const keyString = `${platform}-${arch}`;

    const supportedKeys: PlatformTargetKey[] = [
      'win32-x64',
      'win32-arm64',
      'darwin-x64',
      'darwin-arm64',
      'linux-x64',
      'linux-arm64',
    ];

    const key: PlatformTargetKey = supportedKeys.includes(keyString as PlatformTargetKey)
      ? (keyString as PlatformTargetKey)
      : 'unsupported';

    const isSupported = key !== 'unsupported';
    const hasMetal = platform === 'darwin' && arch === 'arm64';
    const hasCuda = Boolean(process.env.CUDA_VISIBLE_DEVICES || process.env.CUDA_PATH);

    let displayName = `${platform} (${arch})`;
    if (platform === 'win32') displayName = `Windows ${arch}`;
    if (platform === 'darwin') displayName = arch === 'arm64' ? 'macOS Apple Silicon' : 'macOS Intel';
    if (platform === 'linux') displayName = `Linux ${arch}`;

    return {
      key,
      platform,
      arch,
      isSupported,
      displayName,
      hasMetal,
      hasCuda,
      note: isSupported ? undefined : `Platform ${keyString} is not directly supported for native binary acceleration. Falling back to CPU vectorization.`,
    };
  }
}
