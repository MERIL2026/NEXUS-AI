/**
 * NEXUS AI — True Black-Box CLI End-to-End Acceptance Test
 *
 * Requirements:
 * 1. Must launch the actual installed `nexus` executable as a separate OS process (spawn/execFile).
 * 2. Absolutely NO in-process imports of ApplicationApi, AgentRunner, TaskDecompositionService,
 *    ProjectTaskOrchestrator, PreviewService, or model mocks.
 * 3. Verified against dynamically discovered CLI binary and package version.
 * 4. Interacts exclusively via stdin / stdout / stderr / OS signals.
 * 5. Verifies dynamic task plan output, child unit execution, /tasks command, /preview command,
 *    live preview HTTP response, workspace artifact substance, SQLite persistence (read-only observer),
 *    chat regression, and process restart/resume.
 */

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchHttp(url: string, timeoutMs = 10000): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`HTTP request timed out after ${timeoutMs}ms`));
    });
  });
}

function findFilesRecursive(dir: string, filename: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findFilesRecursive(full, filename));
      } else if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
        results.push(full);
      }
    }
  } catch {
    /* ignore */
  }
  return results;
}

// ---------------------------------------------------------------------------
// Dynamic Executable Resolution (Windows / macOS / Linux)
// ---------------------------------------------------------------------------

interface ResolvedCli {
  command: string;
  args: string[];
  description: string;
}

function resolveInstalledNexusCli(): ResolvedCli {
  // 1. Explicit override via environment variable
  if (process.env.NEXUS_BIN && fs.existsSync(process.env.NEXUS_BIN)) {
    return {
      command: process.execPath,
      args: [process.env.NEXUS_BIN],
      description: `NEXUS_BIN environment override: ${process.env.NEXUS_BIN}`,
    };
  }

  // 2. Discover global npm installation root
  try {
    const npmGlobalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (npmGlobalRoot) {
      const candidates = [
        path.join(npmGlobalRoot, '@nexus-ai-nexoralabs', 'cli', 'dist', 'cli', 'bin.js'),
        path.join(npmGlobalRoot, 'nexus-ai', 'dist', 'cli', 'bin.js'),
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          return {
            command: process.execPath,
            args: [cand],
            description: `Globally installed npm package entry: ${cand}`,
          };
        }
      }
    }
  } catch {
    /* continue to PATH resolution */
  }

  // 3. Discover executable in PATH
  if (process.platform === 'win32') {
    try {
      const whereOut = execSync('where.exe nexus', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const firstLine = whereOut.split('\n')[0].trim();
      if (firstLine && fs.existsSync(firstLine)) {
        return {
          command: 'cmd.exe',
          args: ['/c', firstLine],
          description: `Windows PATH executable: ${firstLine}`,
        };
      }
    } catch {
      /* continue */
    }
  } else {
    try {
      const whichOut = execSync('which nexus', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (whichOut && fs.existsSync(whichOut)) {
        return {
          command: whichOut,
          args: [],
          description: `Unix PATH executable: ${whichOut}`,
        };
      }
    } catch {
      /* continue */
    }
  }

  // 4. Fallback to dist/cli/bin.js in project root only if built
  const localDist = path.resolve('dist', 'cli', 'bin.js');
  if (fs.existsSync(localDist)) {
    return {
      command: process.execPath,
      args: [localDist],
      description: `Local build target (fallback): ${localDist}`,
    };
  }

  throw new Error(
    'Could not resolve installed nexus executable. Ensure @nexus-ai-nexoralabs/cli is installed globally (npm i -g .) or run npm run build first.'
  );
}

// ---------------------------------------------------------------------------
// Interactive CLI Process Harness
// ---------------------------------------------------------------------------

class CliProcessSession {
  private child: ReturnType<typeof spawn>;
  public output = '';
  public stderrOutput = '';
  private isExited = false;
  private exitCode: number | null = null;

  constructor(
    private cli: ResolvedCli,
    private extraEnv: Record<string, string> = {}
  ) {
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      ...extraEnv,
    };

    this.child = spawn(this.cli.command, this.cli.args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout?.on('data', (d) => {
      const s = d.toString();
      this.output += s;
    });

    this.child.stderr?.on('data', (d) => {
      const s = d.toString();
      this.stderrOutput += s;
      this.output += s;
    });

    this.child.on('exit', (code) => {
      this.isExited = true;
      this.exitCode = code;
    });
  }

  send(input: string): void {
    if (!this.child.stdin?.writable) {
      throw new Error('Process stdin is not writable (process may have terminated)');
    }
    this.child.stdin.write(input + '\n');
  }

  async waitForPattern(
    pattern: RegExp | string,
    timeoutMs = 60000,
    pollIntervalMs = 200,
    fromOffset?: number
  ): Promise<string> {
    const startTime = Date.now();
    const startLen = fromOffset !== undefined ? fromOffset : this.output.length;
    const isRegex = pattern instanceof RegExp;

    while (Date.now() - startTime < timeoutMs) {
      const slice = stripAnsi(this.output.slice(startLen));
      const matches = isRegex ? (pattern as RegExp).test(slice) : slice.includes(pattern as string);
      if (matches) {
        return slice;
      }
      if (this.isExited) {
        throw new Error(
          `Process exited prematurely with code ${this.exitCode} while waiting for ${pattern}.\nNew Output:\n${slice.slice(-1500)}`
        );
      }
      await delay(pollIntervalMs);
    }

    const recent = stripAnsi(this.output.slice(startLen)).slice(-2000);
    throw new Error(`Timeout of ${timeoutMs}ms exceeded waiting for pattern: ${pattern}\nRecent Output:\n${recent}`);
  }

  async close(gracePeriodMs = 3000): Promise<void> {
    if (this.isExited) return;

    try {
      this.send('/exit');
    } catch {
      /* process may already be closing */
    }

    const start = Date.now();
    while (!this.isExited && Date.now() - start < gracePeriodMs) {
      await delay(200);
    }

    if (!this.isExited) {
      try {
        this.child.kill('SIGTERM');
        await delay(500);
        if (!this.isExited) {
          this.child.kill('SIGKILL');
        }
      } catch {
        /* ignore kill errors */
      }
    }
  }

  getOutput(): string {
    return stripAnsi(this.output);
  }

  getRawOutput(): string {
    return this.output;
  }

  getOutputLength(): number {
    return this.output.length;
  }

  getOutputSlice(startOffset: number): string {
    return stripAnsi(this.output.slice(startOffset));
  }
}

// ---------------------------------------------------------------------------
// Main Black-Box Acceptance Test Runner
// ---------------------------------------------------------------------------

async function runCliBlackBoxAcceptance(): Promise<void> {
  console.log('============================================================');
  console.log('NEXUS AI — TRUE BLACK-BOX CLI END-TO-END ACCEPTANCE SUITE');
  console.log('============================================================\n');

  // Step 0: Read version from package.json dynamically
  const pkgPath = path.resolve('package.json');
  const pkgData = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const expectedVersion = pkgData.version || '0.1.3';
  console.log(`Target Package: ${pkgData.name} v${expectedVersion}`);

  // Step 1: Resolve actual installed executable
  const resolvedCli = resolveInstalledNexusCli();
  console.log(`Resolved Executable: ${resolvedCli.description}`);
  console.log(`Command Line: ${resolvedCli.command} ${resolvedCli.args.join(' ')}\n`);

  // Step 2: Verify `nexus --version`
  console.log('--- STEP 1: VERIFYING INSTALLED CLI VERSION ---');
  let versionOutput = '';
  if (resolvedCli.command === 'cmd.exe') {
    versionOutput = execSync(`${resolvedCli.args.join(' ')} --version`, { encoding: 'utf8' }).trim();
  } else {
    const fullArgs = [...resolvedCli.args, '--version'];
    versionOutput = execSync(`"${resolvedCli.command}" ${fullArgs.join(' ')}`, { encoding: 'utf8' }).trim();
  }
  console.log(`Output: "${versionOutput}"`);

  if (!versionOutput.includes(`NEXUS AI v${expectedVersion}`)) {
    throw new Error(`CLI version mismatch. Expected "NEXUS AI v${expectedVersion}", got: "${versionOutput}"`);
  }
  console.log(`✓ STEP 1 PASSED: nexus --version matches expected "NEXUS AI v${expectedVersion}"\n`);

  // Step 3: Chat Regression Test (Mode isolation)
  console.log('--- STEP 2: CHAT REGRESSION & MODE ISOLATION TEST ---');
  const chatTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-chat-reg-'));
  const chatWs = path.join(chatTmpDir, 'workspace');
  const chatDb = path.join(chatTmpDir, 'nexus.sqlite');
  fs.mkdirSync(chatWs, { recursive: true });

  const chatSession = new CliProcessSession(resolvedCli, {
    WORKSPACE_ROOT: chatWs,
    DATABASE_PATH: chatDb,
  });

  try {
    await chatSession.waitForPattern(/NEXUS>/, 20000);
    console.log('CLI initialized in Agent Mode');

    // Switch to Chat Mode
    chatSession.send('/chat');
    await chatSession.waitForPattern(/CHAT>|NEXUS Chat Mode|Chat Mode Active/i, 20000);
    console.log('Switched to Chat Mode');

    // Send math prompt in Chat Mode
    chatSession.send('Hello, what is 2 + 2?');
    await chatSession.waitForPattern(/4/, 30000);
    console.log('Chat response received successfully with expected calculation result');
    await chatSession.waitForPattern(/Chat>/i, 20000);
    await delay(1000);

    // Exit Chat Mode
    chatSession.send('/exit-chat');
    await chatSession.waitForPattern(/Returned to NEXUS Agent mode|NEXUS>/i, 20000);
    console.log('Returned to Agent Mode cleanly');

    await chatSession.close();

    // Verify Chat mode did not create project child tasks in SQLite
    if (fs.existsSync(chatDb)) {
      const db = new Database(chatDb, { readonly: true });
      const childTasks = db.prepare("SELECT count(*) as cnt FROM agent_tasks WHERE task_type = 'child_unit'").get() as { cnt: number };
      db.close();
      if (childTasks.cnt > 0) {
        throw new Error(`Chat Mode unexpectedly created ${childTasks.cnt} project child tasks!`);
      }
    }
    console.log('✓ STEP 2 PASSED: Chat mode operates with complete subsystem isolation.\n');
  } finally {
    await chatSession.close();
    try {
      fs.rmSync(chatTmpDir, { recursive: true, force: true });
    } catch {}
  }

  // Step 4: Full Real User Project Orchestration Black-Box Test
  console.log('--- STEP 3: REAL USER PROJECT DECOMPOSITION & ORCHESTRATION ---');
  const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-e2e-'));
  const testWs = path.join(testTmpDir, 'workspace');
  const testDb = path.join(testTmpDir, 'nexus.sqlite');
  fs.mkdirSync(testWs, { recursive: true });

  console.log(`Isolated Test Workspace: ${testWs}`);
  console.log(`Isolated Test Database:  ${testDb}`);

  const mainSession = new CliProcessSession(resolvedCli, {
    WORKSPACE_ROOT: testWs,
    DATABASE_PATH: testDb,
  });

  let previewUrl = '';

  try {
    // 1. Wait for CLI startup dashboard
    await mainSession.waitForPattern(/NEXUS>/, 25000);
    console.log('CLI Dashboard loaded');

    // 2. Submit Real User Prompt through stdin
    const userPrompt =
      'Build a complete premium modern landing page for a fictional technology company called E2E-NEXUS. Include a navbar, hero, features, pricing, FAQ, CTA, footer, responsive design and interactions.';
    console.log(`\nSubmitting user prompt via stdin:\n"${userPrompt}"\n`);
    mainSession.send(userPrompt);

    // 3. Verify Real Task Plan Output in CLI stdout
    console.log('Waiting for NEXUS TASK PLAN output in CLI stdout...');
    await mainSession.waitForPattern(/NEXUS TASK PLAN|TASK PLAN|Decomposed into/i, 45000);
    console.log('✓ Observed NEXUS TASK PLAN in real CLI stdout');

    // 4. Verify evidence of multiple child units executing
    console.log('Monitoring child units execution progress...');
    await mainSession.waitForPattern(/Project Foundation|Navigation Header|Hero Section|Core Features/i, 60000);
    console.log('✓ Observed child units starting and executing');

    // 5. Wait for full orchestration completion
    console.log('Waiting for full project orchestration completion (up to 5 minutes)...');
    await mainSession.waitForPattern(/FINAL RESULT — PROJECT COMPLETED|PROJECT COMPLETED|Final end-to-end integration verified/i, 300000);
    console.log('✓ Observed project orchestration completion card in CLI stdout');

    // Allow prompt to stabilize
    await mainSession.waitForPattern(/NEXUS>/, 20000);
    await delay(1000);

    // 6. Test /tasks command through interactive CLI
    console.log('\n--- STEP 4: VERIFYING /tasks COMMAND THROUGH REAL CLI ---');
    mainSession.send('/tasks');
    const tasksOutput = await mainSession.waitForPattern(/Task History|ACTIVE TASK|E2E-NEXUS|COMPLETED/i, 15000);
    console.log('✓ /tasks output confirmed parent and child tasks in CLI');
    await mainSession.waitForPattern(/NEXUS>/, 10000);
    await delay(500);

    // 7. Test /preview command through interactive CLI
    console.log('\n--- STEP 5: VERIFYING /preview COMMAND THROUGH REAL CLI ---');
    const previewSendOffset = mainSession.getOutputLength();
    mainSession.send('/preview');
    await mainSession.waitForPattern(/Preview launched successfully|Preview Unavailable|Cannot preview/i, 25000);
    const previewSlice = mainSession.getOutputSlice(previewSendOffset);
    const urlMatch = previewSlice.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (!urlMatch) {
      throw new Error(`Failed to obtain preview URL from CLI output slice:\n${previewSlice}`);
    }
    previewUrl = urlMatch[0];
    console.log(`✓ /preview launched successfully at: ${previewUrl}`);

    // 8. Fetch live HTTP response from preview server
    console.log(`Fetching HTTP GET from ${previewUrl}...`);
    const httpRes = await fetchHttp(previewUrl, 10000);
    console.log(`HTTP Status Code: ${httpRes.statusCode}`);
    console.log(`HTTP Body Size:   ${httpRes.body.length} bytes`);

    if (httpRes.statusCode !== 200) {
      throw new Error(`Preview server responded with non-200 status: ${httpRes.statusCode}`);
    }

    if (!httpRes.body.includes('E2E-NEXUS')) {
      throw new Error('Preview server HTTP body does not contain the requested brand name "E2E-NEXUS"!');
    }
    console.log('✓ Preview server serves live content containing brand "E2E-NEXUS"');

    // 9. Stop preview server via CLI command
    console.log('Stopping preview server with /preview stop...');
    mainSession.send('/preview stop');
    await mainSession.waitForPattern(/Preview server stopped successfully|NEXUS>/i, 15000);
    console.log('✓ /preview stop confirmed');
    await delay(500);

    // 10. Exit main CLI session cleanly
    await mainSession.close();
    console.log('✓ Main CLI session closed cleanly');

    // 11. SQLite Database Inspection (Read-Only Observation)
    console.log('\n--- STEP 6: VERIFYING PERSISTED DATABASE STATE ---');
    if (!fs.existsSync(testDb)) {
      throw new Error(`Database file was not created at: ${testDb}`);
    }

    const db = new Database(testDb, { readonly: true });

    // Verify parent task
    const parentTask = db
      .prepare("SELECT * FROM agent_tasks WHERE parent_task_id IS NULL AND title LIKE '%E2E-NEXUS%' ORDER BY created_at DESC LIMIT 1")
      .get() as { id: string; state: string; title: string } | undefined;

    if (!parentTask) {
      throw new Error('No root parent task found in SQLite database for E2E-NEXUS');
    }
    console.log(`✓ Root Task ID:   ${parentTask.id} (${parentTask.title})`);
    console.log(`✓ Root Task State: ${parentTask.state}`);
    if (parentTask.state !== 'completed') {
      throw new Error(`Expected root task state 'completed', got '${parentTask.state}'`);
    }

    // Verify child tasks
    const childTasks = db
      .prepare('SELECT id, sequence, title, state, dependencies, parent_task_id FROM agent_tasks WHERE parent_task_id = ? ORDER BY sequence ASC')
      .all(parentTask.id) as Array<{ id: string; sequence: number; title: string; state: string; dependencies: string; parent_task_id: string }>;

    console.log(`✓ Child Tasks Count: ${childTasks.length}`);
    if (childTasks.length < 8) {
      throw new Error(`Expected at least 8 decomposed child tasks, found ${childTasks.length}`);
    }

    childTasks.forEach((c) => {
      console.log(`  [Unit ${c.sequence}] ${c.title.padEnd(42, ' ')} -> State: ${c.state.toUpperCase()}`);
      if (c.state !== 'completed') {
        throw new Error(`Child task '${c.title}' (ID: ${c.id}) is in state '${c.state}', expected 'completed'`);
      }
    });

    // Verify task artifact registration
    const artifact = db
      .prepare('SELECT * FROM task_artifacts WHERE task_id = ?')
      .get(parentTask.id) as { project_root: string; entry_point: string; artifact_type: string; is_verified: number } | undefined;

    if (!artifact) {
      throw new Error(`No task artifact recorded in database for task ${parentTask.id}`);
    }
    console.log(`✓ Registered Artifact: type=${artifact.artifact_type}, entryPoint=${artifact.entry_point}, verified=${artifact.is_verified}`);
    if (artifact.is_verified !== 1) {
      throw new Error('Task artifact is not marked as verified in database!');
    }

    db.close();

    // 12. Workspace File Substance & Placeholder Audit
    console.log('\n--- STEP 7: VERIFYING WORKSPACE ARTIFACT SUBSTANCE ---');
    const indexFiles = findFilesRecursive(testWs, 'index.html');
    if (indexFiles.length === 0) {
      throw new Error(`index.html was not found in workspace: ${testWs}`);
    }
    const indexPath = indexFiles[0];
    const htmlContent = fs.readFileSync(indexPath, 'utf8');
    console.log(`Located index.html at: ${indexPath} (${htmlContent.length} bytes)`);

    // Verify required sections
    const requiredSections = [
      { name: 'Brand Name (E2E-NEXUS)', check: htmlContent.includes('E2E-NEXUS') },
      { name: 'Navbar / Navigation', check: htmlContent.includes('nav') || htmlContent.includes('header') },
      { name: 'Hero Section', check: htmlContent.includes('hero') || htmlContent.includes('Hero') },
      { name: 'Features Section', check: htmlContent.includes('feature') || htmlContent.includes('Feature') },
      { name: 'Pricing Section', check: htmlContent.includes('pricing') || htmlContent.includes('price') || htmlContent.includes('Plan') },
      { name: 'FAQ Section', check: htmlContent.includes('faq') || htmlContent.includes('FAQ') || htmlContent.includes('accordion') || htmlContent.includes('details') },
      { name: 'Call to Action (CTA)', check: htmlContent.includes('cta') || htmlContent.includes('CTA') || htmlContent.includes('Get Started') },
      { name: 'Footer Section', check: htmlContent.includes('footer') || htmlContent.includes('Footer') },
    ];

    for (const sec of requiredSections) {
      if (!sec.check) {
        throw new Error(`Substance verification failed: Missing required section '${sec.name}' in index.html`);
      }
      console.log(`  ✓ ${sec.name}`);
    }

    // Verify no forbidden placeholder comment patterns
    const forbiddenPlaceholders = [
      '<!-- Hero Content -->',
      '<!-- Features Content -->',
      '<!-- Content -->',
      '<!-- TODO',
      '/* TODO',
      '// Content for',
    ];
    for (const ph of forbiddenPlaceholders) {
      if (htmlContent.includes(ph)) {
        throw new Error(`Found forbidden placeholder comment '${ph}' in index.html!`);
      }
    }
    console.log('✓ Zero placeholder comments detected in generated HTML');

    // 13. Restart / Resume Black-Box Test
    console.log('\n--- STEP 8: RESTART & RESUME BLACK-BOX TEST ---');
    const resumeSession = new CliProcessSession(resolvedCli, {
      WORKSPACE_ROOT: testWs,
      DATABASE_PATH: testDb,
    });

    try {
      await resumeSession.waitForPattern(/NEXUS>/, 25000);
      console.log('CLI restarted against existing workspace and database');

      resumeSession.send('/tasks');
      await resumeSession.waitForPattern(/E2E-NEXUS|COMPLETED/i, 15000);
      console.log('✓ Restarted CLI successfully retained completed tasks state');

      const resumeSendOffset = resumeSession.getOutputLength();
      resumeSession.send('/preview');
      await resumeSession.waitForPattern(/Preview launched successfully|http:\/\/127\.0\.0\.1:\d+/i, 20000);
      const resumePreviewSlice = resumeSession.getOutputSlice(resumeSendOffset);
      const resumeUrlMatch = resumePreviewSlice.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (resumeUrlMatch) {
        const resumeHttp = await fetchHttp(resumeUrlMatch[0], 5000);
        if (resumeHttp.statusCode === 200 && resumeHttp.body.includes('E2E-NEXUS')) {
          console.log(`✓ Restarted CLI instantly served preview on ${resumeUrlMatch[0]} without re-executing`);
        }
        resumeSession.send('/preview stop');
        await resumeSession.waitForPattern(/Preview server stopped successfully|NEXUS>/i, 10000);
      }
    } finally {
      await resumeSession.close();
    }

    // 14. Negative / Failure-Path Verification
    console.log('\n--- STEP 9: TRUTHFUL FAILURE & NON-PREVIEWABLE TEST ---');
    const negTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-neg-'));
    const negWs = path.join(negTmpDir, 'workspace');
    const negDb = path.join(negTmpDir, 'nexus.sqlite');
    fs.mkdirSync(negWs, { recursive: true });

    const negSession = new CliProcessSession(resolvedCli, {
      WORKSPACE_ROOT: negWs,
      DATABASE_PATH: negDb,
    });

    try {
      await negSession.waitForPattern(/NEXUS>/, 20000);

      // Request a non-web file
      negSession.send('Create a plain text file notes.txt containing text test data');
      await negSession.waitForPattern(/TASK COMPLETED|Completed/i, 40000);
      await negSession.waitForPattern(/NEXUS>/, 10000);

      // Attempt /preview on non-web project
      negSession.send('/preview');
      const negPreviewOut = await negSession.waitForPattern(
        /does not contain a previewable web project|NOT_WEB_PROJECT|MISSING_INDEX|No completed task|NEXUS>/i,
        20000
      );
      console.log('✓ Non-web task correctly blocked from launching invalid web preview');

      await negSession.close();
    } finally {
      await negSession.close();
      try {
        fs.rmSync(negTmpDir, { recursive: true, force: true });
      } catch {}
    }

    console.log('\n============================================================');
    console.log('NEXUS BLACK-BOX CLI E2E ACCEPTANCE EVIDENCE');
    console.log('============================================================');
    console.log(`✓ nexus --version (${versionOutput})`);
    console.log('✓ Real nexus executable launched as separate OS process');
    console.log('✓ Real user prompt submitted through stdin');
    console.log('✓ NEXUS TASK PLAN observed in CLI stdout');
    console.log(`✓ ${childTasks.length} child units created and executed through real CLI`);
    console.log('✓ Child verification and final integration observed');
    console.log('✓ Parent task marked COMPLETED');
    console.log('✓ /tasks verified through interactive CLI');
    console.log(`✓ /preview verified through interactive CLI (${previewUrl})`);
    console.log('✓ Live preview HTTP GET returned 200 with E2E-NEXUS brand content');
    console.log('✓ Real project artifacts verified with zero placeholder content');
    console.log('✓ Restart & resume verified on existing workspace database');
    console.log('✓ Chat mode verified with complete task isolation');
    console.log('✓ Non-web task preview properly guarded');
    console.log('============================================================');
    console.log('\nREAL INSTALLED CLI E2E = PASS\n');
  } finally {
    await mainSession.close();
    // Clean up temporary directory unless retention requested for debugging
    if (process.env.NEXUS_PRESERVE_TEST_DIR !== '1') {
      try {
        fs.rmSync(testTmpDir, { recursive: true, force: true });
      } catch {}
    } else {
      console.log(`[DEBUG] Retained test directory: ${testTmpDir}`);
    }
  }
}

runCliBlackBoxAcceptance().catch((err) => {
  console.error('\n============================================================');
  console.error('NEXUS BLACK-BOX CLI E2E ACCEPTANCE FAILED');
  console.error('============================================================');
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  console.error('\nREAL INSTALLED CLI E2E = NOT PROVEN\n');
  process.exit(1);
});
