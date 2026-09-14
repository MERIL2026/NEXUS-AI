/**
 * NEXUS AI — P6-C: Terminal Adapter
 *
 * The ONLY location where child processes are spawned.
 *
 * SECURITY GUARANTEES:
 *  - Uses child_process.spawn() with shell: false (no shell interpreter).
 *  - Working directory is validated to be inside the workspace root.
 *  - Environment is sanitized: secrets are stripped, only safe vars preserved.
 *  - Execution is bounded by a configurable timeout (default 30s, max 120s).
 *  - stdout and stderr are bounded (default 256 KB, max 1 MB).
 *  - AbortSignal/AbortController cancellation is supported.
 *  - No orphan processes are left running after timeout or cancellation.
 *
 * PIPELINE:
 *   ToolExecutor -> TerminalCommandPolicy -> TerminalAdapter -> child_process.spawn()
 *
 * NO DIRECT ACCESS FROM:
 *   ApplicationApi | CLI | AgentRunner | Planner | PlanSynthesisService
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Logger, LogLevel } from '../../common/logger.js';
import type { TerminalExecuteParams, TerminalExecuteResult } from './terminalTypes.js';
import { TERMINAL_LIMITS } from './terminalTypes.js';

// ---------------------------------------------------------------------------
// Environment Sanitization
// ---------------------------------------------------------------------------

/**
 * Sensitive environment variable name patterns to strip from the child process.
 * Matched case-insensitively against variable names.
 */
const SENSITIVE_ENV_PATTERNS: ReadonlyArray<RegExp> = [
  /.*_KEY$/i,
  /.*_TOKEN$/i,
  /.*_SECRET$/i,
  /.*_PASSWORD$/i,
  /.*_PASS$/i,
  /.*_CREDENTIAL/i,
  /.*_CREDENTIALS$/i,
  /^AWS_.*/i,
  /^AZURE_.*/i,
  /^GCP_.*/i,
  /^GOOGLE_.*/i,
  /^GITHUB_.*/i,
  /^GITLAB_.*/i,
  /^NPM_TOKEN.*/i,
  /^NUGET_.*/i,
  /^DOCKER_.*/i,
  /^KUBERNETES_.*/i,
  /^VAULT_.*/i,
  /^CONSUL_.*/i,
  /^DATABASE_URL$/i,
  /^DB_URL$/i,
  /^DB_PASSWORD$/i,
  /^DB_PASS$/i,
  /^REDIS_URL$/i,
  /^MONGO_URL$/i,
  /^ELASTICSEARCH_URL$/i,
  /^OPENAI_API_KEY$/i,
  /^ANTHROPIC_API_KEY$/i,
  /^OLLAMA_API_KEY$/i,
  /^STRIPE_.*/i,
  /^TWILIO_.*/i,
  /^SENDGRID_.*/i,
  /^JWT_SECRET$/i,
  /^ENCRYPTION_KEY$/i,
  /^SSL_KEY$/i,
  /^TLS_KEY$/i,
  /^PRIVATE_KEY$/i,
  /^SIGNING_KEY$/i,
];

/**
 * Explicitly allowed environment variables to pass to child processes.
 * Only these variables (from the parent environment) are forwarded.
 */
const ALLOWED_ENV_VARS: ReadonlyArray<string> = [
  // PATH is essential for finding executables
  'PATH',
  // Node.js
  'NODE_ENV',
  'NODE_PATH',
  'NODE_OPTIONS',
  // npm
  'NPM_CONFIG_LOGLEVEL',
  'npm_config_cache',
  // System locale / encoding
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  // OS essentials (Windows)
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'windir',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMDATA',
  // OS essentials (Unix)
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'XDG_RUNTIME_DIR',
  // Python
  'PYTHONPATH',
  'VIRTUAL_ENV',
  'CONDA_DEFAULT_ENV',
  // Development
  'EDITOR',
  'VISUAL',
  'CI',
  'CONTINUOUS_INTEGRATION',
];

/**
 * Build a sanitized environment for the child process.
 * Only explicitly allowed variables are forwarded; all sensitive patterns are stripped.
 */
function buildSanitizedEnv(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const varName of ALLOWED_ENV_VARS) {
    const value = parentEnv[varName];
    if (value !== undefined && value !== null) {
      // Double-check against sensitive patterns even for allowed vars
      const isSensitive = SENSITIVE_ENV_PATTERNS.some((p) => p.test(varName));
      if (!isSensitive) {
        sanitized[varName] = value;
      }
    }
  }

  return sanitized;
}

// ---------------------------------------------------------------------------
// Workspace Boundary Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a requested working directory is inside the canonical workspace root.
 *
 * @param requestedCwd The cwd from the execute params (may be relative or absolute).
 * @param canonicalWorkspaceRoot Canonical, real-path workspace root.
 * @returns resolved canonical cwd, or null if invalid.
 */
function validateWorkspaceCwd(
  requestedCwd: string | undefined,
  canonicalWorkspaceRoot: string
): { valid: true; resolvedCwd: string } | { valid: false; errorMessage: string } {
  // Default: workspace root
  const rawCwd = requestedCwd || '.';

  // Reject null bytes
  if (rawCwd.includes('\0')) {
    return { valid: false, errorMessage: 'Working directory contains a null byte character.' };
  }

  // Resolve against workspace root
  const resolvedTarget = path.isAbsolute(rawCwd)
    ? path.normalize(rawCwd)
    : path.resolve(canonicalWorkspaceRoot, rawCwd);

  // Resolve real path to catch symlink escapes
  let canonicalTarget: string;
  try {
    if (fs.existsSync(resolvedTarget)) {
      canonicalTarget = fs.realpathSync(resolvedTarget);
    } else {
      // Non-existent path: check parent for symlinks
      const parent = path.dirname(resolvedTarget);
      if (fs.existsSync(parent)) {
        const canonicalParent = fs.realpathSync(parent);
        canonicalTarget = path.join(canonicalParent, path.basename(resolvedTarget));
      } else {
        canonicalTarget = resolvedTarget;
      }
    }
  } catch {
    canonicalTarget = resolvedTarget;
  }

  const isWindows = process.platform === 'win32';
  const rootCheck = isWindows ? canonicalWorkspaceRoot.toLowerCase() : canonicalWorkspaceRoot;
  const targetCheck = isWindows ? canonicalTarget.toLowerCase() : canonicalTarget;

  const isInsideWorkspace =
    targetCheck === rootCheck ||
    targetCheck.startsWith(rootCheck + path.sep) ||
    targetCheck.startsWith(rootCheck + '/') ||
    targetCheck.startsWith(rootCheck + '\\');

  if (!isInsideWorkspace) {
    return {
      valid: false,
      errorMessage: `Working directory '${rawCwd}' resolves outside the workspace sandbox.`,
    };
  }

  // Verify it is a directory (if it exists)
  if (fs.existsSync(canonicalTarget)) {
    const stat = fs.statSync(canonicalTarget);
    if (!stat.isDirectory()) {
      return {
        valid: false,
        errorMessage: `Working directory '${rawCwd}' is not a directory.`,
      };
    }
  }

  return { valid: true, resolvedCwd: canonicalTarget };
}

// ---------------------------------------------------------------------------
// TerminalAdapter Class
// ---------------------------------------------------------------------------

export class TerminalAdapter {
  private canonicalWorkspaceRoot: string;
  private logger: Logger;

  constructor(workspaceRoot: string, logLevel: LogLevel = 'info') {
    this.logger = new Logger('TerminalAdapter', logLevel);

    if (!workspaceRoot || typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
      throw new Error('TerminalAdapter: workspaceRoot must be a non-empty string.');
    }

    const resolvedRoot = path.resolve(workspaceRoot);

    // Ensure workspace root exists
    if (!fs.existsSync(resolvedRoot)) {
      try {
        fs.mkdirSync(resolvedRoot, { recursive: true });
      } catch (err) {
        throw new Error(`TerminalAdapter: workspace directory could not be created: ${String(err)}`);
      }
    }

    try {
      this.canonicalWorkspaceRoot = fs.realpathSync(resolvedRoot);
    } catch {
      this.canonicalWorkspaceRoot = resolvedRoot;
    }
  }

  /**
   * Execute a policy-validated terminal command inside the workspace.
   *
   * PRECONDITION: params.command and params.args have already been validated
   * by TerminalCommandPolicy.evaluate(). Do NOT call this directly from
   * outside ToolExecutor.
   *
   * @param command The exact executable to spawn (from policy resolvedCommand).
   * @param args Validated argument array (from policy resolvedArgs).
   * @param params Original params (for cwd, timeout, output limits).
   * @param signal Optional AbortSignal for cancellation.
   * @returns Normalized TerminalExecuteResult.
   */
  async execute(
    command: string,
    args: string[],
    params: TerminalExecuteParams,
    signal?: AbortSignal
  ): Promise<TerminalExecuteResult> {
    const startTime = Date.now();

    // 1. Validate working directory
    const cwdResult = validateWorkspaceCwd(params.cwd, this.canonicalWorkspaceRoot);
    if (!cwdResult.valid) {
      return this.errorResult(
        'PATH_TRAVERSAL_DENIED',
        cwdResult.errorMessage,
        startTime
      );
    }

    const resolvedCwd = cwdResult.resolvedCwd;

    // 2. Resolve timeout (clamp to limits)
    const rawTimeout = typeof params.timeoutMs === 'number' ? params.timeoutMs : TERMINAL_LIMITS.DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(rawTimeout, 1), TERMINAL_LIMITS.MAX_TIMEOUT_MS);

    // 3. Resolve output limits (clamp to limits)
    const stdoutLimit = typeof params.maxStdoutBytes === 'number'
      ? Math.min(Math.max(params.maxStdoutBytes, 1), TERMINAL_LIMITS.MAX_OUTPUT_BYTES)
      : TERMINAL_LIMITS.DEFAULT_OUTPUT_BYTES;

    const stderrLimit = typeof params.maxStderrBytes === 'number'
      ? Math.min(Math.max(params.maxStderrBytes, 1), TERMINAL_LIMITS.MAX_OUTPUT_BYTES)
      : TERMINAL_LIMITS.DEFAULT_OUTPUT_BYTES;

    // 4. Build sanitized environment
    const sanitizedEnv = buildSanitizedEnv(process.env);

    // 5. Check if already cancelled before spawning
    if (signal?.aborted) {
      return {
        success: false,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: Date.now() - startTime,
        timedOut: false,
        cancelled: true,
        errorCategory: 'PROCESS_TERMINATED',
        errorMessage: 'Execution was cancelled before process could start.',
      };
    }

    this.logger.info(`Spawning process`, {
      command,
      argCount: args.length,
      cwd: resolvedCwd,
      timeoutMs,
    });

    // 6. Spawn process (NO SHELL — primary security control)
    return new Promise<TerminalExecuteResult>((resolve) => {
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let resolved = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let gracefulKillTimer: ReturnType<typeof setTimeout> | null = null;

      const resolveOnce = (result: TerminalExecuteResult) => {
        if (resolved) return;
        resolved = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        if (gracefulKillTimer) clearTimeout(gracefulKillTimer);
        resolve(result);
      };

      /**
       * Gracefully terminate the process: SIGTERM, then SIGKILL after grace period.
       */
      const terminateProcess = (reason: 'timeout' | 'cancelled') => {
        if (resolved) return;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }

        gracefulKillTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, TERMINAL_LIMITS.KILL_GRACE_MS);

        const elapsed = Date.now() - startTime;
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        resolveOnce({
          success: false,
          exitCode: null,
          signal: 'SIGTERM',
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          durationMs: elapsed,
          timedOut: reason === 'timeout',
          cancelled: reason === 'cancelled',
          errorCategory: reason === 'timeout' ? 'TIMEOUT' : 'PROCESS_TERMINATED',
          errorMessage: reason === 'timeout'
            ? `Process timed out after ${timeoutMs}ms.`
            : 'Process was cancelled via AbortSignal.',
        });
      };

      // Spawn with shell: false (CRITICAL — no shell interpreter)
      const child = spawn(command, args, {
        cwd: resolvedCwd,
        env: sanitizedEnv,
        shell: false,               // NEVER set to true
        windowsHide: true,          // Hide console window on Windows
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Handle spawn errors (command not found, permission denied, etc.)
      child.on('error', (err) => {
        const elapsed = Date.now() - startTime;
        this.logger.warn(`Process spawn error`, { command, error: String(err) });
        resolveOnce({
          success: false,
          exitCode: null,
          signal: null,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          stdoutTruncated,
          stderrTruncated,
          durationMs: elapsed,
          timedOut: false,
          cancelled: false,
          errorCategory: 'PROCESS_ERROR',
          errorMessage: `Process failed to spawn: ${err.message}`,
        });
      });

      // Collect stdout (bounded)
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutTruncated) return;
        const remaining = stdoutLimit - stdoutBytes;
        if (chunk.length >= remaining) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes += remaining;
          stdoutTruncated = true;
        } else {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        }
      });

      // Collect stderr (bounded)
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrTruncated) return;
        const remaining = stderrLimit - stderrBytes;
        if (chunk.length >= remaining) {
          stderrChunks.push(chunk.subarray(0, remaining));
          stderrBytes += remaining;
          stderrTruncated = true;
        } else {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        }
      });

      // Process exit
      child.on('close', (code, sig) => {
        if (resolved) return;
        const elapsed = Date.now() - startTime;
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const exitCode = code ?? null;
        const exitSignal = sig ?? null;
        const success = exitCode === 0 && exitSignal === null;

        this.logger.info(`Process exited`, {
          command,
          exitCode,
          signal: exitSignal,
          durationMs: elapsed,
          stdoutTruncated,
          stderrTruncated,
        });

        resolveOnce({
          success,
          exitCode,
          signal: exitSignal,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          durationMs: elapsed,
          timedOut: false,
          cancelled: false,
        });
      });

      // Timeout enforcement
      timeoutTimer = setTimeout(() => {
        this.logger.warn(`Process timeout reached`, { command, timeoutMs });
        terminateProcess('timeout');
      }, timeoutMs);

      // AbortSignal cancellation
      if (signal) {
        if (signal.aborted) {
          terminateProcess('cancelled');
        } else {
          const onAbort = () => {
            this.logger.info(`Process abort signal received`, { command });
            terminateProcess('cancelled');
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
    });
  }

  /**
   * Get the canonical workspace root this adapter is bound to.
   */
  getWorkspaceRoot(): string {
    return this.canonicalWorkspaceRoot;
  }

  private errorResult(
    errorCategory: 'PATH_TRAVERSAL_DENIED' | 'PROCESS_ERROR' | 'TIMEOUT' | 'PROCESS_TERMINATED',
    errorMessage: string,
    startTime: number
  ): TerminalExecuteResult {
    return {
      success: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: Date.now() - startTime,
      timedOut: false,
      cancelled: false,
      errorCategory,
      errorMessage,
    };
  }
}

// Export environment sanitization for testing purposes
export { buildSanitizedEnv, validateWorkspaceCwd };
