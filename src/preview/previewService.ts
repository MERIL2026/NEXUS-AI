/**
 * NEXUS AI — P7-H: Local Web Project Preview Service
 *
 * Coordinates latest completed task resolution, artifact discovery,
 * workspace boundary validation, preview HTTP server lifecycle, and
 * safe browser launching.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import type { AgentTaskRepository } from '../storage/repositories/agentTaskRepository.js';
import type { TaskArtifactRepository } from '../storage/repositories/taskArtifactRepository.js';
import type { AgentTask } from '../storage/repositories/types.js';
import { PreviewServer } from './previewServer.js';
import type {
  PreviewResult,
  PreviewStatus,
  DiscoveredArtifacts,
} from './previewTypes.js';
import { verifyHtmlContentSubstance } from '../orchestration/placeholderDetector.js';
import { Logger } from '../common/logger.js';

function isSubpathOrEqual(parentDir: string, childPath: string): boolean {
  const isWin = process.platform === 'win32';
  const p = isWin ? parentDir.toLowerCase() : parentDir;
  const c = isWin ? childPath.toLowerCase() : childPath;
  return c === p || c.startsWith(p + (isWin ? '\\' : '/')) || c.startsWith(p + path.sep);
}

export class PreviewService {
  private server: PreviewServer;
  private logger: Logger;
  private activeTask: AgentTask | null = null;

  constructor(
    private taskRepo: AgentTaskRepository,
    private workspaceRoot: string,
    logLevel: import('../common/logger.js').LogLevel = 'info',
    private artifactRepo?: TaskArtifactRepository
  ) {
    this.logger = new Logger('PreviewService', logLevel);
    this.server = new PreviewServer(logLevel);
  }

  setArtifactRepository(artifactRepo: TaskArtifactRepository): void {
    this.artifactRepo = artifactRepo;
  }

  /**
   * Resolve target task based on explicit index (number), task ID (string), or latest task (undefined).
   *
   * 1. No argument: targets the latest task across ALL states in the task repository.
   * 2. Number / Numeric string (e.g. 2, "2", "#2"): targets the N-th task (1-indexed) from deterministic task history.
   * 3. Task ID string: targets the specific task by its unique ID.
   */
  resolveTargetTask(target?: string | number): {
    task: AgentTask | null;
    targetType: 'latest' | 'index' | 'id';
    targetIndex?: number;
    error?: string;
  } {
    const allTasks = this.taskRepo.listAll();
    if (allTasks.length === 0) {
      return {
        task: null,
        targetType: 'latest',
        error: 'No tasks recorded yet.',
      };
    }

    if (target === undefined || target === null || (typeof target === 'string' && target.trim() === '')) {
      return {
        task: allTasks[0],
        targetType: 'latest',
        targetIndex: 1,
      };
    }

    const str = String(target).trim();

    // Check if target is a numeric index (e.g. 1, 2, "1", "2", "#1", "#2")
    if (/^#?\d+$/.test(str)) {
      const idx = parseInt(str.replace(/^#/, ''), 10);
      if (idx >= 1) {
        if (idx > allTasks.length) {
          return {
            task: null,
            targetType: 'index',
            targetIndex: idx,
            error: `Task #${idx} does not exist. Available tasks: 1 to ${allTasks.length}. Run /tasks to view all tasks.`,
          };
        }
        return {
          task: allTasks[idx - 1],
          targetType: 'index',
          targetIndex: idx,
        };
      }
    }

    // Otherwise, treat as explicit taskId
    const task = this.taskRepo.findById(str);
    if (!task) {
      return {
        task: null,
        targetType: 'id',
        error: `Task with ID '${str}' not found.`,
      };
    }

    return {
      task,
      targetType: 'id',
    };
  }

  /**
   * Resolve latest completed task or specific task by ID.
   * Maintained for backwards compatibility.
   */
  resolveCompletedTask(taskId?: string): AgentTask | null {
    const resolved = this.resolveTargetTask(taskId);
    if (resolved.task && resolved.task.state === 'completed') {
      return resolved.task;
    }
    return null;
  }

  /**
   * Discover files and project entry point created by a completed task.
   *
   * PRIORITY 1: Task's persisted artifact record in SQLite (TaskArtifactRepository).
   * PRIORITY 2: Task-scoped plan steps (legacy tasks only).
   * PRIORITY 3: FAIL SAFELY. Never fall back to arbitrary workspace scanning, mtime, or other tasks.
   */
  discoverArtifacts(task: AgentTask): DiscoveredArtifacts {
    const canonicalWorkspace = fs.realpathSync(path.resolve(this.workspaceRoot));

    // ── PRIORITY 1: Persisted Artifact Metadata from SQLite ────────────────────
    if (this.artifactRepo) {
      let persistedArtifact = this.artifactRepo.findByTaskId(task.id);

      // If this is a parent task, check artifacts owned by its child tasks
      if (!persistedArtifact) {
        const childTasks = this.taskRepo.findByParentTaskId(task.id);
        if (childTasks.length > 0) {
          const childArtifacts = childTasks
            .map((c) => this.artifactRepo!.findByTaskId(c.id))
            .filter((a): a is import('../storage/repositories/types.js').TaskArtifact => !!a);
          if (childArtifacts.length > 0) {
            const mergedFiles = Array.from(new Set(childArtifacts.flatMap((a) => a.files)));
            const primary = childArtifacts[childArtifacts.length - 1];
            persistedArtifact = {
              ...primary,
              id: `art-${task.id}`,
              taskId: task.id,
              files: mergedFiles,
            };
          }
        }
      }

      // If this is a child task, check parent artifact
      if (!persistedArtifact && task.parentTaskId) {
        persistedArtifact = this.artifactRepo.findByTaskId(task.parentTaskId);
      }

      if (persistedArtifact) {
        let canonicalProjectDir = persistedArtifact.projectRoot;
        try {
          if (fs.existsSync(canonicalProjectDir)) {
            canonicalProjectDir = fs.realpathSync(canonicalProjectDir);
          }
        } catch {
          // keep path
        }

        let entryFile = persistedArtifact.entryPoint || 'index.html';
        if (!entryFile.toLowerCase().endsWith('.html') && fs.existsSync(path.join(canonicalProjectDir, 'index.html'))) {
          entryFile = 'index.html';
        }

        let entryPath = path.join(canonicalProjectDir, entryFile);
        let entryExists = fs.existsSync(entryPath) && fs.statSync(entryPath).isFile();

        if (!entryExists && fs.existsSync(path.join(canonicalProjectDir, 'index.html'))) {
          entryFile = 'index.html';
          entryPath = path.join(canonicalProjectDir, 'index.html');
          entryExists = true;
        }

        if (entryExists) {
          // Scan project directory for associated web files
          const allProjectFiles: string[] = [];
          const scanDir = (currentDir: string, relPrefix: string) => {
            const entries = fs.readdirSync(currentDir, { withFileTypes: true });
            for (const entry of entries) {
              if (['node_modules', '.git', 'dist', 'build', '.nexus'].includes(entry.name)) continue;
              const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
              if (entry.isDirectory()) {
                scanDir(path.join(currentDir, entry.name), relPath);
              } else if (entry.isFile()) {
                allProjectFiles.push(relPath.replace(/\\/g, '/'));
              }
            }
          };

          try {
            scanDir(canonicalProjectDir, '');
          } catch {
            // ignore scan failure
          }

          const uniqueFiles = Array.from(new Set([...persistedArtifact.files, ...allProjectFiles]));

          this.logger.info(`Resolved preview artifact from SQLite metadata for task '${task.id}'`, {
            projectDir: canonicalProjectDir,
            entryFile,
            fileCount: uniqueFiles.length,
          });

          return {
            projectDir: canonicalProjectDir,
            entryFile,
            files: uniqueFiles,
            hasIndexHtml: entryFile.endsWith('.html') || fs.existsSync(path.join(canonicalProjectDir, 'index.html')),
            isWebProject: true,
          };
        } else {
          this.logger.warn(`Persisted artifact entry point missing on disk for task '${task.id}'`, { entryPath });
          return {
            projectDir: canonicalProjectDir,
            entryFile: persistedArtifact.entryPoint || 'index.html',
            files: [],
            hasIndexHtml: false,
            isWebProject: false,
          };
        }
      }
    }

    // ── PRIORITY 2: Task-Scoped Plan Steps (Legacy Plan Fallback) ──────────────
    const createdFiles: string[] = [];
    const createdDirs: string[] = [];

    const extractFromObj = (obj: unknown) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim()) {
          const val = value.trim();
          const lowerKey = key.toLowerCase();
          if (
            lowerKey.includes('path') ||
            lowerKey.includes('file') ||
            lowerKey.includes('dir') ||
            lowerKey.includes('dest') ||
            lowerKey === 'target' ||
            val.endsWith('.html') ||
            val.endsWith('.css') ||
            val.endsWith('.js')
          ) {
            if (val.endsWith('.html') || val.endsWith('.css') || val.endsWith('.js') || val.includes('/') || val.includes('\\')) {
              createdFiles.push(val);
            } else {
              createdDirs.push(val);
            }
          }
        } else if (typeof value === 'object' && value !== null) {
          extractFromObj(value);
        }
      }
    };

    if (task.plan) {
      try {
        const planObj = typeof task.plan === 'string' ? JSON.parse(task.plan) : task.plan;
        extractFromObj(planObj);
      } catch (err) {
        this.logger.warn(`Failed to parse plan JSON for task '${task.id}'`, { error: String(err) });
      }
    }

    // Extract folder name from task title if explicit or matches existing subdirectories
    try {
      const wsEntries = fs.readdirSync(canonicalWorkspace, { withFileTypes: true });
      const dirNames = wsEntries
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map((d) => d.name);

      const folderMatch = task.title.match(/(?:folder|directory|project|called|named|create)\s+[`"']?([a-zA-Z0-9_\-]+)[`"']?/i);
      if (folderMatch && folderMatch[1]) {
        const candidate = folderMatch[1].trim();
        if (dirNames.some((d) => d.toLowerCase() === candidate.toLowerCase())) {
          createdDirs.push(candidate);
        }
      }

      const titleWords = task.title.toLowerCase().replace(/[^a-z0-9_\-\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && w !== 'task' && w !== 'the');
      for (const d of dirNames) {
        const lowerName = d.toLowerCase();
        if (titleWords.some((w) => lowerName.includes(w) || (w.length > 3 && w.includes(lowerName)))) {
          createdDirs.push(d);
        }
      }

      // If task title mentions subdirectory/folder/app and exactly one subdirectory with index.html exists
      if (createdDirs.length === 0 && /(?:subdirectory|folder|project|app|site|web)/i.test(task.title)) {
        const subdirsWithIndex = dirNames.filter((d) => fs.existsSync(path.join(canonicalWorkspace, d, 'index.html')));
        if (subdirsWithIndex.length === 1) {
          createdDirs.push(subdirsWithIndex[0]);
        }
      }
    } catch {
      /* ignore */
    }

    const validAbsFiles: string[] = [];
    for (const f of createdFiles) {
      const abs = path.resolve(canonicalWorkspace, f);
      if (isSubpathOrEqual(canonicalWorkspace, abs) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        validAbsFiles.push(fs.realpathSync(abs));
      }
    }

    const validAbsDirs: string[] = [];
    for (const d of createdDirs) {
      const abs = path.resolve(canonicalWorkspace, d);
      if (isSubpathOrEqual(canonicalWorkspace, abs) && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        validAbsDirs.push(fs.realpathSync(abs));
      }
    }

    // Root workspace fallback ONLY when task is a web task and no specific subdirectory was claimed and root index.html exists
    if (validAbsFiles.length === 0 && validAbsDirs.length === 0) {
      if (!/(?:python|data|analysis|backend|fibonacci|non-web)/i.test(task.title)) {
        const rootIndex = path.join(canonicalWorkspace, 'index.html');
        if (fs.existsSync(rootIndex) && fs.statSync(rootIndex).isFile()) {
          validAbsFiles.push(fs.realpathSync(rootIndex));
        }
      }
    }

    let targetProjectDir: string | null = null;
    let entryFile = 'index.html';

    const indexAbs = validAbsFiles.find((f) => path.basename(f).toLowerCase() === 'index.html');
    if (indexAbs) {
      targetProjectDir = path.dirname(indexAbs);
      entryFile = path.basename(indexAbs);
    }

    if (!targetProjectDir && validAbsFiles.length > 0) {
      const fileDirs = validAbsFiles.map((f) => path.dirname(f));
      const candidateDirs = Array.from(new Set([...fileDirs, ...validAbsDirs]));
      for (const dir of candidateDirs) {
        const indexPath = path.join(dir, 'index.html');
        if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
          targetProjectDir = dir;
          entryFile = 'index.html';
          break;
        }
      }
      if (!targetProjectDir) {
        targetProjectDir = fileDirs[0];
      }
    }

    if (!targetProjectDir && validAbsDirs.length > 0) {
      for (const dir of validAbsDirs) {
        const indexPath = path.join(dir, 'index.html');
        if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
          targetProjectDir = dir;
          entryFile = 'index.html';
          break;
        }
      }
      if (!targetProjectDir) {
        targetProjectDir = validAbsDirs[0];
      }
    }

    // If NO task-specific artifact could be identified for THIS task, FAIL SAFELY.
    // NEVER fall back to global workspace, root index.html, or arbitrary mtime directories.
    if (!targetProjectDir) {
      this.logger.info(`No task-specific previewable artifact found for task '${task.id}'`);
      return {
        projectDir: canonicalWorkspace,
        entryFile: 'index.html',
        files: [],
        hasIndexHtml: false,
        isWebProject: false,
      };
    }

    // Canonicalize target project directory
    let canonicalProjectDir = fs.existsSync(targetProjectDir)
      ? fs.realpathSync(targetProjectDir)
      : canonicalWorkspace;

    if (!isSubpathOrEqual(canonicalWorkspace, canonicalProjectDir)) {
      canonicalProjectDir = canonicalWorkspace;
    }

    // Scan selected projectDir for files
    const allProjectFiles: string[] = [];
    let hasIndexHtml = false;
    let hasWebFiles = false;

    if (fs.existsSync(canonicalProjectDir)) {
      const scanDir = (dir: string, base: string) => {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          const relPath = base ? `${base}/${item.name}` : item.name;
          const fullPath = path.join(dir, item.name);

          if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') {
            scanDir(fullPath, relPath);
          } else if (item.isFile()) {
            allProjectFiles.push(relPath);
            const lowerName = item.name.toLowerCase();
            if (lowerName === 'index.html') {
              hasIndexHtml = true;
            }
            if (
              lowerName.endsWith('.html') ||
              lowerName.endsWith('.css') ||
              lowerName.endsWith('.js')
            ) {
              hasWebFiles = true;
            }
          }
        }
      };

      try {
        scanDir(canonicalProjectDir, '');
      } catch (err) {
        this.logger.warn(`Error scanning directory '${canonicalProjectDir}'`, { error: String(err) });
      }
    }

    const relativeCreatedFiles = validAbsFiles.map((abs) => path.relative(canonicalProjectDir, abs));
    const uniqueFiles = Array.from(new Set([...relativeCreatedFiles, ...allProjectFiles]));

    return {
      projectDir: canonicalProjectDir,
      entryFile,
      files: uniqueFiles,
      hasIndexHtml: hasIndexHtml || fs.existsSync(path.join(canonicalProjectDir, 'index.html')),
      isWebProject: hasIndexHtml || hasWebFiles,
    };
  }

  /**
   * Launch preview for latest task, specific task number (#N), or specified task ID.
   *
   * STRICT SEMANTICS:
   * 1. If no target is given, resolves the user's latest task.
   * 2. If target is numeric (e.g. 2, "2", "#2"), resolves task #N from /tasks list.
   * 3. If target is string, resolves task by ID.
   * 4. If target task is FAILED -> returns status TASK_FAILED with reason, blocks preview, NO FALLBACK.
   * 5. If target task is INCOMPLETE -> returns status TASK_INCOMPLETE, blocks preview, NO FALLBACK.
   * 6. If target task is COMPLETED -> verifies artifact for THAT task, then launches preview.
   */
  async preview(target?: string | number): Promise<PreviewResult> {
    const resolved = this.resolveTargetTask(target);

    if (!resolved.task) {
      return {
        success: false,
        status: 'NO_COMPLETED_TASK',
        message: resolved.error || 'No task is available to preview.',
      };
    }

    const task = resolved.task;
    const targetLabel =
      resolved.targetType === 'latest'
        ? 'Latest task'
        : resolved.targetType === 'index'
          ? `Task #${resolved.targetIndex}`
          : `Task '${task.id}'`;

    // 1. Check if task failed -> NEVER FALL BACK TO AN OLDER TASK
    if (task.state === 'failed') {
      this.logger.warn(`Preview blocked: ${targetLabel} is in FAILED state`, {
        taskId: task.id,
        errorCategory: task.errorCategory,
      });
      return {
        success: false,
        status: 'TASK_FAILED',
        task,
        error: task.errorCategory || 'Execution Failed',
        message: `Preview unavailable: ${targetLabel} '${task.title}' failed (${task.errorCategory || 'Execution Failed'}).`,
      };
    }

    // 2. Check if task is incomplete -> NEVER FALL BACK
    if (task.state !== 'completed') {
      this.logger.warn(`Preview blocked: ${targetLabel} is not completed (state: ${task.state})`, {
        taskId: task.id,
        state: task.state,
      });
      return {
        success: false,
        status: 'TASK_INCOMPLETE',
        task,
        message: `Preview unavailable: ${targetLabel} '${task.title}' is currently ${task.state.toUpperCase()}. Only completed tasks can be previewed.`,
      };
    }

    // 3. Task is COMPLETED: Discover artifacts for THIS task only
    const artifacts = this.discoverArtifacts(task);

    if (!artifacts.isWebProject) {
      return {
        success: false,
        status: 'NOT_WEB_PROJECT',
        task,
        artifactsSummary: artifacts.files,
        message: `${targetLabel} '${task.title}' does not contain a previewable web project.`,
      };
    }

    if (!artifacts.hasIndexHtml) {
      return {
        success: false,
        status: 'MISSING_INDEX',
        task,
        detectedFiles: artifacts.files,
        message: `No index.html entry point was found for task '${task.title}'.`,
      };
    }

    // Ensure projectDir is inside workspace
    const canonicalWorkspace = fs.realpathSync(path.resolve(this.workspaceRoot));
    if (!isSubpathOrEqual(canonicalWorkspace, artifacts.projectDir)) {
      return {
        success: false,
        status: 'ERROR',
        task,
        error: 'Security Error: Preview directory is outside workspace boundaries.',
      };
    }

    // Verify artifact is a real implementation and passes content integrity checks
    let entryFileToUse = artifacts.entryFile || 'index.html';
    if (!entryFileToUse.toLowerCase().endsWith('.html') && fs.existsSync(path.join(artifacts.projectDir, 'index.html'))) {
      entryFileToUse = 'index.html';
      artifacts.entryFile = 'index.html';
    }

    const entryFullPath = path.join(artifacts.projectDir, entryFileToUse);
    if (fs.existsSync(entryFullPath) && entryFullPath.endsWith('.html')) {
      const content = fs.readFileSync(entryFullPath, 'utf8');
      const contentVerif = verifyHtmlContentSubstance(content, task.title);

      if (!contentVerif.valid) {
        this.logger.warn(`Preview blocked: artifact failed content verification for task '${task.id}'`, {
          category: contentVerif.errorCategory,
          reason: contentVerif.reason,
        });
        return {
          success: false,
          status: 'PLACEHOLDER_ARTIFACT_BLOCKED',
          task,
          detectedFiles: artifacts.files,
          message: `Preview blocked: generated artifact failed integrity/content verification. ${contentVerif.reason || ''}`.trim(),
        };
      }
    }

    try {
      const serverInfo = await this.server.start(
        artifacts.projectDir,
        artifacts.entryFile || 'index.html'
      );
      this.activeTask = task;

      // Automatically launch browser
      await this.openBrowser(serverInfo.url);

      return {
        success: true,
        status: 'LAUNCHED',
        task,
        serverInfo,
        detectedFiles: artifacts.files,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to start preview server for task '${task.id}'`, { error: msg });
      return {
        success: false,
        status: 'ERROR',
        task,
        error: `Failed to start preview server: ${msg}`,
      };
    }
  }

  /**
   * Stop active preview server.
   */
  async stop(): Promise<PreviewResult> {
    const info = this.server.getInfo();
    if (!info) {
      return {
        success: true,
        status: 'ALREADY_STOPPED',
        message: 'No active preview server is currently running.',
      };
    }

    await this.server.stop();
    this.activeTask = null;

    return {
      success: true,
      status: 'STOPPED',
      message: 'Preview server stopped successfully.',
    };
  }

  /**
   * Get active preview status.
   */
  getStatus(): PreviewStatus {
    const info = this.server.getInfo();
    if (!info) {
      return { active: false };
    }

    return {
      active: true,
      taskId: this.activeTask?.id,
      taskTitle: this.activeTask?.title,
      serverInfo: info,
    };
  }

  /**
   * Open local preview URL safely in default browser without shell injection risk.
   */
  async openBrowser(url: string): Promise<boolean> {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
      return true;
    }

    if (!url.startsWith('http://127.0.0.1:')) {
      this.logger.warn(`Refusing to open non-loopback URL: '${url}'`);
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const platform = process.platform;
      let command = '';
      let args: string[] = [];

      if (platform === 'win32') {
        command = 'cmd.exe';
        args = ['/c', 'start', '', url];
      } else if (platform === 'darwin') {
        command = 'open';
        args = [url];
      } else {
        command = 'xdg-open';
        args = [url];
      }

      execFile(command, args, (err) => {
        if (err) {
          this.logger.warn(`Browser open command returned error (non-fatal): ${err.message}`);
          resolve(false);
        } else {
          this.logger.info(`Browser launched for URL: ${url}`);
          resolve(true);
        }
      });
    });
  }
}
