import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config/index.js';
import { ApplicationApi } from '../api/index.js';

describe('NEXUS AI Phase P1 Application API Baseline Tests', () => {
  it('loads configuration with expected defaults', () => {
    const config = loadConfig();
    expect(config).toBeDefined();
    expect(config.port).toBeTypeOf('number');
    expect(config.ollamaHost).toBeTypeOf('string');
    expect(config.databasePath).toBeTypeOf('string');
    expect(config.environment).toBeTypeOf('string');
  });

  it('bootstraps all subsystem boundaries including SQLite persistence', async () => {
    const config = loadConfig({ DATABASE_PATH: ':memory:', LOG_LEVEL: 'error' });
    const api = new ApplicationApi(config);
    const health = await api.bootstrap();

    expect(health.overall).toBe('ok');
    expect(health.subsystems).toHaveLength(5);

    const storageStatus = health.subsystems.find((s) => s.name === 'StorageService');
    expect(storageStatus).toBeDefined();
    expect(storageStatus?.status).toBe('ok');
    expect(storageStatus?.message).toContain('v10');

    api.close();
  });
});
