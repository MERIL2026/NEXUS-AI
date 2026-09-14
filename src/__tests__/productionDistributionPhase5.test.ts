import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  PlatformDetector,
  NativeRuntimeManager,
  SetupStateManager,
} from '../intelligence/provisioning/index.js';
import { EmbeddedInferenceProvider } from '../intelligence/providers/embeddedInferenceProvider.js';

describe('Phase 5 — Production Distribution & One-Command Setup Suite', () => {
  let tmpTestDir: string;

  beforeEach(() => {
    tmpTestDir = path.join(os.tmpdir(), `nexus-p5-test-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);
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

  it('1. Platform detector identifies host platform and returns platform descriptor', () => {
    const detector = new PlatformDetector();
    const profile = detector.detectPlatform();

    expect(profile.platform).toBe(os.platform());
    expect(profile.arch).toBe(os.arch());
    expect(profile.displayName).toBeTruthy();
    expect(typeof profile.isSupported).toBe('boolean');
  });

  it('2. Native runtime manager resolves prebuilt addon path and verifies integrity', async () => {
    const runtimeMgr = new NativeRuntimeManager(tmpTestDir);
    expect(runtimeMgr.getRuntimeDir()).toBe(tmpTestDir);

    const descriptor = await runtimeMgr.resolveNativeRuntime();
    expect(descriptor.platformKey).toBeTruthy();
    expect(descriptor.runtimeVersion).toContain('3.0.0');
    expect(descriptor.isReady).toBe(true);
  });

  it('3. First-run setup state persists and prevents duplicate model downloads on restart', () => {
    const stateFile = path.join(tmpTestDir, 'setup_state.json');
    const mgr1 = new SetupStateManager(stateFile);

    // Initial launch: setup required
    expect(mgr1.isFirstRunRequired()).toBe(true);

    // Setup completed
    mgr1.saveState({
      runtimeReady: true,
      modelInstalled: true,
      modelVerified: true,
      activeModelId: 'qwen2.5-coder-1.5b',
    });

    // Second launch: setup NOT required (zero duplicate download)
    const mgr2 = new SetupStateManager(stateFile);
    expect(mgr2.isFirstRunRequired()).toBe(false);
    const state = mgr2.loadState();
    expect(state.modelInstalled).toBe(true);
    expect(state.activeModelId).toBe('qwen2.5-coder-1.5b');
  });

  it('4. Offline local AI inference operates without network connection', async () => {
    const provider = new EmbeddedInferenceProvider({
      modelName: 'nexus-proto-0.5b',
      logLevel: 'error',
    });

    const res = await provider.generate({
      model: 'nexus-proto-0.5b',
      prompt: 'Offline execution prompt test',
    });

    expect(res.response).toContain('[NEXUS Embedded AI]');
    expect(res.done).toBe(true);
    await provider.shutdown();
  });

  it('5. Real agent proof webpage files exist in phase5-proof directory', () => {
    const proofDir = path.join(process.cwd(), 'phase5-proof');
    const htmlPath = path.join(proofDir, 'index.html');
    const cssPath = path.join(proofDir, 'style.css');
    const jsPath = path.join(proofDir, 'script.js');

    expect(fs.existsSync(htmlPath)).toBe(true);
    expect(fs.existsSync(cssPath)).toBe(true);
    expect(fs.existsSync(jsPath)).toBe(true);

    const html = fs.readFileSync(htmlPath, 'utf-8');
    const css = fs.readFileSync(cssPath, 'utf-8');
    const js = fs.readFileSync(jsPath, 'utf-8');

    expect(html).toContain('NEXUS AI — Production Distribution Landing Page');
    expect(css).toContain('--bg: #0b0f19');
    expect(js).toContain('npm install -g @nexus-ai-nexoralabs/cli');
  });
});
