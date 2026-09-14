import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  verifyHtmlContentSubstance,
} from '../orchestration/placeholderDetector.js';
import { GoalCompletionVerifier } from '../orchestration/goalCompletionVerifier.js';
import { PreviewService } from '../preview/previewService.js';
import { StorageService } from '../storage/index.js';
import { AgentTaskService } from '../orchestration/agentTaskService.js';
import { AgentPlanStep } from '../orchestration/types.js';

describe('Placeholder & Skeleton Prevention Regression Suite (Requirements A-L)', { timeout: 20000 }, () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let storage: StorageService;
  let taskService: AgentTaskService;
  let previewService: PreviewService;
  let verifier: GoalCompletionVerifier;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-anti-skeleton-test-'));
    workspaceRoot = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const dbPath = path.join(tmpDir, 'test.db');
    storage = new StorageService(dbPath, 'error');
    await storage.initialize();
    taskService = new AgentTaskService(storage.agentTasks, storage.artifacts, 'error');
    previewService = new PreviewService(storage.agentTasks, workspaceRoot, 'error', storage.artifacts);
    verifier = new GoalCompletionVerifier('error');
  });

  afterEach(async () => {
    try {
      if (previewService) {
        await previewService.stop();
      }
    } catch {}
    try {
      if (storage) {
        await storage.close();
      }
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // A. Complete HTML → PASS
  it('A. Complete HTML with real visible content passes verification', () => {
    const completeHtml = `<!DOCTYPE html>
<html lang="en">
<head><title>NEXORA — Next Gen AI Platform</title><link rel="stylesheet" href="style.css"></head>
<body>
  <header class="navbar"><div class="logo">NEXORA</div><nav><a href="#features">Features</a></nav></header>
  <main>
    <section id="hero" class="hero">
      <h1>Build What's Next with Autonomous AI</h1>
      <p>Supercharge your engineering workflow with NEXORA high-throughput intelligent agents.</p>
      <button class="btn">Get Started</button>
    </section>
    <section id="features" class="features">
      <h2>Core Capabilities</h2>
      <p>Explore our multi-agent orchestration and local offline reasoning capabilities.</p>
    </section>
    <section id="pricing" class="pricing">
      <h2>Simple Pricing</h2>
      <p>Transparent tiers for developers and enterprises alike.</p>
    </section>
  </main>
  <footer id="footer"><p>&copy; 2026 NEXORA Inc.</p></footer>
</body>
</html>`;
    const res = verifyHtmlContentSubstance(completeHtml, 'Build a landing page for NEXORA with hero, features, pricing, and footer');
    expect(res.valid).toBe(true);
  });

  // B. Empty HTML → FAIL
  it('B. Empty HTML / 0 visible text fails verification', () => {
    const emptyHtml = `<!DOCTYPE html><html><head><title>NEXORA</title></head><body></body></html>`;
    const res = verifyHtmlContentSubstance(emptyHtml, 'Build a landing page for NEXORA');
    expect(res.valid).toBe(false);
    expect(res.errorCategory).toMatch(/EMPTY_HTML_BODY|INSUFFICIENT_PROJECT_CONTENT/);
  });

  // C. Placeholder-only HTML (e.g. <!-- Hero Content -->) → FAIL
  it('C. Placeholder-only HTML skeleton fails verification with INCOMPLETE_SKELETON_REJECTED or PLACEHOLDER_ARTIFACT_REJECTED', () => {
    const skeletonHtml = `<!DOCTYPE html>
<html lang="en">
<head><title>NEXORA</title><link rel="stylesheet" href="styles.css"></head>
<body>
  <section class="hero">
    <!-- Hero Content -->
  </section>
  <section class="features">
    <!-- Features Content -->
  </section>
  <section class="solutions">
    <!-- Solutions Content -->
  </section>
  <div id="product-dashboard">
    <!-- Interactive Product Dashboard Content -->
  </div>
  <section class="pricing">
    <!-- Pricing Content -->
  </section>
  <footer>
    <!-- Footer Content -->
  </footer>
</body>
</html>`;
    const res = verifyHtmlContentSubstance(skeletonHtml, 'Build a complete landing page for NEXORA');
    expect(res.valid).toBe(false);
    expect(res.errorCategory).toMatch(/PLACEHOLDER_ARTIFACT_REJECTED|INCOMPLETE_SKELETON_REJECTED/);
  });

  // D. Missing requested content / brand → FAIL
  it('D. Missing requested brand identity fails verification', () => {
    const unrelatedHtml = `<!DOCTYPE html>
<html>
<head><title>Random App</title><link rel="stylesheet" href="style.css"></head>
<body>
  <h1>Welcome to Generic App</h1>
  <p>This is a random web page that has no mention of the requested company.</p>
</body>
</html>`;
    const res = verifyHtmlContentSubstance(unrelatedHtml, 'Build a landing page for NEXORA');
    expect(res.valid).toBe(false);
    expect(res.errorCategory).toBe('CONTENT_VERIFICATION_FAILED');
    expect(res.reason).toContain('missing requested project brand/title terms');
  });

  // E. Generic NEXUS template → FAIL
  it('E. Generic fallback template with "NEXUS Web Application" fails verification for custom brand', () => {
    const fallbackHtml = `<!DOCTYPE html>
<html>
<head><title>NEXUS Web Application</title><link rel="stylesheet" href="style.css"></head>
<body>
  <div class="container">
    <h1>NEXUS Web Application</h1>
    <p>Generated by NEXUS AI Agent. All features operational.</p>
  </div>
</body>
</html>`;
    const res = verifyHtmlContentSubstance(fallbackHtml, 'Build a coffee shop website called Bean & Brew');
    expect(res.valid).toBe(false);
    expect(res.errorCategory).toMatch(/PLACEHOLDER_ARTIFACT_REJECTED|CONTENT_VERIFICATION_FAILED/);
  });

  // F. Old calculator artifact → FAIL
  it('F. Old calculator artifact fails verification when landing page was requested', () => {
    const calcHtml = `<!DOCTYPE html>
<html>
<head><title>NEXUS Calculator</title><link rel="stylesheet" href="style.css"></head>
<body>
  <div class="calculator">
    <div id="display">0</div>
    <div class="buttons"><button class="btn">1</button></div>
  </div>
</body>
</html>`;
    const res = verifyHtmlContentSubstance(calcHtml, 'Build a landing page for NEXORA');
    expect(res.valid).toBe(false);
    expect(res.errorCategory).toMatch(/STALE_PROJECT_MISMATCH|CONTENT_VERIFICATION_FAILED/);
  });

  // G. Correct NEXORA project → PASS
  it('G. Correct NEXORA project satisfies goal and verifier passes', () => {
    const nexoraHtml = `<!DOCTYPE html>
<html lang="en">
<head><title>NEXORA — Build What's Next.</title><link rel="stylesheet" href="style.css"></head>
<body class="dark-theme">
  <header class="navbar"><div class="logo">NEXORA</div></header>
  <section class="hero"><h1>Build What's Next.</h1><p>Next-generation autonomous intelligent platforms.</p></section>
  <section class="features"><h2>6 Core Features</h2><p>High speed, offline execution, safety isolation, zero latency.</p></section>
  <section class="solutions"><h2>Solutions</h2><p>Enterprise AI workflows.</p></section>
  <section class="pricing"><h2>Pricing</h2><p>Starts at $0/month.</p></section>
  <section class="faq"><h2>FAQ</h2><p>Frequently asked questions about NEXORA.</p></section>
  <footer><p>&copy; 2026 NEXORA</p></footer>
</body>
</html>`;
    const res = verifyHtmlContentSubstance(nexoraHtml, 'Build a landing page for NEXORA with hero, features, solutions, pricing, faq, footer');
    expect(res.valid).toBe(true);
  });

  // H. Correct Bean & Brew project → PASS
  it('H. Correct Bean & Brew project satisfies cafe request and passes', () => {
    const cafeHtml = `<!DOCTYPE html>
<html>
<head><title>Bean & Brew — Artisan Coffee</title><link rel="stylesheet" href="style.css"></head>
<body>
  <header class="navbar"><div class="logo">☕ Bean & Brew</div><nav><a href="#menu">Menu</a></nav></header>
  <section class="hero"><h1>Artisan Coffee Crafted with Passion</h1><p>Organic beans roasted fresh daily at Bean & Brew.</p></section>
  <section id="menu"><h2>Our Specialties</h2><p>Espresso Romano, Caramel Oat Latte, Pour-Over Ethiopia</p></section>
  <footer><p>&copy; 2026 Bean & Brew Cafe</p></footer>
</body>
</html>`;
    const res = verifyHtmlContentSubstance(cafeHtml, 'Build a coffee shop landing page called Bean & Brew');
    expect(res.valid).toBe(true);
  });

  // I. Correct unrelated project → PASS when its own request is satisfied
  it('I. Unrelated portfolio project satisfies its own request and passes', () => {
    const portfolioHtml = `<!DOCTYPE html>
<html>
<head><title>DevForge — Systems Architecture</title><link rel="stylesheet" href="style.css"></head>
<body>
  <header class="navbar"><div class="logo">&lt;/DevForge&gt;</div></header>
  <section class="hero"><h1>High-Performance Software Engineering</h1><p>Distributed systems and cloud tooling by DevForge.</p></section>
  <section class="projects"><h2>Featured Projects</h2><p>AI Runtime, Memory Store, Cloud Control Plane.</p></section>
  <footer><p>&copy; 2026 DevForge</p></footer>
</body>
</html>`;
    const res = verifyHtmlContentSubstance(portfolioHtml, 'Build a developer portfolio called DevForge');
    expect(res.valid).toBe(true);
  });

  // J. Invalid artifact → PreviewService BLOCKS preview
  it('J. PreviewService blocks preview when artifact contains skeleton placeholders', async () => {
    const task = taskService.createTask({ title: 'Build landing page for NEXORA' });

    const projectDir = path.join(workspaceRoot, 'skeleton-test');
    fs.mkdirSync(projectDir, { recursive: true });
    const indexPath = path.join(projectDir, 'index.html');
    fs.writeFileSync(
      indexPath,
      `<!DOCTYPE html><html><body><section class="hero"><!-- Hero Content --></section><section class="features"><!-- Features Content --></section></body></html>`,
      'utf8'
    );

    taskService.transitionTask(task.id, { targetState: 'planning' });
    taskService.transitionTask(task.id, { targetState: 'executing' });
    taskService.transitionTask(task.id, { targetState: 'observing' });
    taskService.transitionTask(task.id, { targetState: 'verifying' });
    taskService.completeTask(task.id, {
      artifactRoot: projectDir,
      entryPoint: indexPath,
    });

    taskService.registerArtifact({
      taskId: task.id,
      projectRoot: projectDir,
      relativeProjectRoot: 'skeleton-test',
      entryPoint: 'index.html',
      files: ['index.html'],
      artifactType: 'web_project',
      workspacePath: workspaceRoot,
      isVerified: true,
    });

    const previewRes = await previewService.preview(task.id);
    expect(previewRes.status).toBe('PLACEHOLDER_ARTIFACT_BLOCKED');
    expect(previewRes.previewUrl).toBeUndefined();
    expect(previewRes.message).toContain('Preview blocked: generated artifact failed integrity/content verification');
  });

  // K. Valid artifact → PreviewService ALLOWS preview
  it('K. PreviewService starts preview for valid artifact', async () => {
    const task = taskService.createTask({ title: 'Build landing page for NEXORA' });

    const projectDir = path.join(workspaceRoot, 'valid-test');
    fs.mkdirSync(projectDir, { recursive: true });
    const indexPath = path.join(projectDir, 'index.html');
    fs.writeFileSync(
      indexPath,
      `<!DOCTYPE html><html><head><title>NEXORA</title></head><body><h1>Welcome to NEXORA</h1><p>Real product capabilities.</p></body></html>`,
      'utf8'
    );
    fs.writeFileSync(path.join(projectDir, 'style.css'), `body { background: #000; color: #fff; }`, 'utf8');

    taskService.transitionTask(task.id, { targetState: 'planning' });
    taskService.transitionTask(task.id, { targetState: 'executing' });
    taskService.transitionTask(task.id, { targetState: 'observing' });
    taskService.transitionTask(task.id, { targetState: 'verifying' });
    taskService.completeTask(task.id, {
      artifactRoot: projectDir,
      entryPoint: indexPath,
    });

    taskService.registerArtifact({
      taskId: task.id,
      projectRoot: projectDir,
      relativeProjectRoot: 'valid-test',
      entryPoint: 'index.html',
      files: ['index.html', 'style.css'],
      artifactType: 'web_project',
      workspacePath: workspaceRoot,
      isVerified: true,
    });

    const previewRes = await previewService.preview(task.id);
    try {
      expect(previewRes.status).toBe('LAUNCHED');
      expect(previewRes.serverInfo).toBeDefined();
      expect(previewRes.serverInfo?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/);
    } finally {
      await previewService.stop();
    }
  });

  // L. Failed generation → GoalCompletionVerifier rejects task
  it('L. GoalCompletionVerifier rejects task when files are empty skeleton', () => {
    const skeletonPath = path.join(workspaceRoot, 'index.html');
    fs.writeFileSync(
      skeletonPath,
      `<!DOCTYPE html><html><body><section class="hero"><!-- Hero Content --></section><section class="features"><!-- Features Content --></section></body></html>`,
      'utf8'
    );

    const steps: AgentPlanStep[] = [
      {
        stepId: 'step-1',
        toolId: 'filesystem_write',
        requestedCapabilities: ['filesystem.write'],
        params: { relativePath: 'index.html' },
        status: 'completed',
      },
    ];

    const result = verifier.verifyGoal('Build a landing page for NEXORA with hero and features', steps, workspaceRoot);
    expect(result.verified).toBe(false);
    expect(result.errorCategory).toMatch(/PLACEHOLDER_ARTIFACT_REJECTED|INCOMPLETE_SKELETON_REJECTED/);
  });
});
