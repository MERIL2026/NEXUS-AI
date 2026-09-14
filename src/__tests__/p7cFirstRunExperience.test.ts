/**
 * NEXUS AI — P7-C First-Run Experience Test Suite
 *
 * 25 tests covering:
 *  1.  Fresh installation state (FIRST_RUN)
 *  2.  Existing configured state (READY/CONFIGURED)
 *  3.  Configuration validation — valid
 *  4.  Configuration validation — invalid PORT
 *  5.  Workspace creation on first launch
 *  6.  Workspace validation — existing, accessible
 *  7.  Workspace inaccessible
 *  8.  Workspace traversal rejection
 *  9.  Runtime ready
 * 10.  Runtime unavailable
 * 11.  No models installed
 * 12.  Primary model available
 * 13.  Primary model missing
 * 14.  Fallback model available
 * 15.  Both models unavailable → DEGRADED
 * 16.  Degraded readiness
 * 17.  Blocked readiness (workspace invalid)
 * 18.  First-run state persistence
 * 19.  Configuration version handling
 * 20.  Secret redaction (no secrets in report)
 * 21.  Consolidated health report structure
 * 22.  Security regression — path traversal
 * 23.  Repeated startup reads CONFIGURED
 * 24.  P7-A regression
 * 25.  P7-B regression
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { ConfigService, CONFIG_VERSION } from '../config/index.js';
import { WorkspaceService } from '../config/workspaceService.js';
import { FirstRunService } from '../config/firstRunService.js';
import { buildFirstRunReport } from '../config/firstRunHealthCheck.js';
import { ApplicationApi } from '../api/index.js';
import { StorageService } from '../storage/index.js';
import { OllamaRuntimeAdapter } from '../intelligence/runtime/ollamaRuntimeAdapter.js';

describe('P7-C — Configuration & First-Run Experience', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-p7c-test-'));
    dbPath = path.join(tmpDir, 'test_p7c.sqlite');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ─── 1. Fresh installation state ─────────────────────────────────────────
  it('1. Detects FIRST_RUN state on fresh install (no persisted settings)', async () => {
    const storage = new StorageService(dbPath, 'error');
    await storage.initialize();
    const svc = new FirstRunService(storage.settings, 'error');

    const state = svc.determineState({
      configOk: true,
      dbOk: true,
      workspaceOk: true,
      runtimeReady: true,
      hasUsableModel: true,
    });

    expect(state).toBe('FIRST_RUN');
    storage.close();
  });

  // ─── 2. Existing configured state ────────────────────────────────────────
  it('2. Reads READY state after first-run has been persisted', async () => {
    const storage = new StorageService(dbPath, 'error');
    await storage.initialize();
    const svc = new FirstRunService(storage.settings, 'error');

    svc.markFirstRunCompleted(tmpDir);

    const state = svc.determineState({
      configOk: true,
      dbOk: true,
      workspaceOk: true,
      runtimeReady: true,
      hasUsableModel: true,
    });

    expect(state).toBe('READY');
    storage.close();
  });

  // ─── 3. Valid configuration ────────────────────────────────────────────
  it('3. ConfigService parses valid env without error', () => {
    const config = new ConfigService({
      PORT: '3000',
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      OLLAMA_HOST: 'http://127.0.0.1:11434',
      DATABASE_PATH: dbPath,
      WORKSPACE_ROOT: tmpDir,
      PRIMARY_MODEL: 'qwen2.5:3b',
      FALLBACK_MODEL: 'deepseek-r1:8b',
    }).getConfig();

    expect(config.port).toBe(3000);
    expect(config.primaryModel).toBe('qwen2.5:3b');
    expect(config.fallbackModel).toBe('deepseek-r1:8b');
    expect(config.configVersion).toBe(CONFIG_VERSION);
  });

  // ─── 4. Invalid configuration ─────────────────────────────────────────
  it('4. ConfigService throws on invalid PORT', () => {
    expect(() => new ConfigService({ PORT: 'abc' })).toThrow(/Invalid PORT/);
  });

  // ─── 5. Workspace creation ────────────────────────────────────────────
  it('5. WorkspaceService creates workspace directory on first launch', () => {
    const newWs = path.join(tmpDir, 'new_workspace');
    expect(fs.existsSync(newWs)).toBe(false);

    const svc = new WorkspaceService('error');
    const result = svc.initializeWorkspace(newWs);

    expect(result.state).toBe('WORKSPACE_CREATED');
    expect(result.existed).toBe(false);
    expect(result.readable).toBe(true);
    expect(result.writable).toBe(true);
    expect(fs.existsSync(newWs)).toBe(true);
  });

  // ─── 6. Workspace validation — existing ───────────────────────────────
  it('6. WorkspaceService reports WORKSPACE_READY for existing accessible directory', () => {
    const svc = new WorkspaceService('error');
    const result = svc.validateWorkspace(tmpDir);

    expect(result.state).toBe('WORKSPACE_READY');
    expect(result.readable).toBe(true);
    expect(result.writable).toBe(true);
    expect(result.existed).toBe(true);
  });

  // ─── 7. Workspace not accessible ──────────────────────────────────────
  it('7. WorkspaceService reports WORKSPACE_NOT_ACCESSIBLE for non-existing path (validate only)', () => {
    const svc = new WorkspaceService('error');
    const result = svc.validateWorkspace(path.join(tmpDir, 'does_not_exist'));

    expect(result.state).toBe('WORKSPACE_NOT_ACCESSIBLE');
    expect(result.readable).toBe(false);
  });

  // ─── 8. Workspace traversal rejection ─────────────────────────────────
  it('8. WorkspaceService rejects path with traversal segments', () => {
    const svc = new WorkspaceService('error');
    // Use raw string with .. preserved — NOT path.join which would resolve them away
    const traversalPath = tmpDir + '/../../etc/passwd';
    const result = svc.initializeWorkspace(traversalPath);

    expect(result.state).toBe('WORKSPACE_INVALID');
    expect(result.reason).toContain('traversal');
  });

  // ─── 9. Runtime ready ─────────────────────────────────────────────────
  it('9. FirstRunService determines READY when runtime is healthy', async () => {
    const storage = new StorageService(dbPath, 'error');
    await storage.initialize();
    const svc = new FirstRunService(storage.settings, 'error');
    svc.markFirstRunCompleted(tmpDir);

    const state = svc.determineState({
      configOk: true,
      dbOk: true,
      workspaceOk: true,
      runtimeReady: true,
      hasUsableModel: true,
    });
    expect(state).toBe('READY');
    storage.close();
  });

  // ─── 10. Runtime unavailable ──────────────────────────────────────────
  it('10. OllamaRuntimeAdapter reports UNREACHABLE on offline port', async () => {
    const adapter = new OllamaRuntimeAdapter('http://127.0.0.1:59999', 'error');
    const health = await adapter.checkHealth(500);
    expect(health.status).toBe('UNREACHABLE');
    expect(health.suggestedAction).toBeDefined();
  });

  // ─── 11. No models installed ──────────────────────────────────────────
  it('11. FirstRunService determines DEGRADED when no models are available', async () => {
    const storage = new StorageService(dbPath, 'error');
    await storage.initialize();
    const svc = new FirstRunService(storage.settings, 'error');
    svc.markFirstRunCompleted(tmpDir);

    const state = svc.determineState({
      configOk: true,
      dbOk: true,
      workspaceOk: true,
      runtimeReady: true,
      hasUsableModel: false,
    });
    expect(state).toBe('DEGRADED');
    storage.close();
  });

  // ─── 12. Primary model available ──────────────────────────────────────
  it('12. FirstRunReport marks Primary Model OK when model is READY', () => {
    const report = buildFirstRunReport({
      configOk: true,
      storageStatus: { name: 'StorageService', initialized: true, status: 'ok' },
      workspaceResult: { state: 'WORKSPACE_READY', canonicalPath: tmpDir, existed: true, readable: true, writable: true },
      runtimeHealth: { providerId: 'ollama', status: 'READY', endpoint: 'http://127.0.0.1:11434', version: '0.3.0', timestamp: '' },
      availableModelIds: ['qwen2.5:3b'],
      primaryModelId: 'qwen2.5:3b',
      primaryModelReadiness: 'MODEL_READY',
      toolGatewayStatus: { name: 'ToolGateway', initialized: true, status: 'ok' },
      orchestratorStatus: { name: 'Orchestrator', initialized: true, status: 'ok' },
      knowledgeStatus: { name: 'KnowledgeEngine', initialized: true, status: 'ok' },
      firstRunState: 'READY',
    });

    const primaryCheck = report.checks.find((c) => c.name === 'Primary Model');
    expect(primaryCheck?.status).toBe('OK');
    expect(primaryCheck?.detail).toContain('qwen2.5:3b');
  });

  // ─── 13. Primary model missing ────────────────────────────────────────
  it('13. FirstRunReport marks Primary Model FAIL when model is NOT_INSTALLED', () => {
    const report = buildFirstRunReport({
      configOk: true,
      storageStatus: { name: 'StorageService', initialized: true, status: 'ok' },
      workspaceResult: { state: 'WORKSPACE_READY', canonicalPath: tmpDir, existed: true, readable: true, writable: true },
      runtimeHealth: { providerId: 'ollama', status: 'READY', endpoint: '', timestamp: '' },
      availableModelIds: [],
      primaryModelId: 'missing-model:7b',
      primaryModelReadiness: 'MODEL_NOT_INSTALLED',
      toolGatewayStatus: { name: 'ToolGateway', initialized: true, status: 'ok' },
      orchestratorStatus: { name: 'Orchestrator', initialized: true, status: 'ok' },
      knowledgeStatus: { name: 'KnowledgeEngine', initialized: true, status: 'ok' },
      firstRunState: 'DEGRADED',
    });

    const primaryCheck = report.checks.find((c) => c.name === 'Primary Model');
    expect(primaryCheck?.status).toBe('FAIL');
    expect(primaryCheck?.action).toContain('ollama pull missing-model:7b');
  });

  // ─── 14. Fallback model available ─────────────────────────────────────
  it('14. FirstRunReport marks Fallback Model OK when model is READY', () => {
    const report = buildFirstRunReport({
      configOk: true,
      storageStatus: { name: 'StorageService', initialized: true, status: 'ok' },
      workspaceResult: { state: 'WORKSPACE_READY', canonicalPath: tmpDir, existed: true, readable: true, writable: true },
      runtimeHealth: { providerId: 'ollama', status: 'READY', endpoint: '', timestamp: '' },
      availableModelIds: ['qwen2.5:3b', 'deepseek-r1:8b'],
      primaryModelId: 'qwen2.5:3b',
      primaryModelReadiness: 'MODEL_READY',
      fallbackModelId: 'deepseek-r1:8b',
      fallbackModelReadiness: 'MODEL_READY',
      toolGatewayStatus: { name: 'ToolGateway', initialized: true, status: 'ok' },
      orchestratorStatus: { name: 'Orchestrator', initialized: true, status: 'ok' },
      knowledgeStatus: { name: 'KnowledgeEngine', initialized: true, status: 'ok' },
      firstRunState: 'READY',
    });

    const fallbackCheck = report.checks.find((c) => c.name === 'Fallback Model');
    expect(fallbackCheck?.status).toBe('OK');
    expect(fallbackCheck?.detail).toContain('deepseek-r1:8b');
  });

  // ─── 15. Both models unavailable → DEGRADED ───────────────────────────
  it('15. FirstRunService returns DEGRADED when both primary and fallback are unavailable', async () => {
    const storage = new StorageService(dbPath, 'error');
    await storage.initialize();
    const svc = new FirstRunService(storage.settings, 'error');
    svc.markFirstRunCompleted(tmpDir);

    const state = svc.determineState({
      configOk: true,
      dbOk: true,
      workspaceOk: true,
      runtimeReady: false,
      hasUsableModel: false,
    });
    expect(state).toBe('DEGRADED');
    storage.close();
  });

  // ─── 16. Degraded readiness ───────────────────────────────────────────
  it('16. FirstRunReport state is DEGRADED when runtime is UNREACHABLE', () => {
    const report = buildFirstRunReport({
      configOk: true,
      storageStatus: { name: 'StorageService', initialized: true, status: 'ok' },
      workspaceResult: { state: 'WORKSPACE_READY', canonicalPath: tmpDir, existed: true, readable: true, writable: true },
      runtimeHealth: {
        providerId: 'ollama',
        status: 'UNREACHABLE',
        endpoint: 'http://127.0.0.1:59999',
        reason: 'ECONNREFUSED',
        suggestedAction: 'Start the local Ollama runtime process',
        timestamp: '',
      },
      availableModelIds: [],
      toolGatewayStatus: { name: 'ToolGateway', initialized: true, status: 'ok' },
      orchestratorStatus: { name: 'Orchestrator', initialized: true, status: 'ok' },
      knowledgeStatus: { name: 'KnowledgeEngine', initialized: true, status: 'ok' },
      firstRunState: 'DEGRADED',
    });

    expect(report.state).toBe('DEGRADED');
    const runtimeCheck = report.checks.find((c) => c.name === 'AI Runtime');
    expect(runtimeCheck?.status).toBe('DEGRADED');
    expect(runtimeCheck?.action).toContain('Ollama runtime');
  });

  // ─── 17. Blocked readiness ────────────────────────────────────────────
  it('17. FirstRunService returns BLOCKED when workspace is invalid', async () => {
    const storage = new StorageService(dbPath, 'error');
    await storage.initialize();
    const svc = new FirstRunService(storage.settings, 'error');

    const state = svc.determineState({
      configOk: true,
      dbOk: true,
      workspaceOk: false,
      runtimeReady: true,
      hasUsableModel: true,
    });
    expect(state).toBe('BLOCKED');
    storage.close();
  });

  // ─── 18. First-run state persistence ─────────────────────────────────
  it('18. First-run completion persists across instantiations of FirstRunService', async () => {
    const storage = new StorageService(dbPath, 'error');
    await storage.initialize();

    const svc1 = new FirstRunService(storage.settings, 'error');
    expect(svc1.readPersistence().firstRunCompleted).toBe(false);

    svc1.markFirstRunCompleted(tmpDir);

    const svc2 = new FirstRunService(storage.settings, 'error');
    const persisted = svc2.readPersistence();
    expect(persisted.firstRunCompleted).toBe(true);
    expect(persisted.workspacePath).toBe(tmpDir);
    expect(persisted.configVersion).toBe(CONFIG_VERSION);
    storage.close();
  });

  // ─── 19. Configuration version handling ───────────────────────────────
  it('19. Detects PARTIALLY_CONFIGURED when stored configVersion is older than current', async () => {
    const storage = new StorageService(dbPath, 'error');
    await storage.initialize();

    // Manually store an older config version
    storage.settings.set('nexus.firstrun.completed', 'true');
    storage.settings.set('nexus.config.version', '0'); // older than CONFIG_VERSION (1)

    const svc = new FirstRunService(storage.settings, 'error');
    const state = svc.determineState({
      configOk: true,
      dbOk: true,
      workspaceOk: true,
      runtimeReady: true,
      hasUsableModel: true,
    });
    expect(state).toBe('PARTIALLY_CONFIGURED');
    storage.close();
  });

  // ─── 20. Secret redaction ─────────────────────────────────────────────
  it('20. FirstRunReport does not expose environment variables or secrets', () => {
    const report = buildFirstRunReport({
      configOk: true,
      storageStatus: { name: 'StorageService', initialized: true, status: 'ok' },
      workspaceResult: { state: 'WORKSPACE_READY', canonicalPath: tmpDir, existed: true, readable: true, writable: true },
      runtimeHealth: { providerId: 'ollama', status: 'READY', endpoint: 'http://127.0.0.1:11434', version: '0.3.0', timestamp: '' },
      availableModelIds: ['qwen2.5:3b'],
      toolGatewayStatus: { name: 'ToolGateway', initialized: true, status: 'ok' },
      orchestratorStatus: { name: 'Orchestrator', initialized: true, status: 'ok' },
      knowledgeStatus: { name: 'KnowledgeEngine', initialized: true, status: 'ok' },
      firstRunState: 'READY',
    });

    const reportStr = JSON.stringify(report);
    // Confirm no env var names, API key patterns, or password fields appear
    expect(reportStr).not.toContain('process.env');
    expect(reportStr).not.toContain('API_KEY');
    expect(reportStr).not.toContain('password');
    expect(reportStr).not.toContain('token');
    expect(reportStr).not.toContain('secret');
  });

  // ─── 21. Consolidated health report structure ─────────────────────────
  it('21. FirstRunReport contains all 9 required checks', () => {
    const report = buildFirstRunReport({
      configOk: true,
      storageStatus: { name: 'StorageService', initialized: true, status: 'ok' },
      workspaceResult: { state: 'WORKSPACE_READY', canonicalPath: tmpDir, existed: true, readable: true, writable: true },
      runtimeHealth: { providerId: 'ollama', status: 'READY', endpoint: '', timestamp: '' },
      availableModelIds: ['qwen2.5:3b', 'deepseek-r1:8b'],
      primaryModelReadiness: 'MODEL_READY',
      fallbackModelReadiness: 'MODEL_READY',
      toolGatewayStatus: { name: 'ToolGateway', initialized: true, status: 'ok' },
      orchestratorStatus: { name: 'Orchestrator', initialized: true, status: 'ok' },
      knowledgeStatus: { name: 'KnowledgeEngine', initialized: true, status: 'ok' },
      firstRunState: 'READY',
    });

    const checkNames = report.checks.map((c) => c.name);
    expect(checkNames).toContain('Configuration');
    expect(checkNames).toContain('Database');
    expect(checkNames).toContain('Workspace');
    expect(checkNames).toContain('AI Runtime');
    expect(checkNames).toContain('Primary Model');
    expect(checkNames).toContain('Fallback Model');
    expect(checkNames).toContain('ToolGateway');
    expect(checkNames).toContain('Orchestrator');
    expect(checkNames).toContain('Knowledge Engine');
    expect(report.checks).toHaveLength(9);
  });

  // ─── 22. Security regression — path traversal ─────────────────────────
  it('22. ApplicationApi.validateWorkspace rejects traversal paths', async () => {
    const config = new ConfigService({
      DATABASE_PATH: dbPath,
      WORKSPACE_ROOT: tmpDir,
      LOG_LEVEL: 'error',
    }).getConfig();

    const appApi = new ApplicationApi(config);
    // Use raw string with .. preserved — NOT path.join which would resolve them away
    const result = appApi.validateWorkspace(tmpDir + '/../../etc/passwd');

    expect(result.state).toBe('WORKSPACE_INVALID');
    expect(result.reason).toContain('traversal');
  });

  // ─── 23. Repeated startup reads CONFIGURED ────────────────────────────
  it('23. Repeated startup returns READY after first-run is persisted', async () => {
    const storage = new StorageService(dbPath, 'error');
    await storage.initialize();
    const svc = new FirstRunService(storage.settings, 'error');

    // First run
    svc.markFirstRunCompleted(tmpDir);

    // Second run (same db)
    const state = svc.determineState({
      configOk: true,
      dbOk: true,
      workspaceOk: true,
      runtimeReady: true,
      hasUsableModel: true,
    });
    expect(state).toBe('READY');
    storage.close();
  });

  // ─── 24. P7-A regression ─────────────────────────────────────────────
  it('24. P7-A: ApplicationApi startup crash recovery still works after P7-C changes', async () => {
    const config = new ConfigService({
      DATABASE_PATH: dbPath,
      WORKSPACE_ROOT: tmpDir,
      LOG_LEVEL: 'error',
    }).getConfig();

    const appApi = new ApplicationApi(config);
    await appApi.bootstrap();

    // Transition task through state machine to 'executing' to simulate mid-run crash
    const task = appApi.tasks.createTask({ title: 'P7-A Regression Task' });
    appApi.tasks.transitionTask(task.id, { targetState: 'planning' });
    appApi.tasks.transitionTask(task.id, { targetState: 'executing' });

    appApi.close();

    // Second bootstrap — crash recovery should transition the task to failed
    const appApi2 = new ApplicationApi(config);
    await appApi2.bootstrap();

    const recovered = appApi2.tasks.getTask(task.id);
    expect(recovered?.state).toBe('failed');
    appApi2.close();
  });

  // ─── 25. P7-B regression ─────────────────────────────────────────────
  it('25. P7-B: ApplicationApi bootstraps in DEGRADED mode when Ollama is offline', async () => {
    const config = new ConfigService({
      DATABASE_PATH: dbPath,
      WORKSPACE_ROOT: tmpDir,
      OLLAMA_HOST: 'http://127.0.0.1:59999',
      NEXUS_INFERENCE_PROVIDER: 'ollama',
      LOG_LEVEL: 'error',
    }).getConfig();

    const appApi = new ApplicationApi(config);
    const health = await appApi.bootstrap();

    expect(health.overall).toBe('degraded');
    const intelSub = health.subsystems.find((s) => s.name === 'IntelligenceService');
    expect(intelSub?.status).toBe('degraded');
    expect(intelSub?.details?.ollamaAvailable).toBe(false);

    // Workspace and storage should still be functional
    const task = appApi.tasks.createTask({ title: 'Degraded Mode Regression' });
    expect(task.id).toBeDefined();

    appApi.close();
  });
});
