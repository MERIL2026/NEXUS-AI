import { describe, it, expect } from 'vitest';
import { ConfigService, loadConfig } from '../config/index.js';

describe('ConfigService', () => {
  it('loads valid configuration with environment variable defaults', () => {
    const config = loadConfig({
      PORT: '4000',
      NODE_ENV: 'test',
      OLLAMA_HOST: 'http://localhost:11434',
      DATABASE_PATH: ':memory:',
      LOG_LEVEL: 'debug',
    });

    expect(config.port).toBe(4000);
    expect(config.environment).toBe('test');
    expect(config.ollamaHost).toBe('http://localhost:11434');
    expect(config.databasePath).toBe(':memory:');
    expect(config.logLevel).toBe('debug');
  });

  it('throws error on invalid port configuration', () => {
    expect(() => new ConfigService({ PORT: 'invalid_port' })).toThrow(/Invalid PORT/);
    expect(() => new ConfigService({ PORT: '70000' })).toThrow(/Invalid PORT/);
  });

  it('throws error on invalid environment configuration', () => {
    expect(() => new ConfigService({ NODE_ENV: 'staging' })).toThrow(/Invalid NODE_ENV/);
  });

  it('throws error on invalid log level configuration', () => {
    expect(() => new ConfigService({ LOG_LEVEL: 'verbose' })).toThrow(/Invalid LOG_LEVEL/);
  });
});
