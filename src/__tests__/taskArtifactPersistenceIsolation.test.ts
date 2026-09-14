import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StorageService } from '../storage/index.js';
import { PreviewService } from '../preview/previewService.js';
import { AgentExecutionService } from '../orchestration/agentExecutionService.js';
import { AgentTaskService } from '../orchestration/agentTaskService.js';
import { PlanSynthesisService } from '../orchestration/planner.js';
import { ToolGateway } from '../tools/index.js';
import { IntelligenceService } from '../intelligence/index.js';

function completeTaskDirectly(taskService: AgentTaskService, taskId: string): void {
  taskService.transitionTask(taskId, { targetState: 'planning' });
  taskService.transitionTask(taskId, { targetState: 'executing' });
  taskService.transitionTask(taskId, { targetState: 'observing' });
  taskService.transitionTask(taskId, { targetState: 'verifying' });
  taskService.completeTask(taskId);
}

describe('Agent Artifact Persistence & Workspace Preview Isolation', () => {
  let tmpDir: string;
  let dbPath: string;
  let workspaceRoot: string;
  let storage: StorageService;
  let taskService: AgentTaskService;
  let previewService: PreviewService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-artifact-test-'));
    dbPath = path.join(tmpDir, 'nexus-test.db');
    workspaceRoot = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });

    storage = new StorageService(dbPath, 'error');
    await storage.initialize();

    taskService = new AgentTaskService(storage.agentTasks, storage.artifacts, 'error');
    previewService = new PreviewService(storage.agentTasks, workspaceRoot, 'error', storage.artifacts);
  });

  afterEach(async () => {
    if (previewService) {
      await previewService.stop();
    }
    if (storage) {
      storage.close();
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('persists artifact metadata into SQLite task_artifacts table upon registration', () => {
    const task = taskService.createTask('Build a modern cafe landing page for Bean & Brew');
    expect(task.id).toBeDefined();

    const cafeDir = path.join(workspaceRoot, 'cafe-landing-page');
    fs.mkdirSync(cafeDir, { recursive: true });
    fs.writeFileSync(path.join(cafeDir, 'index.html'), '<html><body><h1>Bean & Brew Cafe</h1></body></html>', 'utf-8');
    fs.writeFileSync(path.join(cafeDir, 'style.css'), 'body { background: #6F4E37; }', 'utf-8');

    const artifact = taskService.registerArtifact({
      taskId: task.id,
      projectRoot: cafeDir,
      relativeProjectRoot: 'cafe-landing-page',
      entryPoint: 'index.html',
      files: ['index.html', 'style.css'],
      artifactType: 'static-html',
      workspacePath: workspaceRoot,
      isVerified: true,
    });

    expect(artifact).not.toBeNull();
    expect(artifact?.id).toBeDefined();
    expect(artifact?.taskId).toBe(task.id);
    expect(artifact?.projectRoot).toBe(cafeDir);
    expect(artifact?.entryPoint).toBe('index.html');
    expect(artifact?.files).toEqual(['index.html', 'style.css']);

    // Retrieve from repository
    const found = storage.artifacts.findByTaskId(task.id);
    expect(found).not.toBeNull();
    expect(found?.taskId).toBe(task.id);
    expect(found?.projectRoot).toBe(cafeDir);
    expect(found?.isVerified).toBe(true);
  });

  it('CRITICAL: current task preview must never fall back to unrelated calculator artifact', async () => {
    // 1. Manually create a stale calculator project in workspace with a NEWER timestamp
    const oldCalcDir = path.join(workspaceRoot, 'calculator');
    fs.mkdirSync(oldCalcDir, { recursive: true });
    fs.writeFileSync(
      path.join(oldCalcDir, 'index.html'),
      '<!DOCTYPE html><html><head><title>Old Calculator</title></head><body><div class="calculator">0</div></body></html>',
      'utf-8',
    );

    // 2. Create and execute Task B: "Build a modern landing page for a cafe called Bean & Brew"
    const cafeTask = taskService.createTask('Build a modern landing page for a cafe called Bean & Brew');
    const cafeProjectDir = path.join(workspaceRoot, 'cafe-landing-page');
    fs.mkdirSync(cafeProjectDir, { recursive: true });
    const cafeHtml = '<!DOCTYPE html><html><head><title>Bean & Brew Cafe</title></head><body><h1>Welcome to Bean & Brew</h1></body></html>';
    fs.writeFileSync(path.join(cafeProjectDir, 'index.html'), cafeHtml, 'utf-8');
    fs.writeFileSync(path.join(cafeProjectDir, 'style.css'), 'body { color: brown; }', 'utf-8');

    // Register verified artifact for cafe task
    taskService.registerArtifact({
      taskId: cafeTask.id,
      projectRoot: cafeProjectDir,
      relativeProjectRoot: 'cafe-landing-page',
      entryPoint: 'index.html',
      files: ['index.html', 'style.css'],
      artifactType: 'static-html',
      workspacePath: workspaceRoot,
      isVerified: true,
    });

    completeTaskDirectly(taskService, cafeTask.id);

    // 3. Make calculator timestamp NEWER than cafe landing page
    const futureTime = new Date(Date.now() + 100000);
    fs.utimesSync(path.join(oldCalcDir, 'index.html'), futureTime, futureTime);

    // 4. Request preview for latest completed task
    const previewResult = await previewService.preview();

    expect(previewResult.success).toBe(true);
    expect(previewResult.status).toBe('LAUNCHED');
    expect(previewResult.task?.id).toBe(cafeTask.id);
    expect(previewResult.serverInfo?.projectDir).toBe(cafeProjectDir);
    expect(previewResult.serverInfo?.url).toBeDefined();

    // Fetch the previewed URL and verify content is Bean & Brew, NOT Calculator
    const res = await fetch(previewResult.serverInfo!.url);
    const text = await res.text();
    expect(text).toContain('Bean & Brew');
    expect(text).not.toContain('Old Calculator');
    expect(text).not.toContain('calculator');
  });

  it('maintains cross-task isolation between sequential projects (Calculator, Cafe, Portfolio)', async () => {
    // Project A: Calculator
    const taskA = taskService.createTask('Build a modern calculator web application');
    const dirA = path.join(workspaceRoot, 'calculator-app');
    fs.mkdirSync(dirA, { recursive: true });
    fs.writeFileSync(path.join(dirA, 'index.html'), '<html><body><h1>Smart Calculator</h1></body></html>', 'utf-8');
    taskService.registerArtifact({
      taskId: taskA.id,
      projectRoot: dirA,
      relativeProjectRoot: 'calculator-app',
      entryPoint: 'index.html',
      files: ['index.html'],
      artifactType: 'static-html',
      workspacePath: workspaceRoot,
      isVerified: true,
    });
    completeTaskDirectly(taskService, taskA.id);

    // Project B: Cafe Landing Page
    const taskB = taskService.createTask('Build a landing page for Bean & Brew cafe');
    const dirB = path.join(workspaceRoot, 'cafe-app');
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirB, 'index.html'), '<html><body><h1>Bean & Brew Cafe</h1></body></html>', 'utf-8');
    taskService.registerArtifact({
      taskId: taskB.id,
      projectRoot: dirB,
      relativeProjectRoot: 'cafe-app',
      entryPoint: 'index.html',
      files: ['index.html'],
      artifactType: 'static-html',
      workspacePath: workspaceRoot,
      isVerified: true,
    });
    completeTaskDirectly(taskService, taskB.id);

    // Project C: Developer Portfolio
    const taskC = taskService.createTask('Build a personal portfolio landing page for a developer');
    const dirC = path.join(workspaceRoot, 'portfolio-app');
    fs.mkdirSync(dirC, { recursive: true });
    fs.writeFileSync(path.join(dirC, 'index.html'), '<html><body><h1>Jane Doe Developer Portfolio</h1></body></html>', 'utf-8');
    taskService.registerArtifact({
      taskId: taskC.id,
      projectRoot: dirC,
      relativeProjectRoot: 'portfolio-app',
      entryPoint: 'index.html',
      files: ['index.html'],
      artifactType: 'static-html',
      workspacePath: workspaceRoot,
      isVerified: true,
    });
    completeTaskDirectly(taskService, taskC.id);

    // Preview Project B explicitly by task ID
    const previewB = await previewService.preview(taskB.id);
    expect(previewB.success).toBe(true);
    expect(previewB.serverInfo?.projectDir).toBe(dirB);
    let res = await fetch(previewB.serverInfo!.url);
    let body = await res.text();
    expect(body).toContain('Bean & Brew Cafe');
    expect(body).not.toContain('Smart Calculator');
    expect(body).not.toContain('Jane Doe');

    // Preview Project A explicitly by task ID
    const previewA = await previewService.preview(taskA.id);
    expect(previewA.success).toBe(true);
    expect(previewA.serverInfo?.projectDir).toBe(dirA);
    res = await fetch(previewA.serverInfo!.url);
    body = await res.text();
    expect(body).toContain('Smart Calculator');
    expect(body).not.toContain('Bean & Brew');

    // Default preview (latest completed = Task C)
    const previewLatest = await previewService.preview();
    expect(previewLatest.success).toBe(true);
    expect(previewLatest.serverInfo?.projectDir).toBe(dirC);
    res = await fetch(previewLatest.serverInfo!.url);
    body = await res.text();
    expect(body).toContain('Jane Doe Developer Portfolio');
  }, 15000);

  it('fails safely when artifact directory is missing or deleted', async () => {
    const task = taskService.createTask('Build a modern web app');
    const ghostDir = path.join(workspaceRoot, 'ghost-project');
    fs.mkdirSync(ghostDir, { recursive: true });
    fs.writeFileSync(path.join(ghostDir, 'index.html'), '<html><body>Ghost</body></html>', 'utf-8');

    taskService.registerArtifact({
      taskId: task.id,
      projectRoot: ghostDir,
      relativeProjectRoot: 'ghost-project',
      entryPoint: 'index.html',
      files: ['index.html'],
      artifactType: 'static-html',
      workspacePath: workspaceRoot,
      isVerified: true,
    });
    completeTaskDirectly(taskService, task.id);

    // Delete the project directory
    fs.rmSync(ghostDir, { recursive: true, force: true });

    // Preview should fail safely and NOT pick another project
    const result = await previewService.preview(task.id);
    expect(result.success).toBe(false);
    expect(result.status).toBe('NOT_WEB_PROJECT');
    expect(result.message).toContain('does not contain a previewable web project');
  });

  it('survives restart and persists task artifact association across StorageService re-instantiation', async () => {
    const task = taskService.createTask('Build cafe landing page');
    const cafeDir = path.join(workspaceRoot, 'cafe-site');
    fs.mkdirSync(cafeDir, { recursive: true });
    fs.writeFileSync(path.join(cafeDir, 'index.html'), '<html><body><h1>Persistent Bean & Brew</h1></body></html>', 'utf-8');

    taskService.registerArtifact({
      taskId: task.id,
      projectRoot: cafeDir,
      relativeProjectRoot: 'cafe-site',
      entryPoint: 'index.html',
      files: ['index.html'],
      artifactType: 'static-html',
      workspacePath: workspaceRoot,
      isVerified: true,
    });
    completeTaskDirectly(taskService, task.id);

    // Simulate restart: close storage, create new storage and preview service
    storage.close();

    const restartStorage = new StorageService(dbPath, 'error');
    await restartStorage.initialize();

    const restartPreview = new PreviewService(restartStorage.agentTasks, workspaceRoot, 'error', restartStorage.artifacts);
    const result = await restartPreview.preview(task.id);

    expect(result.success).toBe(true);
    expect(result.serverInfo?.projectDir.toLowerCase()).toBe(fs.realpathSync(cafeDir).toLowerCase());
    const res = await fetch(result.serverInfo!.url);
    const text = await res.text();
    expect(text).toContain('Persistent Bean & Brew');

    await restartPreview.stop();
    restartStorage.close();
  });

  it('verifies real filesystem artifacts and registers them during agent execution loop', async () => {
    const task = taskService.createTask('Build a modern landing page for a cafe called Bean & Brew');

    const tools = new ToolGateway(undefined, 'error');
    await tools.initialize(taskService, workspaceRoot);

    const intel = new IntelligenceService('http://127.0.0.1:59999', 'error');
    await intel.initialize(storage.models);
    const modelGateway = intel.gateway;

    const planner = new PlanSynthesisService(modelGateway, tools, 'error');
    const executionService = new AgentExecutionService(
      taskService,
      tools,
      undefined,
      'error',
    );

    const planResult = await planner.synthesize(task.id, { taskGoal: task.title });
    expect(planResult.success).toBe(true);
    expect(planResult.plan?.steps.length).toBeGreaterThan(0);

    const completedTask = await executionService.runExecutionLoop(task.id, planResult.plan!.steps);
    expect(completedTask.state).toBe('completed');

    // Verify artifact is registered in SQLite
    const artifact = storage.artifacts.findByTaskId(task.id);
    expect(artifact).not.toBeNull();
    expect(artifact?.isVerified).toBe(true);
    expect(artifact?.entryPoint).toBe('index.html');
    expect(fs.existsSync(artifact!.projectRoot)).toBe(true);

    // Verify index.html contains cafe content
    const indexPath = path.join(artifact!.projectRoot, 'index.html');
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content.toLowerCase()).toContain('bean & brew');

    // Verify preview serves this verified project
    const previewResult = await previewService.preview(task.id);
    expect(previewResult.success).toBe(true);
    expect(previewResult.serverInfo?.projectDir).toBe(artifact!.projectRoot);
    const res = await fetch(previewResult.serverInfo!.url);
    const text = await res.text();
    expect(text).toContain('Bean & Brew');

    await previewService.stop();
  }, 30000);
});
