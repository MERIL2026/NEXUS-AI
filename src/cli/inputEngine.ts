/**
 * NEXUS AI - P7-F.1: Professional CLI Input Engine
 *
 * Provides a paste-safe, multi-line-capable input layer for the NEXUS CLI.
 *
 * Features:
 *  - Paste debounce: Lines arriving within PASTE_DEBOUNCE_MS of each other are
 *    accumulated and dispatched as a single input string. This prevents clipboard
 *    pastes from splitting into multiple tasks.
 *  - Compose mode: /prompt enters an explicit multi-line editor. Lines accumulate
 *    until /send or Ctrl+D (EOF). The prompt prefix changes to signal compose mode.
 *  - /prompt [initial text]: Captures initial text provided on the /prompt line.
 *  - Multiline paste support: Pasting multiple lines in compose mode or starting
 *    with /prompt preserves all lines in order with newlines.
 *  - Approval bypass: When the current task is awaiting_approval, debounce is
 *    bypassed and y/n/v are dispatched immediately.
 *  - No raw mode required: Works on Windows CMD, PowerShell, and any readline-
 *    compatible terminal without setRawMode.
 *
 * SECURITY: This is a pure input layer. It only calls onInput(string) and has
 * zero direct filesystem, SQLite, child_process, or Ollama access.
 */

import * as readline from 'readline';
import { colors, renderComposeHeader, renderPromptPreview } from './uiFormatters.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Time window (ms) within which multiple arriving lines are accumulated
 * into a single input. Catches clipboard pastes without affecting manual typing.
 */
export const PASTE_DEBOUNCE_MS = 20;

/** Sentinel returned by AgentRunner commands to signal entering compose mode. */
export const SIGNAL_ENTER_COMPOSE = '__ENTER_COMPOSE__';

/** Sentinel returned by AgentRunner commands to signal submitting compose buffer. */
export const SIGNAL_SEND_COMPOSE = '__SEND_COMPOSE__';

/** Sentinel returned to signal entering chat mode. */
export const SIGNAL_ENTER_CHAT = '__ENTER_CHAT__';

/** Sentinel returned to signal exiting chat mode. */
export const SIGNAL_EXIT_CHAT = '__EXIT_CHAT__';

// ---------------------------------------------------------------------------
// InputEngine
// ---------------------------------------------------------------------------

export type InputMode = 'normal' | 'compose';
export type CliMode = 'agent' | 'chat';

export interface InputEngineOptions {
  /** Called when a complete, accumulated input is ready for processing. */
  onInput: (text: string) => Promise<void>;

  /** Called to check whether the current task is awaiting approval (bypass debounce). */
  isAwaitingApproval: () => boolean;

  /** Optional: override paste debounce window in ms (default: PASTE_DEBOUNCE_MS). */
  debounceMs?: number;
}

export class InputEngine {
  private rl: readline.Interface;
  private lineBuffer: string[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private mode: InputMode = 'normal';
  private cliMode: CliMode = 'agent';
  private composeBuffer: string[] = [];
  private readonly onInput: (text: string) => Promise<void>;
  private readonly isAwaitingApproval: () => boolean;
  private readonly debounceMs: number;

  // Public so main.ts can wire SIGINT handling
  readonly readline: readline.Interface;

  constructor(options: InputEngineOptions) {
    this.onInput = options.onInput;
    this.isAwaitingApproval = options.isAwaitingApproval;
    this.debounceMs = options.debounceMs ?? PASTE_DEBOUNCE_MS;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY ?? false,
      prompt: this.buildPrompt(),
    });

    // Expose readline for SIGINT wiring in main.ts
    this.readline = this.rl;

    this.rl.on('line', (line: string) => this.handleLine(line));

    this.rl.on('close', () => {
      // Ctrl+D (POSIX) or Ctrl+Z (Windows) - flush any pending buffer
      if (this.mode === 'compose' && this.composeBuffer.length > 0) {
        const text = this.composeBuffer.join('\n').trim();
        this.composeBuffer = [];
        this.mode = 'normal';
        void this.dispatchInput(text);
      } else if (this.lineBuffer.length > 0) {
        this.flushDebounce();
      }
    });

    this.rl.prompt();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Process an input line or multi-line string (used by readline and unit tests). */
  processInput(input: string): void {
    this.handleLine(input);
  }

  /** Enter compose (multi-line) mode with optional initial text. */
  enterComposeMode(initialText?: string): void {
    this.mode = 'compose';
    this.composeBuffer = [];
    if (initialText && initialText.trim()) {
      this.composeBuffer.push(initialText.trim());
    }
    // Cancel any pending debounce
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.lineBuffer = [];
    }
    process.stdout.write('\n' + renderComposeHeader() + '\n');
    this.refreshPrompt();
  }

  /** Exit compose mode, discarding the buffer. */
  cancelComposeMode(): void {
    this.mode = 'normal';
    this.composeBuffer = [];
    process.stdout.write(
      `\n${colors.dim}Compose mode cancelled. Buffer discarded.${colors.reset}\n\n`
    );
    this.refreshPrompt();
  }

  /** Submit compose buffer immediately (used by /send signal handler in main.ts). */
  async submitComposeBuffer(): Promise<void> {
    if (this.mode !== 'compose') return;
    const text = this.composeBuffer.join('\n').trim();
    this.mode = 'normal';
    this.composeBuffer = [];
    if (text) {
      await this.dispatchInput(text);
    } else {
      process.stdout.write(
        `\n${colors.brightYellow}Compose buffer is empty. Nothing submitted.${colors.reset}\n\n`
      );
    }
    this.refreshPrompt();
  }

  /** Sets the active CLI mode ('agent' or 'chat'). */
  setCliMode(mode: CliMode): void {
    this.cliMode = mode;
    this.refreshPrompt();
  }

  /** Gets the active CLI mode ('agent' or 'chat'). */
  getCliMode(): CliMode {
    return this.cliMode;
  }

  /** Returns current mode. */
  getMode(): InputMode {
    return this.mode;
  }

  /** Returns a copy of the current compose buffer. */
  getComposeBuffer(): string[] {
    return [...this.composeBuffer];
  }

  /** Refresh the readline prompt (call after printing output). */
  refreshPrompt(): void {
    this.rl.setPrompt(this.buildPrompt());
    this.rl.prompt(true);
  }

  /** Close the underlying readline interface. */
  close(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.rl.close();
  }

  // ---------------------------------------------------------------------------
  // Private: Line handling
  // ---------------------------------------------------------------------------

  private handleLine(input: string): void {
    if (input.includes('\n')) {
      const subLines = input.split(/\r?\n/);
      for (const subLine of subLines) {
        this.handleSingleLine(subLine);
      }
      return;
    }
    this.handleSingleLine(input);
  }

  private handleSingleLine(line: string): void {
    // -------------------------------------------------------------------------
    // COMPOSE MODE
    // -------------------------------------------------------------------------
    if (this.mode === 'compose') {
      const trimmedEnd = line.trimEnd(); // preserve leading whitespace (code indentation)
      const trimmed = line.trim();

      // /send on its own line submits the buffer
      if (trimmed === '/send') {
        void this.submitComposeBuffer();
        return;
      }

      // /cancel in compose mode discards the buffer
      if (trimmed === '/cancel') {
        this.cancelComposeMode();
        return;
      }

      // If user types /prompt inside compose mode, capture initial text if any
      if (trimmed.startsWith('/prompt')) {
        const initial = trimmed.slice(7).trim();
        if (initial) {
          this.composeBuffer.push(initial);
        }
        this.refreshPrompt();
        return;
      }

      this.composeBuffer.push(trimmedEnd);
      this.refreshPrompt();
      return;
    }

    // -------------------------------------------------------------------------
    // NORMAL MODE
    // -------------------------------------------------------------------------
    const trimmed = line.trim();

    // Check if line starts with /prompt command
    if (trimmed.startsWith('/prompt')) {
      const initial = trimmed.slice(7).trim();
      this.enterComposeMode(initial);
      return;
    }

    // Check if line is /send in normal mode
    if (trimmed === '/send') {
      process.stdout.write(
        `\n${colors.brightYellow}Not in compose mode. Use /prompt to start compose mode.${colors.reset}\n\n`
      );
      this.refreshPrompt();
      return;
    }

    // Approval bypass: dispatch y/n/v immediately without debounce
    if (this.isAwaitingApproval()) {
      const lower = trimmed.toLowerCase();
      const isApprovalInput =
        lower === 'y' ||
        lower === 'yes' ||
        lower === 'n' ||
        lower === 'no' ||
        lower === 'v' ||
        lower === 'view' ||
        lower === '/y' ||
        lower === '/n' ||
        lower === '/v' ||
        lower.startsWith('/approve') ||
        lower.startsWith('/reject') ||
        lower.startsWith('/cancel') ||
        lower.startsWith('/help') ||
        lower.startsWith('/status') ||
        lower.startsWith('/exit') ||
        lower.startsWith('/quit');

      if (isApprovalInput) {
        if (this.debounceTimer !== null) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
          this.lineBuffer = [];
        }
        void this.dispatchInput(line.trim());
        return;
      }
    }

    // Slash commands are dispatched immediately without debounce
    if (trimmed.startsWith('/')) {
      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
        this.lineBuffer = [];
      }
      void this.dispatchInput(trimmed);
      return;
    }

    // Empty line in normal mode - ignore
    if (trimmed === '') {
      this.refreshPrompt();
      return;
    }

    // Accumulate line into paste buffer
    this.lineBuffer.push(line);

    // Reset debounce timer
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.flushDebounce();
    }, this.debounceMs);
  }

  /** Flush the accumulated paste buffer and dispatch as a single input. */
  private flushDebounce(): void {
    this.debounceTimer = null;
    if (this.lineBuffer.length === 0) return;

    const text = this.lineBuffer.join('\n');
    this.lineBuffer = [];
    void this.dispatchInput(text);
  }

  // ---------------------------------------------------------------------------
  // Private: Dispatch
  // ---------------------------------------------------------------------------

  private async dispatchInput(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      this.refreshPrompt();
      return;
    }

    // Show prompt preview for multi-line or long inputs (before AgentRunner processes them)
    const isMultiLine = trimmed.includes('\n');
    const isLong = trimmed.length > 120;
    const isSlashCommand = trimmed.startsWith('/');

    if ((isMultiLine || isLong) && !isSlashCommand) {
      process.stdout.write('\n' + renderPromptPreview(trimmed) + '\n');
    }

    // Delegate entirely to the onInput callback (AgentRunner.runCommand)
    await this.onInput(trimmed);
  }

  // ---------------------------------------------------------------------------
  // Private: Prompt builder
  // ---------------------------------------------------------------------------

  private buildPrompt(): string {
    if (this.mode === 'compose') {
      return `${colors.dim}  ···  ${colors.reset}`;
    }
    if (this.cliMode === 'chat') {
      return `${colors.bold}${colors.brightCyan}Chat${colors.reset}${colors.dim}>${colors.reset} `;
    }
    return `${colors.bold}${colors.brightCyan}NEXUS${colors.reset}${colors.dim}>${colors.reset} `;
  }
}

