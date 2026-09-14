import type { SubsystemStatus } from '../storage/index.js';
import type { AppConfig } from '../config/index.js';
import { StorageService, ProjectService } from '../storage/index.js';
import { IntelligenceService } from '../intelligence/index.js';
import { KnowledgeEngine } from '../knowledge/index.js';
import { ToolGateway } from '../tools/index.js';
import { Orchestrator } from '../orchestration/index.js';
import { ConversationService } from '../chat/conversationService.js';
import { MessageService } from '../chat/messageService.js';
import { ChatService } from '../chat/chatService.js';
import { WorkspaceService } from '../config/workspaceService.js';
import { FirstRunService } from '../config/firstRunService.js';
import { PreviewService } from '../preview/previewService.js';
import { buildFirstRunReport } from '../config/firstRunHealthCheck.js';
import type { WorkspaceValidationResult } from '../config/workspaceService.js';
import type { FirstRunReport } from '../config/firstRunHealthCheck.js';
import type { AgentTaskService, AgentExecutionService, PlanSynthesisService, HumanApprovalService, CodingAgentService } from '../orchestration/index.js';

export interface SystemHealthReport {
  overall: 'ok' | 'degraded' | 'error';
  timestamp: string;
  config: {
    environment: string;
    port: number;
    ollamaHost: string;
    databasePath: string;
  };
  subsystems: SubsystemStatus[];
}

export class ApplicationApi {
  private storage: StorageService;
  public intelligence: IntelligenceService;
  public knowledge: KnowledgeEngine;
  public projects!: ProjectService;
  public conversations!: ConversationService;
  public messages!: MessageService;
  public chat!: ChatService;
  /** Agent task lifecycle service — exposed from Orchestrator. */
  public tasks!: AgentTaskService;
  /** Agent execution loop service — exposed from Orchestrator. */
  public execution?: AgentExecutionService;
  /** Plan synthesis service (P5-E) — exposed from Orchestrator. */
  public planner?: PlanSynthesisService;
  /** Human approval service (P5-F) — exposed from Orchestrator. */
  public approvals?: HumanApprovalService;
  /** Coding agent service (P6-D) — exposed from Orchestrator. */
  public codingAgent?: CodingAgentService;
  /** Task decomposition service — analyzes goals for multi-task orchestration. */
  public decomposition?: import('../orchestration/taskDecompositionService.js').TaskDecompositionService;
  /** Project task orchestrator — coordinates queue execution and verification. */
  public projectOrchestrator?: import('../orchestration/projectOrchestrator.js').ProjectTaskOrchestrator;
  /** Tool registry and permission authorization gateway. */
  public tools: ToolGateway;
  /** Workspace service — exposes validateWorkspace for safe consumer use. */
  public workspace: WorkspaceService;
  /** First-run state management service (available after bootstrap). */
  public firstRun?: FirstRunService;
  /** Local web project preview service (P7-H). */
  public preview!: PreviewService;

  private orchestrator = new Orchestrator();
  private closed = false;
  private workspaceResult?: WorkspaceValidationResult;

  constructor(private config: AppConfig) {
    this.storage = new StorageService(config.databasePath, config.logLevel);
    this.intelligence = new IntelligenceService(config.ollamaHost, config.logLevel, config.nexusInferenceProvider);
    this.knowledge = new KnowledgeEngine(config.logLevel);
    this.tools = new ToolGateway(undefined, config.logLevel);
    this.workspace = new WorkspaceService(config.logLevel);
  }

  /**
   * Safe workspace validation — can be called before or after bootstrap.
   * Never bypasses sandbox or traversal rules.
   */
  validateWorkspace(rawPath: string): WorkspaceValidationResult {
    return this.workspace.validateWorkspace(rawPath);
  }

  async bootstrap(): Promise<SystemHealthReport> {
    // Workspace initialization (before tool init so ToolGateway gets canonical root)
    this.workspaceResult = this.workspace.initializeWorkspace(this.config.workspaceRoot);

    await this.storage.initialize();
    await this.intelligence.initialize(this.storage.models);
    await this.knowledge.initialize(this.storage.knowledge);

    this.projects = new ProjectService(this.storage.projects, this.config.logLevel);
    this.conversations = new ConversationService(this.storage.conversations, this.config.logLevel);
    this.messages = new MessageService(this.storage.messages, this.config.logLevel);
    this.chat = new ChatService(this.conversations, this.messages, this.intelligence.gateway, this.knowledge.rag, this.config.logLevel);

    await this.orchestrator.initialize(
      this.storage.agentTasks,
      this.tools,
      this.intelligence.gateway,
      this.storage.approvals,
      this.storage.artifacts,
      this.config.workspaceRoot
    );
    this.tasks = this.orchestrator.tasks;
    this.execution = this.orchestrator.execution;
    this.planner = this.orchestrator.planner;
    this.approvals = this.orchestrator.approvals;
    this.codingAgent = this.orchestrator.codingAgent;
    this.decomposition = this.orchestrator.decomposition;
    this.projectOrchestrator = this.orchestrator.projectOrchestrator;
    await this.tools.initialize(this.tasks, this.config.workspaceRoot);

    // Startup Crash Recovery: recover interrupted active tasks left in transient execution states
    const transientStates: import('../storage/repositories/types.js').AgentTaskState[] = ['executing', 'observing', 'verifying'];
    for (const state of transientStates) {
      const activeTasks = this.tasks.getTasksByState(state);
      for (const t of activeTasks) {
        this.tasks.failTask(t.id, {
          errorCategory: 'INTERRUPTED_BY_SHUTDOWN',
          currentStep: t.currentStep || undefined,
        });
      }
    }

    // Wire up FirstRunService using the settings repository
    this.firstRun = new FirstRunService(this.storage.settings, this.config.logLevel);

    // Initialize Local Web Project Preview Service (P7-H) with TaskArtifactRepository
    this.preview = new PreviewService(this.storage.agentTasks, this.config.workspaceRoot, this.config.logLevel, this.storage.artifacts);

    return this.getHealthReport();
  }

  getHealthReport(): SystemHealthReport {
    const subsystems = [
      this.storage.getStatus(),
      this.intelligence.getStatus(),
      this.knowledge.getStatus(),
      this.tools.getStatus(),
      this.orchestrator.getStatus(),
    ];

    const hasError = subsystems.some((s) => s.status === 'error');
    const hasDegraded = subsystems.some((s) => s.status === 'degraded');
    const overallStatus: SystemHealthReport['overall'] = hasError ? 'error' : hasDegraded ? 'degraded' : 'ok';

    return {
      overall: overallStatus,
      timestamp: new Date().toISOString(),
      config: {
        environment: this.config.environment,
        port: this.config.port,
        ollamaHost: this.config.ollamaHost,
        databasePath: this.config.databasePath,
      },
      subsystems,
    };
  }

  /**
   * Build a consolidated first-run health report.
   * Returns null if bootstrap has not been called yet.
   */
  async getFirstRunReport(): Promise<FirstRunReport | null> {
    if (!this.firstRun || !this.workspaceResult) {
      return null;
    }

    const storageStatus = this.storage.getStatus();
    const toolGatewayStatus = this.tools.getStatus();
    const orchestratorStatus = this.orchestrator.getStatus();
    const knowledgeStatus = this.knowledge.getStatus();
    const runtimeHealth = await this.intelligence.runtimeManager.getHealth();

    const availableModels = this.intelligence.registry?.getAvailableModels() ?? [];
    const availableModelIds = availableModels.map((m) => m.id);

    // Resolve primary/fallback model readiness
    const primaryModelId = this.config.primaryModel || availableModelIds[0];
    const fallbackModelId = this.config.fallbackModel || availableModelIds[1];

    let primaryModelReadiness = undefined;
    let fallbackModelReadiness = undefined;

    if (primaryModelId) {
      const check = await this.intelligence.runtimeManager.checkModelReadiness(primaryModelId);
      primaryModelReadiness = check.readiness;
    }
    if (fallbackModelId && fallbackModelId !== primaryModelId) {
      const check = await this.intelligence.runtimeManager.checkModelReadiness(fallbackModelId);
      fallbackModelReadiness = check.readiness;
    }

    const dbOk = storageStatus.status === 'ok';
    const workspaceOk = this.workspaceResult.state === 'WORKSPACE_READY' || this.workspaceResult.state === 'WORKSPACE_CREATED';
    const runtimeReady = runtimeHealth.status === 'READY';
    const hasUsableModel = availableModelIds.length > 0;

    const firstRunState = this.firstRun.determineState({
      configOk: true,
      dbOk,
      workspaceOk,
      runtimeReady,
      hasUsableModel,
    });

    const report = buildFirstRunReport({
      configOk: true,
      storageStatus,
      workspaceResult: this.workspaceResult,
      runtimeHealth,
      availableModelIds,
      primaryModelId,
      primaryModelReadiness,
      fallbackModelId,
      fallbackModelReadiness,
      toolGatewayStatus,
      orchestratorStatus,
      knowledgeStatus,
      firstRunState,
    });

    // Persist first-run completion if workspace is valid
    if (workspaceOk && dbOk) {
      this.firstRun.markFirstRunCompleted(this.workspaceResult.canonicalPath);
    }

    return report;
  }

  getConfig(): AppConfig {
    return this.config;
  }

  getWorkspaceResult(): WorkspaceValidationResult | undefined {
    return this.workspaceResult;
  }

  getActivityTimeline(): Array<{
    id: string;
    type: 'task_created' | 'state_transition' | 'approval_requested' | 'approval_decision' | 'step_executed';
    title: string;
    detail?: string;
    timestamp: string;
  }> {
    const items: Array<{
      id: string;
      type: 'task_created' | 'state_transition' | 'approval_requested' | 'approval_decision' | 'step_executed';
      title: string;
      detail?: string;
      timestamp: string;
    }> = [];

    const tasks = this.tasks?.listTasks() ?? [];
    for (const t of tasks) {
      items.push({
        id: `act-task-${t.id}`,
        type: 'task_created',
        title: `Task Created: "${t.title}"`,
        detail: `Task ID: ${t.id} | State: ${t.state}`,
        timestamp: t.createdAt,
      });

      if (t.completedAt) {
        items.push({
          id: `act-task-comp-${t.id}`,
          type: 'state_transition',
          title: `Task Completed: "${t.title}"`,
          detail: `Task ID: ${t.id}`,
          timestamp: t.completedAt,
        });
      }
    }

    const approvals = this.approvals?.listPendingApprovals() ?? [];
    for (const a of approvals) {
      items.push({
        id: `act-appr-${a.approvalId}`,
        type: 'approval_requested',
        title: `Approval Required: ${a.toolId}`,
        detail: `Risk Level: ${a.riskLevel.toUpperCase()} | Task: ${a.taskId}`,
        timestamp: a.createdAt,
      });
    }

    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return items.slice(0, 50);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    void this.preview?.stop();
    this.storage.close();
  }
}
