/**
 * NEXUS AI - P7-F.1: Interactive Agent CLI Shell Main Entry Point
 *
 * Bootstraps ApplicationApi, displays NEXUS Workstation Dashboard,
 * and manages an interactive shell via InputEngine (paste-debounced,
 * compose-mode-capable) with concurrency guards and safe SIGINT handling.
 *
 * Provides clean dual-runtime operation:
 *  - Agent Mode: Full task execution pipeline (Think -> Plan -> Approve -> Execute -> Verify)
 *  - Chat Mode: Pure conversational AI (direct ModelGateway / ChatService inference)
 */

import { loadConfig } from '../config/index.js';
import { ApplicationApi } from '../api/index.js';
import { AgentRunner } from './agentRunner.js';
import { ChatRunner } from './chatRunner.js';
import {
  InputEngine,
  SIGNAL_ENTER_COMPOSE,
  SIGNAL_SEND_COMPOSE,
  SIGNAL_ENTER_CHAT,
  SIGNAL_EXIT_CHAT,
} from './inputEngine.js';
import { renderDashboard, renderOllamaMissingBanner, colors } from './uiFormatters.js';
import { formatCliVersion } from './version.js';

export function handleCliFlags(args: string[] = process.argv.slice(2)): boolean {
  if (args.includes('--version') || args.includes('-v')) {
    console.log(formatCliVersion());
    return true;
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`NEXUS AI — Local-First AI Workstation CLI

Usage:
  nexus [options]

Options:
  -v, --version  Display NEXUS AI version
  -h, --help     Display CLI help and usage

Interactive Shell Commands:
  /chat          Start normal AI conversation (Chat Mode)
  /chats         View conversation history
  /help          Show available in-app commands
  /model [id]    Display or switch active AI model
  /models        List all discovered models
  /tasks         List recent task history
  /preview       Launch project preview server
  /clear         Clear terminal screen
  /exit          Exit NEXUS AI Workstation`);
    return true;
  }

  return false;
}

async function runCli(): Promise<void> {
  if (handleCliFlags()) {
    process.exit(0);
  }

  const config = loadConfig();
  const api = new ApplicationApi(config);

  // 1. Bootstrap all subsystems
  const healthReport = await api.bootstrap();
  const runner = new AgentRunner(api, config.logLevel);
  const chatRunner = new ChatRunner(api, config.logLevel);

  // 2. Render initial Workstation Dashboard
  const renderStartDashboard = () => renderDashboard(healthReport, config.workspaceRoot);
  console.log(renderStartDashboard());

  // 3. Check First-Run Model Setup status
  const intelligenceStatus = healthReport.subsystems.find((s) => s.name === 'IntelligenceService');
  if (intelligenceStatus && intelligenceStatus.status !== 'ok') {
    const activeProvider = (intelligenceStatus.details?.['activeProvider'] as string) || 'embedded';
    if (activeProvider === 'ollama') {
      console.log(renderOllamaMissingBanner(config.ollamaHost));
    } else {
      const { renderFirstRunSetupScreen } = await import('./uiFormatters.js');
      console.log(renderFirstRunSetupScreen('NEXUS Recommended Coding 1.5B (GGUF)', 1100, 2048));
    }
  }

  let isBusy = false;

  // 4. Build InputEngine — paste-debounced, compose-mode-capable, dual-mode (Agent / Chat)
  let engine!: InputEngine;
  engine = new InputEngine({
    isAwaitingApproval: (): boolean =>
      engine?.getCliMode() === 'agent' &&
      !!(runner.currentTask && runner.currentTask.state === 'awaiting_approval'),

    onInput: async (text: string) => {
      const lower = text.toLowerCase();

      // Global Exit commands handled before isBusy to allow clean exit at any time
      if (lower === '/exit' || lower === '/quit' || lower === '/q') {
        if (engine.getCliMode() === 'chat') {
          engine.setCliMode('agent');
          process.stdout.write(`\n${colors.brightCyan}Returned to NEXUS Agent mode.${colors.reset}\n\n`);
          engine.refreshPrompt();
          return;
        }
        console.log(`\n${runner.exitRunner()}\n`);
        api.close();
        engine.close();
        process.exit(0);
      }

      if (lower === '/clear' || lower === '/cls') {
        process.stdout.write('\x1bc');
        if (engine.getCliMode() === 'agent') {
          console.log(renderStartDashboard());
        }
        engine.refreshPrompt();
        return;
      }

      if (isBusy) {
        process.stdout.write(
          `\n${colors.brightYellow}Operation in progress. Please wait or press Ctrl+C to cancel.${colors.reset}\n\n`
        );
        engine.refreshPrompt();
        return;
      }

      isBusy = true;
      try {
        // ---------------------------------------------------------------------
        // CHAT MODE DISPATCH
        // ---------------------------------------------------------------------
        if (engine.getCliMode() === 'chat') {
          if (lower === '/exit-chat' || lower === '/exitchat') {
            engine.setCliMode('agent');
            process.stdout.write(`\n${colors.brightCyan}Returned to NEXUS Agent mode.${colors.reset}\n\n`);
            return;
          }

          const response = await chatRunner.runCommand(text, { streamToStdout: true });

          if (response === SIGNAL_EXIT_CHAT) {
            engine.setCliMode('agent');
            process.stdout.write(`\n${colors.brightCyan}Returned to NEXUS Agent mode.${colors.reset}\n\n`);
            return;
          }

          if (response) {
            process.stdout.write(`\n${response}\n\n`);
          }
          return;
        }

        // ---------------------------------------------------------------------
        // AGENT MODE DISPATCH
        // ---------------------------------------------------------------------
        const response = await runner.runCommand(text);

        // Handle compose mode signals returned by AgentRunner
        if (response === SIGNAL_ENTER_COMPOSE) {
          engine.enterComposeMode();
          return;
        }

        if (response === SIGNAL_SEND_COMPOSE) {
          await engine.submitComposeBuffer();
          return;
        }

        // Handle Chat Mode transitions
        if (response === SIGNAL_ENTER_CHAT || response.startsWith(`${SIGNAL_ENTER_CHAT}:`)) {
          const targetConvId = response.startsWith(`${SIGNAL_ENTER_CHAT}:`)
            ? response.slice(SIGNAL_ENTER_CHAT.length + 1).trim()
            : undefined;

          engine.setCliMode('chat');
          const banner = await chatRunner.startOrResumeChat(targetConvId);
          process.stdout.write(`\n${banner}\n\n`);
          return;
        }

        if (response) {
          process.stdout.write(`\n${response}\n\n`);
        }
      } catch (err) {
        process.stdout.write(
          `\n${colors.brightRed}Error: ${err instanceof Error ? err.message : String(err)}${colors.reset}\n\n`
        );
      } finally {
        isBusy = false;
        engine.refreshPrompt();
      }
    },
  });

  // 5. Safe Ctrl+C handling: cancels active generation or task if running, or exits cleanly if idle
  engine.readline.on('SIGINT', async () => {
    if (engine.getCliMode() === 'chat') {
      if (chatRunner.cancelActiveGeneration()) {
        process.stdout.write(
          `\n\n${colors.brightYellow}[SIGINT] Chat generation cancelled.${colors.reset}\n\n`
        );
        isBusy = false;
        engine.refreshPrompt();
        return;
      }
      process.stdout.write(
        `\n\n${colors.dim}[SIGINT] Safely closing NEXUS AI Workstation...${colors.reset}\n`
      );
      api.close();
      engine.close();
      process.exit(0);
      return;
    }

    if (
      runner.currentTask &&
      ['created', 'planning', 'executing', 'awaiting_approval'].includes(runner.currentTask.state)
    ) {
      process.stdout.write(
        `\n\n${colors.brightYellow}[SIGINT] Cancelling active task '${runner.currentTask.id}'...${colors.reset}\n`
      );
      const cancelMsg = await runner.cancelCurrentTask();
      process.stdout.write(`${cancelMsg}\n\n`);
      isBusy = false;
      engine.refreshPrompt();
    } else {
      process.stdout.write(
        `\n\n${colors.dim}[SIGINT] Safely closing NEXUS AI Workstation...${colors.reset}\n`
      );
      api.close();
      engine.close();
      process.exit(0);
    }
  });
}

// Guard top-level execution so importing main.js in tests does not trigger runCli()
const isMainEntry =
  process.argv[1] &&
  (process.argv[1].endsWith('main.ts') ||
    process.argv[1].endsWith('main.js') ||
    process.argv[1].endsWith('bin.ts') ||
    process.argv[1].endsWith('bin.js') ||
    process.argv[1].includes('nexus'));

if (isMainEntry) {
  runCli().catch((err) => {
    console.error('[NEXUS AI Agent Shell] Fatal startup error:', err);
    process.exit(1);
  });
}
