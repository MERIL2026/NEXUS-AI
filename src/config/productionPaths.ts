/**
 * NEXUS AI — Production Path Resolution (P7-E)
 *
 * Resolves standard user data, database, log, and workspace paths for Windows
 * desktop packaging. Separates read-only application installation files from
 * writable user data directories.
 *
 * In Production:
 *   - User Data Dir:  %APPDATA%\NEXUS AI\
 *   - Database Path:  %APPDATA%\NEXUS AI\data\nexus.sqlite
 *   - Log Directory:  %APPDATA%\NEXUS AI\logs\
 *   - Workspace Root: %USERPROFILE%\NEXUS-Workspace (User configurable)
 *
 * In Development / Test:
 *   - Uses relative fallback paths (e.g. ./data/nexus.sqlite, ./workspace)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ResolvedAppPaths {
  userDataDir: string;
  databasePath: string;
  logDir: string;
  workspaceRoot: string;
  isProduction: boolean;
}

/**
 * Returns the OS-specific base directory for user data.
 * Windows: %APPDATA%\NEXUS AI
 * Fallback: ~/.nexus-ai
 */
export function getBaseUserDataDir(env: Record<string, string | undefined> = process.env): string {
  if (env.APPDATA) {
    return path.join(env.APPDATA, 'NEXUS AI');
  }
  return path.join(os.homedir(), '.nexus-ai');
}

/**
 * Resolves all application paths based on environment and explicitly provided overrides.
 */
export function resolveProductionPaths(env: Record<string, string | undefined> = process.env): ResolvedAppPaths {
  const isExplicitNonProd = env.NODE_ENV === 'test' || env.NODE_ENV === 'development' || Boolean(env.VITEST || process.env.VITEST);
  const isProduction = env.NODE_ENV === 'production' || (!isExplicitNonProd && typeof process !== 'undefined' && (process as unknown as { defaultApp?: boolean }).defaultApp === undefined);

  const baseDir = getBaseUserDataDir(env);

  // Database path resolution
  let databasePath: string;
  if (env.DATABASE_PATH) {
    databasePath = env.DATABASE_PATH;
  } else if (isProduction) {
    databasePath = path.join(baseDir, 'data', 'nexus.sqlite');
  } else {
    databasePath = './data/nexus.sqlite';
  }

  // Log directory resolution
  let logDir: string;
  if (env.LOG_DIR) {
    logDir = env.LOG_DIR;
  } else if (isProduction) {
    logDir = path.join(baseDir, 'logs');
  } else {
    logDir = './logs';
  }

  // Workspace root resolution
  let workspaceRoot: string;
  if (env.WORKSPACE_ROOT) {
    workspaceRoot = env.WORKSPACE_ROOT;
  } else if (isProduction) {
    workspaceRoot = path.join(os.homedir(), 'NEXUS-Workspace');
  } else {
    workspaceRoot = './workspace';
  }

  // Ensure directories exist for writable production paths
  if (isProduction || env.NODE_ENV !== 'test') {
    try {
      const dbDir = path.dirname(path.resolve(databasePath));
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      const resolvedLogDir = path.resolve(logDir);
      if (!fs.existsSync(resolvedLogDir)) {
        fs.mkdirSync(resolvedLogDir, { recursive: true });
      }
    } catch {
      // Non-fatal if filesystem is read-only in specialized test runners
    }
  }

  return {
    userDataDir: baseDir,
    databasePath,
    logDir,
    workspaceRoot,
    isProduction,
  };
}
