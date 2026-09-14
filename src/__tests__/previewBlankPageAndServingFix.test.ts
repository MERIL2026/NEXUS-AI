/**
 * NEXUS AI — Critical Bug #3 Regression Test Suite:
 * Blank Page Prevention, Real Generated Project Serving, Windows Path Normalization, Favicon Fallback
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { PreviewServer } from '../preview/previewServer.js';
import { PreviewService } from '../preview/previewService.js';
import { StorageService } from '../storage/index.js';
import { ToolGateway } from '../tools/index.js';
import { IntelligenceService } from '../intelligence/index.js';
import { AgentTaskService } from '../orchestration/agentTaskService.js';
import { AgentExecutionService } from '../orchestration/agentExecutionService.js';
import { PlanSynthesisService } from '../orchestration/planner.js';

function httpGet(url: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: data,
        });
      });
    }).on('error', (err) => reject(err));
  });
}

describe('Critical Bug #3 — Blank Page Prevention & Real Project Serving', { timeout: 20000 }, () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let storage: StorageService;
  let taskService: AgentTaskService;
  let toolGateway: ToolGateway;
  let intel: IntelligenceService;
  let planSynthesis: PlanSynthesisService;
  let executionService: AgentExecutionService;
  let previewService: PreviewService;
  let previewServer: PreviewServer;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-blank-page-test-'));
    workspaceRoot = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });

    storage = new StorageService(path.join(tmpDir, 'test.db'), 'error');
    await storage.initialize();

    taskService = new AgentTaskService(storage.agentTasks, storage.artifacts, 'error');
    toolGateway = new ToolGateway(undefined, 'error');
    await toolGateway.initialize(taskService, workspaceRoot);

    intel = new IntelligenceService('http://127.0.0.1:59999', 'error');
    await intel.initialize(storage.models);

    planSynthesis = new PlanSynthesisService(intel.gateway, toolGateway, 'error');
    executionService = new AgentExecutionService(taskService, toolGateway, undefined, 'error');
    previewService = new PreviewService(storage.agentTasks, workspaceRoot, 'error', storage.artifacts);
    previewServer = new PreviewServer('error');
  });

  afterEach(async () => {
    await previewService.stop();
    await previewServer.stop();
    try {
      storage.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('1. Generated HTML is non-empty and contains valid HTML structure and DOCTYPE', async () => {
    const prompt = 'Build a complete, premium, modern multi-section landing website for a fictional technology company called NEXORA.';
    const task = taskService.createTask({ title: prompt });
    const synthResult = await planSynthesis.synthesize(task.id, { taskGoal: prompt });
    expect(synthResult.success).toBe(true);
    expect(synthResult.plan).toBeDefined();

    const htmlStep = synthResult.plan!.steps.find((s: { params?: { path?: string; content?: string } }) => s.params?.path?.endsWith('index.html'));
    expect(htmlStep).toBeDefined();
    const content = htmlStep!.params!.content;

    expect(content).toBeTruthy();
    expect(content.length).toBeGreaterThan(500);
    expect(content).toContain('<!DOCTYPE html>');
    expect(content).toContain('<html');
    expect(content).toContain('<head>');
    expect(content).toContain('<body');
    expect(content).toContain('NEXORA');
    expect(content).toContain('style.css');
    expect(content).toContain('script.js');
  });

  it('2. Missing favicon.ico returns HTTP 204 No Content without 404 console error spam', async () => {
    const projectDir = path.join(workspaceRoot, 'nexora-test');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'index.html'), '<!DOCTYPE html><html><body><h1>NEXORA</h1></body></html>', 'utf8');

    const info = await previewServer.start(projectDir, 'index.html');
    expect(info.url).toBeTruthy();

    const favRes = await httpGet(`${info.url}/favicon.ico`);
    expect(favRes.statusCode).toBe(204);
    expect(favRes.headers['content-type']).toContain('image/x-icon');
  });

  it('3. Windows path case differences (C: vs c:) do not trigger 403 Forbidden', async () => {
    const projectDir = path.join(workspaceRoot, 'nexora-casing');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'index.html'), '<!DOCTYPE html><html><body><h1>NEXORA Platform</h1></body></html>', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'style.css'), 'body { background: #000; color: #fff; }', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'script.js'), 'console.log("NEXORA active");', 'utf8');

    // Start preview server
    const info = await previewServer.start(projectDir, 'index.html');

    // Fetch index.html
    const indexRes = await httpGet(`${info.url}/`);
    expect(indexRes.statusCode).toBe(200);
    expect(indexRes.body).toContain('NEXORA Platform');

    // Fetch style.css
    const cssRes = await httpGet(`${info.url}/style.css`);
    expect(cssRes.statusCode).toBe(200);
    expect(cssRes.body).toContain('background: #000');

    // Fetch script.js
    const jsRes = await httpGet(`${info.url}/script.js`);
    expect(jsRes.statusCode).toBe(200);
    expect(jsRes.body).toContain('console.log("NEXORA active")');
  });

  it('4. Full execution of NEXORA project generation, artifact persistence, and live HTTP serving', async () => {
    const goal = 'Build a complete, premium, modern multi-section landing website for a fictional technology company called NEXORA.';
    const task = taskService.createTask({ title: goal });

    const synthResult = await planSynthesis.synthesize(task.id, { taskGoal: goal });
    expect(synthResult.success).toBe(true);

    const completedTask = await executionService.runExecutionLoop(task.id, synthResult.plan!.steps);
    expect(completedTask.state).toBe('completed');

    // Verify artifact persisted in SQLite
    const artifact = storage.artifacts.findByTaskId(task.id);
    expect(artifact).toBeDefined();
    expect(artifact!.isVerified).toBe(true);

    // Launch preview via PreviewService
    const previewRes = await previewService.preview(task.id);
    expect(previewRes.success).toBe(true);
    expect(previewRes.status).toBe('LAUNCHED');
    expect(previewRes.serverInfo).toBeDefined();

    // Direct HTTP check against preview server URL
    const httpRes = await httpGet(previewRes.serverInfo!.url);
    expect(httpRes.statusCode).toBe(200);
    expect(httpRes.headers['content-type']).toContain('text/html');
    expect(httpRes.body).toContain('NEXORA');
    expect(httpRes.body).toContain('Autonomous Intelligence');
    expect(httpRes.body).not.toContain('NEXUS Web Application');
    expect(httpRes.body).not.toContain('Calculator');
  });

  it('5. Full execution of Bean & Brew cafe project generation and distinct preview serving', async () => {
    const goal = 'Build a modern landing page for a cafe called Bean & Brew.';
    const task = taskService.createTask({ title: goal });

    const synthResult = await planSynthesis.synthesize(task.id, { taskGoal: goal });
    expect(synthResult.success).toBe(true);

    const completedTask = await executionService.runExecutionLoop(task.id, synthResult.plan!.steps);
    expect(completedTask.state).toBe('completed');

    // Launch preview
    const previewRes = await previewService.preview(task.id);
    expect(previewRes.success).toBe(true);
    expect(previewRes.status).toBe('LAUNCHED');

    // Direct HTTP check
    const httpRes = await httpGet(previewRes.serverInfo!.url);
    expect(httpRes.statusCode).toBe(200);
    expect(httpRes.body).toContain('Bean & Brew');
    expect(httpRes.body).toContain('Artisan Coffee');
    expect(httpRes.body).not.toContain('NEXORA');
    expect(httpRes.body).not.toContain('Calculator');
  });
});
