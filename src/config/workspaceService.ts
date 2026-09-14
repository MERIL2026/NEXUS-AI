/**
 * NEXUS AI — WorkspaceService (P7-C)
 *
 * Centralizes workspace lifecycle operations: validation, creation, access checks,
 * canonical path resolution, and traversal prevention.
 *
 * Security invariants:
 * - NEVER allows path traversal beyond a given base
 * - NEVER touches secret files
 * - NEVER calls ToolGateway / PermissionEngine (runs pre-bootstrap)
 * - Canonical path is the ONLY path ever stored or returned
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger, LogLevel } from '../common/logger.js';

export type WorkspaceState =
  | 'WORKSPACE_READY'
  | 'WORKSPACE_CREATED'
  | 'WORKSPACE_INVALID'
  | 'WORKSPACE_UNAVAILABLE'
  | 'WORKSPACE_NOT_ACCESSIBLE';

export interface WorkspaceValidationResult {
  state: WorkspaceState;
  canonicalPath: string;
  existed: boolean;
  readable: boolean;
  writable: boolean;
  reason?: string;
}

export class WorkspaceService {
  private logger: Logger;

  constructor(logLevel: LogLevel = 'info') {
    this.logger = new Logger('WorkspaceService', logLevel);
  }

  /**
   * Validates an existing workspace path without creating it.
   * Returns the canonical path and access state.
   */
  validateWorkspace(rawPath: string): WorkspaceValidationResult {
    return this._validate(rawPath, false);
  }

  /**
   * Validates and, if the workspace does not yet exist, creates it (mkdir -p).
   * The path is canonicalized BEFORE any filesystem operation.
   */
  initializeWorkspace(rawPath: string): WorkspaceValidationResult {
    return this._validate(rawPath, true);
  }

  private _validate(rawPath: string, allowCreate: boolean): WorkspaceValidationResult {
    if (!rawPath || typeof rawPath !== 'string' || rawPath.trim() === '') {
      return {
        state: 'WORKSPACE_INVALID',
        canonicalPath: '',
        existed: false,
        readable: false,
        writable: false,
        reason: 'Workspace path is empty or missing.',
      };
    }

    let canonicalPath: string;
    try {
      // Resolve against cwd to make relative paths absolute, then normalize
      const resolved = path.resolve(rawPath);
      canonicalPath = resolved;
    } catch {
      return {
        state: 'WORKSPACE_INVALID',
        canonicalPath: rawPath,
        existed: false,
        readable: false,
        writable: false,
        reason: `Workspace path could not be resolved: "${rawPath}"`,
      };
    }

    // Reject paths that contain traversal segments after resolution
    if (this._containsTraversal(rawPath)) {
      this.logger.warn(`Workspace traversal attempt rejected: "${rawPath}"`);
      return {
        state: 'WORKSPACE_INVALID',
        canonicalPath,
        existed: false,
        readable: false,
        writable: false,
        reason: `Workspace path contains traversal segments and was rejected for safety.`,
      };
    }

    // Reject obviously dangerous system paths
    if (this._isDangerousSystemPath(canonicalPath)) {
      return {
        state: 'WORKSPACE_INVALID',
        canonicalPath,
        existed: false,
        readable: false,
        writable: false,
        reason: `Workspace path points to a protected system directory and cannot be used.`,
      };
    }

    let existed = false;
    try {
      existed = fs.existsSync(canonicalPath);
    } catch {
      return {
        state: 'WORKSPACE_UNAVAILABLE',
        canonicalPath,
        existed: false,
        readable: false,
        writable: false,
        reason: `Could not determine workspace existence for path: "${canonicalPath}"`,
      };
    }

    if (!existed) {
      if (!allowCreate) {
        return {
          state: 'WORKSPACE_NOT_ACCESSIBLE',
          canonicalPath,
          existed: false,
          readable: false,
          writable: false,
          reason: `Workspace directory does not exist: "${canonicalPath}"`,
        };
      }

      // Try to create workspace
      try {
        fs.mkdirSync(canonicalPath, { recursive: true });
        this.logger.info(`Workspace created at: ${canonicalPath}`);
        return {
          state: 'WORKSPACE_CREATED',
          canonicalPath,
          existed: false,
          readable: true,
          writable: true,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          state: 'WORKSPACE_NOT_ACCESSIBLE',
          canonicalPath,
          existed: false,
          readable: false,
          writable: false,
          reason: `Failed to create workspace directory: ${msg}`,
        };
      }
    }

    // Workspace exists — verify it is a directory
    try {
      const stat = fs.statSync(canonicalPath);
      if (!stat.isDirectory()) {
        return {
          state: 'WORKSPACE_INVALID',
          canonicalPath,
          existed: true,
          readable: false,
          writable: false,
          reason: `Workspace path exists but is not a directory: "${canonicalPath}"`,
        };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        state: 'WORKSPACE_UNAVAILABLE',
        canonicalPath,
        existed: true,
        readable: false,
        writable: false,
        reason: `Could not stat workspace path: ${msg}`,
      };
    }

    // Probe read access
    let readable = false;
    try {
      fs.accessSync(canonicalPath, fs.constants.R_OK);
      readable = true;
    } catch {
      readable = false;
    }

    // Probe write access
    let writable = false;
    try {
      fs.accessSync(canonicalPath, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }

    if (!readable || !writable) {
      return {
        state: 'WORKSPACE_NOT_ACCESSIBLE',
        canonicalPath,
        existed: true,
        readable,
        writable,
        reason: `Workspace directory is not fully accessible (readable=${readable}, writable=${writable}).`,
      };
    }

    this.logger.info(`Workspace ready at: ${canonicalPath}`);
    return {
      state: 'WORKSPACE_READY',
      canonicalPath,
      existed: true,
      readable: true,
      writable: true,
    };
  }

  /** Returns true if the raw path string contains traversal patterns before resolution. */
  private _containsTraversal(rawPath: string): boolean {
    const normalized = rawPath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts.some((p) => p === '..');
  }

  /** Rejects well-known system root paths that should never be used as workspaces. */
  private _isDangerousSystemPath(canonicalPath: string): boolean {
    const dangerous = [
      'C:\\Windows',
      'C:\\Windows\\System32',
      '/etc',
      '/bin',
      '/usr',
      '/sys',
      '/proc',
      '/dev',
    ];
    const norm = canonicalPath.replace(/\\/g, '/').toLowerCase();
    return dangerous.some((d) => norm === d.replace(/\\/g, '/').toLowerCase());
  }
}
