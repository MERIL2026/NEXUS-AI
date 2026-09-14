/**
 * NEXUS AI — P7-F.2: CLI Visual Formatting & Theme Engine
 *
 * Provides premium dark-terminal styling, ANSI color utilities, box-drawing
 * primitives, state machine symbols, and structured card renderers for the
 * NEXUS AI CLI, matching the P7-F.2 reference design specification.
 *
 * Design language: electric blue / violet / cyan on near-black background.
 * Visual hierarchy: NEXUS wordmark → info cards → welcome panel → input hint → footer.
 *
 * Zero external dependencies — uses Node.js standard ANSI escape codes only.
 */

import type { SystemHealthReport } from '../api/index.js';
import type { AgentTask } from '../storage/repositories/types.js';
import type { AgentPlan } from '../orchestration/types.js';
import type { ApprovalRequest } from '../tools/approvalTypes.js';
import type {
  DecompositionPlan,
  ProjectOrchestrationResult,
} from '../orchestration/taskDecompositionTypes.js';

// ---------------------------------------------------------------------------
// ANSI Color Palette & Typography Tokens
// ---------------------------------------------------------------------------

export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Primary Theme — Cyan / Blue / Violet
  cyan: '\x1b[36m',
  brightCyan: '\x1b[96m',
  blue: '\x1b[34m',
  brightBlue: '\x1b[94m',
  magenta: '\x1b[35m',
  brightMagenta: '\x1b[95m',

  // Semantic Status Colors
  green: '\x1b[32m',
  brightGreen: '\x1b[92m',
  yellow: '\x1b[33m',
  brightYellow: '\x1b[93m',
  red: '\x1b[31m',
  brightRed: '\x1b[91m',
  white: '\x1b[97m',
  gray: '\x1b[90m',
};

// ---------------------------------------------------------------------------
// State Machine Symbols (with & without ANSI colors)
// ---------------------------------------------------------------------------

export const stateSymbols = {
  completed: `${colors.brightGreen}✓${colors.reset}`,
  executing: `${colors.brightCyan}●${colors.reset}`,
  planning: `${colors.dim}◌${colors.reset}`,
  awaitingApproval: `${colors.brightYellow}!${colors.reset}`,
  failed: `${colors.brightRed}✕${colors.reset}`,
  cancelled: `${colors.gray}○${colors.reset}`,

  plain: {
    completed: '✓',
    executing: '●',
    planning: '◌',
    awaitingApproval: '!',
    failed: '✕',
    cancelled: '○',
  },
};

export function getSymbolForState(state: string, useColor = true): string {
  const normalized = state.toLowerCase();
  if (normalized === 'completed')
    return useColor ? stateSymbols.completed : stateSymbols.plain.completed;
  if (normalized === 'executing' || normalized === 'observing' || normalized === 'verifying')
    return useColor ? stateSymbols.executing : stateSymbols.plain.executing;
  if (normalized === 'planning' || normalized === 'plan_ready' || normalized === 'created')
    return useColor ? stateSymbols.planning : stateSymbols.plain.planning;
  if (normalized === 'awaiting_approval')
    return useColor ? stateSymbols.awaitingApproval : stateSymbols.plain.awaitingApproval;
  if (normalized === 'failed')
    return useColor ? stateSymbols.failed : stateSymbols.plain.failed;
  if (normalized === 'cancelled')
    return useColor ? stateSymbols.cancelled : stateSymbols.plain.cancelled;
  return useColor ? `${colors.dim}•${colors.reset}` : '•';
}

// ---------------------------------------------------------------------------
// Secret & Sensitive Parameter Sanitization
// ---------------------------------------------------------------------------

export function sanitizeText(text: string): string {
  if (!text) return text;
  return text
    .replace(/(api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[^'"\s\n]+['"]?/gi, '$1=***REDACTED***')
    .replace(/bearer\s+[a-zA-Z0-9_\-.]+/gi, 'Bearer ***REDACTED***');
}

// ---------------------------------------------------------------------------
// Internal Layout Utilities
// ---------------------------------------------------------------------------

/** Strip ANSI escape sequences from a string */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Visible character width of a string (ignoring ANSI codes) */
function visibleWidth(str: string): number {
  return stripAnsi(str).length;
}

/**
 * Pad a string (which may contain ANSI codes) to a target visible width.
 * If the string is longer than `width`, it is truncated with a trailing ellipsis.
 */
function padAnsi(str: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const vw = visibleWidth(str);
  if (vw > width) {
    const stripped = stripAnsi(str);
    return width > 1 ? stripped.slice(0, width - 1) + '\u2026' : stripped.slice(0, width);
  }
  const pad = width - vw;
  if (align === 'right') return ' '.repeat(pad) + str;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + str + ' '.repeat(pad - left);
  }
  return str + ' '.repeat(pad);
}

/** Effective terminal width, clamped to a usable range */
function termWidth(): number {
  return Math.min(Math.max(process.stdout.columns || 100, 80), 130);
}

/** Horizontal divider (public export — used by agentRunner.ts) */
export function drawDivider(char = '─', width = 74): string {
  return `${colors.dim}${char.repeat(width)}${colors.reset}`;
}

/** Full terminal-width divider */
function fullDivider(char = '─', ansiColor = colors.dim): string {
  return `${ansiColor}${char.repeat(termWidth())}${colors.reset}`;
}

/**
 * Merge multiple column arrays side by side with a separator.
 * Each column's strings are padded to their specified width.
 */
function mergeColumns(cols: string[][], widths: number[], separator = '  '): string[] {
  const maxRows = Math.max(...cols.map((c) => c.length), 0);
  const result: string[] = [];
  for (let i = 0; i < maxRows; i++) {
    const parts = cols.map((col, ci) => padAnsi(col[i] ?? '', widths[ci]));
    result.push(parts.join(separator));
  }
  return result;
}

/**
 * Wrap content lines in a bordered box.
 * The box is exactly `outerWidth` visible characters wide (including the two border chars).
 * Content lines are padded to fill the inner width.
 */
function drawBox(
  lines: string[],
  outerWidth: number,
  borderColor = colors.brightBlue
): string[] {
  const innerWidth = Math.max(0, outerWidth - 2);
  const out: string[] = [];
  out.push(`${borderColor}\u250c${'─'.repeat(innerWidth)}\u2510${colors.reset}`);
  for (const line of lines) {
    out.push(`${borderColor}\u2502${colors.reset}${padAnsi(line, innerWidth)}${borderColor}\u2502${colors.reset}`);
  }
  out.push(`${borderColor}\u2514${'─'.repeat(innerWidth)}\u2518${colors.reset}`);
  return out;
}

// ---------------------------------------------------------------------------
// NEXUS ASCII Wordmark
// ---------------------------------------------------------------------------

/**
 * Returns the multi-line NEXUS block-art wordmark.
 * Uses blue → cyan → violet gradient across letters N-E-X-U-S.
 * Visible width of each line is ~47 characters.
 */
function nexusWordmark(): string[] {
  const C1 = colors.brightCyan;
  const C2 = colors.brightBlue;
  const C3 = colors.brightMagenta;
  const R = colors.reset;
  return [
    `${C1} \u2588\u2588\u2588\u2557   \u2588\u2588\u2557${C2}\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557${C1}\u2588\u2588\u2557  \u2588\u2588\u2557${C2}\u2588\u2588\u2557   \u2588\u2588\u2557${C3}\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557${R}`,
    `${C1} \u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2551${C2}\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d${C1}\u255a\u2588\u2588\u2557\u2588\u2588\u2554\u255d${C2}\u2588\u2588\u2551   \u2588\u2588\u2551${C3}\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d${R}`,
    `${C1} \u2588\u2588\u2554\u2588\u2588\u2557 \u2588\u2588\u2551${C2}\u2588\u2588\u2588\u2588\u2588\u2557  ${C1} \u255a\u2588\u2588\u2588\u2554\u255d ${C2}\u2588\u2588\u2551   \u2588\u2588\u2551${C3}\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557${R}`,
    `${C1} \u2588\u2588\u2551\u255a\u2588\u2588\u2557\u2588\u2588\u2551${C2}\u2588\u2588\u2554\u2550\u2550\u255d  ${C1} \u2588\u2588\u2554\u2588\u2588\u2557 ${C2}\u2588\u2588\u2551   \u2588\u2588\u2551${C3}\u255a\u2550\u2550\u2550\u2550\u2588\u2588\u2551${R}`,
    `${C1} \u2588\u2588\u2551 \u255a\u2588\u2588\u2588\u2588\u2551${C2}\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557${C1}\u2588\u2588\u2554\u255d \u2588\u2588\u2557${C2}\u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d${C3}\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551${R}`,
    `${C1} \u255a\u2550\u255d  \u255a\u2550\u2550\u2550\u255d${C2}\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u255d${C1}\u255a\u2550\u255d  \u255a\u2550\u255d${C2} \u255a\u2550\u2550\u2550\u2550\u2550\u255d ${C3}\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u255d${R}`,
  ];
}

/** Small N glyph + tagline for the welcome panel visual mark */
function nMark(): string[] {
  const C = colors.brightBlue;
  const D = colors.dim;
  const R = colors.reset;
  return [
    '',
    `${C}  \u2588\u2557  \u2588\u2557${R}`,
    `${C}  \u2588\u2588\u2557 \u2588\u2588\u2551${R}`,
    `${C}  \u2588\u2554\u2588\u2588\u2554\u2588\u2551${R}`,
    `${C}  \u2588\u2551\u255a\u2588\u2588\u2554\u2588\u2551${R}`,
    `${C}  \u2588\u2551 \u255a\u2588\u2554\u2588\u2551${R}`,
    `${C}  \u255a\u2550\u255d  \u255a\u2550\u255d${R}`,
    '',
    `${D}  IDEAS TO${R}`,
    `${D}  IMPACT${R}`,
    '',
  ];
}

// ---------------------------------------------------------------------------
// Header Banner (drawHeaderBanner)
// ---------------------------------------------------------------------------

export function drawHeaderBanner(): string {
  const W = termWidth();
  const lines: string[] = [];

  lines.push(fullDivider('\u2550', colors.brightBlue));

  // Wordmark rows + right-side branding aligned to right edge
  const wm = nexusWordmark();
  const wmVW = visibleWidth(wm[0]); // e.g. ~49 chars

  const rightLines = [
    `${colors.dim}THINK ${colors.brightCyan}\u203a${colors.dim} PLAN ${colors.brightCyan}\u203a${colors.dim} APPROVE${colors.reset}`,
    `${colors.dim}EXECUTE ${colors.brightCyan}\u203a${colors.dim} ACHIEVE${colors.reset}`,
    '',
    `${colors.gray}LOCAL \u00b7 PRIVATE \u00b7 POWERFUL \u00b7 YOURS${colors.reset}`,
    '',
    `${colors.dim}v0.1.0${colors.reset}`,
  ];

  const rightColW = Math.max(0, W - wmVW - 4); // 2 leading spaces + 2 spacing
  const maxRows = Math.max(wm.length, rightLines.length);

  for (let i = 0; i < maxRows; i++) {
    const leftPart = wm[i] ? `  ${wm[i]}` : `  ${' '.repeat(wmVW)}`;
    const rightPart = rightLines[i]
      ? padAnsi(rightLines[i], rightColW, 'right')
      : ' '.repeat(rightColW);
    lines.push(leftPart + '  ' + rightPart);
  }

  lines.push('');
  lines.push(
    `  ${colors.bold}${colors.brightCyan}NEXUS AI — YOUR LOCAL AI WORKSTATION${colors.reset}`
  );
  lines.push('');
  lines.push(fullDivider('─', colors.brightBlue));

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Workstation Dashboard (renderDashboard) — Startup View
// ---------------------------------------------------------------------------

export function renderDashboard(report: SystemHealthReport, workspaceRoot: string): string {
  const lines: string[] = [];
  const W = termWidth();

  // ── HEADER ──────────────────────────────────────────────────────────────
  lines.push(drawHeaderBanner());
  lines.push('');

  // ── THREE-COLUMN CARDS ───────────────────────────────────────────────────

  // Column outer widths must sum to W with two 2-char separators:
  // col1Outer + 2 + col2Outer + 2 + col3Outer = W
  const col1Outer = Math.floor(W * 0.33);
  const col2Outer = Math.floor(W * 0.34);
  const col3Outer = W - col1Outer - col2Outer - 4;
  const col1Inner = col1Outer - 2;
  const col2Inner = col2Outer - 2;
  const col3Inner = col3Outer - 2;

  // -- SYSTEM CARD --
  const ollamaSub = report.subsystems.find((s) => s.name === 'IntelligenceService');
  const ollamaVersion = String(
    (ollamaSub?.details as Record<string, unknown>)?.ollamaVersion ?? 'Connected'
  );
  const modelCount = (ollamaSub?.details as Record<string, unknown>)?.modelsCount ?? 0;
  const primaryModel = String(
    (ollamaSub?.details as Record<string, unknown>)?.primaryModel ?? 'Auto'
  );
  const isReady = ollamaSub?.status === 'ok';
  const statusLabel = isReady
    ? `${colors.brightGreen}\u25cf READY${colors.reset}`
    : `${colors.brightYellow}\u25cf DEGRADED${colors.reset}`;

  const maxWsLen = col1Inner - 4;
  const wsShort =
    workspaceRoot.length > maxWsLen
      ? '\u2026' + workspaceRoot.slice(-(maxWsLen - 1))
      : workspaceRoot;
  const maxModelLen = col1Inner - 4;
  const modelShort =
    primaryModel.length > maxModelLen
      ? primaryModel.slice(0, maxModelLen - 1) + '\u2026'
      : primaryModel;

  const col1Lines = [
    `  ${colors.brightGreen}\u25cf SYSTEM STATUS${colors.reset}`,
    `  ${colors.bold}System Health${colors.reset}   ${statusLabel}`,
    '',
    `  ${colors.dim}AI Runtime${colors.reset}`,
    `  ${colors.white}Ollama ${ollamaVersion}${colors.reset}`,
    '',
    `  ${colors.dim}Primary Model${colors.reset}`,
    `  ${colors.brightCyan}${modelShort}${colors.reset}`,
    '',
    `  ${colors.dim}Workspace${colors.reset}`,
    `  ${colors.gray}${wsShort}${colors.reset}`,
    '',
    `  ${colors.dim}Database${colors.reset}    ${colors.green}Connected${colors.reset}`,
    `  ${colors.dim}Models${colors.reset}      ${colors.white}${String(modelCount)} available${colors.reset}`,
    '',
  ];

  // -- CENTER QUOTE CARD --
  const col2Lines = [
    '',
    '',
    `  ${colors.dim}\u275d${colors.reset}`,
    '',
    `  ${colors.bold}${colors.white}Turn your ideas${colors.reset}`,
    `  ${colors.bold}${colors.white}into real results.${colors.reset}`,
    '',
    `  ${colors.dim}\u2014 NEXUS AI${colors.reset}`,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
  ];

  // -- QUICK COMMANDS CARD --
  const col3Lines = [
    `  ${colors.brightMagenta}\u2736 QUICK COMMANDS${colors.reset}`,
    '',
    `  ${colors.brightCyan}/help${colors.reset}       ${colors.gray}Show all commands${colors.reset}`,
    `  ${colors.brightCyan}/models${colors.reset}     ${colors.gray}List AI models${colors.reset}`,
    `  ${colors.brightCyan}/workspace${colors.reset}  ${colors.gray}Workspace info${colors.reset}`,
    `  ${colors.brightCyan}/agents${colors.reset}     ${colors.gray}Agent status${colors.reset}`,
    `  ${colors.brightCyan}/clear${colors.reset}      ${colors.gray}Clear screen${colors.reset}`,
    `  ${colors.brightCyan}/exit${colors.reset}       ${colors.gray}Exit NEXUS${colors.reset}`,
    '',
    `  ${colors.dim}Type /help for full list${colors.reset}`,
    '',
    '',
    '',
    '',
    '',
    '',
  ];

  // Ensure all columns have the same number of rows (pad shorter ones)
  const maxColRows = Math.max(col1Lines.length, col2Lines.length, col3Lines.length);
  while (col1Lines.length < maxColRows) col1Lines.push('');
  while (col2Lines.length < maxColRows) col2Lines.push('');
  while (col3Lines.length < maxColRows) col3Lines.push('');

  // Pre-pad content to inner column width before boxing
  const padCol1 = col1Lines.map((l) => padAnsi(l, col1Inner));
  const padCol2 = col2Lines.map((l) => padAnsi(l, col2Inner));
  const padCol3 = col3Lines.map((l) => padAnsi(l, col3Inner));

  const box1 = drawBox(padCol1, col1Outer, colors.brightBlue);
  const box2 = drawBox(padCol2, col2Outer, `${colors.dim}`);
  const box3 = drawBox(padCol3, col3Outer, colors.brightMagenta);

  const merged = mergeColumns([box1, box2, box3], [col1Outer, col2Outer, col3Outer], '  ');
  lines.push(...merged);
  lines.push('');

  if (report.overall === 'degraded') {
    lines.push(`${colors.brightYellow}⚠ NOTICE: AI Runtime is operating in DEGRADED mode. Local Ollama instance may be offline.${colors.reset}`);
    lines.push('');
  }

  // ── WELCOME PANEL ────────────────────────────────────────────────────────
  const welcomeOuter = W;
  const welcomeInner = welcomeOuter - 2;

  // Right visual mark (N + IDEAS TO IMPACT)
  const mark = nMark();
  const markVW = 12; // fixed width for the N mark column
  const contentW = welcomeInner - markVW;

  // Examples separator line
  const exSepLen = Math.max(0, contentW - 10);
  const examplesSep = `  ${colors.dim}EXAMPLES ${colors.gray}${'─'.repeat(exSepLen)}${colors.reset}`;

  const contentLines = [
    `  ${colors.brightCyan}\u25c8${colors.reset}  ${colors.bold}${colors.white}NEXUS${colors.reset}`,
    '',
    `  ${colors.bold}${colors.white}Welcome to NEXUS AI!${colors.reset}`,
    `  ${colors.gray}I'm your local AI agent, ready to help you build,${colors.reset}`,
    `  ${colors.gray}automate, research, and create. Just describe what${colors.reset}`,
    `  ${colors.gray}you want to do, and I'll take care of the rest.${colors.reset}`,
    '',
    examplesSep,
    '',
    `  ${colors.dim}"Create a calculator with HTML, CSS and JS"${colors.reset}`,
    `  ${colors.dim}"Summarize the files in my workspace"${colors.reset}`,
    `  ${colors.dim}"Build a to-do app"${colors.reset}`,
    `  ${colors.dim}"Write a research report on quantum computing"${colors.reset}`,
    '',
  ];

  const maxWelcomeRows = Math.max(contentLines.length, mark.length);
  const welcomeRows: string[] = [];
  for (let i = 0; i < maxWelcomeRows; i++) {
    const leftPart = padAnsi(contentLines[i] ?? '', contentW);
    const rightPart = padAnsi(mark[i] ?? '', markVW);
    welcomeRows.push(leftPart + rightPart);
  }

  const welcomeBox = drawBox(welcomeRows, welcomeOuter, colors.brightBlue);
  lines.push(...welcomeBox);
  lines.push('');

  // ── INPUT AREA HINT ──────────────────────────────────────────────────────
  const inputOuter = W;
  const inputInner = inputOuter - 2;
  const inputLeft = `  ${colors.brightCyan}\u203a${colors.reset}  ${colors.dim}Ask NEXUS anything...${colors.reset}`;
  const inputRight = `${colors.dim}Ctrl+Enter to send${colors.reset}  `;
  const inputLeftVW = visibleWidth(inputLeft);
  const inputRightVW = visibleWidth(inputRight);
  const inputGap = Math.max(0, inputInner - inputLeftVW - inputRightVW);
  const inputRow = inputLeft + ' '.repeat(inputGap) + inputRight;

  lines.push(`${colors.brightBlue}\u250c${'─'.repeat(inputInner)}\u2510${colors.reset}`);
  lines.push(
    `${colors.brightBlue}\u2502${colors.reset}${padAnsi(inputRow, inputInner)}${colors.brightBlue}\u2502${colors.reset}`
  );
  lines.push(`${colors.brightBlue}\u2514${'─'.repeat(inputInner)}\u2518${colors.reset}`);
  lines.push('');

  // ── FOOTER ───────────────────────────────────────────────────────────────
  lines.push(fullDivider('─', colors.dim));

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const dateStr = now.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const footerLeft = ` ${colors.brightCyan}N${colors.reset}  ${colors.bold}NEXUS AI CLI${colors.reset}`;
  const footerCenter = `${colors.dim}BUILT FOR CREATORS, DEVELOPERS, THINKERS.${colors.reset}`;
  const footerRight = `${colors.gray}${dateStr} ${timeStr}${colors.reset} `;

  const fLeftVW = visibleWidth(footerLeft);
  const fCenterVW = visibleWidth(footerCenter);
  const fRightVW = visibleWidth(footerRight);

  const totalAvail = W;
  const centerPos = Math.floor((totalAvail - fCenterVW) / 2);
  const leftGap = Math.max(1, centerPos - fLeftVW);
  const rightGap = Math.max(1, totalAvail - fLeftVW - leftGap - fCenterVW - fRightVW);

  lines.push(
    footerLeft +
    ' '.repeat(leftGap) +
    footerCenter +
    ' '.repeat(rightGap) +
    footerRight
  );
  lines.push('');

  return lines.join('\n');
}

export function formatRelativeTime(isoString: string): string {
  try {
    const time = new Date(isoString).getTime();
    if (isNaN(time)) return 'recently';
    const now = Date.now();
    const diffMs = Math.max(0, now - time);
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 45) return 'just now';
    if (diffMin === 1) return '1 minute ago';
    if (diffMin < 60) return `${diffMin} minutes ago`;
    if (diffHour === 1) return '1 hour ago';
    if (diffHour < 24) return `${diffHour} hours ago`;
    if (diffDay === 1) return 'yesterday';
    if (diffDay < 7) return `${diffDay} days ago`;
    return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return 'recently';
  }
}

export function renderChatBanner(): string {
  const lines: string[] = [];
  lines.push(`${colors.bold}${colors.brightCyan}NEXUS CHAT${colors.reset}`);
  lines.push(drawDivider('─', 40));
  lines.push('');
  lines.push('You are now chatting with NEXUS.');
  lines.push(`Type ${colors.brightCyan}/exit-chat${colors.reset} to return to the main NEXUS prompt.`);
  lines.push(`Type ${colors.brightCyan}/new-chat${colors.reset} to start a new conversation.`);
  lines.push(`Type ${colors.brightCyan}/chats${colors.reset} to view conversation history.`);
  return lines.join('\n');
}

export function renderChatHistory(
  conversations: Array<import('../storage/repositories/types.js').ConversationSummary>
): string {
  const lines: string[] = [];
  lines.push(`${colors.bold}${colors.brightCyan}NEXUS CHAT HISTORY${colors.reset}`);
  lines.push(drawDivider('─', 40));
  lines.push('');

  if (conversations.length === 0) {
    lines.push(`${colors.dim}No conversation history found. Type /chat to start chatting.${colors.reset}`);
    lines.push('');
    return lines.join('\n');
  }

  conversations.forEach((c, idx) => {
    const relTime = formatRelativeTime(c.updatedAt);
    lines.push(`${colors.bold}${colors.white}${idx + 1}. ${c.title}${colors.reset}`);
    lines.push(`   ${colors.dim}Updated:${colors.reset} ${relTime}`);
    lines.push(`   ${colors.dim}Messages:${colors.reset} ${c.messageCount}`);
    lines.push(`   ${colors.dim}ID:${colors.reset} ${colors.brightCyan}${c.id}${colors.reset}`);
    lines.push('');
  });

  lines.push(`${colors.bold}Commands:${colors.reset}`);
  lines.push(`  ${colors.brightCyan}/chats open <id>${colors.reset}    Open conversation`);
  lines.push(`  ${colors.brightCyan}/chats delete <id>${colors.reset}  Delete conversation`);
  lines.push(`  ${colors.brightCyan}/chats search <q>${colors.reset}   Search conversations`);
  return lines.join('\n');
}

export function renderChatSearchResults(
  query: string,
  results: Array<import('../storage/repositories/types.js').ConversationSummary>
): string {
  const lines: string[] = [];
  lines.push(`${colors.bold}${colors.brightCyan}NEXUS CHAT SEARCH RESULTS: "${query}"${colors.reset}`);
  lines.push(drawDivider('─', 48));
  lines.push('');

  if (results.length === 0) {
    lines.push(`${colors.dim}No conversations found matching "${query}".${colors.reset}`);
    lines.push('');
    return lines.join('\n');
  }

  results.forEach((c, idx) => {
    lines.push(
      `${colors.bold}${idx + 1}. ${c.title}${colors.reset} ${colors.dim}(${c.messageCount} msg${c.messageCount === 1 ? '' : 's'}) [ID: ${colors.brightCyan}${c.id}${colors.dim}]${colors.reset}`
    );
  });

  lines.push('');
  lines.push(`${colors.dim}Use /chats open <id> to resume a conversation.${colors.reset}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Help Command Renderer
// ---------------------------------------------------------------------------

export function renderHelpMenu(): string {
  const lines = [
    `${colors.bold}${colors.brightCyan}NEXUS AI Agent Runner \u2014 Help & Command Reference${colors.reset}`,
    drawDivider('─', 64),
    `${colors.dim}CHAT${colors.reset}`,
    `  ${colors.brightCyan}/chat${colors.reset}              Start normal AI conversation`,
    `  ${colors.brightCyan}/chats${colors.reset}             View conversation history`,
    `  ${colors.brightCyan}/chats open <id>${colors.reset}   Open previous conversation`,
    `  ${colors.brightCyan}/chats search <q>${colors.reset}  Search conversations`,
    `  ${colors.brightCyan}/chats delete <id>${colors.reset} Delete conversation`,
    '',
    `${colors.dim}CHAT MODE${colors.reset}`,
    `  ${colors.brightCyan}/exit-chat${colors.reset}         Return to Agent Mode`,
    `  ${colors.brightCyan}/new-chat${colors.reset}          Start new conversation`,
    `  ${colors.brightCyan}/chats${colors.reset}             View conversations`,
    `  ${colors.brightCyan}/model${colors.reset}             Display or switch active model`,
    '',
    `${colors.dim}AGENT MODE${colors.reset}`,
    `  ${colors.brightCyan}<task description>${colors.reset}   Submit a natural language goal`,
    `  ${colors.brightCyan}/task <goal>${colors.reset}         Explicitly submit a task (alias: /t)`,
    `  ${colors.brightCyan}/code <goal>${colors.reset}         Run automated coding task (P6-D)`,
    `  ${colors.brightCyan}/prompt${colors.reset}              Enter compose (multi-line) mode`,
    `  ${colors.brightCyan}/send${colors.reset}                Submit compose buffer`,
    `  ${colors.brightCyan}/status${colors.reset}              Show current task status`,
    `  ${colors.brightCyan}/plan${colors.reset}                View synthesized plan`,
    `  ${colors.brightCyan}/result${colors.reset}              Show execution result`,
    `  ${colors.brightCyan}/cancel${colors.reset}              Cancel active task`,
    '',
    `${colors.dim}WORKSTATION & SYSTEM${colors.reset}`,
    `  ${colors.brightCyan}/preview${colors.reset}             Preview latest completed web task`,
    `  ${colors.brightCyan}/preview stop${colors.reset}        Stop active preview server`,
    `  ${colors.brightCyan}/preview status${colors.reset}      Show active preview status`,
    `  ${colors.brightCyan}/tasks${colors.reset}               List recent task history`,
    `  ${colors.brightCyan}/models${colors.reset}              List installed models`,
    `  ${colors.brightCyan}/model <role> <n>${colors.reset}    Set role model override`,
    `  ${colors.brightCyan}/model reset${colors.reset}         Reset all model overrides`,
    `  ${colors.brightCyan}/workspace${colors.reset}           Workspace root & security info`,
    `  ${colors.brightCyan}/agents${colors.reset}              Subsystem status`,
    `  ${colors.brightCyan}/approvals${colors.reset}           Pending approval requests`,
    `  ${colors.brightCyan}/approve <id>${colors.reset}        Approve a request`,
    `  ${colors.brightCyan}/reject <id>${colors.reset}         Reject a request`,
    `  ${colors.brightCyan}/clear${colors.reset}               Clear terminal screen`,
    `  ${colors.brightCyan}/exit${colors.reset}                Exit NEXUS CLI`,
    drawDivider('─', 64),
    `${colors.dim}TIP: Type /chat to talk directly with the AI without creating tasks.${colors.reset}`,
    `${colors.dim}     Type task instructions at NEXUS> to have the Agent build & execute.${colors.reset}`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Task History Renderer (/tasks)
// ---------------------------------------------------------------------------

export function renderTasksList(tasks: AgentTask[]): string {
  if (tasks.length === 0) {
    return `${colors.dim}No task history recorded yet. Submit a task using: /task <goal>${colors.reset}`;
  }

  const lines = [
    `${colors.bold}${colors.brightCyan}RECENT TASKS${colors.reset}`,
    drawDivider('─', 74),
  ];

  tasks.slice(0, 15).forEach((t, idx) => {
    const num = `${idx + 1}.`.padEnd(4, ' ');
    const symbol = getSymbolForState(t.state);
    const idPad = t.id.padEnd(26, ' ');
    const titleTrunc =
      t.title.length > 26 ? `${t.title.slice(0, 23)}...` : t.title.padEnd(26, ' ');
    const stateColor =
      t.state === 'completed'
        ? colors.brightGreen
        : t.state === 'failed'
          ? colors.brightRed
          : t.state === 'awaiting_approval'
            ? colors.brightYellow
            : colors.dim;
    lines.push(
      `${colors.bold}${num}${colors.reset}${symbol} ${colors.brightCyan}${idPad}${colors.reset} ${titleTrunc} ${stateColor}${t.state.toUpperCase()}${colors.reset}`
    );
  });

  lines.push(drawDivider('─', 74));
  lines.push(
    `${colors.dim}Commands: /preview (latest) | /preview <number> (e.g. /preview 2) | /task <id>${colors.reset}`
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Interactive Approval Card Generator
// ---------------------------------------------------------------------------

export function renderApprovalCard(approval: ApprovalRequest, taskTitle?: string): string {
  const lines = [
    drawDivider('─', 64),
    `${colors.bold}${colors.brightYellow}\u26a0 APPROVAL REQUIRED${colors.reset}`,
    '',
    `  ${colors.bold}Task:${colors.reset}          ${taskTitle || approval.taskId}`,
    `  ${colors.bold}Approval ID:${colors.reset}   ${colors.brightCyan}${approval.approvalId}${colors.reset}`,
    `  ${colors.bold}Step ID:${colors.reset}       ${approval.stepId}`,
    `  ${colors.bold}Tool:${colors.reset}          ${colors.bold}${colors.white}${approval.toolId}${colors.reset}`,
    `  ${colors.bold}Risk Level:${colors.reset}    ${colors.bold}${colors.brightRed}${approval.riskLevel.toUpperCase()}${colors.reset}`,
    `  ${colors.bold}Capability:${colors.reset}    ${approval.requestedCapability}`,
    `  ${colors.bold}Reason:${colors.reset}        ${approval.decisionReason || 'Action requires explicit human approval'}`,
    '',
    `${colors.bold}Options:${colors.reset}`,
    `  ${colors.brightGreen}[Y] Approve${colors.reset}   Allow and resume task (/approve ${approval.approvalId})`,
    `  ${colors.brightRed}[N] Reject${colors.reset}    Reject and cancel task (/reject ${approval.approvalId})`,
    `  ${colors.brightCyan}[V] View${colors.reset}      View approval parameters`,
    drawDivider('─', 64),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Task Completion Card Generator
// ---------------------------------------------------------------------------

export function renderCompletionCard(
  task: AgentTask,
  plan?: AgentPlan | null,
  durationMs?: number
): string {
  const durationSec = durationMs ? (durationMs / 1000).toFixed(1) : 'N/A';
  const lines = [
    drawDivider('─', 64),
    `${colors.bold}${colors.brightGreen}FINAL RESULT \u2014 TASK COMPLETED${colors.reset}`,
    '',
    `  ${colors.bold}Goal:${colors.reset}        ${task.title}`,
    `  ${colors.bold}Status:${colors.reset}      ${colors.brightGreen}\u2713 COMPLETED${colors.reset}`,
    `  ${colors.bold}Task ID:${colors.reset}     ${task.id}`,
    `  ${colors.bold}Duration:${colors.reset}    ${durationSec}s`,
  ];

  if (plan) {
    const total = plan.steps.length;
    const comp = plan.steps.filter((s) => s.status === 'completed').length;
    lines.push(`  ${colors.bold}Steps:${colors.reset}       ${comp}/${total} completed successfully`);
  }

  lines.push('');
  lines.push(`${colors.bold}Verification:${colors.reset}`);
  lines.push(`  ${colors.brightGreen}\u2713 All plan steps executed cleanly${colors.reset}`);
  lines.push(`  ${colors.brightGreen}\u2713 Task state verified as COMPLETED in SQLite${colors.reset}`);
  lines.push(drawDivider('─', 64));

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Task Failure Card Generator
// ---------------------------------------------------------------------------

export function renderFailureCard(task: AgentTask, errorMessage?: string): string {
  const category = task.errorCategory || 'UNKNOWN_ERROR';
  const lines = [
    drawDivider('─', 64),
    `${colors.bold}${colors.brightRed}\u2716 TASK FAILED${colors.reset}`,
    '',
    `  ${colors.bold}Goal:${colors.reset}           ${task.title}`,
    `  ${colors.bold}Task ID:${colors.reset}        ${task.id}`,
    `  ${colors.bold}Error Category:${colors.reset} ${colors.bold}${colors.brightRed}${category}${colors.reset}`,
    `  ${colors.bold}Failed Step:${colors.reset}    ${task.currentStep || 'Initialization / Planning'}`,
    `  ${colors.bold}Details:${colors.reset}        ${sanitizeText(errorMessage || 'Execution encountered a non-retryable error.')}`,
    '',
    `${colors.bold}Suggested Action:${colors.reset}`,
  ];

  if (category === 'FILE_NOT_FOUND') {
    lines.push('  \u2022 Check if the specified relative path is correct.');
    lines.push('  \u2022 If you meant to author a new file, request to "create" or "build" it.');
  } else if (category === 'PERMISSION_DENIED') {
    lines.push('  \u2022 The action was blocked by the Security PermissionEngine policy.');
    lines.push('  \u2022 Check workspace boundary or allowed capabilities.');
  } else if (category === 'APPROVAL_REJECTED') {
    lines.push('  \u2022 Action was cancelled because approval was rejected.');
  } else {
    lines.push('  \u2022 Inspect plan steps with /plan or submit a simplified goal.');
  }

  lines.push(drawDivider('─', 64));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Task Decomposition & Project Orchestration Renderers
// ---------------------------------------------------------------------------

export function renderTaskDecompositionPlanCard(plan: DecompositionPlan, taskTitle: string): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(drawDivider('─', 64));
  lines.push(` ${colors.bold}${colors.brightCyan}NEXUS TASK PLAN${colors.reset}`);
  lines.push(drawDivider('─', 64));
  lines.push('');
  lines.push(`  ${colors.bold}Goal:${colors.reset} ${taskTitle}`);
  lines.push(`  ${colors.dim}${plan.units.length} implementation units detected (${plan.estimatedComplexity.toUpperCase()} complexity):${colors.reset}`);
  lines.push('');

  plan.units.forEach((unit, idx) => {
    const num = `${idx + 1}.`.padEnd(4, ' ');
    const title = unit.title;
    const cat = `[${unit.category}]`.padEnd(14, ' ');
    const deps = unit.dependencies.length > 0 ? `${colors.dim}(deps: ${unit.dependencies.join(', ')})${colors.reset}` : '';
    lines.push(`  ${colors.bold}${num}${colors.reset} ${colors.brightCyan}${cat}${colors.reset} ${title} ${deps}`);
  });

  lines.push('');
  lines.push(`  ${colors.dim}Executing queue sequentially with per-unit verification...${colors.reset}`);
  lines.push(drawDivider('─', 64));
  return lines.join('\n');
}

export function renderDecompositionCompletionCard(
  task: AgentTask,
  result: ProjectOrchestrationResult,
  durationMs?: number
): string {
  const durationSec = durationMs ? (durationMs / 1000).toFixed(1) : 'N/A';
  const lines: string[] = [];
  lines.push(drawDivider('─', 64));
  lines.push(` ${colors.bold}${colors.brightGreen}FINAL RESULT \u2014 PROJECT COMPLETED${colors.reset}`);
  lines.push(drawDivider('─', 64));
  lines.push('');
  lines.push(`  ${colors.bold}Goal:${colors.reset}        ${task.title}`);
  lines.push(`  ${colors.bold}Status:${colors.reset}      ${colors.brightGreen}\u2713 COMPLETED${colors.reset}`);
  lines.push(`  ${colors.bold}Task ID:${colors.reset}     ${task.id}`);
  lines.push(`  ${colors.bold}Duration:${colors.reset}    ${durationSec}s`);
  lines.push(`  ${colors.bold}Units:${colors.reset}       ${result.completedUnits}/${result.totalUnits} completed cleanly`);
  lines.push('');
  lines.push(`${colors.bold}Execution Summary:${colors.reset}`);
  result.childResults.forEach((child, idx) => {
    const sym = child.success ? `${colors.brightGreen}\u2713${colors.reset}` : `${colors.brightRed}\u2716${colors.reset}`;
    lines.push(`  ${sym} Unit ${idx + 1}: ${child.title}`);
  });
  lines.push('');
  lines.push(`${colors.bold}Verification:${colors.reset}`);
  lines.push(`  ${colors.brightGreen}\u2713 All child implementation units verified${colors.reset}`);
  lines.push(`  ${colors.brightGreen}\u2713 Final end-to-end integration verified${colors.reset}`);
  lines.push(`  ${colors.brightGreen}\u2713 Artifacts registered and ready for /preview${colors.reset}`);
  lines.push(drawDivider('─', 64));
  return lines.join('\n');
}

export function renderDecompositionFailureCard(
  task: AgentTask,
  result: ProjectOrchestrationResult
): string {
  const lines: string[] = [];
  lines.push(drawDivider('─', 64));
  lines.push(` ${colors.bold}${colors.brightRed}PROJECT EXECUTION FAILED${colors.reset}`);
  lines.push(drawDivider('─', 64));
  lines.push('');
  lines.push(`  ${colors.bold}Goal:${colors.reset}        ${task.title}`);
  lines.push(`  ${colors.bold}Status:${colors.reset}      ${colors.brightRed}\u2716 FAILED${colors.reset}`);
  lines.push(`  ${colors.bold}Task ID:${colors.reset}     ${task.id}`);
  lines.push(`  ${colors.bold}Progress:${colors.reset}    ${result.completedUnits}/${result.totalUnits} units succeeded`);
  if (result.error) {
    lines.push(`  ${colors.bold}Error:${colors.reset}       ${colors.brightRed}${result.error}${colors.reset}`);
  }
  lines.push('');
  lines.push(`${colors.bold}Unit Breakdown:${colors.reset}`);
  result.childResults.forEach((child, idx) => {
    const sym = child.success
      ? `${colors.brightGreen}\u2713${colors.reset}`
      : child.status === 'blocked'
        ? `${colors.gray}\u25cb${colors.reset}`
        : `${colors.brightRed}\u2716${colors.reset}`;
    const statusText = child.success
      ? `${colors.brightGreen}COMPLETED${colors.reset}`
      : child.status === 'blocked'
        ? `${colors.gray}BLOCKED${colors.reset}`
        : `${colors.brightRed}FAILED${colors.reset}`;
    lines.push(`  ${sym} Unit ${idx + 1}: ${child.title.padEnd(30, ' ')} [${statusText}]`);
  });
  lines.push('');
  lines.push(`  ${colors.dim}Preview is unavailable due to verification or execution failure.${colors.reset}`);
  lines.push(drawDivider('─', 64));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// P7-F.1: Prompt Preview Card
// ---------------------------------------------------------------------------

const MAX_PREVIEW_LINES = 5;
const PREVIEW_WIDTH = 65;

export function renderPromptPreview(text: string): string {
  const allLines = text.split('\n');
  const lineCount = allLines.length;
  const charCount = text.length;
  const previewLines = allLines.slice(0, MAX_PREVIEW_LINES);
  const overflow = lineCount - MAX_PREVIEW_LINES;

  const innerWidth = PREVIEW_WIDTH - 4;
  const top = `${colors.dim}\u250c\u2500 TASK ${'─'.repeat(Math.max(0, PREVIEW_WIDTH - 8))}\u2510${colors.reset}`;
  const bottom = `${colors.dim}\u2514${'─'.repeat(PREVIEW_WIDTH - 2)}\u2518${colors.reset}`;

  const rows: string[] = [top];

  for (const line of previewLines) {
    const truncated = line.length > innerWidth ? line.slice(0, innerWidth - 1) + '\u2026' : line;
    rows.push(
      `${colors.dim}\u2502${colors.reset} ${padAnsi(truncated, innerWidth)} ${colors.dim}\u2502${colors.reset}`
    );
  }

  if (overflow > 0) {
    const overflowStr = `${colors.dim}+ ${overflow} more line${overflow === 1 ? '' : 's'}${colors.reset}`;
    rows.push(
      `${colors.dim}\u2502${colors.reset} ${padAnsi(overflowStr, innerWidth)} ${colors.dim}\u2502${colors.reset}`
    );
  }

  rows.push(
    `${colors.dim}\u2502${colors.reset} ${' '.repeat(innerWidth)} ${colors.dim}\u2502${colors.reset}`
  );

  const stats = `${colors.dim}${lineCount} line${lineCount === 1 ? '' : 's'} \u2022 ${charCount} character${charCount === 1 ? '' : 's'}${colors.reset}`;
  rows.push(
    `${colors.dim}\u2502${colors.reset} ${padAnsi(stats, innerWidth)} ${colors.dim}\u2502${colors.reset}`
  );
  rows.push(bottom);

  return rows.join('\n');
}

// ---------------------------------------------------------------------------
// P7-F.1: Compose Mode Header
// ---------------------------------------------------------------------------

export function renderComposeHeader(): string {
  const lines = [
    `${colors.brightBlue}\u250c\u2500 NEXUS COMPOSE ${'─'.repeat(47)}\u2510${colors.reset}`,
    `${colors.brightBlue}\u2502${colors.reset}${' '.repeat(63)}${colors.brightBlue}\u2502${colors.reset}`,
    `${colors.brightBlue}\u2502${colors.reset}  ${colors.bold}${colors.brightCyan}COMPOSE MODE${colors.reset} \u2014 Type or paste your complete task.       ${colors.brightBlue}\u2502${colors.reset}`,
    `${colors.brightBlue}\u2502${colors.reset}${' '.repeat(63)}${colors.brightBlue}\u2502${colors.reset}`,
    `${colors.brightBlue}\u2502${colors.reset}  Lines accumulate until you finish with one of:             ${colors.brightBlue}\u2502${colors.reset}`,
    `${colors.brightBlue}\u2502${colors.reset}    ${colors.brightCyan}/send${colors.reset}    \u2014 Submit the prompt                           ${colors.brightBlue}\u2502${colors.reset}`,
    `${colors.brightBlue}\u2502${colors.reset}    ${colors.brightYellow}/cancel${colors.reset}  \u2014 Discard and return to normal mode           ${colors.brightBlue}\u2502${colors.reset}`,
    `${colors.brightBlue}\u2502${colors.reset}    ${colors.dim}Ctrl+D${colors.reset}   \u2014 Submit (EOF signal)                          ${colors.brightBlue}\u2502${colors.reset}`,
    `${colors.brightBlue}\u2502${colors.reset}${' '.repeat(63)}${colors.brightBlue}\u2502${colors.reset}`,
    `${colors.brightBlue}\u2514${'─'.repeat(63)}\u2518${colors.reset}`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// P7-G: Model Control & Status Screen Renderers
// ---------------------------------------------------------------------------

export function renderModelControlScreen(
  models: Array<{ id: string; name: string; provider?: string; capabilities: string[]; isAvailable?: boolean }>,
  roleStatus: Record<string, { modelId: string; source: 'USER' | 'AUTO' }>,
  providerName: string = 'Embedded (Local)',
  activeModelId?: string
): string {
  const lines: string[] = [];
  lines.push(drawDivider('─', 60));
  lines.push(` ${colors.bold}${colors.brightCyan}NEXUS MODEL CONTROL${colors.reset}`);
  lines.push(drawDivider('─', 60));
  lines.push('');

  const activeModelDisplay = activeModelId || roleStatus['chat']?.modelId || roleStatus['coder']?.modelId || (models[0] ? models[0].id : 'None');
  const activeModelObj = models.find((m) => m.id === activeModelDisplay);
  const activeProviderDisplay = activeModelObj?.provider ? (activeModelObj.provider === 'embedded' ? 'Embedded' : 'Ollama') : providerName;

  lines.push(`  ${colors.bold}Current Active Model:${colors.reset} ${colors.brightCyan}${colors.bold}${activeModelDisplay}${colors.reset}`);
  lines.push(`  ${colors.dim}Provider:${colors.reset} ${colors.brightGreen}${activeProviderDisplay}${colors.reset}  •  ${colors.dim}Status:${colors.reset} ${colors.brightGreen}READY${colors.reset}`);
  lines.push('');
  lines.push(`${colors.bold}AVAILABLE MODELS${colors.reset}`);
  lines.push('');

  if (models.length === 0) {
    lines.push(`  ${colors.brightYellow}No local models discovered.${colors.reset}`);
  } else {
    models.forEach((m, idx) => {
      const pTag = m.provider === 'embedded' ? `${colors.brightGreen}[Embedded]${colors.reset}` : `${colors.brightCyan}[Ollama]${colors.reset}`;
      const statusTag = m.isAvailable !== false ? `${colors.brightGreen}AVAILABLE${colors.reset}` : `${colors.brightRed}UNAVAILABLE${colors.reset}`;
      lines.push(`  ${colors.brightCyan}[${idx + 1}]${colors.reset} ${colors.bold}${m.name}${colors.reset} ${pTag}`);
      lines.push(`      ${colors.dim}Capabilities:${colors.reset} ${m.capabilities.join(', ')}  •  ${colors.dim}Status:${colors.reset} ${statusTag}`);
      lines.push('');
    });
  }

  lines.push(`${colors.bold}MODEL ROLES${colors.reset}`);
  lines.push('');

  const roles: Array<{ key: string; label: string }> = [
    { key: 'planner', label: 'Planner   ' },
    { key: 'coder', label: 'Coder     ' },
    { key: 'reasoning', label: 'Reasoning ' },
    { key: 'chat', label: 'Chat      ' },
  ];

  roles.forEach(({ key, label }) => {
    const st = roleStatus[key];
    const sourceBadge =
      st && st.source === 'USER'
        ? ` ${colors.brightYellow}[USER]${colors.reset}`
        : ` ${colors.dim}[AUTO]${colors.reset}`;
    const modelDisplay = st
      ? st.source === 'USER'
        ? colors.bold + st.modelId + colors.reset
        : colors.dim + st.modelId + colors.reset
      : colors.dim + 'AUTO' + colors.reset;
    lines.push(`  ${label} \u2192 ${modelDisplay}${sourceBadge}`);
  });

  lines.push('');
  lines.push(drawDivider('─', 60));
  lines.push(
    `${colors.dim}Usage: /model <index|id>  |  /model <role> <index|id>  |  /model reset${colors.reset}`
  );
  return lines.join('\n');
}

export function renderModelStatusScreen(
  roleStatus: Record<string, { modelId: string; source: 'USER' | 'AUTO' }>,
  globalOverride?: string,
  runtimeVersion?: string,
  modelCount = 0,
  providerName = 'Embedded (Local)'
): string {
  const lines: string[] = [];
  lines.push(drawDivider('─', 60));
  lines.push(` ${colors.bold}${colors.brightCyan}NEXUS MODEL CONFIGURATION${colors.reset}`);
  lines.push(drawDivider('─', 60));
  lines.push('');
  lines.push(`  Provider     \u2192 ${colors.bold}${colors.brightGreen}${providerName}${colors.reset}`);
  lines.push(
    `  Global       \u2192 ${
      globalOverride
        ? colors.bold + colors.brightYellow + globalOverride + ' [USER]'
        : colors.dim + 'AUTO'
    }${colors.reset}`
  );
  lines.push('');

  const roles: Array<{ key: string; label: string }> = [
    { key: 'planner', label: 'Planner   ' },
    { key: 'coder', label: 'Coder     ' },
    { key: 'reasoning', label: 'Reasoning ' },
    { key: 'chat', label: 'Chat      ' },
  ];

  roles.forEach(({ key, label }) => {
    const st = roleStatus[key];
    const sourceBadge =
      st && st.source === 'USER'
        ? ` ${colors.brightYellow}[USER]${colors.reset}`
        : ` ${colors.dim}[AUTO]${colors.reset}`;
    const modelDisplay = st
      ? st.source === 'USER'
        ? colors.bold + st.modelId + colors.reset
        : colors.dim + st.modelId + colors.reset
      : colors.dim + 'AUTO' + colors.reset;
    lines.push(`  ${label} \u2192 ${modelDisplay}${sourceBadge}`);
  });

  lines.push('');
  lines.push(`  Runtime      \u2192 ${providerName} (v${runtimeVersion || '0.1.0'})`);
  lines.push(`  Models       \u2192 ${modelCount} available`);
  lines.push('');
  lines.push(drawDivider('─', 60));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// P7-H: Local Web Project Preview Renderers (/preview)
// ---------------------------------------------------------------------------

export function renderPreviewCard(result: import('../preview/previewTypes.js').PreviewResult): string {
  const lines: string[] = [];
  lines.push(drawDivider('─', 56));
  lines.push(` ${colors.bold}${colors.brightCyan}NEXUS PREVIEW${colors.reset}`);
  lines.push(drawDivider('─', 56));
  lines.push('');

  if (result.status === 'NO_COMPLETED_TASK') {
    lines.push(`  ${colors.brightYellow}ℹ No previewable task is available.${colors.reset}`);
    lines.push('');
    lines.push(`  ${colors.dim}${result.message || 'Run a task to build a project first, or type /tasks to view history.'}${colors.reset}`);
    lines.push(drawDivider('─', 56));
    return lines.join('\n');
  }

  if (result.status === 'TASK_FAILED') {
    lines.push(`  ${colors.brightRed}\u2716 Preview Unavailable${colors.reset}`);
    lines.push('');
    if (result.task) {
      lines.push(`  ${colors.bold}Task:${colors.reset}`);
      lines.push(`    ${result.task.title}`);
      lines.push('');
      lines.push(`  ${colors.bold}Status:${colors.reset}`);
      lines.push(`    ${colors.brightRed}FAILED${colors.reset}`);
      lines.push('');
      lines.push(`  ${colors.bold}Reason:${colors.reset}`);
      lines.push(`    ${result.error || result.task.errorCategory || 'Execution Failed'}`);
      lines.push('');
    }
    lines.push(`  ${colors.dim}Run /tasks to view history or /preview <number> to preview an older completed task.${colors.reset}`);
    lines.push(drawDivider('─', 56));
    return lines.join('\n');
  }

  if (result.status === 'TASK_INCOMPLETE') {
    lines.push(`  ${colors.brightYellow}\u26a0 Preview Unavailable${colors.reset}`);
    lines.push('');
    if (result.task) {
      lines.push(`  ${colors.bold}Task:${colors.reset}`);
      lines.push(`    ${result.task.title}`);
      lines.push('');
      lines.push(`  ${colors.bold}Status:${colors.reset}`);
      lines.push(`    ${colors.brightYellow}${result.task.state.toUpperCase()}${colors.reset}`);
      lines.push('');
    }
    lines.push(`  ${colors.dim}${result.message || 'Only completed tasks can be previewed. Run /tasks to view history.'}${colors.reset}`);
    lines.push(drawDivider('─', 56));
    return lines.join('\n');
  }

  if (result.status === 'NOT_WEB_PROJECT') {
    lines.push(`  ${colors.brightYellow}\u26a0 Selected task does not contain a previewable web project.${colors.reset}`);
    lines.push('');
    if (result.task) {
      lines.push(`  ${colors.bold}Task:${colors.reset}`);
      lines.push(`    ${result.task.title}`);
      lines.push('');
    }
    if (result.artifactsSummary && result.artifactsSummary.length > 0) {
      lines.push(`  ${colors.bold}Detected artifacts:${colors.reset}`);
      result.artifactsSummary.forEach((art) => {
        lines.push(`    \u2022 ${art}`);
      });
      lines.push('');
    }
    lines.push(`  ${colors.bold}Supported preview types currently include:${colors.reset}`);
    lines.push(`    HTML/CSS/JavaScript websites.`);
    lines.push(drawDivider('─', 56));
    return lines.join('\n');
  }

  if (result.status === 'MISSING_INDEX') {
    lines.push(`  ${colors.brightYellow}\u26a0 Cannot preview this project.${colors.reset}`);
    lines.push('');
    if (result.task) {
      lines.push(`  ${colors.bold}Task:${colors.reset}`);
      lines.push(`    ${result.task.title}`);
      lines.push('');
    }
    lines.push(`  ${colors.bold}Reason:${colors.reset}`);
    lines.push(`    No index.html entry point was found.`);
    lines.push('');
    if (result.detectedFiles && result.detectedFiles.length > 0) {
      lines.push(`  ${colors.bold}Detected files:${colors.reset}`);
      result.detectedFiles.forEach((f) => {
        lines.push(`    \u2022 ${f}`);
      });
      lines.push('');
    }
    lines.push(`  ${colors.dim}Add an index.html entry point to preview this project.${colors.reset}`);
    lines.push(drawDivider('─', 56));
    return lines.join('\n');
  }

  if (result.status === 'PLACEHOLDER_ARTIFACT_BLOCKED') {
    lines.push(`  ${colors.brightRed}\u2716 Preview Blocked${colors.reset}`);
    lines.push('');
    if (result.task) {
      lines.push(`  ${colors.bold}Task:${colors.reset}`);
      lines.push(`    ${result.task.title}`);
      lines.push('');
      lines.push(`  ${colors.bold}Status:${colors.reset}`);
      lines.push(`    ${colors.brightRed}PLACEHOLDER_ARTIFACT_REJECTED${colors.reset}`);
      lines.push('');
    }
    lines.push(`  ${colors.bold}Reason:${colors.reset}`);
    lines.push(`    ${result.message || 'Generated artifact does not contain a valid implementation of the requested task.'}`);
    lines.push('');
    lines.push(`  ${colors.dim}The agent must generate a real project implementation before previewing.${colors.reset}`);
    lines.push(drawDivider('─', 56));
    return lines.join('\n');
  }

  if (result.status === 'ERROR' || !result.success || !result.serverInfo) {
    lines.push(`  ${colors.brightRed}\u2716 Preview Launch Failed${colors.reset}`);
    lines.push(`  ${result.error || result.message || 'Unknown preview error'}`);
    lines.push(drawDivider('─', 56));
    return lines.join('\n');
  }

  // Status LAUNCHED
  const taskTitle = result.task?.title || 'Web Project Task';
  const projectFolder = result.serverInfo.projectDir.replace(/\\/g, '/').split('/').pop() || 'project';
  const entry = result.serverInfo.entryFile || 'index.html';

  lines.push(`  ${colors.bold}Current Task${colors.reset}`);
  lines.push(`    ${taskTitle}`);
  lines.push('');
  lines.push(`  ${colors.bold}Project${colors.reset}`);
  lines.push(`    ${projectFolder}`);
  lines.push('');
  lines.push(`  ${colors.bold}Entry Point${colors.reset}`);
  lines.push(`    ${entry}`);
  lines.push('');

  if (result.detectedFiles && result.detectedFiles.length > 0) {
    lines.push(`  ${colors.bold}Files${colors.reset}`);
    result.detectedFiles.forEach((f) => {
      lines.push(`    ${colors.brightGreen}\u2713${colors.reset} ${f}`);
    });
    lines.push('');
  }

  lines.push(`  ${colors.bold}Preview Server${colors.reset}`);
  lines.push(`    ${colors.brightCyan}\u25cf Starting...${colors.reset}`);
  lines.push('');
  lines.push(`    ${colors.bold}URL${colors.reset}`);
  lines.push(`    ${colors.brightGreen}${result.serverInfo.url}${colors.reset}`);
  lines.push('');
  lines.push(`  ${colors.dim}Opening browser...${colors.reset}`);
  lines.push('');
  lines.push(`  ${colors.brightGreen}\u2713 Preview launched successfully.${colors.reset}`);
  lines.push(drawDivider('─', 56));

  return lines.join('\n');
}

export function renderPreviewStatusCard(status: import('../preview/previewTypes.js').PreviewStatus): string {
  const lines: string[] = [];
  lines.push(drawDivider('─', 56));
  lines.push(` ${colors.bold}${colors.brightCyan}NEXUS PREVIEW STATUS${colors.reset}`);
  lines.push(drawDivider('─', 56));
  lines.push('');

  if (!status.active || !status.serverInfo) {
    lines.push(`  ${colors.dim}No active preview server is currently running.${colors.reset}`);
    lines.push(`  ${colors.dim}Use /preview to launch preview for the latest completed task.${colors.reset}`);
    lines.push(drawDivider('─', 56));
    return lines.join('\n');
  }

  lines.push(`  ${colors.bold}Status:${colors.reset}       ${colors.brightGreen}\u25cf ACTIVE${colors.reset}`);
  lines.push(`  ${colors.bold}Task ID:${colors.reset}      ${status.taskId || 'N/A'}`);
  lines.push(`  ${colors.bold}Task:${colors.reset}         ${status.taskTitle || 'N/A'}`);
  lines.push(`  ${colors.bold}Port:${colors.reset}         ${status.serverInfo.port}`);
  lines.push(`  ${colors.bold}URL:${colors.reset}          ${colors.brightGreen}${status.serverInfo.url}${colors.reset}`);
  lines.push(`  ${colors.bold}Directory:${colors.reset}    ${status.serverInfo.projectDir}`);
  lines.push(`  ${colors.bold}Entry File:${colors.reset}   ${status.serverInfo.entryFile}`);
  lines.push('');
  lines.push(`  ${colors.dim}Use /preview stop to terminate the preview server.${colors.reset}`);
  lines.push(drawDivider('─', 56));

  return lines.join('\n');
}

export function renderPreviewStoppedCard(): string {
  const lines: string[] = [];
  lines.push(drawDivider('─', 56));
  lines.push(` ${colors.bold}${colors.brightCyan}NEXUS PREVIEW${colors.reset}`);
  lines.push(drawDivider('─', 56));
  lines.push(`  ${colors.dim}\u2713 Preview server stopped successfully.${colors.reset}`);
  lines.push(drawDivider('─', 56));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Ollama Missing Banner — First-Run Actionable Error Screen (P7-J)
// ---------------------------------------------------------------------------

/**
 * Renders a prominent, professional banner displayed on CLI startup
 * when the Ollama AI runtime is not detected or not running.
 *
 * Designed for new users who have not yet installed Ollama.
 * The CLI remains fully operational (help, commands etc.) — this is a
 * non-blocking informational screen, not a crash.
 */
export function renderOllamaMissingBanner(ollamaHost = 'http://127.0.0.1:11434'): string {
  const lines: string[] = [];
  const W = Math.min(termWidth(), 74);

  lines.push('');
  lines.push(`${colors.brightYellow}${'─'.repeat(W)}${colors.reset}`);
  lines.push('');
  lines.push(
    `  ${colors.bold}${colors.brightYellow}\u26a0  NEXUS AI — ACTION REQUIRED${colors.reset}`
  );
  lines.push('');
  lines.push(`${colors.brightYellow}${'─'.repeat(W)}${colors.reset}`);
  lines.push('');
  lines.push(
    `  ${colors.white}Ollama was not detected at:${colors.reset} ${colors.dim}${ollamaHost}${colors.reset}`
  );
  lines.push('');
  lines.push(
    `  ${colors.white}NEXUS requires ${colors.brightCyan}Ollama${colors.reset}${colors.white} for local AI inference.${colors.reset}`
  );
  lines.push(`  ${colors.dim}Without it, tasks and AI commands will not work.${colors.reset}`);
  lines.push('');
  lines.push(`  ${colors.bold}${colors.brightCyan}SETUP STEPS${colors.reset}`);
  lines.push('');
  lines.push(`  ${colors.brightGreen}1.${colors.reset} Install Ollama:`);
  lines.push(`     ${colors.dim}https://ollama.com/download${colors.reset}`);
  lines.push('');
  lines.push(`  ${colors.brightGreen}2.${colors.reset} Start Ollama:`);
  lines.push(`     ${colors.dim}ollama serve${colors.reset}`);
  lines.push('');
  lines.push(`  ${colors.brightGreen}3.${colors.reset} Install a model:`);
  lines.push(`     ${colors.dim}ollama pull qwen2.5:3b${colors.reset}`);
  lines.push('');
  lines.push(`  ${colors.brightGreen}4.${colors.reset} Restart NEXUS:`);
  lines.push(`     ${colors.dim}nexus${colors.reset}`);
  lines.push('');
  lines.push(`${colors.dim}${'─'.repeat(W)}${colors.reset}`);
  lines.push(
    `  ${colors.dim}You can still use /help, /models, /settings while Ollama is offline.${colors.reset}`
  );
  lines.push(`${colors.dim}${'─'.repeat(W)}${colors.reset}`);
  return lines.join('\n');
}

/**
 * Phase 4: Renders First-Run Model Setup Screen for NEXUS CLI startup.
 */
export function renderFirstRunSetupScreen(manifestName: string, sizeMb: number, reqStorageMb: number, warning?: string): string {
  const lines: string[] = [];
  const W = 60;
  lines.push('');
  lines.push(drawDivider('─', W));
  lines.push(` ${colors.bold}${colors.brightCyan}NEXUS AI — FIRST TIME SETUP${colors.reset}`);
  lines.push(drawDivider('─', W));
  lines.push('');
  lines.push(`  ${colors.brightGreen}✓${colors.reset} NEXUS Workstation Installed`);
  lines.push(`  ${colors.brightGreen}✓${colors.reset} Embedded AI Runtime Ready`);
  lines.push('');
  lines.push(`${colors.bold}AI MODEL PROVISIONING${colors.reset}`);
  lines.push(`  ${colors.brightYellow}→ Production model is not installed.${colors.reset}`);
  lines.push('');
  lines.push(`  ${colors.dim}Recommended Model:${colors.reset} ${colors.bold}${colors.brightCyan}${manifestName}${colors.reset}`);
  lines.push(`  ${colors.dim}Download Size:${colors.reset}     ${colors.bold}${sizeMb} MB${colors.reset}`);
  lines.push(`  ${colors.dim}Required Storage:${colors.reset}  ${colors.bold}${reqStorageMb} MB free disk space${colors.reset}`);
  if (warning) {
    lines.push('');
    lines.push(`  ${colors.brightYellow}\u26a0  ${warning}${colors.reset}`);
  }
  lines.push('');
  lines.push(`  ${colors.dim}Run ${colors.brightCyan}/model install${colors.reset} ${colors.dim}to download and provision local model files.${colors.reset}`);
  lines.push(drawDivider('─', W));
  return lines.join('\n');
}

/**
 * Phase 4: Renders detailed model info card for /model info <id> command.
 */
export function renderModelInfoCard(manifest: { id: string; displayName: string; version: string; sizeBytes: number; format: string; tier: string; license: string; description: string }, isInstalled: boolean): string {
  const lines: string[] = [];
  const W = 60;
  const sizeMb = Math.round(manifest.sizeBytes / (1024 * 1024));
  lines.push(drawDivider('─', W));
  lines.push(` ${colors.bold}${colors.brightCyan}MODEL DETAILS: ${manifest.id}${colors.reset}`);
  lines.push(drawDivider('─', W));
  lines.push(`  Name        → ${manifest.displayName}`);
  lines.push(`  Tier        → ${manifest.tier.toUpperCase()}`);
  lines.push(`  Format      → ${manifest.format.toUpperCase()} (Binary GGUF)`);
  lines.push(`  Size        → ${sizeMb} MB`);
  lines.push(`  License     → ${manifest.license}`);
  lines.push(`  Installed   → ${isInstalled ? colors.brightGreen + 'YES (READY)' : colors.brightYellow + 'NO'}${colors.reset}`);
  lines.push(`  Description → ${manifest.description}`);
  lines.push(drawDivider('─', W));
  return lines.join('\n');
}
