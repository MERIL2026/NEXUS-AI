import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseConnection } from '../storage/database.js';
import { MigrationRunner } from '../storage/migration.js';
import type { Database } from 'better-sqlite3';

describe('DatabaseConnection & MigrationRunner', () => {
  let dbConn: DatabaseConnection;
  let db: Database;

  beforeEach(() => {
    dbConn = new DatabaseConnection(':memory:', 'error');
    db = dbConn.connect();
  });

  afterEach(() => {
    dbConn.close();
  });

  it('connects to in-memory database and executes query', () => {
    const row = db.prepare('SELECT 1 + 1 as result').get() as { result: number };
    expect(row.result).toBe(2);
  });

  it('runs migrations and tracks current version', () => {
    const runner = new MigrationRunner(db, 'error');
    expect(runner.getCurrentVersion()).toBe(0);

    runner.runMigrations();
    expect(runner.getCurrentVersion()).toBe(10);

    // Running migrations again should be idempotent
    runner.runMigrations();
    expect(runner.getCurrentVersion()).toBe(10);
  });
});
