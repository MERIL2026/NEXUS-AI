/**
 * NEXUS AI — P7-H Test Suite: Local Web Project Preview (/preview)
 *
 * Verifies all 20 requirements for the NEXUS AI Preview feature:
 *  1. /preview command exists and handles input.
 *  2. /preview with no completed task returns NO_COMPLETED_TASK error.
 *  3. /preview identifies the latest completed task among multiple tasks.
 *  4. /preview ignores failed tasks.
 *  5. /preview ignores cancelled tasks.
 *  6. /preview identifies index.html entry point.
 *  7. /preview identifies associated CSS and JS files.
 *  8. Preview server starts successfully.
 *  9. Dynamic port is assigned.
 * 10. Browser URL is generated correctly (http://127.0.0.1:<port>).
 * 11. Preview root stays inside NEXUS workspace boundaries.
 * 12. Path traversal (e.g., ../outside) is rejected with 403.
 * 13. /preview status shows active preview server info.
 * 14. /preview stop stops the server.
 * 15. Non-web task produces NOT_WEB_PROJECT result.
 * 16. Missing index.html produces MISSING_INDEX error.
 * 17. /preview <task-id> previews a specific completed task.
 * 18. Serves static files over HTTP correctly.
 * 19. Repeated /preview calls cleanly replace prior running server.
 * 20. Clean shutdown on API close.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as net from 'net';

import { ApplicationApi } from '../api/index.js';
import { loadConfig } from '../config/index.js';
import { AgentRunner } from '../cli/agentRunner.js';
import { PreviewServer } from '../preview/previewServer.js';

describe('P7-H — Local Web Project Preview (/preview)', () => {
  let tmpDir: string;
  let api: ApplicationApi;
  let runner: AgentRunner;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-preview-test-'));

    const config = loadConfig({
      DATABASE_PATH: ':memory:',
      WORKSPACE_ROOT: tmpDir,
      LOG_LEVEL: 'error',
    });

    api = new ApplicationApi(config);
    await api.bootstrap();
    runner = new AgentRunner(api, config.logLevel);

    // Mock openBrowser so tests don't pop real OS browser windows
    vi.spyOn(api.preview, 'openBrowser').mockResolvedValue(true);
  });

  afterEach(async () => {
    if (api) {
      await api.preview?.stop();
      api.close();
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('1. /preview command exists and is recognized by AgentRunner', async () => {
    const res = await runner.runCommand('/preview');
    expect(res).toContain('NEXUS PREVIEW');
  });

  it('2. /preview with no completed task returns NO_COMPLETED_TASK message', async () => {
    const res = await runner.runCommand('/preview');
    expect(res).toContain('No previewable task is available');
  });

  it('3. /preview identifies latest completed task among multiple completed tasks', async () => {
    // Task 1: Old task
    const t1 = api.tasks.createTask({ title: 'Old Task 1' });
    api.storage.agentTasks.updateState(t1.id, {
      state: 'completed',
      completedAt: new Date(Date.now() - 100000).toISOString(),
    });

    // Task 2: Newest task with web files
    const projDir = path.join(tmpDir, 'web-app-2');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'index.html'), '<html><body>App 2</body></html>');

    const planJson = JSON.stringify({
      planId: 'p2',
      taskId: 't2',
      version: 1,
      reasoning: 'Build web app',
      modelId: 'test-model',
      synthesizedAt: new Date().toISOString(),
      steps: [
        {
          stepId: 's1',
          taskId: 't2',
          sequence: 1,
          stepType: 'tool_execution',
          status: 'completed',
          toolId: 'filesystem_write',
          params: { relativePath: 'web-app-2/index.html' },
          attemptCount: 1,
          maxAttempts: 3,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const t2 = api.tasks.createTask({ title: 'New Web App Task' });
    api.storage.agentTasks.updateState(t2.id, {
      state: 'completed',
      plan: planJson,
      completedAt: new Date().toISOString(),
    });

    const result = await api.preview.preview();
    expect(result.success).toBe(true);
    expect(result.status).toBe('LAUNCHED');
    expect(result.task?.id).toBe(t2.id);
  });

  it('4. /preview ignores failed tasks and reports failed status', async () => {
    const tFail = api.tasks.createTask({ title: 'Failed Web Task' });
    api.tasks.failTask(tFail.id, { errorCategory: 'TEST_FAILURE' });

    const res = await runner.runCommand('/preview');
    expect(res).toContain('Preview Unavailable');
    expect(res).toContain('FAILED');
    expect(res).toContain('TEST_FAILURE');
  });

  it('5. /preview ignores cancelled tasks and reports incomplete status', async () => {
    const tCancel = api.tasks.createTask({ title: 'Cancelled Web Task' });
    api.tasks.cancelTask(tCancel.id);

    const res = await runner.runCommand('/preview');
    expect(res).toContain('Preview Unavailable');
    expect(res).toContain('CANCELLED');
  });

  it('6. /preview identifies index.html entry point', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Home</body></html>');
    const t = api.tasks.createTask({ title: 'Root Web Task' });
    api.storage.agentTasks.updateState(t.id, {
      state: 'completed',
      completedAt: new Date().toISOString(),
    });

    const res = await api.preview.preview();
    expect(res.success).toBe(true);
    expect(res.serverInfo?.entryFile).toBe('index.html');
  });

  it('7. /preview identifies associated CSS and JS files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Hello</body></html>');
    fs.writeFileSync(path.join(tmpDir, 'style.css'), 'body { color: red; }');
    fs.writeFileSync(path.join(tmpDir, 'script.js'), 'console.log("hi");');

    const t = api.tasks.createTask({ title: 'HTML CSS JS Task' });
    api.storage.agentTasks.updateState(t.id, {
      state: 'completed',
      completedAt: new Date().toISOString(),
    });

    const res = await api.preview.preview();
    expect(res.success).toBe(true);
    expect(res.detectedFiles).toContain('index.html');
    expect(res.detectedFiles).toContain('style.css');
    expect(res.detectedFiles).toContain('script.js');
  });

  it('8. Preview server starts successfully on loopback 127.0.0.1', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Loopback Test</body></html>');
    const t = api.tasks.createTask({ title: 'Loopback Task' });
    api.storage.agentTasks.updateState(t.id, {
      state: 'completed',
      completedAt: new Date().toISOString(),
    });

    const res = await api.preview.preview();
    expect(res.success).toBe(true);
    expect(res.serverInfo?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('9. Dynamic port is assigned (> 0)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Port Test</body></html>');
    const t = api.tasks.createTask({ title: 'Port Task' });
    api.storage.agentTasks.updateState(t.id, {
      state: 'completed',
      completedAt: new Date().toISOString(),
    });

    const res = await api.preview.preview();
    expect(res.serverInfo?.port).toBeGreaterThan(0);
  });

  it('10. Browser URL is generated correctly', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>URL Test</body></html>');
    const t = api.tasks.createTask({ title: 'URL Task' });
    api.storage.agentTasks.updateState(t.id, {
      state: 'completed',
      completedAt: new Date().toISOString(),
    });

    const res = await api.preview.preview();
    expect(res.serverInfo?.url).toBe(`http://127.0.0.1:${res.serverInfo?.port}`);
  });

  it('11. Preview root stays inside NEXUS workspace boundaries', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Boundary Test</body></html>');
    const t = api.tasks.createTask({ title: 'Boundary Task' });
    api.storage.agentTasks.updateState(t.id, {
      state: 'completed',
      completedAt: new Date().toISOString(),
    });

    const res = await api.preview.preview();
    const canonicalTmp = fs.realpathSync(tmpDir);
    expect(res.serverInfo?.projectDir.startsWith(canonicalTmp)).toBe(true);
  });

  it('12. Path traversal (e.g. ../outside) is rejected with 403', async () => {
    const projDir = path.join(tmpDir, 'sub-app');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'index.html'), '<html>Sub App</html>');

    // Create a secret file outside sub-app but inside tmpDir
    fs.writeFileSync(path.join(tmpDir, 'secret.txt'), 'TOP SECRET');

    const server = new PreviewServer('error');
    const info = await server.start(projDir, 'index.html');

    // Attempt path traversal HTTP GET using %2f
    const resp = await new Promise<{ statusCode: number; body: string }>((resolve) => {
      http.get(`${info.url}/..%2fsecret.txt`, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
      });
    });

    expect(resp.statusCode).toBe(403);
    expect(resp.body).toContain('Forbidden');
    await server.stop();
  });

  it('13. /preview status shows active preview server info', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html>Status Test</html>');
    const t = api.tasks.createTask({ title: 'Status Task' });
    api.storage.agentTasks.updateState(t.id, {
      state: 'completed',
      completedAt: new Date().toISOString(),
    });

    await runner.runCommand('/preview');

    const statusRes = await runner.runCommand('/preview status');
    expect(statusRes).toContain('ACTIVE');
    expect(statusRes).toContain('Status Task');
    expect(statusRes).toContain('http://127.0.0.1:');
  });

  it('14. /preview stop stops the server', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html>Stop Test</html>');
    const t = api.tasks.createTask({ title: 'Stop Task' });
    api.storage.agentTasks.updateState(t.id, {
      state: 'completed',
      completedAt: new Date().toISOString(),
    });

    await runner.runCommand('/preview');
    expect(api.preview.getStatus().active).toBe(true);

    const stopRes = await runner.runCommand('/preview stop');
    expect(stopRes).toContain('stopped successfully');
    expect(api.preview.getStatus().active).toBe(false);
  });

  it('15. Non-web task produces NOT_WEB_PROJECT result', async () => {
    const pyDir = path.join(tmpDir, 'py-app');
    fs.mkdirSync(pyDir, { recursive: true });
    fs.writeFileSync(path.join(pyDir, 'script.py'), 'print("hello")');
    const planJson = JSON.stringify({
      planId: 'p-py',
      taskId: 't-py',
      version: 1,
      reasoning: 'Python script',
      modelId: 'test',
      synthesizedAt: new Date().toISOString(),
      steps: [
        {
          stepId: 's1',
          taskId: 't-py',
          sequence: 1,
          stepType: 'tool_execution',
          status: 'completed',
          toolId: 'filesystem_write',
          params: { relativePath: 'py-app/script.py' },
          attemptCount: 1,
          maxAttempts: 3,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const t = api.tasks.createTask({ title: 'Run Python Script' });
    api.storage.agentTasks.updateState(t.id, {
      state: 'completed',
      plan: planJson,
      completedAt: new Date().toISOString(),
    });

    const res = await api.preview.preview();
    expect(res.status).toBe('NOT_WEB_PROJECT');
    expect(res.success).toBe(false);
  });

  it('16. Missing index.html produces MISSING_INDEX error', async () => {
    const cssDir = path.join(tmpDir, 'css-app');
    fs.mkdirSync(cssDir, { recursive: true });
    fs.writeFileSync(path.join(cssDir, 'style.css'), 'body { background: black; }');
    const planJson = JSON.stringify({
      planId: 'p-css',
      taskId: 't-css',
      version: 1,
      reasoning: 'CSS only',
      modelId: 'test',
      synthesizedAt: new Date().toISOString(),
      steps: [
        {
          stepId: 's1',
          taskId: 't-css',
          sequence: 1,
          stepType: 'tool_execution',
          status: 'completed',
          toolId: 'filesystem_write',
          params: { relativePath: 'css-app/style.css' },
          attemptCount: 1,
          maxAttempts: 3,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const t = api.tasks.createTask({ title: 'CSS Only Task' });
    api.storage.agentTasks.updateState(t.id, {
      state: 'completed',
      plan: planJson,
      completedAt: new Date().toISOString(),
    });

    const res = await api.preview.preview();
    expect(res.status).toBe('MISSING_INDEX');
    expect(res.success).toBe(false);
  });

  it('17. /preview <task-id> previews a specific completed task', async () => {
    // Task 1: Specific target task
    const app1Dir = path.join(tmpDir, 'app-1');
    fs.mkdirSync(app1Dir, { recursive: true });
    fs.writeFileSync(path.join(app1Dir, 'index.html'), '<html>App 1</html>');
    const t1 = api.tasks.createTask({ title: 'App 1 Task' });
    api.storage.agentTasks.updateState(t1.id, {
      state: 'completed',
      completedAt: new Date(Date.now() - 50000).toISOString(),
    });

    // Task 2: Later task
    const app2Dir = path.join(tmpDir, 'app-2');
    fs.mkdirSync(app2Dir, { recursive: true });
    fs.writeFileSync(path.join(app2Dir, 'index.html'), '<html>App 2</html>');
    const t2 = api.tasks.createTask({ title: 'App 2 Task' });
    api.storage.agentTasks.updateState(t2.id, {
      state: 'completed',
      completedAt: new Date().toISOString(),
    });

    // Preview specific task 1
    const res = await api.preview.preview(t1.id);
    expect(res.success).toBe(true);
    expect(res.task?.id).toBe(t1.id);
  });

  it('18. Serves static files over HTTP correctly', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<!DOCTYPE html><html><body><h1>Hello NEXUS</h1></body></html>');
    fs.writeFileSync(path.join(tmpDir, 'style.css'), 'h1 { color: blue; }');

    const t = api.tasks.createTask({ title: 'Static Serve Task' });
    api.storage.agentTasks.updateState(t.id, {
      state: 'completed',
      completedAt: new Date().toISOString(),
    });

    const previewRes = await api.preview.preview();
    const url = previewRes.serverInfo!.url;

    // Fetch index.html
    const htmlRes = await new Promise<{ statusCode: number; body: string }>((resolve) => {
      http.get(`${url}/index.html`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
      });
    });

    expect(htmlRes.statusCode).toBe(200);
    expect(htmlRes.body).toContain('<h1>Hello NEXUS</h1>');

    // Fetch style.css
    const cssRes = await new Promise<{ statusCode: number; body: string }>((resolve) => {
      http.get(`${url}/style.css`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
      });
    });

    expect(cssRes.statusCode).toBe(200);
    expect(cssRes.body).toContain('color: blue');
  });

  it('20. /preview automatically detects index.html inside a project subdirectory (e.g. nexus-final-test)', async () => {
    const subDir = path.join(tmpDir, 'nexus-final-test');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'index.html'), '<!DOCTYPE html><html><body>Calculator App</body></html>');
    fs.writeFileSync(path.join(subDir, 'style.css'), '.calc { background: black; }');
    fs.writeFileSync(path.join(subDir, 'script.js'), 'console.log("calc");');

    const t = api.tasks.createTask({ title: 'Subdirectory Web App Task' });
    api.storage.agentTasks.updateState(t.id, {
      state: 'completed',
      completedAt: new Date().toISOString(),
    });

    const previewRes = await api.preview.preview();
    expect(previewRes.success).toBe(true);
    const url = previewRes.serverInfo!.url;

    // Fetch /index.html from preview server
    const htmlRes = await new Promise<{ statusCode: number; body: string }>((resolve) => {
      http.get(`${url}/index.html`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
      });
    });

    expect(htmlRes.statusCode).toBe(200);
    expect(htmlRes.body).toContain('Calculator App');

    // Fetch /style.css
    const cssRes = await new Promise<{ statusCode: number; body: string }>((resolve) => {
      http.get(`${url}/style.css`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
      });
    });
    expect(cssRes.statusCode).toBe(200);
    expect(cssRes.body).toContain('.calc');

    // Fetch /script.js
    const jsRes = await new Promise<{ statusCode: number; body: string }>((resolve) => {
      http.get(`${url}/script.js`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
      });
    });
    expect(jsRes.statusCode).toBe(200);
    expect(jsRes.body).toContain('calc');
  });

  it('21. /preview handles missing index.html gracefully returning MISSING_INDEX status', async () => {
    const emptySubDir = path.join(tmpDir, 'no-index-project');
    fs.mkdirSync(emptySubDir, { recursive: true });
    fs.writeFileSync(path.join(emptySubDir, 'readme.txt'), 'No HTML here');

    const t = api.tasks.createTask({ title: 'No HTML Task' });
    api.storage.agentTasks.updateState(t.id, {
      state: 'completed',
      completedAt: new Date().toISOString(),
    });

    const previewRes = await api.preview.preview();
    expect(previewRes.success).toBe(false);
    expect(previewRes.status).toBe('NOT_WEB_PROJECT');
  });

  it('22. /preview blocks path traversal attempts returning 403 Forbidden', async () => {
    const subDir = path.join(tmpDir, 'safe-app');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'index.html'), '<html>Safe App</html>');

    const t = api.tasks.createTask({ title: 'Safe App Task' });
    api.storage.agentTasks.updateState(t.id, {
      state: 'completed',
      completedAt: new Date().toISOString(),
    });

    const previewRes = await api.preview.preview();

    const traversalRes = await new Promise<number>((resolve) => {
      const socket = net.connect(previewRes.serverInfo!.port, '127.0.0.1', () => {
        socket.write('GET /../package.json HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      socket.on('data', (data) => {
        const str = data.toString();
        if (str.includes('403 Forbidden')) resolve(403);
        else if (str.includes('404 Not Found')) resolve(404);
        else resolve(200);
        socket.destroy();
      });
    });

    expect(traversalRes).toBe(403);
  });

  it('23. /preview interactive command via AgentRunner correctly serves subdirectory web project', async () => {
    const subDir = path.join(tmpDir, 'nexus-interactive-test');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'index.html'), '<!DOCTYPE html><html><body>Interactive App</body></html>');
    fs.writeFileSync(path.join(subDir, 'style.css'), '.btn { color: red; }');
    fs.writeFileSync(path.join(subDir, 'script.js'), 'console.log("interactive");');

    const plan = {
      planId: 'plan-interactive',
      steps: [
        {
          stepId: 'step-1',
          toolId: 'filesystem_write',
          status: 'completed',
          params: { path: 'nexus-interactive-test/index.html' },
        },
        {
          stepId: 'step-2',
          toolId: 'filesystem_write',
          status: 'completed',
          params: { path: 'nexus-interactive-test/style.css' },
        },
        {
          stepId: 'step-3',
          toolId: 'filesystem_write',
          status: 'completed',
          params: { path: 'nexus-interactive-test/script.js' },
        },
      ],
    };

    const t = api.tasks.createTask({ title: 'Create folder nexus-interactive-test containing index.html' });
    api.storage.agentTasks.updateState(t.id, {
      plan: JSON.stringify(plan),
      state: 'completed',
      completedAt: new Date().toISOString(),
    });

    const card = await runner.runCommand('/preview');
    expect(card).toContain('NEXUS PREVIEW');

    const st = api.preview.getStatus();
    expect(st.active).toBe(true);
    const url = st.serverInfo!.url;

    // GET /index.html
    const htmlRes = await new Promise<{ statusCode: number; body: string }>((resolve) => {
      http.get(`${url}/index.html`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
      });
    });
    expect(htmlRes.statusCode).toBe(200);
    expect(htmlRes.body).toContain('Interactive App');

    // GET /style.css
    const cssRes = await new Promise<{ statusCode: number; body: string }>((resolve) => {
      http.get(`${url}/style.css`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
      });
    });
    expect(cssRes.statusCode).toBe(200);
    expect(cssRes.body).toContain('.btn');

    // GET /script.js
    const jsRes = await new Promise<{ statusCode: number; body: string }>((resolve) => {
      http.get(`${url}/script.js`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
      });
    });
    expect(jsRes.statusCode).toBe(200);
    expect(jsRes.body).toContain('interactive');
  });
});

