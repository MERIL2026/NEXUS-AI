import type { SubsystemStatus } from '../storage/index.js';
import type { AgentTaskRepository } from '../storage/repositories/agentTaskRepository.js';
import type { ApprovalRepository } from '../storage/repositories/approvalRepository.js';
import type { TaskArtifactRepository } from '../storage/repositories/taskArtifactRepository.js';
import type { ToolGateway } from '../tools/index.js';
import type { ModelGateway } from '../intelligence/modelGateway.js';
import { AgentTaskService } from './agentTaskService.js';
import { AgentExecutionService } from './agentExecutionService.js';
import { PlanSynthesisService, PlanValidator } from './planner.js';
import { HumanApprovalService } from './humanApprovalService.js';
import { CodingAgentService } from './codingAgentService.js';
import { GoalCompletionVerifier } from './goalCompletionVerifier.js';
import { TaskDecompositionService } from './taskDecompositionService.js';
import { ProjectTaskOrchestrator } from './projectOrchestrator.js';
import { Logger, LogLevel } from '../common/logger.js';

export * from './types.js';
export * from './codingAgentTypes.js';
export * from './taskDecompositionTypes.js';
export { AgentStateMachine } from './agentStateMachine.js';
export { AgentTaskService } from './agentTaskService.js';
export { AgentExecutionService } from './agentExecutionService.js';
export { PlanValidator, PlanSynthesisService } from './planner.js';
export { HumanApprovalService } from './humanApprovalService.js';
export { CodingAgentService } from './codingAgentService.js';
export { CodingAgentDiscovery } from './codingAgentDiscovery.js';
export { CodingAgentVerifier } from './codingAgentVerifier.js';
export { CodingRepairService } from './codingRepairService.js';
export { GoalCompletionVerifier } from './goalCompletionVerifier.js';
export { TaskDecompositionService } from './taskDecompositionService.js';
export { ProjectTaskOrchestrator } from './projectOrchestrator.js';
export type { CreateAgentTaskDto, TransitionAgentTaskDto, FailAgentTaskDto } from './agentTaskService.js';
export type { TransitionResult } from './agentStateMachine.js';

export interface IOrchestrator {
  initialize(
    taskRepo: AgentTaskRepository,
    toolGateway?: ToolGateway,
    modelGateway?: ModelGateway,
    approvalRepo?: ApprovalRepository,
    artifactRepo?: TaskArtifactRepository,
    workspaceRoot?: string
  ): Promise<SubsystemStatus>;
  getStatus(): SubsystemStatus;
  readonly tasks: AgentTaskService;
  readonly execution?: AgentExecutionService;
  readonly planner?: PlanSynthesisService;
  readonly approvals?: HumanApprovalService;
  readonly codingAgent?: CodingAgentService;
  readonly goalVerifier?: GoalCompletionVerifier;
  readonly decomposition?: TaskDecompositionService;
  readonly projectOrchestrator?: ProjectTaskOrchestrator;
}

export class Orchestrator implements IOrchestrator {
  private initialized = false;
  private logger: Logger;
  private logLevel: LogLevel;
  public tasks!: AgentTaskService;
  public execution?: AgentExecutionService;
  public planner?: PlanSynthesisService;
  public approvals?: HumanApprovalService;
  public codingAgent?: CodingAgentService;
  public goalVerifier?: GoalCompletionVerifier;
  public decomposition?: TaskDecompositionService;
  public projectOrchestrator?: ProjectTaskOrchestrator;

  constructor(logLevel: LogLevel = 'info') {
    this.logLevel = logLevel;
    this.logger = new Logger('Orchestrator', logLevel);
  }

  async initialize(
    taskRepo: AgentTaskRepository,
    toolGateway?: ToolGateway,
    modelGateway?: ModelGateway,
    approvalRepo?: ApprovalRepository,
    artifactRepo?: TaskArtifactRepository,
    workspaceRoot: string = process.cwd()
  ): Promise<SubsystemStatus> {
    this.tasks = new AgentTaskService(taskRepo, artifactRepo, this.logLevel);

    if (toolGateway) {
      this.approvals = new HumanApprovalService(this.tasks, toolGateway, approvalRepo, undefined, this.logLevel);
      this.logger.info('HumanApprovalService initialized');

      this.execution = new AgentExecutionService(this.tasks, toolGateway, this.approvals, this.logLevel);
      this.logger.info('AgentExecutionService initialized');

      this.goalVerifier = new GoalCompletionVerifier(this.logLevel);

      this.decomposition = new TaskDecompositionService(modelGateway, this.logLevel);
      this.logger.info('TaskDecompositionService initialized');

      if (modelGateway) {
        this.planner = new PlanSynthesisService(modelGateway, toolGateway, this.logLevel);
        this.logger.info('PlanSynthesisService initialized');

        const validator = new PlanValidator(toolGateway);
        this.codingAgent = new CodingAgentService(
          this.tasks,
          toolGateway,
          this.execution,
          this.planner,
          validator,
          this.logLevel
        );
        this.logger.info('CodingAgentService initialized');

        this.projectOrchestrator = new ProjectTaskOrchestrator(
          this.tasks,
          this.planner,
          this.execution,
          this.goalVerifier,
          workspaceRoot,
          artifactRepo,
          this.approvals,
          this.logLevel
        );
        this.logger.info('ProjectTaskOrchestrator initialized');
      } else {
        this.logger.info('PlanSynthesisService, CodingAgentService & ProjectTaskOrchestrator skipped (no ModelGateway provided)');
      }
    }

    this.initialized = true;
    return this.getStatus();
  }

  getStatus(): SubsystemStatus {
    const plannerReady = this.planner !== undefined;
    const execReady = this.execution !== undefined;
    const approvalReady = this.approvals !== undefined;
    const codingAgentReady = this.codingAgent !== undefined;
    const orchestratorReady = this.projectOrchestrator !== undefined;

    return {
      name: 'Orchestrator',
      initialized: this.initialized,
      status: this.initialized ? 'ok' : 'degraded',
      message: this.initialized
        ? `Orchestrator ready — execution: ${execReady ? 'yes' : 'no'}, planner: ${plannerReady ? 'yes' : 'no'}, approvals: ${approvalReady ? 'yes' : 'no'}, codingAgent: ${codingAgentReady ? 'yes' : 'no'}, projectOrchestrator: ${orchestratorReady ? 'yes' : 'no'}`
        : 'Uninitialized',
    };
  }
}

