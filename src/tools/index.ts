import type { SubsystemStatus } from '../storage/index.js';
import type { AgentTaskService } from '../orchestration/agentTaskService.js';
import type {
  ToolDefinition,
  ToolInvocationRequest,
  ToolInvocationResult,
  ToolExecutionRequest,
  ToolExecutionResult,
  PermissionPolicy,
  AuthorizationResult,
} from './types.js';
import { ToolRegistry } from './toolRegistry.js';
import { PermissionEngine } from './permissionEngine.js';
import { ToolExecutor } from './toolExecutor.js';
import { Logger, LogLevel } from '../common/logger.js';

export * from './types.js';
export * from './approvalTypes.js';
export * from './adapters/terminalTypes.js';
export { ToolRegistry } from './toolRegistry.js';
export { PermissionEngine } from './permissionEngine.js';
export { ToolExecutor } from './toolExecutor.js';
export { ApprovalPolicyEngine } from './approvalPolicyEngine.js';
export { ApprovalGate } from './approvalGate.js';
export { FilesystemAdapter, ReadonlyFilesystemAdapter, calculateContentHash, isSecretFile, generateUnifiedDiff } from './adapters/filesystemAdapter.js';
export { TerminalAdapter, buildSanitizedEnv, validateWorkspaceCwd } from './adapters/terminalAdapter.js';
export { TerminalCommandPolicy } from './adapters/terminalCommandPolicy.js';

export interface IToolGateway {
  initialize(taskService?: AgentTaskService, workspaceRoot?: string): Promise<SubsystemStatus>;
  getStatus(): SubsystemStatus;
  authorizeInvocation(request: ToolInvocationRequest): ToolInvocationResult;
  executeTool(request: ToolExecutionRequest): ToolExecutionResult | Promise<ToolExecutionResult>;
}

export const READONLY_FILESYSTEM_TOOL_DEFINITION: ToolDefinition = {
  id: 'filesystem_read',
  name: 'Workspace File Reader',
  description: 'Safely reads content of files located strictly inside the configured workspace sandbox. READ-ONLY file content inspection. Cannot modify files or create directories.',
  version: '1.0.0',
  category: 'filesystem',
  riskLevel: 'low',
  requiredPermissions: ['filesystem.read'],
  inputSchema: {
    relativePath: {
      type: 'string',
      description: 'Workspace-relative path of file to read',
    },
  },
  enabled: true,
};

export const WORKSPACE_TREE_TOOL_DEFINITION: ToolDefinition = {
  id: 'workspace_tree',
  name: 'Workspace Directory Tree Explorer',
  description: 'Returns a safe, bounded metadata representation of the workspace/project directory tree. READ-ONLY directory/workspace inspection. Strictly read-only: cannot create directories, cannot modify files, cannot create files.',
  version: '1.0.0',
  category: 'filesystem',
  riskLevel: 'low',
  requiredPermissions: ['filesystem.read'],
  inputSchema: {
    path: {
      type: 'string',
      description: 'Workspace-relative directory path to explore (default ".")',
    },
    maxDepth: {
      type: 'number',
      description: 'Maximum directory traversal depth (default 5)',
    },
    maxEntries: {
      type: 'number',
      description: 'Maximum total entries to return (default 500)',
    },
  },
  enabled: true,
};

export const CODE_SEARCH_TOOL_DEFINITION: ToolDefinition = {
  id: 'code_search',
  name: 'Workspace Code Base Search',
  description: 'Searches source files within the workspace using deterministic text matching. READ-ONLY source/code search. Cannot modify files or create directories.',
  version: '1.0.0',
  category: 'filesystem',
  riskLevel: 'low',
  requiredPermissions: ['filesystem.read'],
  inputSchema: {
    query: {
      type: 'string',
      description: 'Text query to search for in source files',
    },
    path: {
      type: 'string',
      description: 'Workspace-relative path to search within (default ".")',
    },
    maxResults: {
      type: 'number',
      description: 'Maximum matching results to return (default 50)',
    },
    fileExtensions: {
      type: 'array',
      description: 'Optional list of file extensions to filter by (e.g. [".ts", ".js"])',
    },
  },
  enabled: true,
};

export const FILESYSTEM_WRITE_TOOL_DEFINITION: ToolDefinition = {
  id: 'filesystem_write',
  name: 'Workspace File Writer',
  description: 'Creates or replaces a file strictly inside the configured workspace sandbox. CREATE/REPLACE file operation. Medium risk, approval required according to P5-F policy.',
  version: '1.0.0',
  category: 'filesystem',
  riskLevel: 'medium',
  requiredPermissions: ['filesystem.write'],
  inputSchema: {
    path: {
      type: 'string',
      description: 'Workspace-relative target file path',
    },
    content: {
      type: 'string',
      description: 'Content to write into the file',
    },
  },
  enabled: true,
};

export const FILESYSTEM_EDIT_TOOL_DEFINITION: ToolDefinition = {
  id: 'filesystem_edit',
  name: 'Workspace File Editor',
  description: 'Applies a deterministic, hash-verified edit to an existing file in the workspace. MODIFY existing file operation. Medium risk, approval required according to P5-F policy.',
  version: '1.0.0',
  category: 'filesystem',
  riskLevel: 'medium',
  requiredPermissions: ['filesystem.write'],
  inputSchema: {
    path: {
      type: 'string',
      description: 'Workspace-relative target file path',
    },
    expectedContentHash: {
      type: 'string',
      description: 'SHA-256 hash of expected current file content',
    },
    oldText: {
      type: 'string',
      description: 'Exact text to replace',
    },
    newText: {
      type: 'string',
      description: 'Replacement text',
    },
    replaceMode: {
      type: 'string',
      description: 'Replacement mode: "single" (default)',
    },
  },
  enabled: true,
};

export const TERMINAL_EXECUTE_TOOL_DEFINITION: ToolDefinition = {
  id: 'terminal_execute',
  name: 'Bounded Terminal Execution Adapter',
  description: 'Executes an explicitly allowed development command inside the configured workspace. High risk, bounded, approval-controlled. Never bypasses PermissionEngine or ApprovalGate.',
  version: '1.0.0',
  category: 'terminal',
  riskLevel: 'high',
  requiredPermissions: ['terminal.execute'],
  inputSchema: {
    command: {
      type: 'string',
      description: 'The executable to run (e.g. "npm", "git", "node")',
    },
    args: {
      type: 'array',
      description: 'Array of command arguments',
    },
    cwd: {
      type: 'string',
      description: 'Optional workspace-relative working directory',
    },
    timeoutMs: {
      type: 'number',
      description: 'Execution timeout in milliseconds (default 30000)',
    },
  },
  enabled: true,
};

export class ToolGateway implements IToolGateway {
  private initialized = false;
  private workspaceRoot = './workspace';
  public registry: ToolRegistry;
  public permissionEngine: PermissionEngine;
  public executor: ToolExecutor | null = null;
  private taskService: AgentTaskService | null = null;
  private logger: Logger;
  private logLevel: LogLevel;

  constructor(
    policy?: PermissionPolicy,
    logLevel: LogLevel = 'info'
  ) {
    this.logLevel = logLevel;
    this.logger = new Logger('ToolGateway', logLevel);
    this.registry = new ToolRegistry(logLevel);
    this.permissionEngine = new PermissionEngine(this.registry, policy, logLevel);
  }

  async initialize(taskService?: AgentTaskService, workspaceRoot: string = './workspace'): Promise<SubsystemStatus> {
    this.workspaceRoot = workspaceRoot;
    if (taskService) {
      this.taskService = taskService;
    }

    // Automatically register tools if not registered
    if (!this.registry.isRegistered(READONLY_FILESYSTEM_TOOL_DEFINITION.id)) {
      this.registry.registerTool(READONLY_FILESYSTEM_TOOL_DEFINITION);
    }
    if (!this.registry.isRegistered(WORKSPACE_TREE_TOOL_DEFINITION.id)) {
      this.registry.registerTool(WORKSPACE_TREE_TOOL_DEFINITION);
    }
    if (!this.registry.isRegistered(CODE_SEARCH_TOOL_DEFINITION.id)) {
      this.registry.registerTool(CODE_SEARCH_TOOL_DEFINITION);
    }
    if (!this.registry.isRegistered(FILESYSTEM_WRITE_TOOL_DEFINITION.id)) {
      this.registry.registerTool(FILESYSTEM_WRITE_TOOL_DEFINITION);
    }
    if (!this.registry.isRegistered(FILESYSTEM_EDIT_TOOL_DEFINITION.id)) {
      this.registry.registerTool(FILESYSTEM_EDIT_TOOL_DEFINITION);
    }
    if (!this.registry.isRegistered(TERMINAL_EXECUTE_TOOL_DEFINITION.id)) {
      this.registry.registerTool(TERMINAL_EXECUTE_TOOL_DEFINITION);
    }

    // Initialize tool executor with workspace sandbox root
    this.executor = new ToolExecutor(workspaceRoot, 2 * 1024 * 1024, this.logLevel);

    this.initialized = true;
    this.logger.info(`ToolGateway & security policy engine fully initialized with workspace root: '${workspaceRoot}'`);
    return this.getStatus();
  }

  /**
   * Register a tool definition with the central registry.
   */
  registerTool(definition: ToolDefinition): void {
    this.registry.registerTool(definition);
  }

  /**
   * Retrieve a registered tool by ID.
   */
  getTool(id: string): ToolDefinition | null {
    return this.registry.getTool(id);
  }

  /**
   * Get workspace root directory path.
   */
  getWorkspaceRoot(): string {
    return this.executor?.getWorkspaceRoot() || this.workspaceRoot;
  }

  /**
   * List all registered tools.
   */
  listTools(): ToolDefinition[] {
    return this.registry.listTools();
  }

  /**
   * Authorize a tool invocation request against security policy and registry.
   * NOTE: Returns authorization status ONLY. Does NOT execute code.
   */
  authorizeInvocation(request: ToolInvocationRequest): ToolInvocationResult {
    const taskExistsFn = this.taskService
      ? (taskId: string) => {
          try {
            return !!this.taskService?.getTask(taskId);
          } catch {
            return false;
          }
        }
      : undefined;

    const authResult: AuthorizationResult = this.permissionEngine.authorize(request, taskExistsFn);

    return {
      requestId: authResult.requestId,
      taskId: authResult.taskId,
      toolId: authResult.toolId,
      authorized: authResult.allowed,
      decision: authResult.decision,
      reason: authResult.reason,
      timestamp: authResult.timestamp,
      executed: false,
    };
  }

  /**
   * Execute an authorized tool request through the secure execution pipeline:
   * Agent Task -> Tool Invocation Request -> Tool Registry -> Permission Engine -> Authorization -> Workspace Validation -> Adapter -> Result.
   *
   * SECURITY GUARANTEE: If authorization is DENIED, execution is NEVER attempted.
   */
  executeTool(request: ToolExecutionRequest): ToolExecutionResult | Promise<ToolExecutionResult> {
    const timestamp = new Date().toISOString();

    // STEP 1: Mandatory P5-B Authorization Check
    const authResult = this.authorizeInvocation({
      requestId: request.requestId,
      taskId: request.taskId,
      toolId: request.toolId,
      requestedCapabilities: request.requestedCapabilities,
      inputMetadata: request.params,
    });

    // STEP 2: Strict Authorization Gate — NO AUTHORIZATION => NO EXECUTION!
    if (!authResult.authorized) {
      this.logger.warn(`Tool execution blocked: authorization denied`, {
        requestId: request.requestId,
        taskId: request.taskId,
        toolId: request.toolId,
        reason: authResult.reason,
      });

      return {
        requestId: request.requestId,
        taskId: request.taskId,
        toolId: request.toolId,
        authorized: false,
        executed: false, // NO EXECUTION OCCURRED!
        success: false,
        decision: authResult.decision,
        errorCategory: 'PERMISSION_DENIED',
        errorMessage: authResult.reason,
        timestamp,
      };
    }

    // STEP 3: Execute tool via Executor
    if (!this.executor) {
      return {
        requestId: request.requestId,
        taskId: request.taskId,
        toolId: request.toolId,
        authorized: true,
        executed: false,
        success: false,
        decision: 'ALLOWED',
        errorCategory: 'EXECUTOR_UNINITIALIZED',
        errorMessage: 'ToolGateway executor is uninitialized. Call initialize() first.',
        timestamp,
      };
    }

    const execResult = this.executor.execute(request);

    if (execResult instanceof Promise) {
      return execResult.then((res) => ({
        requestId: res.requestId,
        taskId: res.taskId,
        toolId: res.toolId,
        authorized: true,
        executed: res.executed,
        success: res.success,
        decision: 'ALLOWED',
        errorCategory: res.errorCategory,
        errorMessage: res.errorMessage,
        output: res.output,
        timestamp: res.timestamp,
      }));
    }

    return {
      requestId: execResult.requestId,
      taskId: execResult.taskId,
      toolId: execResult.toolId,
      authorized: true,
      executed: execResult.executed,
      success: execResult.success,
      decision: 'ALLOWED',
      errorCategory: execResult.errorCategory,
      errorMessage: execResult.errorMessage,
      output: execResult.output,
      timestamp: execResult.timestamp,
    };
  }

  getStatus(): SubsystemStatus {
    return {
      name: 'ToolGateway',
      initialized: this.initialized,
      status: this.initialized ? 'ok' : 'degraded',
      message: this.initialized
        ? `Tool gateway & security policy engine ready (${this.registry.listTools().length} tools registered)`
        : 'Uninitialized',
    };
  }
}
