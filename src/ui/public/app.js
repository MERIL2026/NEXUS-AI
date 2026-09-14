/**
 * NEXUS AI — Desktop SPA Client Application (P7-D)
 *
 * Client-side ES2022 controller.
 * Routes 12 desktop views, interacts with native UIServer REST endpoints,
 * manages view state, plan rendering, approval delegation, file viewing, and wizard overlay.
 */

(function () {
  'use strict';

  // App State
  const state = {
    activeView: 'dashboard',
    health: null,
    firstRunReport: null,
    runtimeInfo: null,
    tasks: [],
    approvals: [],
    activity: [],
    workspaceTree: null,
    activeFileContent: null,
    activeFilePath: null,
  };

  // DOM Elements
  const container = document.getElementById('main-view-container');
  const navItems = document.querySelectorAll('.nav-item');
  const navApprovalCount = document.getElementById('nav-approval-count');

  // Header Elements
  const hdrSysVal = document.getElementById('hdr-sys-val');
  const hdrRtVal = document.getElementById('hdr-rt-val');
  const hdrModelVal = document.getElementById('hdr-model-val');
  const hdrSysDot = document.querySelector('#hdr-system-status .dot');
  const hdrRtDot = document.querySelector('#hdr-runtime-status .dot');

  // Modal Wizard
  const modalWizard = document.getElementById('modal-wizard');
  const btnWizardFinish = document.getElementById('btn-wizard-finish');
  const btnCloseWizard = document.getElementById('btn-close-wizard');
  const btnFirstRunWizard = document.getElementById('btn-first-run-wizard');

  // API helper
  async function apiFetch(endpoint, options = {}) {
    try {
      const res = await fetch(endpoint, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      return await res.json();
    } catch (err) {
      console.error(`API Fetch Error [${endpoint}]:`, err);
      return { error: String(err) };
    }
  }

  // Poll system health
  async function refreshSystemState() {
    state.health = await apiFetch('/api/health');
    state.firstRunReport = await apiFetch('/api/first-run');
    state.runtimeInfo = await apiFetch('/api/runtime');
    const apprRes = await apiFetch('/api/approvals');
    state.approvals = apprRes.approvals || [];
    const taskRes = await apiFetch('/api/tasks');
    state.tasks = taskRes.tasks || [];

    updateHeaderUI();
    updateNavBadges();
  }

  function updateHeaderUI() {
    if (!state.health) return;

    const sysOverall = (state.health.overall || 'UNKNOWN').toUpperCase();
    hdrSysVal.textContent = sysOverall;
    if (sysOverall === 'OK') {
      hdrSysDot.className = 'dot green';
    } else if (sysOverall === 'DEGRADED') {
      hdrSysDot.className = 'dot yellow';
    } else {
      hdrSysDot.className = 'dot red';
    }

    const rtHealth = state.runtimeInfo?.health;
    const rtStatus = (rtHealth?.status || 'UNAVAILABLE').toUpperCase();
    hdrRtVal.textContent = rtStatus;
    if (rtStatus === 'READY') {
      hdrRtDot.className = 'dot green';
    } else {
      hdrRtDot.className = 'dot yellow';
    }

    if (state.firstRunReport?.primaryModelId) {
      hdrModelVal.textContent = state.firstRunReport.primaryModelId;
    }
  }

  function updateNavBadges() {
    const pendingCount = state.approvals.length;
    if (pendingCount > 0) {
      navApprovalCount.textContent = pendingCount;
      navApprovalCount.classList.remove('hidden');
    } else {
      navApprovalCount.classList.add('hidden');
    }
  }

  // Navigation Routing
  function setupNavigation() {
    navItems.forEach((item) => {
      item.addEventListener('click', () => {
        const view = item.getAttribute('data-view');
        switchView(view);
      });
    });

    btnFirstRunWizard?.addEventListener('click', () => showWizardModal());
    btnCloseWizard?.addEventListener('click', () => hideWizardModal());
    btnWizardFinish?.addEventListener('click', () => hideWizardModal());
  }

  function switchView(viewName) {
    state.activeView = viewName;
    navItems.forEach((item) => {
      if (item.getAttribute('data-view') === viewName) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    renderCurrentView();
  }

  function renderCurrentView() {
    switch (state.activeView) {
      case 'dashboard': renderDashboardView(); break;
      case 'agent': renderAgentView(); break;
      case 'plan': renderPlanView(); break;
      case 'approvals': renderApprovalsView(); break;
      case 'explorer': renderExplorerView(); break;
      case 'diff': renderDiffView(); break;
      case 'history': renderHistoryView(); break;
      case 'activity': renderActivityView(); break;
      case 'models': renderModelsView(); break;
      case 'knowledge': renderKnowledgeView(); break;
      case 'settings': renderSettingsView(); break;
      default: renderDashboardView(); break;
    }
  }

  // 1. DASHBOARD VIEW
  function renderDashboardView() {
    const sysOverall = state.health?.overall?.toUpperCase() || 'OK';
    const rtStatus = state.runtimeInfo?.health?.status?.toUpperCase() || 'READY';
    const wsPath = state.firstRunReport?.workspaceCanonicalPath || 'C:\\...\\workspace';
    const model = state.firstRunReport?.primaryModelId || 'qwen2.5:3b';

    container.innerHTML = `
      <div class="view-header">
        <h1 class="view-title">System Dashboard</h1>
        <p class="view-subtitle">Real-time NEXUS AI workstation overview & status</p>
      </div>

      <div class="grid-4" style="margin-bottom:24px;">
        <div class="card">
          <div class="card-title">System Status</div>
          <div class="card-value" style="color:${sysOverall === 'OK' ? 'var(--success)' : 'var(--warning)'}">${sysOverall}</div>
        </div>
        <div class="card">
          <div class="card-title">AI Runtime</div>
          <div class="card-value" style="color:${rtStatus === 'READY' ? 'var(--success)' : 'var(--warning)'}">${rtStatus}</div>
        </div>
        <div class="card">
          <div class="card-title">Active Model</div>
          <div class="card-value" style="font-size:15px; margin-top:4px;">${model}</div>
        </div>
        <div class="card">
          <div class="card-title">Pending Approvals</div>
          <div class="card-value" style="color:${state.approvals.length > 0 ? 'var(--warning)' : 'var(--text-main)'}">${state.approvals.length}</div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-title">Quick Actions</div>
          <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
            <button class="btn-primary" onclick="window.nexusApp.switchView('agent')">🤖 Start New Agent Task</button>
            <button class="btn-secondary" onclick="window.nexusApp.switchView('approvals')">🛡️ Review Pending Approvals (${state.approvals.length})</button>
            <button class="btn-secondary" onclick="window.nexusApp.switchView('explorer')">📁 Browse Workspace Files</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Workspace Location</div>
          <div style="margin-top:10px;">
            <p style="font-size:12px; color:var(--text-muted);">Configured Sandbox Path:</p>
            <div class="code-box" style="margin-top:6px; font-size:11px;">${wsPath}</div>
          </div>
        </div>
      </div>
    `;
  }

  // Task execution polling & formatting helpers
  let activeTaskPollInterval = null;

  function stopTaskPolling() {
    if (activeTaskPollInterval) {
      clearInterval(activeTaskPollInterval);
      activeTaskPollInterval = null;
    }
  }

  function formatTaskLog(task) {
    if (!task) return 'Agent execution log will stream here...';
    let log = `[Task ID] ${task.id}\n`;
    log += `[Goal] ${task.title}\n`;
    log += `[State] ${(task.state || 'UNKNOWN').toUpperCase()}\n`;
    if (task.currentStep) {
      log += `[Current Step] ${task.currentStep} (Status: ${task.stepStatus || 'active'})\n`;
    }

    if (task.plan) {
      try {
        const steps = typeof task.plan === 'string' ? JSON.parse(task.plan) : task.plan;
        if (Array.isArray(steps) && steps.length > 0) {
          log += `\n[Execution Plan Steps (${steps.length})]:\n`;
          steps.forEach((s, i) => {
            log += `  ${i + 1}. [${s.toolId}] ${s.stepId} — caps: [${(s.requestedCapabilities || []).join(', ')}]\n`;
          });
        }
      } catch {
        log += `\n[Plan] ${task.plan}\n`;
      }
    }

    if (task.state === 'completed') {
      log += '\n✅ Task completed successfully.\n';
    } else if (task.state === 'awaiting_approval') {
      log += '\n⚠ Task paused — approval required.\nGo to Approval Center to review and authorize the next step.\n';
    } else if (task.state === 'failed') {
      log += `\n❌ Task failed [${task.errorCategory || 'UNKNOWN'}]\n`;
    } else if (task.state === 'cancelled') {
      log += '\n⚠ Task was cancelled.\n';
    }
    return log;
  }

  function updateFlowSteps(taskState) {
    const steps = ['planning', 'plan_ready', 'awaiting_approval', 'executing', 'observing', 'verifying', 'completed'];
    const currentState = (taskState || '').toLowerCase();

    let activeIndex = 0;
    if (currentState === 'planning') activeIndex = 0;
    else if (currentState === 'awaiting_approval') activeIndex = 2;
    else if (currentState === 'executing') activeIndex = 3;
    else if (currentState === 'observing') activeIndex = 4;
    else if (currentState === 'verifying') activeIndex = 5;
    else if (currentState === 'completed') activeIndex = 6;
    else if (currentState === 'failed') activeIndex = 3;

    steps.forEach((stepId, idx) => {
      const el = document.getElementById(`step-${stepId}`);
      if (el) {
        if (idx <= activeIndex) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      }
    });
  }

  function pollTask(taskId) {
    stopTaskPolling();
    activeTaskPollInterval = setInterval(async () => {
      const res = await apiFetch(`/api/tasks/${taskId}`);
      if (!res.task) {
        stopTaskPolling();
        return;
      }
      const task = res.task;
      const idx = state.tasks.findIndex((t) => t.id === task.id);
      if (idx >= 0) state.tasks[idx] = task;
      else state.tasks.push(task);

      if (state.activeView === 'agent') {
        const box = document.getElementById('agent-output-box');
        if (box) box.textContent = formatTaskLog(task);
        updateFlowSteps(task.state);
      }

      if (['completed', 'failed', 'cancelled', 'awaiting_approval'].includes(task.state)) {
        stopTaskPolling();
        const btn = document.getElementById('btn-submit-task');
        if (btn) btn.disabled = false;
        refreshSystemState();
      }
    }, 800);
  }

  // 2. AGENT WORKSPACE VIEW
  function renderAgentView() {
    stopTaskPolling();

    const latestTask = state.tasks && state.tasks.length > 0 ? state.tasks[state.tasks.length - 1] : null;

    container.innerHTML = `
      <div class="view-header">
        <h1 class="view-title">Agent Workspace</h1>
        <p class="view-subtitle">Issue high-level coding or analysis tasks to NEXUS AI</p>
      </div>

      <div class="card" style="margin-bottom:24px;">
        <div class="card-title">New Task Request</div>
        <div style="display:flex; gap:10px; margin-top:10px;">
          <input type="text" id="inp-task-prompt" placeholder="e.g. Build a portfolio landing page with CSS grid" />
          <button class="btn-primary" id="btn-submit-task" style="white-space:nowrap;">Run Agent Task</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Agent Execution State Machine Flow</div>
        <div class="flow-steps">
          <div class="flow-step" id="step-planning">PLANNING</div>
          <div class="flow-step" id="step-plan_ready">PLAN READY</div>
          <div class="flow-step" id="step-awaiting_approval">AWAITING APPROVAL</div>
          <div class="flow-step" id="step-executing">EXECUTING</div>
          <div class="flow-step" id="step-observing">OBSERVING</div>
          <div class="flow-step" id="step-verifying">VERIFYING</div>
          <div class="flow-step" id="step-completed">COMPLETED</div>
        </div>

        <div id="agent-output-box" class="code-box" style="min-height:180px; font-size:12px; margin-top:12px; color:var(--text-muted);">
          ${formatTaskLog(latestTask)}
        </div>
      </div>
    `;

    if (latestTask) {
      updateFlowSteps(latestTask.state);
      if (!['completed', 'failed', 'cancelled', 'awaiting_approval'].includes(latestTask.state)) {
        pollTask(latestTask.id);
      }
    }

    document.getElementById('btn-submit-task')?.addEventListener('click', async () => {
      const prompt = document.getElementById('inp-task-prompt')?.value?.trim();
      if (!prompt) return;

      const btn = document.getElementById('btn-submit-task');
      if (btn) btn.disabled = true;

      const box = document.getElementById('agent-output-box');
      if (box) box.textContent = `[Planning] Synthesizing plan for: "${prompt}"...\n`;
      updateFlowSteps('planning');

      const res = await apiFetch('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      });

      if (res.error || res.planError || res.executionError) {
        const err = res.error || res.planError || res.executionError;
        if (box) box.textContent += `\n[Error] ${err}\n`;
        if (btn) btn.disabled = false;
        return;
      }

      const task = res.task;
      if (task) {
        if (box) box.textContent = formatTaskLog(task);
        updateFlowSteps(task.state);
        pollTask(task.id);
      } else {
        if (btn) btn.disabled = false;
      }
    });
  }

  // 3. PLAN VIEW
  function renderPlanView() {
    container.innerHTML = `
      <div class="view-header">
        <h1 class="view-title">Plan Visualization</h1>
        <p class="view-subtitle">Structured execution plan steps generated by PlanSynthesisService</p>
      </div>

      <div class="card">
        <div class="card-title">Sample Synthesized Plan Steps</div>
        <div style="margin-top:12px; display:flex; flex-direction:column; gap:12px;">
          <div style="background-color:var(--bg-surface); padding:12px; border-radius:6px; border:1px solid var(--border);">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong>Step 1: Workspace Structure Inspection</strong>
              <span style="background-color:rgba(16,185,129,0.15); color:var(--success); font-size:11px; padding:2px 8px; border-radius:4px; font-weight:600;">LOW RISK</span>
            </div>
            <p style="font-size:12px; color:var(--text-muted); margin-top:4px;">Tool: <code>workspace_tree</code> | Capabilities: <code>filesystem.read</code></p>
          </div>

          <div style="background-color:var(--bg-surface); padding:12px; border-radius:6px; border:1px solid var(--border);">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong>Step 2: Generate Core File</strong>
              <span style="background-color:rgba(245,158,11,0.15); color:var(--warning); font-size:11px; padding:2px 8px; border-radius:4px; font-weight:600;">MEDIUM RISK</span>
            </div>
            <p style="font-size:12px; color:var(--text-muted); margin-top:4px;">Tool: <code>filesystem_write</code> | Capabilities: <code>filesystem.write</code></p>
          </div>
        </div>
      </div>
    `;
  }

  // 4. APPROVAL CENTER
  function renderApprovalsView() {
    const list = state.approvals;
    let html = `
      <div class="view-header">
        <h1 class="view-title">Approval Center</h1>
        <p class="view-subtitle">Review & authorize high-risk operations requested by agent tasks</p>
      </div>
    `;

    if (list.length === 0) {
      html += `
        <div class="card" style="text-align:center; padding:40px;">
          <p style="font-size:16px; color:var(--success);">✅ No pending approval requests</p>
          <p style="font-size:12px; color:var(--text-muted); margin-top:6px;">All low-risk operations are automatically approved by policy.</p>
        </div>
      `;
    } else {
      html += `<div style="display:flex; flex-direction:column; gap:16px;">`;
      list.forEach((appr) => {
        html += `
          <div class="card" style="border-left:4px solid var(--warning);">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <h3>Approval Required: ${appr.toolId}</h3>
              <span style="background-color:var(--warning); color:#000; font-weight:700; font-size:11px; padding:2px 8px; border-radius:4px;">${appr.riskLevel.toUpperCase()} RISK</span>
            </div>
            <p style="font-size:12px; color:var(--text-muted); margin-top:6px;">Task ID: <code>${appr.taskId}</code> | Step ID: <code>${appr.stepId}</code></p>
            <p style="font-size:12px; margin-top:6px;">Reason: ${appr.reasonCategory || 'Operation requires explicit user consent'}</p>
            <div style="display:flex; gap:10px; margin-top:14px;">
              <button class="btn-primary" onclick="window.nexusApp.respondApproval('${appr.approvalId}', 'APPROVED')">Approve</button>
              <button class="btn-danger" onclick="window.nexusApp.respondApproval('${appr.approvalId}', 'REJECTED')">Reject</button>
            </div>
          </div>
        `;
      });
      html += `</div>`;
    }

    container.innerHTML = html;
  }

  // 5. WORKSPACE EXPLORER VIEW
  function renderExplorerView() {
    container.innerHTML = `
      <div class="view-header">
        <h1 class="view-title">Workspace Explorer</h1>
        <p class="view-subtitle">Read-only navigation of canonical workspace directory sandbox</p>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-title">Directory Tree</div>
          <button class="btn-secondary" id="btn-load-tree" style="margin-bottom:10px;">Refresh Directory Tree</button>
          <div class="code-box" id="tree-box" style="height:320px;">Click refresh to inspect workspace tree...</div>
        </div>

        <div class="card">
          <div class="card-title">File Content Reader</div>
          <div style="display:flex; gap:8px; margin-bottom:10px;">
            <input type="text" id="inp-read-file" placeholder="e.g. index.html" />
            <button class="btn-primary" id="btn-read-file">Read</button>
          </div>
          <div class="code-box" id="file-box" style="height:270px;">Enter relative path to view content...</div>
        </div>
      </div>
    `;

    document.getElementById('btn-load-tree')?.addEventListener('click', async () => {
      const box = document.getElementById('tree-box');
      box.textContent = 'Loading workspace tree via ToolGateway...';
      const res = await apiFetch('/api/workspace/tree');
      box.textContent = JSON.stringify(res, null, 2);
    });

    document.getElementById('btn-read-file')?.addEventListener('click', async () => {
      const relPath = document.getElementById('inp-read-file')?.value?.trim();
      if (!relPath) return;
      const box = document.getElementById('file-box');
      box.textContent = `Reading "${relPath}"...`;
      const res = await apiFetch('/api/workspace/file', {
        method: 'POST',
        body: JSON.stringify({ relativePath: relPath }),
      });
      box.textContent = JSON.stringify(res, null, 2);
    });
  }

  // 6. FILE DIFF VIEWER
  function renderDiffView() {
    container.innerHTML = `
      <div class="view-header">
        <h1 class="view-title">File Diff Viewer</h1>
        <p class="view-subtitle">Inspect unified before / after diffs for safe file edits</p>
      </div>

      <div class="card">
        <div class="card-title">Unified Diff Container</div>
        <div class="code-box" style="font-family:var(--font-mono); font-size:12px; margin-top:10px;">
<span style="color:var(--text-dim);">--- a/workspace/index.html</span>
<span style="color:var(--text-dim);">+++ b/workspace/index.html</span>
<span style="color:var(--accent);">@@ -1,5 +1,6 @@</span>
 &lt;!DOCTYPE html&gt;
 &lt;html&gt;
-&lt;title&gt;Old Title&lt;/title&gt;
+&lt;title&gt;NEXUS AI — Desktop App&lt;/title&gt;
 &lt;/html&gt;
        </div>
      </div>
    `;
  }

  // 7. TASK HISTORY VIEW
  function renderHistoryView() {
    const tasks = state.tasks;
    let html = `
      <div class="view-header">
        <h1 class="view-title">Task History</h1>
        <p class="view-subtitle">Chronological record of all created agent execution tasks</p>
      </div>
    `;

    if (tasks.length === 0) {
      html += `<div class="card"><p style="color:var(--text-muted);">No task history recorded yet.</p></div>`;
    } else {
      html += `<div class="card"><div style="display:flex; flex-direction:column; gap:10px;">`;
      tasks.forEach((t) => {
        html += `
          <div style="padding:10px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;">
            <div>
              <strong>${t.title}</strong>
              <div style="font-size:11px; color:var(--text-dim);">ID: ${t.id} | Created: ${new Date(t.createdAt).toLocaleString()}</div>
            </div>
            <span style="background-color:var(--bg-surface); padding:2px 8px; border-radius:4px; font-size:11px; font-weight:700; border:1px solid var(--border);">${t.state.toUpperCase()}</span>
          </div>
        `;
      });
      html += `</div></div>`;
    }

    container.innerHTML = html;
  }

  // 8. ACTIVITY TIMELINE VIEW
  function renderActivityView() {
    container.innerHTML = `
      <div class="view-header">
        <h1 class="view-title">Activity Timeline</h1>
        <p class="view-subtitle">User-friendly timeline of system lifecycle events</p>
      </div>
      <div class="card" id="activity-box">Loading activity timeline...</div>
    `;

    apiFetch('/api/activity').then((res) => {
      const box = document.getElementById('activity-box');
      if (!box) return;
      const list = res.activity || [];
      if (list.length === 0) {
        box.textContent = 'No recent activity items.';
        return;
      }
      let html = '<div style="display:flex; flex-direction:column; gap:12px;">';
      list.forEach((item) => {
        html += `
          <div style="border-left:3px solid var(--accent); padding-left:12px;">
            <strong>${item.title}</strong>
            <p style="font-size:12px; color:var(--text-muted);">${item.detail || ''}</p>
            <span style="font-size:10px; color:var(--text-dim);">${new Date(item.timestamp).toLocaleString()}</span>
          </div>
        `;
      });
      html += '</div>';
      box.innerHTML = html;
    });
  }

  // 9. MODELS & RUNTIME VIEW
  function renderModelsView() {
    const health = state.runtimeInfo?.health;
    const models = state.runtimeInfo?.models || [];

    container.innerHTML = `
      <div class="view-header">
        <h1 class="view-title">Models & Runtime Management</h1>
        <p class="view-subtitle">AI Runtime status and local model inventory</p>
      </div>

      <div class="grid-2" style="margin-bottom:20px;">
        <div class="card">
          <div class="card-title">Runtime Provider</div>
          <div style="font-size:18px; font-weight:700;">${health?.providerId?.toUpperCase() || 'OLLAMA'}</div>
          <p style="font-size:12px; color:var(--text-muted); margin-top:4px;">Endpoint: ${health?.endpoint || 'http://127.0.0.1:11434'}</p>
          <p style="font-size:12px; color:var(--text-muted);">Version: ${health?.version || 'unknown'}</p>
        </div>
        <div class="card">
          <div class="card-title">Runtime Readiness</div>
          <div class="card-value" style="color:${health?.status === 'READY' ? 'var(--success)' : 'var(--warning)'}">${health?.status || 'UNAVAILABLE'}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Discovered Local Models (${models.length})</div>
        <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
          ${models.length === 0 ? '<p style="color:var(--text-muted);">No models discovered in local runtime.</p>' : ''}
          ${models.map((m) => `
            <div style="padding:8px 12px; background-color:var(--bg-surface); border:1px solid var(--border); border-radius:6px; display:flex; justify-content:space-between; align-items:center;">
              <div>
                <strong>${m.id}</strong>
                <span style="font-size:11px; color:var(--text-dim); margin-left:8px;">${m.parameterSize || 'latest'}</span>
              </div>
              <span style="background-color:rgba(16,185,129,0.15); color:var(--success); font-size:11px; font-weight:600; padding:2px 6px; border-radius:4px;">MODEL_READY</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // 10. KNOWLEDGE / RAG VIEW
  function renderKnowledgeView() {
    container.innerHTML = `
      <div class="view-header">
        <h1 class="view-title">Knowledge Engine & RAG</h1>
        <p class="view-subtitle">Offline vector collections and document retrieval sandbox</p>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-title">Ingest Text Document</div>
          <div style="display:flex; flex-direction:column; gap:8px; margin-top:10px;">
            <input type="text" id="inp-doc-name" placeholder="Document Filename (e.g. notes.md)" />
            <textarea id="inp-doc-text" rows="5" placeholder="Enter markdown or plain text content..."></textarea>
            <button class="btn-primary" id="btn-ingest-doc">Ingest into Collection</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Ingestion Result</div>
          <div class="code-box" id="ingest-res-box" style="height:200px;">Ingested document details will appear here...</div>
        </div>
      </div>
    `;

    document.getElementById('btn-ingest-doc')?.addEventListener('click', async () => {
      const filename = document.getElementById('inp-doc-name')?.value?.trim();
      const text = document.getElementById('inp-doc-text')?.value?.trim();
      if (!filename || !text) return;

      const box = document.getElementById('ingest-res-box');
      box.textContent = 'Ingesting document...';
      const res = await apiFetch('/api/knowledge/ingest', {
        method: 'POST',
        body: JSON.stringify({ filename, text }),
      });
      box.textContent = JSON.stringify(res, null, 2);
    });
  }

  // 11. SETTINGS VIEW
  function renderSettingsView() {
    const config = state.health?.config || {};

    container.innerHTML = `
      <div class="view-header">
        <h1 class="view-title">Application Settings</h1>
        <p class="view-subtitle">System configuration & workspace validation sandbox</p>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <div class="card-title">System Settings</div>
        <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
          <div><label style="font-size:12px; color:var(--text-muted);">Environment:</label> <input type="text" value="${config.environment || 'development'}" disabled /></div>
          <div><label style="font-size:12px; color:var(--text-muted);">Port:</label> <input type="text" value="${config.port || 3000}" disabled /></div>
          <div><label style="font-size:12px; color:var(--text-muted);">Ollama Host:</label> <input type="text" value="${config.ollamaHost || 'http://127.0.0.1:11434'}" disabled /></div>
          <div><label style="font-size:12px; color:var(--text-muted);">Database Path:</label> <input type="text" value="${config.databasePath || ''}" disabled /></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Workspace Validator</div>
        <div style="display:flex; gap:10px; margin-top:10px;">
          <input type="text" id="inp-val-ws" placeholder="Enter path to validate..." />
          <button class="btn-primary" id="btn-val-ws">Validate</button>
        </div>
        <div class="code-box" id="val-ws-box" style="margin-top:10px;">Validation output...</div>
      </div>
    `;

    document.getElementById('btn-val-ws')?.addEventListener('click', async () => {
      const pathVal = document.getElementById('inp-val-ws')?.value?.trim();
      if (!pathVal) return;
      const box = document.getElementById('val-ws-box');
      box.textContent = 'Validating workspace path...';
      const res = await apiFetch('/api/workspace/validate', {
        method: 'POST',
        body: JSON.stringify({ path: pathVal }),
      });
      box.textContent = JSON.stringify(res, null, 2);
    });
  }

  // 12. FIRST-RUN WIZARD MODAL
  function showWizardModal() {
    const report = state.firstRunReport;
    const content = document.getElementById('wizard-content');
    if (!content) return;

    if (!report) {
      content.innerHTML = '<p>Loading health check report...</p>';
    } else {
      let html = `<p style="margin-bottom:12px;">First-Run Status: <strong>${report.state}</strong></p>`;
      html += '<div style="display:flex; flex-direction:column; gap:8px;">';
      (report.checks || []).forEach((c) => {
        const color = c.status === 'OK' ? 'var(--success)' : c.status === 'DEGRADED' ? 'var(--warning)' : 'var(--error)';
        html += `
          <div style="padding:8px; border:1px solid var(--border); border-radius:6px; display:flex; justify-content:space-between; align-items:center;">
            <span>${c.name}</span>
            <span style="color:${color}; font-weight:700; font-size:12px;">[${c.status}]</span>
          </div>
        `;
      });
      html += '</div>';
      content.innerHTML = html;
    }

    modalWizard?.classList.remove('hidden');
  }

  function hideWizardModal() {
    modalWizard?.classList.add('hidden');
  }

  // Global namespace export for inline HTML handlers
  window.nexusApp = {
    switchView,
    async respondApproval(id, decision) {
      const res = await apiFetch(`/api/approvals/${id}/respond`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      await refreshSystemState();
      // Show resumed execution result on Agent view if we are on it
      if (state.activeView === 'approvals' && res.task) {
        const task = res.task;
        const msg = task.state === 'completed'
          ? `\n✅ Task ${task.id} completed after approval.`
          : task.state === 'awaiting_approval'
          ? `\n⚠ Another approval is required for task ${task.id}.`
          : task.state === 'failed'
          ? `\n❌ Task ${task.id} failed [${task.errorCategory || 'UNKNOWN'}] after approval.`
          : `\nTask ${task.id} state: ${task.state.toUpperCase()}`;
        alert(msg);
      }
      renderApprovalsView();
    },
  };

  // Init Application
  document.addEventListener('DOMContentLoaded', async () => {
    setupNavigation();
    await refreshSystemState();
    switchView('dashboard');
    setInterval(refreshSystemState, 5000); // 5s refresh loop
  });
})();
