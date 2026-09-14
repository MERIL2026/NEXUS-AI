import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StorageService } from '../storage/index.js';

describe('Storage & Database Health Check', () => {
  let storage: StorageService;

  beforeEach(async () => {
    storage = new StorageService(':memory:', 'error');
    await storage.initialize();
  });

  afterEach(() => {
    storage.close();
  });

  it('reports healthy status for initialized database', () => {
    const status = storage.getStatus();
    expect(status.status).toBe('ok');
    expect(status.initialized).toBe(true);

    const details = storage.getHealthDetails();
    expect(details).not.toBeNull();
    expect(details?.connected).toBe(true);
    expect(details?.ping).toBe(true);
    expect(details?.integrity).toBe('ok');
    expect(details?.schemaVersion).toBe(10);
    expect(details?.diskSpaceAccessible).toBe(true);
  });
});
