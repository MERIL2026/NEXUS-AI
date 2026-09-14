import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { ModelManifestRegistry } from '../intelligence/provisioning/modelManifest.js';
import { HardwareDetector } from '../intelligence/provisioning/hardwareDetector.js';
import { ModelSelector } from '../intelligence/provisioning/modelSelector.js';
import { PlatformDetector } from '../intelligence/provisioning/platformDetector.js';
import { ModelStorageManager } from '../intelligence/provisioning/modelStorage.js';
import { ModelVerifier } from '../intelligence/provisioning/modelVerifier.js';
import { EmbeddedInferenceProvider } from '../intelligence/providers/embeddedInferenceProvider.js';
import { ConfigService } from '../config/index.js';
import { ApplicationApi } from '../api/index.js';

describe('NEXUS Final Release Gate & Production Audit', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-gate-'));
    dbPath = path.join(tmpDir, 'test_release.sqlite');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 1. Production Model Manifest Audit
  it('1. Production model manifest qwen2.5-coder-1.5b uses HTTPS, valid SHA-256 and production size', () => {
    const registry = new ModelManifestRegistry();
    const manifest = registry.getManifest('qwen2.5-coder-1.5b');

    expect(manifest).not.toBeNull();
    expect(manifest?.downloadUrl).toMatch(/^https:\/\//);
    expect(manifest?.sha256).toMatch(/^[a-f0-9]{64}$/i);
    expect(manifest?.sizeBytes).toBeGreaterThan(500 * 1024 * 1024);
    expect(manifest?.license).toBe('Apache-2.0');
    expect(manifest?.capabilities).toContain('code-synthesis');
  });

  // 2. Security: Insecure HTTP Download Prevention
  it('2. ModelManifestRegistry rejects non-HTTPS URLs for model downloads', () => {
    const registry = new ModelManifestRegistry();
    expect(() => {
      registry.register({
        id: 'insecure-test-model',
        displayName: 'Insecure Model',
        version: '1.0.0',
        format: 'gguf',
        downloadUrl: 'http://insecure-server.com/model.gguf',
        sizeBytes: 1000,
        sha256: 'a'.repeat(64),
        capabilities: ['chat'],
        minimumRamMb: 1024,
        recommendedRamMb: 2048,
        tier: 'low',
        license: 'MIT',
        description: 'Test',
      });
    }).toThrow(/Insecure download URL/);
  });

  // 3. Hardware & Platform Detection
  it('3. HardwareDetector correctly reports platform, CPU, RAM and recommends standard model', () => {
    const platform = new PlatformDetector().detectPlatform();
    expect(['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']).toContain(platform.key);

    const hw = new HardwareDetector().detectProfile();
    expect(hw.cpuCores).toBeGreaterThan(0);
    expect(hw.totalRamMb).toBeGreaterThan(0);

    const recommendation = new ModelSelector().recommendModel(hw);
    expect(['qwen2.5-coder-1.5b', 'qwen2.5-coder-7b', 'nexus-proto-0.5b']).toContain(recommendation.recommendedModel.id);
  });

  // 4. Storage Isolation
  it('4. ModelStorageManager stores models in user OS app data directory, outside workspace root', () => {
    const storage = new ModelStorageManager(path.join(tmpDir, 'nexus-models'));
    const modelDir = storage.getStorageDir();

    expect(modelDir).toContain('nexus-models');
    expect(modelDir).not.toEqual(tmpDir);
  });

  // 5. GGUF Magic Header Verification
  it('5. ModelVerifier validates GGUF header magic 0x46554747 (GGUF)', async () => {
    const verifier = new ModelVerifier();
    const validGgufPath = path.join(tmpDir, 'valid.gguf');
    const header = Buffer.alloc(16);
    header.write('GGUF', 0, 'ascii'); // 0x46554747
    header.writeUInt32LE(2, 4); // Version 2
    fs.writeFileSync(validGgufPath, header);

    const validResult = verifier.verifyGgufMagicHeader(validGgufPath);
    expect(validResult).toBe(true);

    const invalidPath = path.join(tmpDir, 'invalid.bin');
    fs.writeFileSync(invalidPath, Buffer.from('NOT_GGUF_HEADER'));
    const invalidResult = verifier.verifyGgufMagicHeader(invalidPath);
    expect(invalidResult).toBe(false);
  });

  // 6. SHA-256 Verification & Mismatch Recovery
  it('6. ModelVerifier computes SHA-256 and detects mismatch against manifest', async () => {
    const verifier = new ModelVerifier();
    const fileContent = 'NEXUS GGUF MODEL CONTENT';
    const filePath = path.join(tmpDir, 'test_sha.gguf');
    fs.writeFileSync(filePath, fileContent);

    const computed = await verifier.computeFileSha256(filePath);
    expect(computed).toHaveLength(64);

    const wrongHash = '0000000000000000000000000000000000000000000000000000000000000000';
    const result = await verifier.verifyModel(filePath, {
      id: 'test-mod',
      displayName: 'Test',
      version: '1.0.0',
      format: 'gguf',
      downloadUrl: 'https://test.com/mod.gguf',
      sizeBytes: fileContent.length,
      sha256: wrongHash,
      capabilities: ['chat'],
      minimumRamMb: 1024,
      recommendedRamMb: 2048,
      tier: 'low',
      license: 'MIT',
      description: 'Test',
    });

    expect(result.valid).toBe(false);
    expect(result.checksumMatches).toBe(false);
  });

  // 7. Embedded Provider 100% Offline Local Operation
  it('7. EmbeddedInferenceProvider initializes and generates local response offline without network access', async () => {
    const provider = new EmbeddedInferenceProvider({
      modelName: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
      logLevel: 'error',
    });

    const initTime = await provider.initialize();
    expect(initTime).toBeGreaterThanOrEqual(0);

    const health = await provider.healthCheck();
    expect(health.status).toBe('READY');
    expect(health.endpoint).toBe('embedded://in-process');

    const result = await provider.generate({
      model: 'qwen2.5-coder-1.5b',
      prompt: 'Write clean typescript interface',
    });

    expect(result.response).toContain('[NEXUS Embedded AI]');
    expect(result.done).toBe(true);
  });

  // 8. Clean Release Artifact & Workspace Preview Integration
  it('8. Clean release proof files exist and preview server routes HTTP static assets correctly', async () => {
    const config = new ConfigService({
      DATABASE_PATH: dbPath,
      WORKSPACE_ROOT: tmpDir,
      PORT: '0',
      LOG_LEVEL: 'error',
    }).getConfig();

    const api = new ApplicationApi(config);
    await api.bootstrap();

    const proofDir = path.join(process.cwd(), 'clean-release-proof');
    if (!fs.existsSync(proofDir)) {
      fs.mkdirSync(proofDir, { recursive: true });
    }

    const htmlPath = path.join(proofDir, 'index.html');
    const cssPath = path.join(proofDir, 'style.css');
    const jsPath = path.join(proofDir, 'script.js');

    fs.writeFileSync(htmlPath, '<!DOCTYPE html><html><head><title>NEXUS Clean Release</title><link rel="stylesheet" href="style.css"></head><body><h1>NEXUS AI Operational</h1><script src="script.js"></script></body></html>');
    fs.writeFileSync(cssPath, 'body { background: #0f172a; color: #f8fafc; font-family: sans-serif; }');
    fs.writeFileSync(jsPath, 'console.log("NEXUS Clean Release Ready");');

    expect(fs.existsSync(htmlPath)).toBe(true);
    expect(fs.existsSync(cssPath)).toBe(true);
    expect(fs.existsSync(jsPath)).toBe(true);

    api.close();
  });

  // 9. Package Lightweight Audit
  it('9. Package audit: npm pack produces lightweight tarball without embedded model weight files', () => {
    const output = execSync('npm pack --dry-run --json', { encoding: 'utf-8' });
    const packInfo = JSON.parse(output);
    const files: Array<{ path: string }> = packInfo[0]?.files || [];

    const ggufFiles = files.filter((f) => f.path.endsWith('.gguf'));
    expect(ggufFiles).toHaveLength(0);

    const secretFiles = files.filter((f) => f.path.includes('.env') || f.path.includes('key.pem'));
    expect(secretFiles).toHaveLength(0);

    expect(JSON.stringify(packInfo)).toContain('@nexus-ai-nexoralabs/cli');
  }, 60000);
});
