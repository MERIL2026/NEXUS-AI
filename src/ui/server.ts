/**
 * NEXUS AI — Native Desktop UI Server (P7-D)
 *
 * Lightweight, zero-dependency HTTP API & static asset server built using Node's native `http` module.
 * Serves the Single-Page Desktop Application and exposes REST endpoints bound strictly to 127.0.0.1.
 *
 * SECURITY INVARIANT:
 * The UI Server is a pure proxy/adapter over `ApplicationApi`.
 * It DOES NOT execute direct filesystem mutations, terminal processes, or database queries.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ApplicationApi } from '../api/index.js';
import type { AgentPlanStep } from '../orchestration/types.js';
import { Logger, LogLevel } from '../common/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

export class UIServer {
  private server: http.Server | null = null;
  private logger: Logger;
  private listeningPort: number;

  constructor(
    private appApi: ApplicationApi,
    port: number = 3000,
    logLevel: LogLevel = 'info'
  ) {
    this.listeningPort = port;
    this.logger = new Logger('UIServer', logLevel);
  }

  getPort(): number {
    return this.listeningPort;
  }

  getHttpServer(): http.Server | null {
    return this.server;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`Error handling request ${req.url}: ${msg}`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal Server Error', detail: msg }));
          }
        }
      });

      this.server.on('error', (err) => {
        this.logger.error(`HTTP Server error: ${err.message}`);
        reject(err);
      });

      this.server.listen(this.listeningPort, '127.0.0.1', () => {
        const address = this.server?.address();
        if (typeof address === 'object' && address !== null) {
          this.listeningPort = address.port;
        }
        this.logger.info(`NEXUS Desktop UI Server listening on http://127.0.0.1:${this.listeningPort}`);
        resolve(this.listeningPort);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.logger.info('Desktop UI Server stopped cleanly.');
        this.server = null;
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    // Security headers & CORS for localhost
    res.setHeader('Access-Control-Allow-Origin', `http://127.0.0.1:${this.listeningPort}`);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── API ROUTES ─────────────────────────────────────────────────────────────
    if (pathname.startsWith('/api/')) {
      await this.handleApiRoute(pathname, method, req, res);
      return;
    }

    // ── STATIC ASSETS ──────────────────────────────────────────────────────────
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

    // Prevent directory traversal out of public/
    if (!path.resolve(filePath).startsWith(path.resolve(PUBLIC_DIR))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Access Denied' }));
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('NEXUS UI Asset Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  }

  private async handleApiRoute(
    pathname: string,
    method: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const json = (data: unknown, statusCode = 200) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };

    const readBody = async (): Promise<Record<string, unknown>> => {
      return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          if (!body.trim()) {
            resolve({});
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('Invalid JSON request payload'));
          }
        });
        req.on('error', reject);
      });
    };

    // 1. GET /api/health — System health report
    if (pathname === '/api/health' && method === 'GET') {
      const report = this.appApi.getHealthReport();
      json(report);
      return;
    }

    // 2. GET /api/first-run — First-run 9-check report
    if (pathname === '/api/first-run' && method === 'GET') {
      const report = await this.appApi.getFirstRunReport();
      json(report);
      return;
    }

    // 3. POST /api/workspace/validate — Safe workspace path validation
    if (pathname === '/api/workspace/validate' && method === 'POST') {
      const body = await readBody();
      const rawPath = String(body.path || '');
      const result = this.appApi.validateWorkspace(rawPath);
      json(result);
      return;
    }

    // 4. GET /api/runtime — AI runtime health & models
    if (pathname === '/api/runtime' && method === 'GET') {
      const health = await this.appApi.intelligence.runtimeManager.getHealth();
      const models = await this.appApi.intelligence.runtimeManager.listModels();
      json({ health, models });
      return;
    }

    // 5. GET /api/models — ModelRegistry available models
    if (pathname === '/api/models' && method === 'GET') {
      const models = this.appApi.intelligence.registry?.getAvailableModels() ?? [];
      json({ models });
      return;
    }

    // 6. GET /api/tasks — List all tasks
    if (pathname === '/api/tasks' && method === 'GET') {
      const tasks = this.appApi.tasks?.listTasks() ?? [];
      json({ tasks });
      return;
    }

    // 7. GET /api/tasks/:id — Get task details
    if (pathname.startsWith('/api/tasks/') && method === 'GET') {
      const id = pathname.substring('/api/tasks/'.length);
      try {
        const task = this.appApi.tasks.getTask(id);
        json({ task });
      } catch {
        json({ error: `Task '${id}' not found` }, 404);
      }
      return;
    }

    // 8. POST /api/tasks — Create task and start background planning/execution pipeline asynchronously
    if (pathname === '/api/tasks' && method === 'POST') {
      const body = await readBody();
      const prompt = String(body.prompt || body.title || '').trim();
      if (!prompt) {
        json({ error: 'Task prompt or title is required' }, 400);
        return;
      }

      if (!this.appApi.planner || !this.appApi.execution) {
        json({ error: 'Agent subsystems (planner/execution) are not initialized' }, 503);
        return;
      }

      // Step 1: Create task
      const title = prompt.length > 50 ? `${prompt.slice(0, 47)}...` : prompt;
      const task = this.appApi.tasks.createTask({ title });

      // Step 2: Launch planning & execution pipeline asynchronously in background
      (async () => {
        try {
          this.appApi.tasks.transitionTask(task.id, { targetState: 'planning' });
          const synthesis = await this.appApi.planner!.synthesize(task.id, {
            taskGoal: prompt,
            temperature: 0.2,
          });

          if (!synthesis.success || !synthesis.plan) {
            this.appApi.tasks.failTask(task.id, {
              errorCategory: synthesis.errorCategory || 'PLAN_VALIDATION_FAILED',
            });
            return;
          }

          // Persist plan steps in SQLite database
          const steps = synthesis.plan.steps;
          this.appApi.tasks.setTaskPlan(task.id, JSON.stringify(steps));

          // Step 3: Run execution loop (may pause at awaiting_approval)
          await this.appApi.execution!.runExecutionLoop(task.id, steps);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`Background task execution failed for task '${task.id}': ${msg}`);
          try {
            this.appApi.tasks.failTask(task.id, { errorCategory: 'EXECUTION_LOOP_FAILED' });
          } catch {
            /* ignore transition errors if already terminal */
          }
        }
      })();

      json({ task: this.appApi.tasks.getTask(task.id) });
      return;
    }

    // 9. GET /api/approvals — List pending approval requests
    if (pathname === '/api/approvals' && method === 'GET') {
      const approvals = this.appApi.approvals?.listPendingApprovals() ?? [];
      json({ approvals });
      return;
    }

    // 10. POST /api/approvals/:id/respond — Respond to an approval request and resume execution from SQLite plan
    if (pathname.startsWith('/api/approvals/') && pathname.endsWith('/respond') && method === 'POST') {
      const parts = pathname.split('/');
      const approvalId = parts[3];
      const body = await readBody();
      const decision = String(body.decision || '').toUpperCase();

      if (!['APPROVED', 'REJECTED'].includes(decision)) {
        json({ error: 'Decision must be APPROVED or REJECTED' }, 400);
        return;
      }

      let updatedApproval;
      try {
        updatedApproval = this.appApi.approvals?.respondToApproval(approvalId, {
          decision: decision as 'APPROVED' | 'REJECTED',
          reason: body.reason ? String(body.reason) : undefined,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        json({ error: msg }, 400);
        return;
      }

      // If decision was APPROVED and execution service is available, resume the execution loop using persisted plan steps from SQLite
      if (decision === 'APPROVED' && updatedApproval && this.appApi.execution) {
        const taskId = updatedApproval.taskId;
        const task = this.appApi.tasks.getTask(taskId);

        let planSteps: AgentPlanStep[] = [];
        if (task.plan) {
          try {
            const parsed = JSON.parse(task.plan);
            planSteps = Array.isArray(parsed) ? parsed : (parsed.steps || []);
          } catch {
            this.logger.error(`Failed to parse persisted plan for task '${taskId}'`);
          }
        }

        if (planSteps.length > 0) {
          try {
            const resumedTask = await this.appApi.execution.runExecutionLoop(taskId, planSteps);
            json({ approval: updatedApproval, task: resumedTask });
            return;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(`Execution resume failed for task '${taskId}' after approval: ${msg}`);
            // Fall through to return approval without resumed task
          }
        } else {
          this.logger.warn(`No persisted plan steps found in SQLite for task '${taskId}' — cannot resume execution loop after approval.`);
        }
      }

      json({ approval: updatedApproval });
      return;
    }

    // 11. GET /api/workspace/tree — Read-only directory tree via ToolGateway
    if (pathname === '/api/workspace/tree' && method === 'GET') {
      let sessionTask = (this.appApi.tasks?.listTasks() || [])[0];
      if (!sessionTask) {
        sessionTask = this.appApi.tasks.createTask({ title: 'Desktop UI Exploration Session' });
      }

      const result = await this.appApi.tools.executeTool({
        requestId: `ui-tree-${Date.now()}`,
        taskId: sessionTask.id,
        toolId: 'workspace_tree',
        requestedCapabilities: ['filesystem.read'],
        params: {},
      });
      json(result);
      return;
    }

    // 12. POST /api/workspace/file — Read file content via ToolGateway
    if (pathname === '/api/workspace/file' && method === 'POST') {
      let sessionTask = (this.appApi.tasks?.listTasks() || [])[0];
      if (!sessionTask) {
        sessionTask = this.appApi.tasks.createTask({ title: 'Desktop UI Exploration Session' });
      }

      const body = await readBody();
      const relPath = String(body.relativePath || body.path || '');
      const result = await this.appApi.tools.executeTool({
        requestId: `ui-read-${Date.now()}`,
        taskId: sessionTask.id,
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: relPath },
      });
      json(result);
      return;
    }

    // 13. GET /api/knowledge/collections — RAG collections
    if (pathname === '/api/knowledge/collections' && method === 'GET') {
      const collections = this.appApi.knowledge?.rag.listCollections() ?? [];
      json({ collections });
      return;
    }

    // 14. POST /api/knowledge/ingest — Ingest document into RAG
    if (pathname === '/api/knowledge/ingest' && method === 'POST') {
      const body = await readBody();
      const filename = String(body.filename || 'untitled.md');
      const text = String(body.text || '');
      const collectionId = body.collectionId
        ? String(body.collectionId)
        : this.appApi.knowledge.rag.getOrCreateDefaultCollection().id;

      const doc = await this.appApi.knowledge.rag.ingestText(filename, text, collectionId);
      json({ document: doc });
      return;
    }

    // 15. GET /api/activity — Activity timeline
    if (pathname === '/api/activity' && method === 'GET') {
      const timeline = this.appApi.getActivityTimeline();
      json({ activity: timeline });
      return;
    }

    // Route not found
    json({ error: `API route not found: ${method} ${pathname}` }, 404);
  }
}
