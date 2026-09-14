import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../storage/database.js';
import { MigrationRunner } from '../storage/migration.js';
import { AgentTaskRepository } from '../storage/repositories/agentTaskRepository.js';
import { TaskArtifactRepository } from '../storage/repositories/taskArtifactRepository.js';
import { AgentTaskService } from '../orchestration/agentTaskService.js';
import { GoalCompletionVerifier } from '../orchestration/goalCompletionVerifier.js';
import { ProjectTaskOrchestrator } from '../orchestration/projectOrchestrator.js';
import type { PlanSynthesisService } from '../orchestration/planner.js';
import type { AgentExecutionService } from '../orchestration/agentExecutionService.js';
import { TaskDecompositionService } from '../orchestration/taskDecompositionService.js';
import { PreviewService } from '../preview/previewService.js';
import { verifyHtmlContentSubstance } from '../orchestration/placeholderDetector.js';

describe('Artifact Ownership, Resolution & Final Integration Isolation Regression Suite', () => {
  let tempDir: string;
  let dbConnection: DatabaseConnection;
  let taskRepo: AgentTaskRepository;
  let artifactRepo: TaskArtifactRepository;
  let taskService: AgentTaskService;
  let goalVerifier: GoalCompletionVerifier;
  let previewService: PreviewService;
  let decompService: TaskDecompositionService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-artifact-isolation-'));
    const dbPath = path.join(tempDir, 'nexus-test.db');
    dbConnection = new DatabaseConnection(dbPath);
    const db = dbConnection.connect();
    const migrationRunner = new MigrationRunner(db, 'error');
    migrationRunner.runMigrations();
    taskRepo = new AgentTaskRepository(db);
    artifactRepo = new TaskArtifactRepository(db);
    taskService = new AgentTaskService(taskRepo, 'error');
    goalVerifier = new GoalCompletionVerifier('error');
    previewService = new PreviewService(taskRepo, tempDir, 'error', artifactRepo);
    decompService = new TaskDecompositionService(undefined, 'error');
  });

  afterEach(async () => {
    if (previewService) {
      await previewService.stop();
    }
    if (dbConnection) {
      dbConnection.close();
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // A. Older calculator.html exists in workspace -> New SERA CAFÉ task generates
  //    its own artifact -> Final verification must inspect ONLY SERA CAFÉ artifact.
  // ───────────────────────────────────────────────────────────────────────────
  it('A. Selects SERA CAFÉ artifact for final verification when older calculator.html exists in workspace', async () => {
    // 1. Pre-existing stale calculator artifact from prior task
    const oldCalcHtml = `<!DOCTYPE html>
<html>
<head><title>Calculator App</title></head>
<body>
  <h1>Online Calculator</h1>
  <div class="calculator-grid">
    <button>1</button><button>+</button><button>=</button>
  </div>
</body>
</html>`;
    fs.writeFileSync(path.join(tempDir, 'calculator.html'), oldCalcHtml, 'utf8');

    // 2. New SERA CAFÉ task
    const seraGoal = 'Build a complete production-quality responsive website for "SERA CAFÉ"';
    const parentTask = taskService.createTask({ title: seraGoal });
    const plan = await decompService.decompose({ taskGoal: seraGoal });

    // Write SERA CAFÉ target files (index.html, styles.css, scripts.js)
    const seraHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SERA CAFÉ — Artisanal Roastery</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header>
    <nav>
      <div class="logo">SERA CAFÉ</div>
      <a href="#features">Features</a>
      <a href="#menu">Explore Menu</a>
      <a href="#about">Our Story</a>
      <a href="#testimonials">Reviews</a>
      <a href="#reserve" class="btn">Reserve a Table</a>
      <a href="#faq">FAQ</a>
    </nav>
  </header>
  <main>
    <section class="hero">
      <h1>SERA CAFÉ</h1>
      <p>Your table is waiting. Discover our world-class artisanal brews.</p>
      <a href="#reserve" class="btn">Reserve a Table</a>
    </section>
    <section id="features">
      <h2>Why Choose SERA CAFÉ</h2>
      <div class="feature-card">
        <h3>Single-Origin Beans</h3>
        <p>Ethically sourced beans roasted fresh every morning in-house.</p>
      </div>
      <div class="feature-card">
        <h3>Master Baristas</h3>
        <p>Certified craft baristas passionate about espresso extraction.</p>
      </div>
      <div class="feature-card">
        <h3>Serene Atmosphere</h3>
        <p>Thoughtfully designed acoustic spaces for work and relaxation.</p>
      </div>
    </section>
    <section id="menu">
      <h2>Artisanal Menu</h2>
      <article class="menu-item">
        <h3>SERA Signature Latte</h3>
        <p>Rich espresso infused with organic bourbon vanilla.</p>
        <span>$5.50</span>
      </article>
      <article class="menu-item">
        <h3>Cold Brew Reserve</h3>
        <p>Slow-steeped single origin Ethiopian Yirgacheffe.</p>
        <span>$4.75</span>
      </article>
    </section>
    <section id="about">
      <h2>Our Story & Craftsmanship</h2>
      <p>Crafting perfection since 2018 with direct-trade farmer partnerships.</p>
    </section>
    <section id="testimonials">
      <h2>Guest Testimonials</h2>
      <div class="review-card">
        <p>"The finest flat white in the entire city."</p>
        <h4>— Elena Rostova</h4>
      </div>
    </section>
    <section id="pricing">
      <h2>Subscription & Tasting Plans</h2>
      <div class="pricing-card">
        <h3>Starter Tasting</h3>
        <p>$19/mo for 2 curated 250g bags</p>
      </div>
      <div class="pricing-card">
        <h3>Master Roaster Tier</h3>
        <p>$39/month for unlimited reserve beans</p>
      </div>
    </section>
    <section id="reserve">
      <h2>Reserve a Table</h2>
      <form>
        <input type="text" placeholder="Your Name" />
        <input type="email" placeholder="Email" />
        <button type="submit" class="btn">Book Table</button>
      </form>
    </section>
    <section id="faq">
      <h2>Frequently Asked Questions</h2>
      <div class="faq-item">
        <h3>Do you offer plant-based milk alternatives?</h3>
        <p>Yes, we offer organic oat, almond, and soy milk at no extra charge.</p>
      </div>
    </section>
    <section id="cta">
      <h2>Experience SERA CAFÉ Today</h2>
      <a href="#reserve" class="btn">Reserve a Table</a>
    </section>
  </main>
  <footer>
    <div class="footer-links">
      <p>&copy; 2026 SERA CAFÉ. All rights reserved.</p>
    </div>
  </footer>
  <script src="scripts.js"></script>
</body>
</html>`;
    fs.writeFileSync(path.join(tempDir, 'index.html'), seraHtml, 'utf8');
    fs.writeFileSync(
      path.join(tempDir, 'styles.css'),
      `:root { --primary: #3b2314; --bg: #fdfbf7; --text: #2c1810; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); }
header { background: #fff; padding: 1rem 2rem; border-bottom: 1px solid #e5e0d8; }
.hero { padding: 4rem 2rem; text-align: center; }
.btn { display: inline-block; padding: 0.75rem 1.5rem; background: var(--primary); color: #fff; text-decoration: none; border-radius: 6px; }`,
      'utf8'
    );
    fs.writeFileSync(path.join(tempDir, 'scripts.js'), 'console.log("SERA CAFÉ loaded");', 'utf8');

    // Execute orchestrator with mock execution
    const mockPlanner = {
      synthesize: vi.fn().mockResolvedValue({
        success: true,
        plan: {
          planId: 'plan-test',
          reasoning: 'mock reasoning',
          steps: [
            {
              stepId: 's1',
              taskId: 'child-1',
              sequence: 1,
              stepType: 'tool_execution',
              toolId: 'filesystem_write',
              requestedCapabilities: ['filesystem.write'],
              status: 'pending',
              attemptCount: 0,
              maxAttempts: 3,
              params: { relativePath: 'index.html' },
            },
          ],
        },
      }),
    };
    const mockExec = {
      runExecutionLoop: vi.fn().mockImplementation(async (childTaskId: string) => {
        taskRepo.updateState(childTaskId, { state: 'verifying' });
        return taskRepo.findById(childTaskId);
      }),
    };

    const orchestrator = new ProjectTaskOrchestrator(
      taskService,
      mockPlanner as unknown as PlanSynthesisService,
      mockExec as unknown as AgentExecutionService,
      goalVerifier,
      tempDir,
      artifactRepo,
      undefined,
      'error'
    );

    const result = await orchestrator.orchestrate(parentTask.id, plan);

    expect(result.success).toBe(true);
    expect(result.finalVerificationPassed).toBe(true);
    expect(result.error).toBeUndefined();

    // Verify parent artifact ownership
    const parentArtifact = artifactRepo.findByTaskId(parentTask.id);
    expect(parentArtifact).not.toBeNull();
    expect(parentArtifact?.entryPoint).toBe('index.html');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // B. Older completed task exists. Current task fails.
  //    /preview must NOT show older completed artifact.
  // ───────────────────────────────────────────────────────────────────────────
  it('B. Blocks /preview and does NOT show older completed artifact when latest task failed', async () => {
    // Old completed task 1 (Calculator)
    const task1 = taskRepo.create({
      id: 'task-1-calc',
      title: 'Build calculator app',
      state: 'completed',
      createdAt: '2026-09-01T10:00:00.000Z',
    });
    artifactRepo.create({
      id: `art-${task1.id}`,
      taskId: task1.id,
      projectId: null,
      projectRoot: tempDir,
      relativeProjectRoot: '.',
      entryPoint: 'calculator.html',
      artifactType: 'web_project',
      workspacePath: tempDir,
      files: ['calculator.html'],
      isVerified: true,
    });

    // New task 2 (SERA CAFÉ) fails
    const task2 = taskRepo.create({
      id: 'task-2-sera',
      title: 'Build SERA CAFÉ website',
      state: 'failed',
      errorCategory: 'INTEGRATION_VERIFICATION_FAILED',
      createdAt: '2026-09-02T10:00:00.000Z',
    });
    expect(task2.id).toBe('task-2-sera');

    // /preview (latest task) must reject because latest task failed
    const previewRes = await previewService.preview();
    expect(previewRes.success).toBe(false);
    expect(previewRes.status).toBe('TASK_FAILED');
    expect(previewRes.message).toContain('failed');
    expect(previewRes.message).not.toContain('calculator');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C. Current parent has child artifacts -> Final verification & preview use them
  // ───────────────────────────────────────────────────────────────────────────
  it('C. Discovers artifacts from child tasks for parent project preview', async () => {
    const parent = taskService.createTask({ title: 'SERA CAFÉ Multi-Unit Project' });
    const child1 = taskService.createTask({ title: 'Navbar Unit', parentTaskId: parent.id, sequence: 1 });
    const child2 = taskService.createTask({ title: 'Hero Unit', parentTaskId: parent.id, sequence: 2 });

    const seraHtml = `<!DOCTYPE html>
<html>
<head><title>SERA CAFÉ</title><link rel="stylesheet" href="styles.css"></head>
<body>
  <h1>SERA CAFÉ</h1>
  <p>Artisanal coffee and fine bakery. Your table is waiting.</p>
  <a href="#menu">Explore Menu</a>
  <a href="#reserve">Reserve a Table</a>
</body>
</html>`;
    fs.writeFileSync(path.join(tempDir, 'index.html'), seraHtml, 'utf8');

    taskRepo.updateState(child1.id, { state: 'completed' });
    taskRepo.updateState(child2.id, { state: 'completed' });

    artifactRepo.create({
      id: `art-${child1.id}`,
      taskId: child1.id,
      projectId: null,
      projectRoot: tempDir,
      relativeProjectRoot: '.',
      entryPoint: 'index.html',
      artifactType: 'web_project',
      workspacePath: tempDir,
      files: ['index.html'],
      isVerified: true,
    });

    taskRepo.updateState(parent.id, { state: 'completed' });

    // Parent task artifact discovery should find child artifacts
    const discovered = previewService.discoverArtifacts(parent);
    expect(discovered.isWebProject).toBe(true);
    expect(discovered.hasIndexHtml).toBe(true);
    expect(discovered.files).toContain('index.html');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // D. Explicit task ID selects only that task's artifacts
  // ───────────────────────────────────────────────────────────────────────────
  it('D. Explicit task ID strictly targets the requested task and its own artifacts', async () => {
    const taskA = taskService.createTask({ title: 'Task A Project' });
    taskRepo.updateState(taskA.id, { state: 'completed' });
    const dirA = path.join(tempDir, 'project-a');
    fs.mkdirSync(dirA, { recursive: true });
    fs.writeFileSync(path.join(dirA, 'index.html'), '<!DOCTYPE html><html><body>Task A</body></html>');
    artifactRepo.create({
      id: `art-${taskA.id}`,
      taskId: taskA.id,
      projectId: null,
      projectRoot: dirA,
      relativeProjectRoot: 'project-a',
      entryPoint: 'index.html',
      artifactType: 'web_project',
      workspacePath: tempDir,
      files: ['project-a/index.html'],
      isVerified: true,
    });

    const taskB = taskService.createTask({ title: 'Task B Project' });
    taskRepo.updateState(taskB.id, { state: 'completed' });
    const dirB = path.join(tempDir, 'project-b');
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirB, 'index.html'), '<!DOCTYPE html><html><body>Task B</body></html>');
    artifactRepo.create({
      id: `art-${taskB.id}`,
      taskId: taskB.id,
      projectId: null,
      projectRoot: dirB,
      relativeProjectRoot: 'project-b',
      entryPoint: 'index.html',
      artifactType: 'web_project',
      workspacePath: tempDir,
      files: ['project-b/index.html'],
      isVerified: true,
    });

    const discA = previewService.discoverArtifacts(taskA);
    const discB = previewService.discoverArtifacts(taskB);

    expect(discA.projectDir).toBe(dirA);
    expect(discB.projectDir).toBe(dirB);
    expect(discA.projectDir).not.toBe(discB.projectDir);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // E. Artifact filenames are different (calculator.html vs index.html)
  // ───────────────────────────────────────────────────────────────────────────
  it('E. Correctly distinguishes different artifact filenames belonging to different tasks', async () => {
    fs.writeFileSync(path.join(tempDir, 'calculator.html'), '<html><body>Calculator</body></html>');
    fs.writeFileSync(path.join(tempDir, 'index.html'), '<!DOCTYPE html><html><head><title>SERA CAFÉ</title></head><body><h1>SERA CAFÉ</h1><p>Welcome to our artisanal cafe.</p></body></html>');

    const calcTask = taskService.createTask({ title: 'Calculator' });
    artifactRepo.create({
      id: `art-${calcTask.id}`,
      taskId: calcTask.id,
      projectId: null,
      projectRoot: tempDir,
      relativeProjectRoot: '.',
      entryPoint: 'calculator.html',
      artifactType: 'web_project',
      workspacePath: tempDir,
      files: ['calculator.html'],
      isVerified: true,
    });

    const seraTask = taskService.createTask({ title: 'SERA CAFÉ' });
    artifactRepo.create({
      id: `art-${seraTask.id}`,
      taskId: seraTask.id,
      projectId: null,
      projectRoot: tempDir,
      relativeProjectRoot: '.',
      entryPoint: 'index.html',
      artifactType: 'web_project',
      workspacePath: tempDir,
      files: ['index.html'],
      isVerified: true,
    });

    const calcDisc = previewService.discoverArtifacts(calcTask);
    const seraDisc = previewService.discoverArtifacts(seraTask);

    expect(calcDisc.entryFile).toBe('calculator.html');
    expect(seraDisc.entryFile).toBe('index.html');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // F. Artifact filenames are identical (index.html) but owned by different tasks
  //    Current task must win.
  // ───────────────────────────────────────────────────────────────────────────
  it('F. Scopes identical artifact filenames to their owning tasks in different project directories', async () => {
    const dir1 = path.join(tempDir, 'brand1');
    const dir2 = path.join(tempDir, 'brand2');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir1, 'index.html'), '<!DOCTYPE html><html><body>Brand 1</body></html>');
    fs.writeFileSync(path.join(dir2, 'index.html'), '<!DOCTYPE html><html><body>Brand 2</body></html>');

    const task1 = taskService.createTask({ title: 'Brand 1 Task' });
    artifactRepo.create({
      id: `art-${task1.id}`,
      taskId: task1.id,
      projectId: null,
      projectRoot: dir1,
      relativeProjectRoot: 'brand1',
      entryPoint: 'index.html',
      artifactType: 'web_project',
      workspacePath: tempDir,
      files: ['brand1/index.html'],
      isVerified: true,
    });

    const task2 = taskService.createTask({ title: 'Brand 2 Task' });
    artifactRepo.create({
      id: `art-${task2.id}`,
      taskId: task2.id,
      projectId: null,
      projectRoot: dir2,
      relativeProjectRoot: 'brand2',
      entryPoint: 'index.html',
      artifactType: 'web_project',
      workspacePath: tempDir,
      files: ['brand2/index.html'],
      isVerified: true,
    });

    expect(previewService.discoverArtifacts(task2).projectDir).toBe(dir2);
    expect(previewService.discoverArtifacts(task1).projectDir).toBe(dir1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // G. Workspace contains many stale artifacts -> Current task still resolves correctly
  // ───────────────────────────────────────────────────────────────────────────
  it('G. Correctly isolates current task amidst many stale workspace files', async () => {
    // Create random stale files in workspace root
    fs.writeFileSync(path.join(tempDir, 'calc.html'), '<html>Calc</html>');
    fs.writeFileSync(path.join(tempDir, 'old.html'), '<html>Old</html>');
    fs.writeFileSync(path.join(tempDir, 'test.py'), 'print("hello")');
    fs.writeFileSync(path.join(tempDir, 'unused.css'), 'body{}');

    const curTask = taskService.createTask({ title: 'Current Web App' });
    const curDir = path.join(tempDir, 'current-app');
    fs.mkdirSync(curDir, { recursive: true });
    fs.writeFileSync(path.join(curDir, 'index.html'), '<!DOCTYPE html><html><head><title>Current App</title></head><body><h1>Current App</h1></body></html>');

    artifactRepo.create({
      id: `art-${curTask.id}`,
      taskId: curTask.id,
      projectId: null,
      projectRoot: curDir,
      relativeProjectRoot: 'current-app',
      entryPoint: 'index.html',
      artifactType: 'web_project',
      workspacePath: tempDir,
      files: ['current-app/index.html'],
      isVerified: true,
    });

    const disc = previewService.discoverArtifacts(curTask);
    expect(disc.projectDir).toBe(curDir);
    expect(disc.entryFile).toBe('index.html');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // H. Restart/reload preserves artifact ownership across database re-connections
  // ───────────────────────────────────────────────────────────────────────────
  it('H. Restart/reload preserves task artifact ownership and discovery', async () => {
    const task = taskService.createTask({ title: 'Persistent Project' });
    const projectDir = path.join(tempDir, 'persistent-proj');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'index.html'), '<!DOCTYPE html><html><body>Persistent</body></html>');

    artifactRepo.create({
      id: `art-${task.id}`,
      taskId: task.id,
      projectId: null,
      projectRoot: projectDir,
      relativeProjectRoot: 'persistent-proj',
      entryPoint: 'index.html',
      artifactType: 'web_project',
      workspacePath: tempDir,
      files: ['persistent-proj/index.html'],
      isVerified: true,
    });
    taskRepo.updateState(task.id, { state: 'completed' });

    // Simulate restart: create new connection and repositories on same DB
    const newDbConn = new DatabaseConnection(path.join(tempDir, 'nexus-test.db'));
    const newDb = newDbConn.connect();
    const newTaskRepo = new AgentTaskRepository(newDb);
    const newArtifactRepo = new TaskArtifactRepository(newDb);
    const newPreview = new PreviewService(newTaskRepo, tempDir, 'error', newArtifactRepo);

    const reloadedTask = newTaskRepo.findById(task.id);
    expect(reloadedTask).not.toBeNull();
    const disc = newPreview.discoverArtifacts(reloadedTask!);

    expect(disc.projectDir).toBe(projectDir);
    expect(disc.hasIndexHtml).toBe(true);
    expect(disc.isWebProject).toBe(true);

    await newPreview.stop();
    newDbConn.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // I. Goal verifier rejects unrelated historical artifact
  // ───────────────────────────────────────────────────────────────────────────
  it('I. GoalCompletionVerifier prioritizes project entry point and rejects unrelated content', () => {
    const calcHtml = '<html><head><title>Calculator</title></head><body><h1>Online Calculator</h1><button>+</button></body></html>';
    const seraGoal = 'Build a complete responsive website for "SERA CAFÉ"';

    const calcCheck = verifyHtmlContentSubstance(calcHtml, seraGoal);
    expect(calcCheck.valid).toBe(false);
    expect(calcCheck.reason).toContain('SERA CAFÉ');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // J. Genuinely incomplete SERA CAFÉ artifact still fails verification
  // ───────────────────────────────────────────────────────────────────────────
  it('J. Genuinely incomplete/placeholder SERA CAFÉ artifact still fails verification strictly', () => {
    const incompleteSeraHtml = `<!DOCTYPE html>
<html>
<head><title>SERA CAFÉ</title></head>
<body>
  <!-- Hero Section -->
  <div id="hero">TODO: Add hero content</div>
  <!-- Menu Section -->
  <div id="menu">TODO: Add menu items</div>
</body>
</html>`;
    const seraGoal = 'Build a complete responsive website for "SERA CAFÉ" with hero, menu, and reservation';

    const check = verifyHtmlContentSubstance(incompleteSeraHtml, seraGoal);
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/placeholder|skeleton|content substance/i);
  });
});
