import type { AgentTaskState } from '../storage/repositories/types.js';

/**
 * NEXUS AI — Agent State Machine
 *
 * Defines and enforces the deterministic lifecycle of an agent task.
 * ALL state transitions MUST go through this class.
 * No external code may directly mutate AgentTask.state.
 *
 * Lifecycle:
 *   created → planning → awaiting_approval → executing → observing → verifying → completed
 *
 * Failure path (from any active state):
 *   * → failed
 *
 * Cancellation path (from any non-terminal active state):
 *   * → cancelled
 *
 * Terminal states (no further transitions):
 *   completed | failed | cancelled
 */

/** All states from which a task may be cancelled. */
const CANCELLABLE_STATES: ReadonlySet<AgentTaskState> = new Set([
  'created',
  'planning',
  'awaiting_approval',
  'executing',
  'observing',
  'verifying',
]);

/** All states from which a task may fail. */
const FAILABLE_STATES: ReadonlySet<AgentTaskState> = new Set([
  'created',
  'planning',
  'awaiting_approval',
  'executing',
  'observing',
  'verifying',
]);

/** States that accept no further transitions. */
const TERMINAL_STATES: ReadonlySet<AgentTaskState> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Explicit forward transition map.
 * A transition is ONLY valid if it is listed here.
 * Cancellation and failure are handled via their dedicated methods.
 */
const VALID_FORWARD_TRANSITIONS: ReadonlyMap<AgentTaskState, ReadonlySet<AgentTaskState>> = new Map([
  ['created',           new Set<AgentTaskState>(['planning'])],
  ['planning',          new Set<AgentTaskState>(['awaiting_approval', 'executing'])],
  ['awaiting_approval', new Set<AgentTaskState>(['executing', 'cancelled'])],
  ['executing',         new Set<AgentTaskState>(['observing'])],
  ['observing',         new Set<AgentTaskState>(['verifying', 'executing'])],
  ['verifying',         new Set<AgentTaskState>(['completed', 'executing', 'planning'])],
  // Terminal states have no forward successors
  ['completed',         new Set<AgentTaskState>()],
  ['failed',            new Set<AgentTaskState>()],
  ['cancelled',         new Set<AgentTaskState>()],
]);

export interface TransitionResult {
  success: boolean;
  previousState: AgentTaskState;
  newState: AgentTaskState;
  error?: string;
}

export class AgentStateMachine {
  /**
   * Validate and return the result of a requested forward transition.
   * Does NOT mutate any task record directly — the caller must persist.
   */
  static transition(currentState: AgentTaskState, targetState: AgentTaskState): TransitionResult {
    if (TERMINAL_STATES.has(currentState)) {
      return {
        success: false,
        previousState: currentState,
        newState: currentState,
        error: `Transition rejected: task is in terminal state '${currentState}' and cannot transition to '${targetState}'.`,
      };
    }

    const allowed = VALID_FORWARD_TRANSITIONS.get(currentState);
    if (!allowed || !allowed.has(targetState)) {
      return {
        success: false,
        previousState: currentState,
        newState: currentState,
        error: `Transition rejected: '${currentState}' → '${targetState}' is not a valid transition.`,
      };
    }

    return {
      success: true,
      previousState: currentState,
      newState: targetState,
    };
  }

  /**
   * Validate a cancellation request.
   * Cancellation is explicit and only allowed from non-terminal active states.
   */
  static cancel(currentState: AgentTaskState): TransitionResult {
    if (TERMINAL_STATES.has(currentState)) {
      return {
        success: false,
        previousState: currentState,
        newState: currentState,
        error: `Cancellation rejected: task is already in terminal state '${currentState}'.`,
      };
    }

    if (!CANCELLABLE_STATES.has(currentState)) {
      return {
        success: false,
        previousState: currentState,
        newState: currentState,
        error: `Cancellation rejected: state '${currentState}' is not cancellable.`,
      };
    }

    return {
      success: true,
      previousState: currentState,
      newState: 'cancelled',
    };
  }

  /**
   * Validate a failure transition.
   * Failure is explicit and allowed from any active non-terminal state.
   */
  static fail(currentState: AgentTaskState): TransitionResult {
    if (TERMINAL_STATES.has(currentState)) {
      return {
        success: false,
        previousState: currentState,
        newState: currentState,
        error: `Failure rejected: task is already in terminal state '${currentState}'.`,
      };
    }

    if (!FAILABLE_STATES.has(currentState)) {
      return {
        success: false,
        previousState: currentState,
        newState: currentState,
        error: `Failure rejected: state '${currentState}' cannot transition to 'failed'.`,
      };
    }

    return {
      success: true,
      previousState: currentState,
      newState: 'failed',
    };
  }

  /** Returns true if the given state is terminal. */
  static isTerminal(state: AgentTaskState): boolean {
    return TERMINAL_STATES.has(state);
  }

  /** Returns the set of valid forward successor states for a given state. */
  static validSuccessors(state: AgentTaskState): AgentTaskState[] {
    return Array.from(VALID_FORWARD_TRANSITIONS.get(state) ?? []);
  }
}
