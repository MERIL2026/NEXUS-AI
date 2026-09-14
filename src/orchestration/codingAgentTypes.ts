/**
 * NEXUS AI — P6-D: Coding Agent & Bounded Repair Loop Types
 *
 * Data contracts and types for the CodingAgentService, Discovery,
 * Verification, and Repair Loop.
 */

import type { AgentTaskState } from '../storage/repositories/types.js';
import type { AgentPlan } from './types.js';
import type { FileChangeDiff } from '../tools/adapters/filesystemAdapter.js';

// ---------------------------------------------------------------------------
// Discovery Contracts
// ---------------------------------------------------------------------------

export interface WorkspaceFileEvidence {
  relativePath: string;
  size?: number;
  snippet?: string;
  isSecret?: boolean;
}

export interface SearchMatchEvidence {
  relativePath: string;
  line: number;
  match: string;
  snippet: string;
}

export interface CodebaseEvidence {
  workspaceRoot: string;
  discoveredFiles: WorkspaceFileEvidence[];
  searchResults: SearchMatchEvidence[];
  treeEntriesCount: number;
  packageInfo?: {
    name?: string;
    version?: string;
    scripts?: Record<string, string>;
  };
  secretFilesExcluded: string[];
}

// ---------------------------------------------------------------------------
// Validation & Verification Contracts
// ---------------------------------------------------------------------------

export interface CodingValidationResult {
  passed: boolean;
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  errorCategory?: string;
  errorMessage?: string;
}

export interface CodingVerificationResult {
  verified: boolean;
  reason: string;
  diffsApplied: FileChangeDiff[];
  validationResult: CodingValidationResult | null;
  errorCategory?: string;
}

// ---------------------------------------------------------------------------
// Repair Contracts
// ---------------------------------------------------------------------------

export interface RepairContext {
  taskGoal: string;
  previousPlan: AgentPlan | null;
  changedFiles: string[];
  diffs: FileChangeDiff[];
  failedValidationCommand: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorCategory?: string;
  repairAttempt: number;
  maxRepairAttempts: number;
}

export interface RepairPlanResult {
  repairable: boolean;
  reason: string;
  repairPlan?: AgentPlan;
  errorCategory?: string;
}

// ---------------------------------------------------------------------------
// Coding Agent Run Options & Result
// ---------------------------------------------------------------------------

export interface CodingAgentTaskOptions {
  /** The goal/prompt submitted by the user. */
  taskGoal: string;
  /** Project/workspace directory root (default "." or configured workspace). */
  workspaceRoot?: string;
  /** Maximum repair retry budget (default: 3). */
  maxRepairAttempts?: number;
  /** Explicit list of validation commands to run (default: ["npm run typecheck", "npm run lint", "npm test", "npm run build"]). */
  validationCommands?: Array<{ command: string; args: string[] }>;
  /** Optional model ID override for plan synthesis. */
  modelId?: string;
  /** Timeout in ms per tool step. */
  stepTimeoutMs?: number;
}

export interface CodingAgentRunResult {
  success: boolean;
  taskId: string;
  runId: string;
  state: AgentTaskState;
  repairAttemptsCount: number;
  maxRepairAttempts: number;
  evidence?: CodebaseEvidence;
  diffs: FileChangeDiff[];
  validation?: CodingValidationResult | null;
  verification?: CodingVerificationResult;
  errorCategory?: string;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Non-Repairable Security & Structural Errors
// ---------------------------------------------------------------------------

/**
 * Failure categories that MUST IMMEDIATELY halt the repair loop.
 * Attempting to "repair" these via code modifications is unsafe.
 */
export const NON_REPAIRABLE_SECURITY_ERRORS: ReadonlySet<string> = new Set([
  'PERMISSION_DENIED',
  'PATH_TRAVERSAL_DENIED',
  'COMMAND_NOT_ALLOWED',
  'INVALID_COMMAND_POLICY',
  'APPROVAL_REQUIRED',
  'APPROVAL_REJECTED',
  'APPROVAL_EXPIRED',
  'DISABLED_TOOL',
  'UNKNOWN_TOOL',
  'UNKNOWN_CAPABILITY',
  'EXCEEDS_POLICY_RISK',
  'SECRET_FILE_PROTECTED',
  'TASK_CANCELLED',
  'STEP_LIMIT_EXCEEDED',
  'REPAIR_BUDGET_EXHAUSTED',
  'UNSUPPORTED_TOOL_OPERATION',
]);
