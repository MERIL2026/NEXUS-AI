import type { AgentTaskRepository } from '../storage/repositories/agentTaskRepository.js';
import type { TaskArtifactRepository } from '../storage/repositories/taskArtifactRepository.js';
import type { AgentTask, AgentTaskState, TaskArtifact } from '../storage/repositories/types.js';
import { AgentStateMachine } from './agentStateMachine.js';
import { Logger, LogLevel } from '../common/logger.js';

export interface CreateAgentTaskDto {
  id?: string;
  projectId?: string | null;
  title: string;
  parentTaskId?: string | null;
  taskType?: AgentTask['taskType'];
  sequence?: number;
  dependencies?: string[];
  expectedOutput?: string | null;
  verificationCriteria?: string | null;
  summary?: string | null;
}

export interface TransitionAgentTaskDto {
  targetState: AgentTaskState;
  currentStep?: string | null;
  plan?: string | null;
  summary?: string | null;
}

export interface FailAgentTaskDto {
  errorCategory: string;
  currentStep?: string | null;
  summary?: string | null;
}

/**
 * NEXUS AI — Agent Task Service
 *
 * Owns the lifecycle of agent tasks and their associated artifacts.
 */
export class AgentTaskService {
  private logger: Logger;
  private artifactRepo?: TaskArtifactRepository;

  constructor(
    private taskRepo: AgentTaskRepository,
    artifactRepoOrLogLevel?: TaskArtifactRepository | LogLevel,
    logLevelOrArtifactRepo?: LogLevel | TaskArtifactRepository
  ) {
    let resolvedArtifactRepo: TaskArtifactRepository | undefined;
    let resolvedLogLevel: LogLevel = 'info';

    if (typeof artifactRepoOrLogLevel === 'string') {
      resolvedLogLevel = artifactRepoOrLogLevel as LogLevel;
      if (typeof logLevelOrArtifactRepo === 'object' && logLevelOrArtifactRepo !== null) {
        resolvedArtifactRepo = logLevelOrArtifactRepo as TaskArtifactRepository;
      }
    } else if (typeof artifactRepoOrLogLevel === 'object' && artifactRepoOrLogLevel !== null) {
      resolvedArtifactRepo = artifactRepoOrLogLevel;
      if (typeof logLevelOrArtifactRepo === 'string') {
        resolvedLogLevel = logLevelOrArtifactRepo;
      }
    }

    this.artifactRepo = resolvedArtifactRepo;
    this.logger = new Logger('AgentTaskService', resolvedLogLevel);
  }

  setArtifactRepository(artifactRepo: TaskArtifactRepository): void {
    this.artifactRepo = artifactRepo;
  }

  registerArtifact(artifact: Omit<TaskArtifact, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): TaskArtifact | null {
    if (!this.artifactRepo) {
      this.logger.warn(`Cannot register artifact: TaskArtifactRepository not configured.`);
      return null;
    }
    const id = artifact.id || `art-${artifact.taskId}-${Date.now()}`;
    const saved = this.artifactRepo.upsert({
      ...artifact,
      id,
    });
    this.logger.info(`Registered task artifact`, { taskId: artifact.taskId, projectRoot: artifact.projectRoot, entryPoint: artifact.entryPoint });
    return saved;
  }

  getArtifact(taskId: string): TaskArtifact | null {
    if (!this.artifactRepo) return null;
    return this.artifactRepo.findByTaskId(taskId);
  }

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  createTask(dto: CreateAgentTaskDto | string): AgentTask {
    const inputDto: CreateAgentTaskDto = typeof dto === 'string' ? { title: dto } : dto;
    const id = inputDto.id ?? `task-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    this.logger.info(`Creating agent task`, { taskId: id, title: inputDto.title, parentTaskId: inputDto.parentTaskId });

    return this.taskRepo.create({
      id,
      projectId: inputDto.projectId ?? null,
      title: inputDto.title,
      parentTaskId: inputDto.parentTaskId ?? null,
      taskType: inputDto.taskType ?? (inputDto.parentTaskId ? 'child_unit' : 'standard'),
      sequence: inputDto.sequence ?? 0,
      dependencies: inputDto.dependencies ?? [],
      expectedOutput: inputDto.expectedOutput ?? null,
      verificationCriteria: inputDto.verificationCriteria ?? null,
      summary: inputDto.summary ?? null,
      plan: null,
    });
  }

  // ---------------------------------------------------------------------------
  // Retrieval
  // ---------------------------------------------------------------------------

  getTask(id: string): AgentTask {
    const task = this.taskRepo.findById(id);
    if (!task) {
      throw new Error(`AgentTask not found: '${id}'`);
    }
    return task;
  }

  getChildTasks(parentId: string): AgentTask[] {
    return this.taskRepo.findByParentTaskId(parentId);
  }

  updateTaskSummary(id: string, summary: string): AgentTask {
    const task = this.getTask(id);
    this.taskRepo.updateState(id, {
      state: task.state,
      summary,
    });
    return this.getTask(id);
  }

  listTasks(projectId?: string | null): AgentTask[] {
    if (projectId === undefined) {
      return this.taskRepo.listAll();
    }
    return this.taskRepo.listByProject(projectId);
  }

  listTopLevelTasks(): AgentTask[] {
    return this.taskRepo.listTopLevelTasks();
  }

  getTasksByState(state: AgentTaskState): AgentTask[] {
    return this.taskRepo.findByState(state);
  }

  // ---------------------------------------------------------------------------
  // State transitions (forward)
  // ---------------------------------------------------------------------------

  transitionTask(id: string, dto: TransitionAgentTaskDto): AgentTask {
    const task = this.getTask(id);
    const result = AgentStateMachine.transition(task.state, dto.targetState);

    if (!result.success) {
      this.logger.warn(`State transition rejected`, {
        taskId: id,
        from: result.previousState,
        to: dto.targetState,
        reason: result.error,
      });
      throw new Error(result.error);
    }

    this.logger.info(`Agent task state transition`, {
      taskId: id,
      from: result.previousState,
      to: result.newState,
    });

    this.taskRepo.updateState(id, {
      state: result.newState,
      currentStep: dto.currentStep ?? null,
      stepStatus: result.newState === 'completed' ? 'done' : 'active',
      attemptCount: task.attemptCount,
      errorCategory: null,
      cancelledAt: null,
      completedAt: result.newState === 'completed' ? new Date().toISOString() : null,
      plan: dto.plan ?? undefined,
    });

    return this.getTask(id);
  }

  setTaskPlan(id: string, plan: string): AgentTask {
    const task = this.getTask(id);
    this.taskRepo.updateState(id, {
      state: task.state,
      currentStep: task.currentStep,
      stepStatus: task.stepStatus,
      attemptCount: task.attemptCount,
      errorCategory: task.errorCategory,
      cancelledAt: task.cancelledAt,
      completedAt: task.completedAt,
      plan,
    });
    return this.getTask(id);
  }

  // ---------------------------------------------------------------------------
  // Terminal transitions
  // ---------------------------------------------------------------------------

  cancelTask(id: string): AgentTask {
    const task = this.getTask(id);
    const result = AgentStateMachine.cancel(task.state);

    if (!result.success) {
      this.logger.warn(`Task cancellation rejected`, {
        taskId: id,
        currentState: task.state,
        reason: result.error,
      });
      throw new Error(result.error);
    }

    this.logger.info(`Agent task cancelled`, {
      taskId: id,
      previousState: result.previousState,
    });

    const now = new Date().toISOString();
    this.taskRepo.updateState(id, {
      state: 'cancelled',
      currentStep: task.currentStep,
      stepStatus: 'error',
      attemptCount: task.attemptCount,
      errorCategory: null,
      cancelledAt: now,
      completedAt: null,
    });

    return this.getTask(id);
  }

  failTask(id: string, dto: FailAgentTaskDto): AgentTask {
    const task = this.getTask(id);
    const result = AgentStateMachine.fail(task.state);

    if (!result.success) {
      this.logger.warn(`Task failure transition rejected`, {
        taskId: id,
        currentState: task.state,
        reason: result.error,
      });
      throw new Error(result.error);
    }

    this.logger.error(`Agent task failed`, {
      taskId: id,
      previousState: result.previousState,
      errorCategory: dto.errorCategory,
    });

    this.taskRepo.updateState(id, {
      state: 'failed',
      currentStep: dto.currentStep ?? task.currentStep,
      stepStatus: 'error',
      attemptCount: task.attemptCount,
      errorCategory: dto.errorCategory,
      cancelledAt: null,
      completedAt: null,
    });

    return this.getTask(id);
  }

  completeTask(id: string): AgentTask {
    return this.transitionTask(id, { targetState: 'completed' });
  }

  resetTaskForRetry(id: string, targetState: AgentTaskState = 'planning'): AgentTask {
    this.logger.info(`Resetting task for retry`, { taskId: id, targetState });
    this.taskRepo.updateState(id, {
      state: targetState,
      errorCategory: null,
      stepStatus: 'idle',
      currentStep: null,
    });
    return this.getTask(id);
  }

  // ---------------------------------------------------------------------------
  // Deletion
  // ---------------------------------------------------------------------------

  deleteTask(id: string): boolean {
    const task = this.getTask(id);
    this.logger.info(`Deleting agent task`, { taskId: id, state: task.state });
    return this.taskRepo.deleteById(id);
  }
}
