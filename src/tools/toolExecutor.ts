import type { ToolExecutionRequest, ToolExecutionResult } from './types.js';
import { FilesystemAdapter } from './adapters/filesystemAdapter.js';
import { TerminalAdapter } from './adapters/terminalAdapter.js';
import { TerminalCommandPolicy } from './adapters/terminalCommandPolicy.js';
import type { TerminalExecuteParams } from './adapters/terminalTypes.js';
import { Logger, LogLevel } from '../common/logger.js';

export class ToolExecutor {
  private fsAdapter: FilesystemAdapter;
  private terminalAdapter: TerminalAdapter;
  private terminalPolicy: TerminalCommandPolicy;
  private logger: Logger;
  private workspaceRoot: string;

  constructor(
    workspaceRoot: string,
    maxFileSize: number = 2 * 1024 * 1024,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('ToolExecutor', logLevel);
    this.workspaceRoot = workspaceRoot;
    this.fsAdapter = new FilesystemAdapter(workspaceRoot, maxFileSize, logLevel);
    this.terminalAdapter = new TerminalAdapter(workspaceRoot, logLevel);
    this.terminalPolicy = new TerminalCommandPolicy(logLevel);
  }

  /**
   * Get the workspace root directory path.
   */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Get the underlying filesystem adapter (useful for testing or direct sandbox checks).
   */
  getFilesystemAdapter(): FilesystemAdapter {
    return this.fsAdapter;
  }

  /**
   * Execute an authorized tool request.
   *
   * @param request Authorized ToolExecutionRequest.
   * @returns Normalized ToolExecutionResult contract.
   */
  execute(
    request: ToolExecutionRequest
  ): Omit<ToolExecutionResult, 'authorized' | 'decision'> | Promise<Omit<ToolExecutionResult, 'authorized' | 'decision'>> {
    const timestamp = new Date().toISOString();

    // Handler 1: filesystem_read / fs_read_tool
    if (request.toolId === 'filesystem_read' || request.toolId === 'fs_read_tool') {
      const relativePath = request.params?.relativePath ?? request.params?.path;

      if (typeof relativePath !== 'string') {
        this.logger.warn(`Execution failed: invalid parameter`, {
          requestId: request.requestId,
          taskId: request.taskId,
          toolId: request.toolId,
          errorCategory: 'INVALID_INPUT',
        });

        return {
          requestId: request.requestId,
          taskId: request.taskId,
          toolId: request.toolId,
          executed: true,
          success: false,
          errorCategory: 'INVALID_INPUT',
          errorMessage: "Tool parameter 'relativePath' or 'path' must be a non-empty string.",
          timestamp,
        };
      }

      const readResult = this.fsAdapter.readFile(relativePath);

      if (!readResult.success) {
        this.logger.warn(`Tool execution failed`, {
          requestId: request.requestId,
          taskId: request.taskId,
          toolId: request.toolId,
          errorCategory: readResult.errorCategory,
        });

        return {
          requestId: request.requestId,
          taskId: request.taskId,
          toolId: request.toolId,
          executed: true,
          success: false,
          errorCategory: readResult.errorCategory,
          errorMessage: readResult.errorMessage,
          timestamp,
        };
      }

      this.logger.info(`Tool execution succeeded`, {
        requestId: request.requestId,
        taskId: request.taskId,
        toolId: request.toolId,
        bytes: readResult.bytes,
      });

      return {
        requestId: request.requestId,
        taskId: request.taskId,
        toolId: request.toolId,
        executed: true,
        success: true,
        output: {
          content: readResult.content,
          bytes: readResult.bytes,
          relativePath: readResult.relativePath,
        },
        timestamp,
      };
    }

    // Handler 2: workspace_tree (P6-A)
    if (request.toolId === 'workspace_tree') {
      const relPath = typeof request.params?.path === 'string' && request.params.path.trim() !== ''
        ? request.params.path.trim()
        : '.';
      const maxDepth = typeof request.params?.maxDepth === 'number' ? request.params.maxDepth : undefined;
      const maxEntries = typeof request.params?.maxEntries === 'number' ? request.params.maxEntries : undefined;

      const treeResult = this.fsAdapter.getWorkspaceTree(relPath, { maxDepth, maxEntries });

      if (!treeResult.success) {
        this.logger.warn(`workspace_tree tool execution failed`, {
          requestId: request.requestId,
          taskId: request.taskId,
          errorCategory: treeResult.errorCategory,
        });

        return {
          requestId: request.requestId,
          taskId: request.taskId,
          toolId: request.toolId,
          executed: true,
          success: false,
          errorCategory: treeResult.errorCategory,
          errorMessage: treeResult.errorMessage,
          timestamp,
        };
      }

      this.logger.info(`workspace_tree tool execution succeeded`, {
        requestId: request.requestId,
        taskId: request.taskId,
        totalEntries: treeResult.totalEntries,
        truncated: treeResult.truncated,
      });

      return {
        requestId: request.requestId,
        taskId: request.taskId,
        toolId: request.toolId,
        executed: true,
        success: true,
        output: {
          root: treeResult.root,
          entries: treeResult.entries,
          totalEntries: treeResult.totalEntries,
          truncated: treeResult.truncated,
        },
        timestamp,
      };
    }

    // Handler 3: code_search (P6-A)
    if (request.toolId === 'code_search') {
      const query = typeof request.params?.query === 'string' ? request.params.query : '';
      const relPath = typeof request.params?.path === 'string' ? request.params.path : '.';
      const maxResults = typeof request.params?.maxResults === 'number' ? request.params.maxResults : undefined;
      const fileExtensions = Array.isArray(request.params?.fileExtensions)
        ? (request.params.fileExtensions as string[])
        : undefined;

      if (!query.trim()) {
        return {
          requestId: request.requestId,
          taskId: request.taskId,
          toolId: request.toolId,
          executed: true,
          success: false,
          errorCategory: 'INVALID_INPUT',
          errorMessage: "Tool parameter 'query' must be a non-empty string.",
          timestamp,
        };
      }

      const searchResult = this.fsAdapter.searchCode(query, relPath, { maxResults, fileExtensions });

      if (!searchResult.success) {
        this.logger.warn(`code_search tool execution failed`, {
          requestId: request.requestId,
          taskId: request.taskId,
          errorCategory: searchResult.errorCategory,
        });

        return {
          requestId: request.requestId,
          taskId: request.taskId,
          toolId: request.toolId,
          executed: true,
          success: false,
          errorCategory: searchResult.errorCategory,
          errorMessage: searchResult.errorMessage,
          timestamp,
        };
      }

      this.logger.info(`code_search tool execution succeeded`, {
        requestId: request.requestId,
        taskId: request.taskId,
        totalMatches: searchResult.totalMatches,
        filesSearched: searchResult.filesSearched,
        truncated: searchResult.truncated,
      });

      return {
        requestId: request.requestId,
        taskId: request.taskId,
        toolId: request.toolId,
        executed: true,
        success: true,
        output: {
          query: searchResult.query,
          results: searchResult.results,
          totalMatches: searchResult.totalMatches,
          filesSearched: searchResult.filesSearched,
          truncated: searchResult.truncated,
        },
        timestamp,
      };
    }

    // Handler 4: filesystem_write (P6-B)
    if (request.toolId === 'filesystem_write') {
      const relPath =
        typeof request.params?.relativePath === 'string' && request.params.relativePath.trim() !== ''
          ? request.params.relativePath.trim()
          : typeof request.params?.path === 'string'
          ? request.params.path.trim()
          : '';
      const content = typeof request.params?.content === 'string' ? request.params.content : undefined;

      if (!relPath || content === undefined) {
        return {
          requestId: request.requestId,
          taskId: request.taskId,
          toolId: request.toolId,
          executed: true,
          success: false,
          errorCategory: 'INVALID_INPUT',
          errorMessage: "Tool parameters 'relativePath' (or 'path') and 'content' must be specified.",
          timestamp,
        };
      }

      const writeResult = this.fsAdapter.writeFile(relPath, content);

      if (!writeResult.success) {
        this.logger.warn(`filesystem_write tool execution failed`, {
          requestId: request.requestId,
          taskId: request.taskId,
          errorCategory: writeResult.errorCategory,
        });

        return {
          requestId: request.requestId,
          taskId: request.taskId,
          toolId: request.toolId,
          executed: true,
          success: false,
          errorCategory: writeResult.errorCategory,
          errorMessage: writeResult.errorMessage,
          timestamp,
        };
      }

      this.logger.info(`filesystem_write tool execution succeeded`, {
        requestId: request.requestId,
        taskId: request.taskId,
        path: writeResult.path,
        bytesWritten: writeResult.bytesWritten,
      });

      return {
        requestId: request.requestId,
        taskId: request.taskId,
        toolId: request.toolId,
        executed: true,
        success: true,
        output: {
          path: writeResult.path,
          bytesWritten: writeResult.bytesWritten,
          created: writeResult.created,
          diff: writeResult.diff,
        },
        timestamp,
      };
    }

    // Handler 5: filesystem_edit (P6-B)
    if (request.toolId === 'filesystem_edit') {
      const relPath =
        typeof request.params?.relativePath === 'string' && request.params.relativePath.trim() !== ''
          ? request.params.relativePath.trim()
          : typeof request.params?.path === 'string'
          ? request.params.path.trim()
          : '';
      const expectedContentHash = typeof request.params?.expectedContentHash === 'string' ? request.params.expectedContentHash : '';
      const oldText = typeof request.params?.oldText === 'string' ? request.params.oldText : '';
      const newText = typeof request.params?.newText === 'string' ? request.params.newText : '';
      const replaceMode = typeof request.params?.replaceMode === 'string' ? request.params.replaceMode : 'single';

      if (!relPath || !expectedContentHash || !oldText || newText === undefined) {
        return {
          requestId: request.requestId,
          taskId: request.taskId,
          toolId: request.toolId,
          executed: true,
          success: false,
          errorCategory: 'INVALID_INPUT',
          errorMessage: "Tool parameters 'path', 'expectedContentHash', 'oldText', and 'newText' are required.",
          timestamp,
        };
      }

      const editResult = this.fsAdapter.editFile(relPath, expectedContentHash, oldText, newText, replaceMode);

      if (!editResult.success) {
        this.logger.warn(`filesystem_edit tool execution failed`, {
          requestId: request.requestId,
          taskId: request.taskId,
          errorCategory: editResult.errorCategory,
        });

        return {
          requestId: request.requestId,
          taskId: request.taskId,
          toolId: request.toolId,
          executed: true,
          success: false,
          errorCategory: editResult.errorCategory,
          errorMessage: editResult.errorMessage,
          timestamp,
        };
      }

      this.logger.info(`filesystem_edit tool execution succeeded`, {
        requestId: request.requestId,
        taskId: request.taskId,
        path: editResult.path,
        bytesWritten: editResult.bytesWritten,
      });

      return {
        requestId: request.requestId,
        taskId: request.taskId,
        toolId: request.toolId,
        executed: true,
        success: true,
        output: {
          path: editResult.path,
          bytesWritten: editResult.bytesWritten,
          diff: editResult.diff,
        },
        timestamp,
      };
    }

    // Handler 6: terminal_execute (P6-C)
    if (request.toolId === 'terminal_execute') {
      const command = typeof request.params?.command === 'string' ? request.params.command : '';
      const args = Array.isArray(request.params?.args)
        ? (request.params.args as string[])
        : [];
      const cwd = typeof request.params?.cwd === 'string' ? request.params.cwd : undefined;
      const timeoutMs = typeof request.params?.timeoutMs === 'number' ? request.params.timeoutMs : undefined;
      const maxStdoutBytes = typeof request.params?.maxStdoutBytes === 'number' ? request.params.maxStdoutBytes : undefined;
      const maxStderrBytes = typeof request.params?.maxStderrBytes === 'number' ? request.params.maxStderrBytes : undefined;

      const params: TerminalExecuteParams = {
        command,
        args,
        cwd,
        timeoutMs,
        maxStdoutBytes,
        maxStderrBytes,
      };

      // 1. Evaluate against TerminalCommandPolicy
      const policyResult = this.terminalPolicy.evaluate(params);

      if (!policyResult.allowed) {
        this.logger.warn(`terminal_execute command policy rejected`, {
          requestId: request.requestId,
          taskId: request.taskId,
          decision: policyResult.decision,
          reason: policyResult.reason,
        });

        return {
          requestId: request.requestId,
          taskId: request.taskId,
          toolId: request.toolId,
          executed: true,
          success: false,
          errorCategory: policyResult.decision as string,
          errorMessage: policyResult.reason,
          timestamp,
        };
      }

      // 2. Dispatch to TerminalAdapter
      const resolvedCommand = policyResult.resolvedCommand || command;
      const resolvedArgs = policyResult.resolvedArgs || args;

      return (async () => {
        const termResult = await this.terminalAdapter.execute(resolvedCommand, resolvedArgs, params);

        if (!termResult.success) {
          this.logger.warn(`terminal_execute tool execution failed`, {
            requestId: request.requestId,
            taskId: request.taskId,
            exitCode: termResult.exitCode,
            signal: termResult.signal,
            timedOut: termResult.timedOut,
            errorCategory: termResult.errorCategory,
          });
        } else {
          this.logger.info(`terminal_execute tool execution succeeded`, {
            requestId: request.requestId,
            taskId: request.taskId,
            durationMs: termResult.durationMs,
          });
        }

        return {
          requestId: request.requestId,
          taskId: request.taskId,
          toolId: request.toolId,
          executed: true,
          success: termResult.success,
          errorCategory: termResult.errorCategory,
          errorMessage: termResult.errorMessage,
          output: {
            success: termResult.success,
            exitCode: termResult.exitCode,
            signal: termResult.signal,
            stdout: termResult.stdout,
            stderr: termResult.stderr,
            stdoutTruncated: termResult.stdoutTruncated,
            stderrTruncated: termResult.stderrTruncated,
            durationMs: termResult.durationMs,
            timedOut: termResult.timedOut,
            cancelled: termResult.cancelled,
          },
          timestamp,
        };
      })();
    }

    // Default: unsupported tool execution
    this.logger.warn(`Execution rejected: unsupported tool handler`, {
      requestId: request.requestId,
      taskId: request.taskId,
      toolId: request.toolId,
      errorCategory: 'UNSUPPORTED_TOOL_OPERATION',
    });

    return {
      requestId: request.requestId,
      taskId: request.taskId,
      toolId: request.toolId,
      executed: false,
      success: false,
      errorCategory: 'UNSUPPORTED_TOOL_OPERATION',
      errorMessage: `Tool '${request.toolId}' does not have an active execution handler configured.`,
      timestamp,
    };
  }

  /**
   * Get the underlying terminal adapter.
   */
  getTerminalAdapter(): TerminalAdapter {
    return this.terminalAdapter;
  }

  /**
   * Get the underlying terminal command policy.
   */
  getTerminalPolicy(): TerminalCommandPolicy {
    return this.terminalPolicy;
  }
}
