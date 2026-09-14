/**
 * NEXUS AI — Task Decomposition & Project Orchestration Types
 */

export interface DecomposedTaskUnit {
  /** Unique unit identifier within the plan (e.g. 'unit-1-foundation'). */
  id: string;
  /** Human-readable title for UI and task history. */
  title: string;
  /** Specific, bounded implementation instructions for the model. */
  description: string;
  /** Categorical stage of this unit. */
  category: 'foundation' | 'component' | 'styling' | 'logic' | 'integration';
  /** IDs of prerequisite units that must be completed before this unit can execute. */
  dependencies: string[];
  /** Relative file paths created or modified by this unit. */
  targetFiles: string[];
  /** Concrete expected output to guide generation and verification. */
  expectedOutput: string;
  /** Rules/checks that must pass for this unit to be marked verified. */
  verificationCriteria: string[];
}

export interface DecompositionPlan {
  /** Original user task goal. */
  parentGoal: string;
  /** Whether the request is complex enough to warrant multi-task decomposition. */
  isDecomposed: boolean;
  /** Ordered list of implementation units. */
  units: DecomposedTaskUnit[];
  /** Architectural reasoning for this decomposition breakdown. */
  reasoning: string;
  /** Complexity estimate of the requested project. */
  estimatedComplexity: 'low' | 'medium' | 'high';
}

export interface ChildTaskExecutionResult {
  unitId: string;
  taskId: string;
  title: string;
  success: boolean;
  status: 'completed' | 'failed' | 'blocked';
  summary: string;
  artifacts: string[];
  error?: string;
  attemptCount: number;
}

export interface ProjectOrchestrationResult {
  parentTaskId: string;
  success: boolean;
  status: 'completed' | 'failed' | 'blocked';
  totalUnits: number;
  completedUnits: number;
  failedUnits: number;
  childResults: ChildTaskExecutionResult[];
  finalVerificationPassed: boolean;
  summary: string;
  error?: string;
  durationMs: number;
}

export interface DecomposeOptions {
  taskGoal: string;
  forceDecompose?: boolean;
}
