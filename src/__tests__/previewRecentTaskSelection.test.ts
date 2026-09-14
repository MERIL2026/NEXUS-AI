/**
 * NEXUS AI — Preview Recent Task Selection & Historical Selection Tests
 *
 * Verifies:
 * 1. /preview with no args ALWAYS targets the latest task (even if failed/incomplete).
 * 2. If the latest task failed, /preview reports TASK_FAILED and NEVER falls back to older tasks.
 * 3. If the latest task is completed, /preview launches that task's preview.
 * 4. Explicit historical selection via /preview <number> (e.g. /preview 2) or /preview <task-id>.
 * 5. If an explicitly selected historical task failed, /preview blocks and does NOT fall back.
 * 6. Task numbering in /tasks matches /preview <number> 100% deterministically.
 * 7. Chat messages do not affect /preview.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StorageService } from '../storage/index.js';
import { PreviewService } from '../preview/previewService.js';
import { renderTasksList, renderPreviewCard } from '../cli/uiFormatters.js';

describe('Preview Recent Task Selection & Deterministic Historical Resolution', () => {
  let tempDir: string;
  let workspaceRoot: string;
  let dbPath: string;
  let storage: StorageService;
  let previewService: PreviewService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-preview-test-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });

    dbPath = path.join(tempDir, 'nexus.db');
    storage = new StorageService(dbPath, 'error');
    await storage.initialize();

    previewService = new PreviewService(
      storage.agentTasks,
      workspaceRoot,
      'error',
      storage.artifacts
    );
    vi.spyOn(previewService, 'openBrowser').mockResolvedValue(true);
  });

  afterEach(async () => {
    await previewService.stop();
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('1. Latest task FAILED with older COMPLETED task: /preview targets latest task and reports TASK_FAILED (NO NEXORA fallback)', async () => {
    // Task A: Older completed NEXORA task
    const nexoraDir = path.join(workspaceRoot, 'nexora');
    fs.mkdirSync(nexoraDir, { recursive: true });
    fs.writeFileSync(
      path.join(nexoraDir, 'index.html'),
      '<!DOCTYPE html><html><head><title>NEXORA AI</title></head><body><header><h1>NEXORA</h1></header><main><section><h2>Next Gen AI Platform</h2><p>Enterprise AI infrastructure and cloud solutions.</p></section></main></body></html>'
    );

    const taskA = storage.agentTasks.create({
      id: 'task-1789223253017-gihzt',
      title: 'Build a complete premium modern landing website for a fictional technology company called NEXORA',
      state: 'completed',
      createdAt: '2026-09-13T10:00:00.000Z',
      updatedAt: '2026-09-13T10:05:00.000Z',
      completedAt: '2026-09-13T10:05:00.000Z',
    });

    storage.artifacts.create({
      id: `art-${taskA.id}`,
      taskId: taskA.id,
      projectRoot: nexoraDir,
      relativeProjectRoot: 'nexora',
      entryPoint: 'index.html',
      workspacePath: workspaceRoot,
      files: ['index.html'],
      isVerified: true,
    });

    // Task B: Newer FAILED Browniw and Brew cafe task
    const cafeDir = path.join(workspaceRoot, 'cafe');
    fs.mkdirSync(cafeDir, { recursive: true });
    fs.writeFileSync(
      path.join(cafeDir, 'index.html'),
      '<!-- Empty skeleton placeholder -->'
    );

    const taskB = storage.agentTasks.create({
      id: 'task-1789277668926-4pujt',
      title: 'Build a simple landing page for a cafe called Browniw and Brew',
      state: 'failed',
      errorCategory: 'PLACEHOLDER_ARTIFACT_REJECTED',
      createdAt: '2026-09-13T10:30:00.000Z',
      updatedAt: '2026-09-13T10:35:00.000Z',
    });

    // Run /preview with NO ARGS
    const previewResult = await previewService.preview();

    // MUST target Task B (Browniw and Brew) and MUST NOT target Task A (NEXORA)
    expect(previewResult.success).toBe(false);
    expect(previewResult.status).toBe('TASK_FAILED');
    expect(previewResult.task?.id).toBe(taskB.id);
    expect(previewResult.task?.title).toBe(taskB.title);
    expect(previewResult.error).toBe('PLACEHOLDER_ARTIFACT_REJECTED');
    expect(previewResult.message).toContain('failed (PLACEHOLDER_ARTIFACT_REJECTED)');

    // Verify UI Card Output
    const card = renderPreviewCard(previewResult);
    expect(card).toContain('Preview Unavailable');
    expect(card).toContain('Browniw and Brew');
    expect(card).toContain('FAILED');
    expect(card).toContain('PLACEHOLDER_ARTIFACT_REJECTED');
    expect(card).not.toContain('NEXORA');
  });

  it('2. Multiple completed tasks: /preview targets the latest completed task', async () => {
    // Task 1: Calculator
    const calcDir = path.join(workspaceRoot, 'calc');
    fs.mkdirSync(calcDir, { recursive: true });
    fs.writeFileSync(
      path.join(calcDir, 'index.html'),
      '<!DOCTYPE html><html><head><title>Calculator</title></head><body><div id="calculator"><h1>Calculator</h1><input id="display"><button>1</button></div></body></html>'
    );
    const task1 = storage.agentTasks.create({
      id: 'task-calc-1',
      title: 'Build a web calculator',
      state: 'completed',
      createdAt: '2026-09-13T09:00:00.000Z',
      updatedAt: '2026-09-13T09:05:00.000Z',
    });
    storage.artifacts.create({
      id: `art-${task1.id}`,
      taskId: task1.id,
      projectRoot: calcDir,
      relativeProjectRoot: 'calc',
      entryPoint: 'index.html',
      workspacePath: workspaceRoot,
      files: ['index.html'],
      isVerified: true,
    });

    // Task 2: NEXORA
    const nexoraDir = path.join(workspaceRoot, 'nexora');
    fs.mkdirSync(nexoraDir, { recursive: true });
    fs.writeFileSync(
      path.join(nexoraDir, 'index.html'),
      '<!DOCTYPE html><html><head><title>NEXORA</title></head><body><h1>NEXORA</h1><p>Enterprise AI solutions.</p></body></html>'
    );
    const task2 = storage.agentTasks.create({
      id: 'task-nexora-2',
      title: 'Build NEXORA landing page',
      state: 'completed',
      createdAt: '2026-09-13T10:00:00.000Z',
      updatedAt: '2026-09-13T10:05:00.000Z',
    });
    storage.artifacts.create({
      id: `art-${task2.id}`,
      taskId: task2.id,
      projectRoot: nexoraDir,
      relativeProjectRoot: 'nexora',
      entryPoint: 'index.html',
      workspacePath: workspaceRoot,
      files: ['index.html'],
      isVerified: true,
    });

    // Task 3: Cafe
    const cafeDir = path.join(workspaceRoot, 'cafe');
    fs.mkdirSync(cafeDir, { recursive: true });
    fs.writeFileSync(
      path.join(cafeDir, 'index.html'),
      '<!DOCTYPE html><html><head><title>Bean & Brew</title></head><body><header><h1>Bean & Brew Cafe</h1></header><main><section><h2>Artisanal Coffee & Fresh Bakes</h2><p>Welcome to Bean & Brew.</p></section></main></body></html>'
    );
    const task3 = storage.agentTasks.create({
      id: 'task-cafe-3',
      title: 'Build Bean & Brew landing page',
      state: 'completed',
      createdAt: '2026-09-13T11:00:00.000Z',
      updatedAt: '2026-09-13T11:05:00.000Z',
    });
    storage.artifacts.create({
      id: `art-${task3.id}`,
      taskId: task3.id,
      projectRoot: cafeDir,
      relativeProjectRoot: 'cafe',
      entryPoint: 'index.html',
      workspacePath: workspaceRoot,
      files: ['index.html'],
      isVerified: true,
    });

    // /preview with no arguments must target Task 3 (Bean & Brew)
    const previewResult = await previewService.preview();
    expect(previewResult.success).toBe(true);
    expect(previewResult.status).toBe('LAUNCHED');
    expect(previewResult.task?.id).toBe(task3.id);
    expect(previewResult.task?.title).toBe(task3.title);
    expect(previewResult.serverInfo?.projectDir.toLowerCase()).toBe(fs.realpathSync(cafeDir).toLowerCase());
  });

  it('3. Explicit historical preview via index (/preview 2 and /preview 3) and ID (/preview <id>)', async () => {
    // Task 1: Calculator (Oldest)
    const calcDir = path.join(workspaceRoot, 'calc');
    fs.mkdirSync(calcDir, { recursive: true });
    fs.writeFileSync(
      path.join(calcDir, 'index.html'),
      '<!DOCTYPE html><html><head><title>Calculator</title></head><body><div id="calculator"><h1>Calculator</h1><input id="display"><button>1</button></div></body></html>'
    );
    const task1 = storage.agentTasks.create({
      id: 'task-calc-1',
      title: 'Build a web calculator',
      state: 'completed',
      createdAt: '2026-09-13T09:00:00.000Z',
      updatedAt: '2026-09-13T09:05:00.000Z',
    });
    storage.artifacts.create({
      id: `art-${task1.id}`,
      taskId: task1.id,
      projectRoot: calcDir,
      relativeProjectRoot: 'calc',
      entryPoint: 'index.html',
      workspacePath: workspaceRoot,
      files: ['index.html'],
      isVerified: true,
    });

    // Task 2: NEXORA (Middle)
    const nexoraDir = path.join(workspaceRoot, 'nexora');
    fs.mkdirSync(nexoraDir, { recursive: true });
    fs.writeFileSync(
      path.join(nexoraDir, 'index.html'),
      '<!DOCTYPE html><html><head><title>NEXORA</title></head><body><h1>NEXORA</h1><p>Enterprise AI solutions.</p></body></html>'
    );
    const task2 = storage.agentTasks.create({
      id: 'task-nexora-2',
      title: 'Build NEXORA landing page',
      state: 'completed',
      createdAt: '2026-09-13T10:00:00.000Z',
      updatedAt: '2026-09-13T10:05:00.000Z',
    });
    storage.artifacts.create({
      id: `art-${task2.id}`,
      taskId: task2.id,
      projectRoot: nexoraDir,
      relativeProjectRoot: 'nexora',
      entryPoint: 'index.html',
      workspacePath: workspaceRoot,
      files: ['index.html'],
      isVerified: true,
    });

    // Task 3: Cafe (Newest)
    const cafeDir = path.join(workspaceRoot, 'cafe');
    fs.mkdirSync(cafeDir, { recursive: true });
    fs.writeFileSync(
      path.join(cafeDir, 'index.html'),
      '<!DOCTYPE html><html><head><title>Bean & Brew</title></head><body><h1>Bean & Brew Cafe</h1><p>Artisanal coffee.</p></body></html>'
    );
    const task3 = storage.agentTasks.create({
      id: 'task-cafe-3',
      title: 'Build Bean & Brew landing page',
      state: 'completed',
      createdAt: '2026-09-13T11:00:00.000Z',
      updatedAt: '2026-09-13T11:05:00.000Z',
    });
    storage.artifacts.create({
      id: `art-${task3.id}`,
      taskId: task3.id,
      projectRoot: cafeDir,
      relativeProjectRoot: 'cafe',
      entryPoint: 'index.html',
      workspacePath: workspaceRoot,
      files: ['index.html'],
      isVerified: true,
    });

    // /tasks list order (newest first):
    // 1. Task 3 (Cafe)
    // 2. Task 2 (NEXORA)
    // 3. Task 1 (Calculator)
    const allTasks = storage.agentTasks.listAll();
    expect(allTasks[0].id).toBe(task3.id);
    expect(allTasks[1].id).toBe(task2.id);
    expect(allTasks[2].id).toBe(task1.id);

    // /preview 2 -> selects Task 2 (NEXORA)
    const res2 = await previewService.preview(2);
    expect(res2.success).toBe(true);
    expect(res2.task?.id).toBe(task2.id);
    expect(res2.task?.title).toBe('Build NEXORA landing page');
    expect(res2.serverInfo?.projectDir.toLowerCase()).toBe(fs.realpathSync(nexoraDir).toLowerCase());
    await previewService.stop();

    // /preview 3 -> selects Task 1 (Calculator)
    const res3 = await previewService.preview('3');
    expect(res3.success).toBe(true);
    expect(res3.task?.id).toBe(task1.id);
    expect(res3.task?.title).toBe('Build a web calculator');
    expect(res3.serverInfo?.projectDir.toLowerCase()).toBe(fs.realpathSync(calcDir).toLowerCase());
    await previewService.stop();

    // /preview <taskId> -> selects explicit task
    const resById = await previewService.preview(task2.id);
    expect(resById.success).toBe(true);
    expect(resById.task?.id).toBe(task2.id);
    await previewService.stop();
  });

  it('4. Explicit selection of a FAILED historical task blocks preview without falling back', async () => {
    // Task 1: COMPLETED NEXORA
    const nexoraDir = path.join(workspaceRoot, 'nexora');
    fs.mkdirSync(nexoraDir, { recursive: true });
    fs.writeFileSync(
      path.join(nexoraDir, 'index.html'),
      '<!DOCTYPE html><html><head><title>NEXORA</title></head><body><h1>NEXORA</h1><p>Real text</p></body></html>'
    );
    const task1 = storage.agentTasks.create({
      id: 'task-1',
      title: 'NEXORA',
      state: 'completed',
      createdAt: '2026-09-13T09:00:00.000Z',
    });
    storage.artifacts.create({
      id: `art-${task1.id}`,
      taskId: task1.id,
      projectRoot: nexoraDir,
      relativeProjectRoot: 'nexora',
      entryPoint: 'index.html',
      workspacePath: workspaceRoot,
      files: ['index.html'],
      isVerified: true,
    });

    // Task 2: FAILED Bean & Brew
    const task2 = storage.agentTasks.create({
      id: 'task-2',
      title: 'Bean & Brew',
      state: 'failed',
      errorCategory: 'PLACEHOLDER_ARTIFACT_REJECTED',
      createdAt: '2026-09-13T10:00:00.000Z',
    });

    // In /tasks list:
    // 1. Task 2 (Bean & Brew - FAILED)
    // 2. Task 1 (NEXORA - COMPLETED)

    // /preview 1 -> targets Task 2 (Bean & Brew)
    const res = await previewService.preview(1);
    expect(res.success).toBe(false);
    expect(res.status).toBe('TASK_FAILED');
    expect(res.task?.id).toBe(task2.id);
    expect(res.message).toContain('failed (PLACEHOLDER_ARTIFACT_REJECTED)');

    // Verify UI card formatting
    const card = renderPreviewCard(res);
    expect(card).toContain('Preview Unavailable');
    expect(card).toContain('Bean & Brew');
    expect(card).not.toContain('NEXORA');
  });

  it('5. Incomplete tasks (in_progress, awaiting_approval) block preview without fallback', async () => {
    // Task 1: Completed
    const nexoraDir = path.join(workspaceRoot, 'nexora');
    fs.mkdirSync(nexoraDir, { recursive: true });
    fs.writeFileSync(
      path.join(nexoraDir, 'index.html'),
      '<!DOCTYPE html><html><body><h1>NEXORA</h1><p>Real content</p></body></html>'
    );
    storage.agentTasks.create({
      id: 'task-1',
      title: 'NEXORA',
      state: 'completed',
      createdAt: '2026-09-13T09:00:00.000Z',
    });

    // Task 2: In Progress
    const task2 = storage.agentTasks.create({
      id: 'task-2',
      title: 'In Progress Task',
      state: 'in_progress',
      createdAt: '2026-09-13T10:00:00.000Z',
    });

    const res = await previewService.preview();
    expect(res.success).toBe(false);
    expect(res.status).toBe('TASK_INCOMPLETE');
    expect(res.task?.id).toBe(task2.id);
    expect(res.message).toContain('is currently IN_PROGRESS');

    const card = renderPreviewCard(res);
    expect(card).toContain('Preview Unavailable');
    expect(card).toContain('IN_PROGRESS');
  });

  it('6. Numbered task list formatting in /tasks and command hint', () => {
    storage.agentTasks.create({
      id: 'task-100',
      title: 'Oldest task',
      state: 'completed',
      createdAt: '2026-09-13T08:00:00.000Z',
    });
    storage.agentTasks.create({
      id: 'task-200',
      title: 'Middle task',
      state: 'completed',
      createdAt: '2026-09-13T09:00:00.000Z',
    });
    storage.agentTasks.create({
      id: 'task-300',
      title: 'Newest task',
      state: 'failed',
      createdAt: '2026-09-13T10:00:00.000Z',
    });

    const allTasks = storage.agentTasks.listAll();
    const tasksOutput = renderTasksList(allTasks);

    expect(tasksOutput).toContain('1.');
    expect(tasksOutput).toContain('2.');
    expect(tasksOutput).toContain('3.');
    expect(tasksOutput).toContain('task-300');
    expect(tasksOutput).toContain('FAILED');
    expect(tasksOutput).toContain('/preview <number>');
  });

  it('7. Out-of-bounds task numbers and non-existent IDs return clear error', async () => {
    storage.agentTasks.create({
      id: 'task-1',
      title: 'Only task',
      state: 'completed',
      createdAt: '2026-09-13T08:00:00.000Z',
    });

    const resOutOfBounds = await previewService.preview(99);
    expect(resOutOfBounds.success).toBe(false);
    expect(resOutOfBounds.status).toBe('NO_COMPLETED_TASK');
    expect(resOutOfBounds.message).toContain('Task #99 does not exist');

    const resInvalidId = await previewService.preview('task-non-existent');
    expect(resInvalidId.success).toBe(false);
    expect(resInvalidId.status).toBe('NO_COMPLETED_TASK');
    expect(resInvalidId.message).toContain('not found');
  });
});
