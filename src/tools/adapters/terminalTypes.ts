/**
 * NEXUS AI — P6-C: Bounded Terminal Execution Types
 *
 * Provides normalized data contracts for the terminal_execute tool.
 *
 * SECURITY DESIGN:
 *  - Input is a structured object (NOT a raw shell string).
 *  - Command and args are always separate fields.
 *  - No shell interpretation is performed at any layer.
 */

// ---------------------------------------------------------------------------
// Input Contract
// ---------------------------------------------------------------------------

/**
 * Structured request for the terminal_execute tool.
 *
 * DO NOT accept raw shell strings. Command + args are always separate.
 * This prevents shell injection, chaining, and interpretation.
 */
export interface TerminalExecuteParams {
  /** The executable to run (e.g. "npm", "git", "node"). Must be in the allowlist. */
  command: string;
  /** Arguments to pass to the command. Each arg is a separate string - no chaining. */
  args: string[];
  /**
   * Working directory for the process.
   * - Relative paths are resolved against the workspace root.
   * - Absolute paths must resolve inside the workspace root.
   * - Defaults to workspace root if omitted or ".".
   */
  cwd?: string;
  /**
   * Execution timeout in milliseconds.
   * - Default: 30,000 ms (30 seconds)
   * - Maximum: 120,000 ms (120 seconds)
   */
  timeoutMs?: number;
  /**
   * Maximum bytes to buffer for stdout.
   * - Default: 262,144 bytes (256 KB)
   * - Maximum: 1,048,576 bytes (1 MB)
   */
  maxStdoutBytes?: number;
  /**
   * Maximum bytes to buffer for stderr.
   * - Default: 262,144 bytes (256 KB)
   * - Maximum: 1,048,576 bytes (1 MB)
   */
  maxStderrBytes?: number;
}

// ---------------------------------------------------------------------------
// Output Contract
// ---------------------------------------------------------------------------

/**
 * Normalized result returned by the terminal_execute tool.
 */
export interface TerminalExecuteResult {
  /** True if the process exited with code 0 and no timeout/cancellation occurred. */
  success: boolean;
  /** Process exit code. null if terminated by signal or timeout. */
  exitCode: number | null;
  /** Signal name that terminated the process (e.g. "SIGTERM"), or null. */
  signal: string | null;
  /** Standard output captured from the process (possibly truncated). */
  stdout: string;
  /** Standard error captured from the process (possibly truncated). */
  stderr: string;
  /** True if stdout was truncated due to output size limits. */
  stdoutTruncated: boolean;
  /** True if stderr was truncated due to output size limits. */
  stderrTruncated: boolean;
  /** Elapsed time in milliseconds from spawn to process exit/timeout. */
  durationMs: number;
  /** True if the process was killed due to timeout. */
  timedOut: boolean;
  /** True if the process was cancelled via AbortSignal. */
  cancelled: boolean;
  /** Error category if execution was blocked or failed. */
  errorCategory?: TerminalErrorCategory;
  /** Human-readable error message if execution was blocked or failed. */
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Command Policy Contract
// ---------------------------------------------------------------------------

export type CommandPolicyDecision =
  | 'ALLOWED'
  | 'COMMAND_NOT_ALLOWED'
  | 'INVALID_REQUEST'
  | 'PATH_TRAVERSAL_DENIED'
  | 'INVALID_COMMAND_POLICY';

/**
 * Risk classification for a validated command.
 */
export type CommandRiskLevel = 'safe' | 'elevated' | 'blocked';

/**
 * Result returned by TerminalCommandPolicy.evaluate().
 */
export interface CommandPolicyResult {
  allowed: boolean;
  decision: CommandPolicyDecision;
  reason: string;
  riskLevel: CommandRiskLevel;
  /** Normalized/resolved command that will be executed. */
  resolvedCommand?: string;
  /** Sanitized args (may be identical to input for safe commands). */
  resolvedArgs?: string[];
}

// ---------------------------------------------------------------------------
// Error Categories
// ---------------------------------------------------------------------------

/**
 * Deterministic error category string union for terminal execution failures.
 */
export type TerminalErrorCategory =
  | 'COMMAND_NOT_ALLOWED'
  | 'INVALID_REQUEST'
  | 'PATH_TRAVERSAL_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'PROCESS_ERROR'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'PROCESS_TERMINATED'
  | 'INVALID_COMMAND_POLICY';

// ---------------------------------------------------------------------------
// Terminal Execution Limits
// ---------------------------------------------------------------------------

export const TERMINAL_LIMITS = {
  /** Default execution timeout in ms. */
  DEFAULT_TIMEOUT_MS: 30_000,
  /** Maximum execution timeout in ms. */
  MAX_TIMEOUT_MS: 120_000,
  /** Default stdout/stderr buffer size in bytes (256 KB). */
  DEFAULT_OUTPUT_BYTES: 256 * 1024,
  /** Maximum stdout/stderr buffer size in bytes (1 MB). */
  MAX_OUTPUT_BYTES: 1024 * 1024,
  /** Grace period in ms before SIGKILL after SIGTERM. */
  KILL_GRACE_MS: 2_000,
} as const;
