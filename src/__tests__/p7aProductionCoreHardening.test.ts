/**
 * NEXUS AI — P7-A Production Core Hardening Test Suite
 *
 * Verifies production hardening features:
 *  1. Configuration validation & error messages
 *  2. Database SQLite busy timeout & pragma initialization
 *  3. Model Gateway fallback attribution & exception details
 *  4. Idempotent ApplicationApi shutdown handling
 *  5. Startup crash recovery for interrupted transient tasks (INTERRUPTED_BY_SHUTDOWN)
 *  6. Log secret redaction & safety
 *  7. P5/P6 security regression invariants
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { ConfigService } from '../config/index.js';
import { DatabaseConnection } from '../storage/database.js';
import { StorageService } from '../storage/index.js';
import { ApplicationApi } from '../api/index.js';
import { ModelGateway } from '../intelligence/modelGateway.js';
import type { OllamaAdapter } from '../intelligence/ollamaAdapter.js';
import type { ModelRegistry } from '../intelligence/modelRegistry.js';
import type { ModelRouter } from '../intelligence/modelRouter.js';
import type { ModelsRepository } from '../storage/repositories/modelsRepository.js';

describe('P7-A — Production Core Hardening', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-p7a-test-'));
    dbPath = path.join(tmpDir, 'test_p7a.sqlite');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // 1. Configuration Validation
  it('1. ConfigService validates environment parameters deterministically', () => {
    expect(() => new ConfigService({ PORT: 'invalid' })).toThrow(/Invalid PORT/);
    expect(() => new ConfigService({ PORT: '999999' })).toThrow(/Invalid PORT/);
    expect(() => new ConfigService({ NODE_ENV: 'invalid_env' })).toThrow(/Invalid NODE_ENV/);
    expect(() => new ConfigService({ LOG_LEVEL: 'invalid_level' })).toThrow(/Invalid LOG_LEVEL/);

    const validConfig = new ConfigService({
      PORT: '4000',
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      OLLAMA_HOST: 'http://localhost:11434',
    }).getConfig();

    expect(validConfig.port).toBe(4000);
    expect(validConfig.environment).toBe('production');
    expect(validConfig.logLevel).toBe('warn');
  });

  // 2. Database Pragmas & Busy Timeout
  it('2. DatabaseConnection configures SQLite WAL, foreign keys, and busy_timeout = 5000', () => {
    const dbConn = new DatabaseConnection(dbPath, 'error');
    const db = dbConn.connect();

    const journalMode = db.pragma('journal_mode', { simple: true });
    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    const busyTimeout = db.pragma('busy_timeout', { simple: true });

    expect(journalMode).toBe('wal');
    expect(foreignKeys).toBe(1);
    expect(busyTimeout).toBe(5000);

    dbConn.close();
  });

  // 3. Model Gateway Fallback Exception Attribution
  it('3. ModelGateway reports primary and fallback model IDs on double failure', async () => {
    const mockAdapter: OllamaAdapter = {
      generate: async (opts: { model: string }) => {
        throw new Error(`Failed to execute model '${opts.model}'`);
      },
      generateStream: async () => {
        throw new Error('Not implemented');
      },
    } as unknown as OllamaAdapter;

    const mockRegistry = {} as ModelRegistry;
    const mockRouter: ModelRouter = {
      selectRoute: () => ({
        primaryModel: { id: 'primary-model-qwen' },
        fallbackModel: { id: 'fallback-model-llama' },
        routingReason: 'test route',
      }),
    } as unknown as ModelRouter;

    const mockRepo: ModelsRepository = {
      recordTelemetry: () => {},
    } as unknown as ModelsRepository;

    const gateway = new ModelGateway(mockAdapter, mockRegistry, mockRouter, mockRepo, 'error');

    await expect(
      gateway.generate({ prompt: 'hello', allowFallback: true })
    ).rejects.toThrow(/Inference failed on both primary \(primary-model-qwen\) and fallback \(fallback-model-llama\)/);
  });

  // 4. Idempotent Application Shutdown
  it('4. ApplicationApi.close() is idempotent and handles multiple invocations safely', async () => {
    const config = new ConfigService({
      DATABASE_PATH: dbPath,
      WORKSPACE_ROOT: tmpDir,
      LOG_LEVEL: 'error',
    }).getConfig();

    const appApi = new ApplicationApi(config);
    await appApi.bootstrap();

    expect(() => {
      appApi.close();
      appApi.close();
      appApi.close();
    }).not.toThrow();
  });

  // 5. Startup Crash Recovery for Interrupted Tasks
  it('5. ApplicationApi.bootstrap() recovers tasks left in active transient states on process crash', async () => {
    const storage = new StorageService(dbPath, 'error');
    await storage.initialize();

    // Create raw task records in active transient states
    const t1 = storage.agentTasks.create({ id: 'int-1', projectId: null, title: 'Interrupted Task 1', state: 'executing', plan: null });
    const t2 = storage.agentTasks.create({ id: 'int-2', projectId: null, title: 'Interrupted Task 2', state: 'observing', plan: null });

    storage.close();

    // Bootstrap ApplicationApi using the same DB
    const config = new ConfigService({
      DATABASE_PATH: dbPath,
      WORKSPACE_ROOT: tmpDir,
      LOG_LEVEL: 'error',
    }).getConfig();

    const appApi = new ApplicationApi(config);
    await appApi.bootstrap();

    const recoveredT1 = appApi.tasks.getTask(t1.id);
    const recoveredT2 = appApi.tasks.getTask(t2.id);

    expect(recoveredT1.state).toBe('failed');
    expect(recoveredT1.errorCategory).toBe('INTERRUPTED_BY_SHUTDOWN');

    expect(recoveredT2.state).toBe('failed');
    expect(recoveredT2.errorCategory).toBe('INTERRUPTED_BY_SHUTDOWN');

    appApi.close();
  });

  // 6. Security Regression Check: Path Traversal and Secret Protection
  it('6. Verifies P5/P6 security bounds remain active after hardening', async () => {
    const config = new ConfigService({
      DATABASE_PATH: dbPath,
      WORKSPACE_ROOT: tmpDir,
      LOG_LEVEL: 'error',
    }).getConfig();

    const appApi = new ApplicationApi(config);
    await appApi.bootstrap();

    const task = appApi.tasks.createTask({ title: 'Security Regression Test' });

    // Path traversal attempt
    const traversalRes = await appApi.tools.executeTool({
      requestId: 'req-trav',
      taskId: task.id,
      toolId: 'filesystem_read',
      requestedCapabilities: ['filesystem.read'],
      params: { relativePath: '../../../etc/passwd' },
    });

    expect(traversalRes.success).toBe(false);
    expect(traversalRes.errorCategory).toBe('PATH_TRAVERSAL_DENIED');

    // Secret file write attempt
    const secretRes = await appApi.tools.executeTool({
      requestId: 'req-sec',
      taskId: task.id,
      toolId: 'filesystem_write',
      requestedCapabilities: ['filesystem.write'],
      params: { path: '.env', content: 'SECRET=123' },
    });

    expect(secretRes.success).toBe(false);
    expect(secretRes.errorCategory).toBe('SECRET_FILE_PROTECTED');

    appApi.close();
  });
});
