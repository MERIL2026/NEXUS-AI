/**
 * NEXUS AI — Regression Test Suite: Preview Target Isolation & Task Association
 *
 * Verifies that /preview strictly resolves preview targets associated with the ACTUAL
 * latest completed task, and prevents old projects (e.g., old calculator or NOVA) from
 * hijacking /preview.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

import { ApplicationApi } from '../api/index.js';
import { loadConfig } from '../config/index.js';

describe('Preview Target Isolation & Task Association Regression Tests', () => {
  let tmpDir: string;
  let api: ApplicationApi;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-preview-regression-'));

    const config = loadConfig({
      DATABASE_PATH: ':memory:',
      WORKSPACE_ROOT: tmpDir,
      LOG_LEVEL: 'error',
    });

    api = new ApplicationApi(config);
    await api.bootstrap();

    // Mock openBrowser to avoid opening real desktop windows during tests
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

  it('Test 1: Resolves new-landing-page instead of old-calculator for latest task', async () => {
    // 1. Create old-calculator project and mark task 1 completed
    const oldDir = path.join(tmpDir, 'old-calculator');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'index.html'), '<html><body>OLD CALCULATOR</body></html>');

    const plan1 = JSON.stringify({
      planId: 'p1',
      steps: [{ toolId: 'filesystem_write', status: 'completed', params: { relativePath: 'old-calculator/index.html' } }],
    });
    const t1 = api.tasks.createTask({ title: 'Build Old Calculator' });
    api.storage.agentTasks.updateState(t1.id, {
      state: 'completed',
      plan: plan1,
      completedAt: new Date(Date.now() - 100000).toISOString(),
    });

    // 2. Create new-landing-page project and mark task 2 completed
    const newDir = path.join(tmpDir, 'new-landing-page');
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, 'index.html'), '<html><body>NEW LANDING PAGE</body></html>');

    const plan2 = JSON.stringify({
      planId: 'p2',
      steps: [{ toolId: 'filesystem_write', status: 'completed', params: { relativePath: 'new-landing-page/index.html' } }],
    });
    const t2 = api.tasks.createTask({ title: 'Build New Landing Page' });
    api.storage.agentTasks.updateState(t2.id, {
      state: 'completed',
      plan: plan2,
      completedAt: new Date().toISOString(),
    });

    // 3. Run /preview
    const res = await api.preview.preview();
    expect(res.success).toBe(true);
    expect(res.task?.id).toBe(t2.id);
    expect(res.serverInfo?.projectDir).toBe(fs.realpathSync(newDir));

    // 4. Verify HTTP content
    const html = await fetchHttp(`${res.serverInfo?.url}/index.html`);
    expect(html).toContain('NEW LANDING PAGE');
    expect(html).not.toContain('OLD CALCULATOR');
  });

  it('Test 2: Selects new project among multiple old web projects', async () => {
    // Create multiple old projects
    const proj1 = path.join(tmpDir, 'old-project-1');
    fs.mkdirSync(proj1, { recursive: true });
    fs.writeFileSync(path.join(proj1, 'index.html'), '<html>OLD 1</html>');

    const proj2 = path.join(tmpDir, 'old-project-2');
    fs.mkdirSync(proj2, { recursive: true });
    fs.writeFileSync(path.join(proj2, 'index.html'), '<html>OLD 2</html>');

    const t1 = api.tasks.createTask({ title: 'Old 1' });
    api.storage.agentTasks.updateState(t1.id, {
      state: 'completed',
      plan: JSON.stringify({ steps: [{ toolId: 'filesystem_write', params: { relativePath: 'old-project-1/index.html' } }] }),
      completedAt: new Date(Date.now() - 200000).toISOString(),
    });

    const t2 = api.tasks.createTask({ title: 'Old 2' });
    api.storage.agentTasks.updateState(t2.id, {
      state: 'completed',
      plan: JSON.stringify({ steps: [{ toolId: 'filesystem_write', params: { relativePath: 'old-project-2/index.html' } }] }),
      completedAt: new Date(Date.now() - 100000).toISOString(),
    });

    // Create target new project
    const newProj = path.join(tmpDir, 'brand-new-web-app');
    fs.mkdirSync(newProj, { recursive: true });
    fs.writeFileSync(path.join(newProj, 'index.html'), '<html>BRAND NEW APP</html>');

    const tNew = api.tasks.createTask({ title: 'Brand New Task' });
    api.storage.agentTasks.updateState(tNew.id, {
      state: 'completed',
      plan: JSON.stringify({ steps: [{ toolId: 'filesystem_write', params: { relativePath: 'brand-new-web-app/index.html' } }] }),
      completedAt: new Date().toISOString(),
    });

    const res = await api.preview.preview();
    expect(res.success).toBe(true);
    expect(res.task?.id).toBe(tNew.id);
    expect(res.serverInfo?.projectDir).toBe(fs.realpathSync(newProj));

    const content = await fetchHttp(`${res.serverInfo?.url}/index.html`);
    expect(content).toContain('BRAND NEW APP');
  });

  it('Test 3: Does NOT preview old web project when latest completed task is non-web', async () => {
    // 1. Previous web project task
    const webDir = path.join(tmpDir, 'web-app');
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, 'index.html'), '<html>WEB APP</html>');

    const tWeb = api.tasks.createTask({ title: 'Create Web App' });
    api.storage.agentTasks.updateState(tWeb.id, {
      state: 'completed',
      plan: JSON.stringify({ steps: [{ toolId: 'filesystem_write', params: { relativePath: 'web-app/index.html' } }] }),
      completedAt: new Date(Date.now() - 50000).toISOString(),
    });

    // 2. Latest non-web task
    const nonWebDir = path.join(tmpDir, 'cli-tool');
    fs.mkdirSync(nonWebDir, { recursive: true });
    fs.writeFileSync(path.join(nonWebDir, 'cli.js'), 'console.log("hello CLI");');

    const tNonWeb = api.tasks.createTask({ title: 'Build CLI Tool' });
    api.storage.agentTasks.updateState(tNonWeb.id, {
      state: 'completed',
      plan: JSON.stringify({ steps: [{ toolId: 'filesystem_write', params: { relativePath: 'cli-tool/cli.js' } }] }),
      completedAt: new Date().toISOString(),
    });

    // 3. /preview must NOT preview the previous web app automatically.
    // cli.js alone counts as hasWebFiles=true, so result is either NOT_WEB_PROJECT or MISSING_INDEX.
    const res = await api.preview.preview();
    expect(res.success).toBe(false);
    expect(['NOT_WEB_PROJECT', 'MISSING_INDEX']).toContain(res.status);
  });

  it('Test 4: Resolves nested directory projects correctly', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'deep', 'my-dashboard');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, 'index.html'), '<html>DEEP DASHBOARD</html>');

    const tNested = api.tasks.createTask({ title: 'Build Deep Dashboard' });
    api.storage.agentTasks.updateState(tNested.id, {
      state: 'completed',
      plan: JSON.stringify({ steps: [{ toolId: 'filesystem_write', params: { relativePath: 'nested/deep/my-dashboard/index.html' } }] }),
      completedAt: new Date().toISOString(),
    });

    const res = await api.preview.preview();
    expect(res.success).toBe(true);
    expect(res.serverInfo?.projectDir).toBe(fs.realpathSync(nestedDir));

    const html = await fetchHttp(`${res.serverInfo?.url}/index.html`);
    expect(html).toContain('DEEP DASHBOARD');
  });

  it('Test 5: Sequential /preview calls update server root to second project', async () => {
    // Task 1: PREVIEW_TARGET_ALPHA
    const dirA = path.join(tmpDir, 'preview-target-alpha');
    fs.mkdirSync(dirA, { recursive: true });
    fs.writeFileSync(path.join(dirA, 'index.html'), '<html>PREVIEW_TARGET_ALPHA</html>');

    const t1 = api.tasks.createTask({ title: 'Create preview-target-alpha' });
    api.storage.agentTasks.updateState(t1.id, {
      state: 'completed',
      plan: JSON.stringify({ steps: [{ toolId: 'filesystem_write', params: { relativePath: 'preview-target-alpha/index.html' } }] }),
      completedAt: new Date(Date.now() - 5000).toISOString(),
    });

    const res1 = await api.preview.preview();
    expect(res1.success).toBe(true);
    const content1 = await fetchHttp(`${res1.serverInfo?.url}/index.html`);
    expect(content1).toContain('PREVIEW_TARGET_ALPHA');

    // Task 2: PREVIEW_TARGET_BETA
    const dirB = path.join(tmpDir, 'preview-target-beta');
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirB, 'index.html'), '<html>PREVIEW_TARGET_BETA</html>');

    const t2 = api.tasks.createTask({ title: 'Create preview-target-beta' });
    api.storage.agentTasks.updateState(t2.id, {
      state: 'completed',
      plan: JSON.stringify({ steps: [{ toolId: 'filesystem_write', params: { relativePath: 'preview-target-beta/index.html' } }] }),
      completedAt: new Date().toISOString(),
    });

    const res2 = await api.preview.preview();
    expect(res2.success).toBe(true);
    expect(res2.serverInfo?.projectDir).toBe(fs.realpathSync(dirB));

    const content2 = await fetchHttp(`${res2.serverInfo?.url}/index.html`);
    expect(content2).toContain('PREVIEW_TARGET_BETA');
    expect(content2).not.toContain('PREVIEW_TARGET_ALPHA');
  });

  it('Test 6: NEXUS restart persistence selects newly completed project', async () => {
    // Task 1: Alpha
    const dirA = path.join(tmpDir, 'preview-target-alpha');
    fs.mkdirSync(dirA, { recursive: true });
    fs.writeFileSync(path.join(dirA, 'index.html'), '<html>PREVIEW_TARGET_ALPHA</html>');

    const dbFile = path.join(tmpDir, 'nexus.sqlite');
    const config = loadConfig({
      DATABASE_PATH: dbFile,
      WORKSPACE_ROOT: tmpDir,
      LOG_LEVEL: 'error',
    });

    let localApi = new ApplicationApi(config);
    await localApi.bootstrap();

    const t1 = localApi.tasks.createTask({ title: 'Task Alpha' });
    localApi.storage.agentTasks.updateState(t1.id, {
      state: 'completed',
      plan: JSON.stringify({ steps: [{ toolId: 'filesystem_write', params: { relativePath: 'preview-target-alpha/index.html' } }] }),
      completedAt: new Date(Date.now() - 10000).toISOString(),
    });

    // Task 2: Beta
    const dirB = path.join(tmpDir, 'preview-target-beta');
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirB, 'index.html'), '<html>PREVIEW_TARGET_BETA</html>');

    const t2 = localApi.tasks.createTask({ title: 'Task Beta' });
    localApi.storage.agentTasks.updateState(t2.id, {
      state: 'completed',
      plan: JSON.stringify({ steps: [{ toolId: 'filesystem_write', params: { relativePath: 'preview-target-beta/index.html' } }] }),
      completedAt: new Date().toISOString(),
    });

    localApi.close();

    // Restart NEXUS by creating a new ApplicationApi instance with the same SQLite DB
    localApi = new ApplicationApi(config);
    await localApi.bootstrap();
    vi.spyOn(localApi.preview, 'openBrowser').mockResolvedValue(true);

    const res = await localApi.preview.preview();
    expect(res.success).toBe(true);
    expect(res.task?.id).toBe(t2.id);

    const content = await fetchHttp(`${res.serverInfo?.url}/index.html`);
    expect(content).toContain('PREVIEW_TARGET_BETA');

    await localApi.preview.stop();
    localApi.close();
  });

  it('Test 7: Old calculator / NOVA folders cannot hijack preview selection', async () => {
    // 1. Pre-existing calculator and NOVA folders in workspace
    const calcDir = path.join(tmpDir, 'calculator');
    fs.mkdirSync(calcDir, { recursive: true });
    fs.writeFileSync(path.join(calcDir, 'index.html'), '<html>OLD CALCULATOR APP</html>');

    const novaDir = path.join(tmpDir, 'NOVA');
    fs.mkdirSync(novaDir, { recursive: true });
    fs.writeFileSync(path.join(novaDir, 'index.html'), '<html>OLD NOVA WEBPAGE</html>');

    // Touch calculator to give it a fresh mtime
    fs.utimesSync(path.join(calcDir, 'index.html'), new Date(), new Date());

    // 2. Create new project preview-target-beta
    const betaDir = path.join(tmpDir, 'preview-target-beta');
    fs.mkdirSync(betaDir, { recursive: true });
    fs.writeFileSync(path.join(betaDir, 'index.html'), '<html>PREVIEW_TARGET_BETA</html>');

    const tBeta = api.tasks.createTask({ title: 'Create project preview-target-beta' });
    api.storage.agentTasks.updateState(tBeta.id, {
      state: 'completed',
      plan: JSON.stringify({ steps: [{ toolId: 'filesystem_write', params: { relativePath: 'preview-target-beta/index.html' } }] }),
      completedAt: new Date().toISOString(),
    });

    const res = await api.preview.preview();
    expect(res.success).toBe(true);
    expect(res.serverInfo?.projectDir).toBe(fs.realpathSync(betaDir));

    const content = await fetchHttp(`${res.serverInfo?.url}/index.html`);
    expect(content).toContain('PREVIEW_TARGET_BETA');
    expect(content).not.toContain('CALCULATOR');
    expect(content).not.toContain('NOVA');
  });
});

function fetchHttp(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
  });
}
