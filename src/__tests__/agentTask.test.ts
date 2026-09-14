import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StorageService } from '../storage/index.js';
import { AgentStateMachine } from '../orchestration/agentStateMachine.js';
import { AgentTaskService } from '../orchestration/agentTaskService.js';

describe('P5-A — Agent State Machine & Task Lifecycle', () => {
  let storage: StorageService;
  let service: AgentTaskService;

  beforeEach(async () => {
    storage = new StorageService(':memory:', 'error');
    await storage.initialize();
    service = new AgentTaskService(storage.agentTasks, 'error');
  });

  afterEach(() => {
    storage.close();
  });

  // -------------------------------------------------------------------------
  // 1. Task creation
  // -------------------------------------------------------------------------

  it('creates a task with initial state "created" and correct metadata defaults', () => {
    const task = service.createTask({ title: 'Analyse codebase' });

    expect(task.id).toMatch(/^task-/);
    expect(task.title).toBe('Analyse codebase');
    expect(task.state).toBe('created');
    expect(task.stepStatus).toBe('idle');
    expect(task.attemptCount).toBe(0);
    expect(task.errorCategory).toBeNull();
    expect(task.cancelledAt).toBeNull();
    expect(task.completedAt).toBeNull();
    expect(task.plan).toBeNull();
    expect(task.createdAt).toBeTruthy();
    expect(task.updatedAt).toBeTruthy();
  });

  it('creates a task with a deterministic id when provided', () => {
    const task = service.createTask({ id: 'task-deterministic-1', title: 'Fixed ID task' });
    expect(task.id).toBe('task-deterministic-1');
  });

  // -------------------------------------------------------------------------
  // 2. Task retrieval
  // -------------------------------------------------------------------------

  it('retrieves an existing task by id', () => {
    const created = service.createTask({ title: 'Retrieve test' });
    const found = service.getTask(created.id);
    expect(found.id).toBe(created.id);
    expect(found.title).toBe('Retrieve test');
  });

  it('throws when retrieving a non-existent task', () => {
    expect(() => service.getTask('task-does-not-exist')).toThrow(/not found/i);
  });

  // -------------------------------------------------------------------------
  // 3. Valid state transitions
  // -------------------------------------------------------------------------

  it('transitions from created → planning correctly', () => {
    const task = service.createTask({ title: 'Planning test' });
    const next = service.transitionTask(task.id, {
      targetState: 'planning',
      currentStep: 'Decomposing goal into sub-tasks',
    });
    expect(next.state).toBe('planning');
    expect(next.currentStep).toBe('Decomposing goal into sub-tasks');
    expect(next.stepStatus).toBe('active');
  });

  it('follows a full happy-path lifecycle to completed', () => {
    const task = service.createTask({ title: 'Full lifecycle' });

    service.transitionTask(task.id, { targetState: 'planning' });
    service.transitionTask(task.id, { targetState: 'awaiting_approval' });
    service.transitionTask(task.id, { targetState: 'executing' });
    service.transitionTask(task.id, { targetState: 'observing' });
    service.transitionTask(task.id, { targetState: 'verifying' });
    const done = service.completeTask(task.id);

    expect(done.state).toBe('completed');
    expect(done.stepStatus).toBe('done');
    expect(done.completedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 4. Invalid state transitions
  // -------------------------------------------------------------------------

  it('rejects an invalid forward transition (created → executing)', () => {
    const task = service.createTask({ title: 'Invalid transition test' });
    expect(() => service.transitionTask(task.id, { targetState: 'executing' })).toThrow(
      /not a valid transition/i
    );
  });

  it('rejects a backwards transition (planning → created)', () => {
    const task = service.createTask({ title: 'Backwards test' });
    service.transitionTask(task.id, { targetState: 'planning' });
    expect(() => service.transitionTask(task.id, { targetState: 'created' })).toThrow(
      /not a valid transition/i
    );
  });

  // -------------------------------------------------------------------------
  // 5. Cancellation
  // -------------------------------------------------------------------------

  it('cancels a task from an active state', () => {
    const task = service.createTask({ title: 'Cancel from executing' });
    service.transitionTask(task.id, { targetState: 'planning' });
    service.transitionTask(task.id, { targetState: 'awaiting_approval' });
    service.transitionTask(task.id, { targetState: 'executing' });

    const cancelled = service.cancelTask(task.id);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.stepStatus).toBe('error');
    expect(cancelled.cancelledAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 6. Failure
  // -------------------------------------------------------------------------

  it('fails a task from an active state with an error category', () => {
    const task = service.createTask({ title: 'Fail test' });
    service.transitionTask(task.id, { targetState: 'planning' });

    const failed = service.failTask(task.id, {
      errorCategory: 'PLANNING_ERROR',
      currentStep: 'Goal decomposition',
    });

    expect(failed.state).toBe('failed');
    expect(failed.stepStatus).toBe('error');
    expect(failed.errorCategory).toBe('PLANNING_ERROR');
  });

  // -------------------------------------------------------------------------
  // 7. Completion
  // -------------------------------------------------------------------------

  it('completeTask() is a shorthand that sets state to completed and stamps completedAt', () => {
    const task = service.createTask({ title: 'Complete shorthand' });
    service.transitionTask(task.id, { targetState: 'planning' });
    service.transitionTask(task.id, { targetState: 'executing' });
    service.transitionTask(task.id, { targetState: 'observing' });
    service.transitionTask(task.id, { targetState: 'verifying' });

    const done = service.completeTask(task.id);
    expect(done.state).toBe('completed');
    expect(done.completedAt).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 8. Terminal-state protection
  // -------------------------------------------------------------------------

  it('rejects any forward transition from a completed terminal state', () => {
    const task = service.createTask({ title: 'Terminal guard test' });
    service.transitionTask(task.id, { targetState: 'planning' });
    service.transitionTask(task.id, { targetState: 'executing' });
    service.transitionTask(task.id, { targetState: 'observing' });
    service.transitionTask(task.id, { targetState: 'verifying' });
    service.completeTask(task.id);

    expect(() => service.transitionTask(task.id, { targetState: 'planning' })).toThrow(
      /terminal state/i
    );
  });

  it('rejects cancellation of an already-cancelled task', () => {
    const task = service.createTask({ title: 'Double cancel guard' });
    service.cancelTask(task.id);
    expect(() => service.cancelTask(task.id)).toThrow(/terminal state/i);
  });

  it('rejects failure of an already-failed task', () => {
    const task = service.createTask({ title: 'Double fail guard' });
    service.failTask(task.id, { errorCategory: 'INITIAL_FAILURE' });
    expect(() => service.failTask(task.id, { errorCategory: 'SECOND_FAILURE' })).toThrow(
      /terminal state/i
    );
  });

  // -------------------------------------------------------------------------
  // 9. Persistence and reload
  // -------------------------------------------------------------------------

  it('persists state transitions that survive across service re-instantiation', () => {
    const task = service.createTask({ title: 'Persist test' });
    service.transitionTask(task.id, { targetState: 'planning' });
    service.transitionTask(task.id, { targetState: 'awaiting_approval' });

    // Simulate reload: same underlying storage, new service instance
    const reloadedService = new AgentTaskService(storage.agentTasks, 'error');
    const reloaded = reloadedService.getTask(task.id);

    expect(reloaded.state).toBe('awaiting_approval');
    expect(reloaded.stepStatus).toBe('active');
    expect(reloaded.updatedAt).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 10. Timestamp & state consistency
  // -------------------------------------------------------------------------

  it('updatedAt advances after each transition', async () => {
    const task = service.createTask({ title: 'Timestamp test' });
    const t0 = task.updatedAt;

    // Small delay to ensure timestamp difference
    await new Promise((r) => setTimeout(r, 5));
    const next = service.transitionTask(task.id, { targetState: 'planning' });

    expect(next.updatedAt >= t0).toBe(true);
    expect(next.createdAt).toBe(task.createdAt); // createdAt must not change
  });

  // -------------------------------------------------------------------------
  // 11. AgentStateMachine unit tests (duplicate transition protection)
  // -------------------------------------------------------------------------

  it('AgentStateMachine.transition() returns a typed result object', () => {
    const result = AgentStateMachine.transition('created', 'planning');
    expect(result.success).toBe(true);
    expect(result.previousState).toBe('created');
    expect(result.newState).toBe('planning');
    expect(result.error).toBeUndefined();
  });

  it('AgentStateMachine.transition() rejects duplicate no-op transitions', () => {
    const result = AgentStateMachine.transition('planning', 'planning');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a valid transition/i);
  });

  // -------------------------------------------------------------------------
  // 12. Invalid task handling
  // -------------------------------------------------------------------------

  it('getTask() and transitionTask() both reject unknown task ids', () => {
    expect(() => service.getTask('ghost-task')).toThrow(/not found/i);
    expect(() => service.transitionTask('ghost-task', { targetState: 'planning' })).toThrow(
      /not found/i
    );
  });
});
