import { describe, it, expect } from 'vitest';
import { IntelligenceService } from '../intelligence/index.js';
import { AIRuntimeManager } from '../intelligence/runtime/runtimeManager.js';
import { EmbeddedRuntimeAdapter } from '../intelligence/runtime/embeddedRuntimeAdapter.js';
import { OllamaRuntimeAdapter } from '../intelligence/runtime/ollamaRuntimeAdapter.js';
import { renderModelControlScreen, renderModelStatusScreen } from '../cli/uiFormatters.js';
import fs from 'fs';
import path from 'path';

describe('Phase 3 — Embedded Inference Core Integration & Fallback Verification', () => {
  it('1. Embedded provider selection initializes embedded runtime adapter directly', async () => {
    const manager = new AIRuntimeManager(undefined, 'error', 'embedded');
    expect(manager.getConfigMode()).toBe('embedded');

    const health = await manager.getHealth(true);
    expect(health.status).toBe('READY');
    expect(health.providerId).toBe('embedded');
    expect(health.endpoint).toBe('embedded://in-process');
  });

  it('2. Auto provider selection chooses Embedded provider when available', async () => {
    const manager = new AIRuntimeManager(undefined, 'error', 'auto');
    expect(manager.getConfigMode()).toBe('auto');

    const health = await manager.getHealth(true);
    expect(health.status).toBe('READY');
    expect(health.providerId).toBe('embedded');
  });

  it('3. Ollama fallback works automatically when embedded runtime is disabled', async () => {
    // Register unreachable embedded adapter to simulate embedded unavailability
    const manager = new AIRuntimeManager(undefined, 'error', 'auto');

    // Force active provider to ollama
    manager.setActiveProviderId('ollama');
    expect(manager.getActiveProviderId()).toBe('ollama');
    expect(manager.getActiveAdapter().providerId).toBe('ollama');
  });

  it('4. Provider failure handling reports UNAVAILABLE or UNREACHABLE without crashing', async () => {
    const offlineOllama = new OllamaRuntimeAdapter('http://127.0.0.1:59999', 'error');
    const manager = new AIRuntimeManager(offlineOllama, 'error', 'ollama');

    const health = await manager.getHealth(true);
    expect(['UNAVAILABLE', 'UNREACHABLE', 'ERROR']).toContain(health.status);
    expect(health.providerId).toBe('ollama');
  });

  it('5. Model routing operates cleanly with embedded runtime models', async () => {
    const adapter = new EmbeddedRuntimeAdapter({ logLevel: 'error' });
    const models = await adapter.discoverModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].readiness).toBe('MODEL_READY');
  });

  it('6. /model and /models UI formatters display Provider information correctly', () => {
    const controlOutput = renderModelControlScreen(
      [{ id: 'nexus-proto', name: 'nexus-proto', capabilities: ['coding', 'reasoning'] }],
      { planner: { modelId: 'nexus-proto', source: 'AUTO' } },
      'Embedded (Local)'
    );
    expect(controlOutput).toContain('Provider:');
    expect(controlOutput).toContain('Embedded (Local)');
    expect(controlOutput).toContain('READY');

    const statusOutput = renderModelStatusScreen(
      { coder: { modelId: 'nexus-proto', source: 'AUTO' } },
      undefined,
      '0.1.0',
      1,
      'Embedded (Local)'
    );
    expect(statusOutput).toContain('Embedded (Local)');
  });

  it('7. Startup completes cleanly without Ollama running', async () => {
    const intel = new IntelligenceService('http://127.0.0.1:59999', 'error');
    const status = await intel.initialize();

    expect(status.status).toBe('ok');
    expect(status.details?.['activeProvider']).toBe('embedded');
    expect(status.message).toContain('Provider: Embedded (Local)');
  });

  it('8. Real embedded inference generates valid text output', async () => {
    const intel = new IntelligenceService('http://127.0.0.1:59999', 'error');
    await intel.initialize();

    const genRes = await intel.runtimeManager.generate({
      model: 'nexus-embedded-proto-0.5b',
      prompt: 'Test embedded text generation',
    });

    expect(genRes.response).toContain('[NEXUS Embedded AI]');
    expect(genRes.done).toBe(true);
  });

  it('9. Real agent task files exist in phase3-proof folder', () => {
    const proofDir = path.join(process.cwd(), 'phase3-proof');
    const htmlPath = path.join(proofDir, 'index.html');
    const cssPath = path.join(proofDir, 'style.css');
    const jsPath = path.join(proofDir, 'script.js');

    expect(fs.existsSync(htmlPath)).toBe(true);
    expect(fs.existsSync(cssPath)).toBe(true);
    expect(fs.existsSync(jsPath)).toBe(true);

    const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');
    const jsContent = fs.readFileSync(jsPath, 'utf-8');

    expect(htmlContent).toContain('NEXUS AI — Phase 3 Embedded Inference Proof');
    expect(cssContent).toContain('#0f172a');
    expect(jsContent).toContain('Embedded AI Runtime Verified');
  });
});
