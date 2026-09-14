import type { ToolCapability } from '../tools/types.js';

// ---------------------------------------------------------------------------
// P5-E — Plan types
// ---------------------------------------------------------------------------

/**
 * A structured, validated agent plan produced by PlanSynthesisService.
 * The plan is an UNTRUSTED PROPOSAL until PlanValidator accepts it.
 * No execution authority is held here — this is pure data.
 */
export interface AgentPlan {
  /** Unique plan identifier. */
  planId: string;
  /** Task this plan was produced for. */
  taskId: string;
  /** Version counter — incremented on each re-plan. */
  version: number;
  /** Validated, ordered list of steps to execute. */
  steps: AgentPlanStep[];
  /** Human-readable reasoning captured from the model output. */
  reasoning: string;
  /** Model that generated this plan. */
  modelId: string;
  /** ISO timestamp when the plan was synthesized. */
  synthesizedAt: string;
}

/** A single validation error produced by PlanValidator. */
export interface PlanValidationError {
  code:
    | 'EMPTY_PLAN'
    | 'STEP_LIMIT_EXCEEDED'
    | 'INVALID_STEP_STRUCTURE'
    | 'UNKNOWN_TOOL'
    | 'UNSUPPORTED_ACTION'
    | 'UNTRUSTED_PARAM'
    | 'MALFORMED_OUTPUT';
  message: string;
  stepId?: string;
}

/** Result returned by PlanValidator.validate(). */
export interface PlanValidationResult {
  valid: boolean;
  errors: PlanValidationError[];
}

/** Options passed to PlanSynthesisService.synthesize(). */
export interface PlanSynthesisOptions {
  /** The task goal description given to the model. */
  taskGoal: string;
  /** Explicit model ID override (optional). */
  modelId?: string;
  /** Temperature override for the planning call (default: 0.2 for determinism). */
  temperature?: number;
  /** Inference timeout in milliseconds (default: 30 000). */
  timeoutMs?: number;
  /** Maximum plan steps allowed (default: 10). */
  maxSteps?: number;
}

/** Result returned by PlanSynthesisService.synthesize(). */
export interface PlanSynthesisResult {
  success: boolean;
  plan?: AgentPlan;
  /** Validation errors when success === false due to an invalid plan. */
  validationErrors?: PlanValidationError[];
  /** Raw error message when the model or network fails. */
  errorMessage?: string;
  /** Error category for upstream handling. */
  errorCategory?:
    | 'MODEL_UNAVAILABLE'
    | 'PLAN_VALIDATION_FAILED'
    | 'PLAN_PARSE_FAILED'
    | 'SYNTHESIS_TIMEOUT'
    | 'INTERNAL_ERROR';
}

export type AgentStepStatus = 'pending' | 'active' | 'completed' | 'failed';

export interface AgentPlanStep {
  stepId: string;
  taskId: string;
  sequence: number;
  stepType: 'tool_execution';
  status: AgentStepStatus;
  toolId?: string;
  requestedCapabilities?: ToolCapability[];
  params?: Record<string, unknown>;
  attemptCount: number;
  maxAttempts: number;
  errorCategory?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentObservation {
  stepId: string;
  taskId: string;
  toolId: string;
  requestId: string;
  success: boolean;
  errorCategory?: string;
  errorMessage?: string;
  outputSummary?: {
    bytes?: number;
    relativePath?: string;
    hasContent: boolean;
  };
  durationMs: number;
  timestamp: string;
}

export interface VerificationResult {
  stepId: string;
  taskId: string;
  verified: boolean;
  reason: string;
  timestamp: string;
}

export interface ExecutionLoopOptions {
  maxSteps?: number;           // Default: 10
  maxAttemptsPerStep?: number; // Default: 3
  stepTimeoutMs?: number;      // Default: 5000ms
  /** When false, the loop leaves the task in 'verifying' state instead of
   *  calling completeTask(). The CALLER is responsible for transitioning
   *  the task to 'completed' or 'failed'. Default: true. */
  autoComplete?: boolean;
}

/** Non-retryable security and structural failure categories. */
export const NON_RETRYABLE_ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  'PERMISSION_DENIED',
  'PATH_TRAVERSAL_DENIED',
  'INVALID_REQUEST',
  'UNKNOWN_TASK',
  'UNKNOWN_TOOL',
  'DISABLED_TOOL',
  'UNKNOWN_CAPABILITY',
  'EXCEEDS_POLICY_RISK',
  'STEP_LIMIT_EXCEEDED',
  'TASK_CANCELLED',
  'INVALID_INPUT',
  'UNSUPPORTED_TOOL_OPERATION',
  'COMMAND_NOT_ALLOWED',
  'INVALID_COMMAND_POLICY',
  'APPROVAL_REQUIRED',
  'OUTPUT_LIMIT_EXCEEDED',
]);
