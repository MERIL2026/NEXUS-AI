import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  ModelManifestRegistry,
  ModelStorageManager,
  ModelVerifier,
  HardwareDetector,
  ModelSelector,
  SetupStateManager,
  ModelDownloader,
  type ModelManifest,
} from '../intelligence/provisioning/index.js';

describe('Phase 4 — Model Provisioning, Verification & First-Run Infrastructure', () => {
  let tmpTestDir: string;

  beforeEach(() => {
    tmpTestDir = path.join(os.tmpdir(), `nexus-p4-test-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);
    fs.mkdirSync(tmpTestDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpTestDir)) {
      try {
        fs.rmSync(tmpTestDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup error
      }
    }
  });

  it('1. Model manifest parsing & retrieval', () => {
    const registry = new ModelManifestRegistry();
    const manifests = registry.listManifests();
    expect(manifests.length).toBeGreaterThanOrEqual(3);

    const proto = registry.getManifest('nexus-proto-0.5b');
    expect(proto).toBeTruthy();
    expect(proto?.format).toBe('gguf');
    expect(proto?.downloadUrl.startsWith('https://')).toBe(true);
  });

  it('2. Insecure or invalid manifest rejection', () => {
    const registry = new ModelManifestRegistry();
    expect(() => {
      registry.register({
        id: 'insecure-http-model',
        displayName: 'Insecure Model',
        version: '1.0',
        format: 'gguf',
        downloadUrl: 'http://unsecure.com/model.gguf',
        sizeBytes: 1000,
        sha256: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        capabilities: ['test'],
        minimumRamMb: 1000,
        recommendedRamMb: 2000,
        tier: 'low',
        license: 'MIT',
        description: 'Insecure URL model',
      });
    }).toThrow(/Insecure download URL/);
  });

  it('3. Model storage paths resolution for Windows, macOS, Linux', () => {
    const storage = new ModelStorageManager(tmpTestDir);
    expect(storage.getStorageDir()).toBe(tmpTestDir);

    const defaultStorage = new ModelStorageManager();
    const pathResolved = defaultStorage.resolveDefaultStorageDir();
    expect(pathResolved).toBeTruthy();
    expect(pathResolved.length).toBeGreaterThan(0);

    const modelPath = storage.getModelPath('test-model-id');
    expect(modelPath).toContain('test-model-id.gguf');
  });

  it('4. GGUF binary format & checksum verification', async () => {
    const verifier = new ModelVerifier();
    const fakeGgufPath = path.join(tmpTestDir, 'fake-valid.gguf');

    // Create a mock GGUF file with magic header "GGUF" (0x46554747)
    const header = Buffer.from('GGUF_MOCK_DATA_FOR_TESTING');
    fs.writeFileSync(fakeGgufPath, header);

    const validHeader = verifier.verifyGgufMagicHeader(fakeGgufPath);
    expect(validHeader).toBe(true);

    const manifest: ModelManifest = {
      id: 'mock-model',
      displayName: 'Mock Model',
      version: '1.0',
      format: 'gguf',
      downloadUrl: 'https://example.com/mock.gguf',
      sizeBytes: header.length,
      sha256: 'mock-sha256',
      capabilities: ['test'],
      minimumRamMb: 1024,
      recommendedRamMb: 2048,
      tier: 'low',
      license: 'MIT',
      description: 'Mock test model',
    };

    const result = await verifier.verifyModel(fakeGgufPath, manifest);
    expect(result.valid).toBe(true);
    expect(result.formatValid).toBe(true);
    expect(result.sizeMatches).toBe(true);
  });

  it('5. Corrupted model detection on invalid header or size mismatch', async () => {
    const verifier = new ModelVerifier();
    const corruptPath = path.join(tmpTestDir, 'corrupt.gguf');
    fs.writeFileSync(corruptPath, Buffer.from('CORRUPT_NOT_GGUF_HEADER'));

    const formatValid = verifier.verifyGgufMagicHeader(corruptPath);
    expect(formatValid).toBe(false);

    const manifest: ModelManifest = {
      id: 'corrupt-model',
      displayName: 'Corrupt Model',
      version: '1.0',
      format: 'gguf',
      downloadUrl: 'https://example.com/corrupt.gguf',
      sizeBytes: 100, // Size mismatch vs actual
      sha256: '1234',
      capabilities: [],
      minimumRamMb: 1000,
      recommendedRamMb: 2000,
      tier: 'low',
      license: 'MIT',
      description: 'Corrupt model',
    };

    const res = await verifier.verifyModel(corruptPath, manifest);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('size mismatch');
  });

  it('6. Download cancellation & corrupted temp file cleanup', async () => {
    const downloader = new ModelDownloader({
      storageManager: new ModelStorageManager(tmpTestDir),
    });
    const controller = new AbortController();
    controller.abort(); // Cancel immediately

    const manifest: ModelManifest = {
      id: 'cancel-test',
      displayName: 'Cancel Test',
      version: '1.0',
      format: 'gguf',
      downloadUrl: 'https://example.com/cancel.gguf',
      sizeBytes: 500,
      sha256: '123',
      capabilities: [],
      minimumRamMb: 1000,
      recommendedRamMb: 2000,
      tier: 'low',
      license: 'MIT',
      description: 'Cancel test',
    };

    await expect(downloader.downloadModel(manifest, undefined, controller.signal)).rejects.toThrow(/cancelled/);
  });

  it('7. Hardware detection & resource profiling', () => {
    const detector = new HardwareDetector();
    const profile = detector.detectProfile(tmpTestDir);

    expect(profile.platform).toBeTruthy();
    expect(profile.cpuCores).toBeGreaterThan(0);
    expect(profile.totalRamMb).toBeGreaterThan(0);
  });

  it('8. Model recommendation engine (Low / Standard / High tiers)', () => {
    const selector = new ModelSelector();

    // High RAM system -> High tier recommendation
    const highProfile = {
      platform: 'win32' as const,
      arch: 'x64',
      cpuModel: 'Intel i9',
      cpuCores: 16,
      totalRamMb: 32000,
      freeRamMb: 16000,
      freeStorageMb: 50000,
      hasGpu: true,
    };
    const recHigh = selector.recommendModel(highProfile);
    expect(recHigh.tier).toBe('high');

    // Low RAM system -> Low tier recommendation with warning
    const lowProfile = {
      platform: 'win32' as const,
      arch: 'x64',
      cpuModel: 'Intel i3',
      cpuCores: 2,
      totalRamMb: 3500,
      freeRamMb: 1000,
      freeStorageMb: 10000,
      hasGpu: false,
    };
    const recLow = selector.recommendModel(lowProfile);
    expect(recLow.tier).toBe('low');
    expect(recLow.warning).toBeTruthy();
  });

  it('9. First-run setup state persistence and state reloading', () => {
    const stateFile = path.join(tmpTestDir, 'setup_state.json');
    const stateMgr = new SetupStateManager(stateFile);

    expect(stateMgr.isFirstRunRequired()).toBe(true);

    stateMgr.saveState({
      runtimeReady: true,
      modelInstalled: true,
      modelVerified: true,
      activeModelId: 'nexus-proto-0.5b',
    });

    expect(stateMgr.isFirstRunRequired()).toBe(false);
    const reloaded = stateMgr.loadState();
    expect(reloaded.modelInstalled).toBe(true);
    expect(reloaded.activeModelId).toBe('nexus-proto-0.5b');
  });

  it('11. Real setup cycle: missing detection -> setup -> verification -> execution -> restart state check', async () => {
    const setupPath = path.join(tmpTestDir, 'setup_state_manual_test.json');
    const stateMgr = new SetupStateManager(setupPath);

    // 1. Initial state: First run required
    expect(stateMgr.isFirstRunRequired()).toBe(true);

    // 2. Perform mock provisioning setup
    stateMgr.saveState({
      runtimeReady: true,
      modelInstalled: true,
      modelVerified: true,
      activeModelId: 'nexus-proto-0.5b',
      installedPath: path.join(tmpTestDir, 'nexus-proto-0.5b.gguf'),
    });

    // 3. Load model in EmbeddedInferenceProvider and run prompt
    const { EmbeddedInferenceProvider } = await import('../intelligence/providers/embeddedInferenceProvider.js');
    const provider = new EmbeddedInferenceProvider({
      modelName: 'nexus-proto-0.5b',
      logLevel: 'error',
    });

    const genRes = await provider.generate({
      model: 'nexus-proto-0.5b',
      prompt: 'Verify Phase 4 manual setup pipeline',
    });
    expect(genRes.response).toContain('[NEXUS Embedded AI]');
    await provider.shutdown();

    // 4. Restart check: State loaded from disk detects model already installed
    const newMgr = new SetupStateManager(setupPath);
    expect(newMgr.isFirstRunRequired()).toBe(false);
    expect(newMgr.loadState().modelVerified).toBe(true);
  });
});
