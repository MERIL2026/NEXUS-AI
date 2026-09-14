/**
 * NEXUS AI — P6-C: Terminal Command Policy Engine
 *
 * Deterministic allowlist-based policy for validating terminal commands.
 *
 * SECURITY PRINCIPLES:
 *  - Default is DENY. Only explicitly allowlisted commands may execute.
 *  - No shell interpreters (cmd, powershell, bash, sh) are ever permitted.
 *  - Shell chaining operators (&&, ||, ;, |, >, >>, <, 2>, &, $) are rejected.
 *  - Destructive and network commands are permanently blocked.
 *  - Each command/argument pair is validated, not just the command name.
 *  - Policy is extensible: add entries to ALLOWED_COMMANDS.
 */

import type { CommandPolicyResult, TerminalExecuteParams } from './terminalTypes.js';
import { Logger, LogLevel } from '../../common/logger.js';

// ---------------------------------------------------------------------------
// Shell Operator Detection
// ---------------------------------------------------------------------------

/**
 * Shell operators that indicate an attempt at shell chaining or injection.
 * Primary defense is non-shell spawn (no shell: true). This is a secondary check.
 */
const SHELL_OPERATOR_PATTERNS: ReadonlyArray<RegExp> = [
  /&&/,
  /\|\|/,
  /(?<![a-zA-Z0-9])[;](?![a-zA-Z0-9])/,  // standalone semicolons
  /(?<![a-zA-Z0-9])\|(?!\|)/,              // single pipe (not ||, already caught)
  />/,
  />>/,
  /<(?!<)/,
  /2>/,
  /2>>/,
  /(?<![a-zA-Z0-9])&(?!&)/,               // single & (background)
  /\$\(/,                                  // command substitution $(...)
  /`[^`]+`/,                              // backtick substitution
  /%COMSPEC%/i,
  /%SystemRoot%/i,
  /\bpowershell\b/i,
  /\bcmd\.exe\b/i,
  /\bcmd\b/i,
  /\bbash\b/i,
  /\bsh\b/i,
  /\bzsh\b/i,
  /\/c\b/i,
  /-[Cc]ommand\b/,
  /-EncodedCommand\b/i,
];

/**
 * Commands that are permanently blocked regardless of arguments.
 * These represent shell interpreters, destructive utilities, and network tools.
 */
const PERMANENTLY_BLOCKED_COMMANDS: ReadonlySet<string> = new Set([
  // Shell interpreters — primary threat
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'bash', 'bash.exe', 'sh', 'sh.exe', 'zsh', 'zsh.exe', 'fish', 'fish.exe',
  'wscript', 'cscript', 'mshta',

  // Destructive filesystem commands
  'rm', 'rmdir', 'del', 'deltree', 'erase', 'format', 'rd',
  'mkfs', 'fdisk', 'diskpart',

  // System control
  'shutdown', 'reboot', 'halt', 'init', 'systemctl', 'service',
  'taskkill', 'tasklist', 'wmic',
  'reg', 'regedit', 'regedt32',
  'net', 'netsh', 'sc',
  'runas', 'sudo', 'su',
  'attrib', 'icacls', 'cacls', 'takeown', 'chmod', 'chown',

  // Network tools
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'telnet',
  'ping', 'tracert', 'traceroute', 'nslookup', 'dig',
  'netstat', 'ipconfig', 'ifconfig', 'arp', 'route',
  'nc', 'ncat', 'socat', 'openssl',

  // Package installation (network)
  'pip', 'pip3', 'pip2',
  'gem', 'bundle',
  'cargo', 'go',
  'composer',
  'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'brew',
  'choco', 'scoop', 'winget',

  // Compilation/build from arbitrary sources
  'make', 'cmake', 'msbuild', 'gradle', 'mvn', 'ant',

  // Virtualization/containers
  'docker', 'podman', 'kubectl', 'helm',
  'vagrant', 'virtualbox',
]);

// ---------------------------------------------------------------------------
// Argument Blocklist Patterns
// ---------------------------------------------------------------------------

/**
 * Patterns that are never allowed in arguments regardless of command.
 * Primarily targets embedded shell sequences or null bytes.
 */
const BLOCKED_ARG_PATTERNS: ReadonlyArray<RegExp> = [
  /\0/,                     // Null byte
  /&&/,
  /\|\|/,
  /`[^`]*`/,               // Backtick substitution
  /\$\(/,                  // Command substitution
  /%COMSPEC%/i,
  /\bpowershell\b/i,
  /\bcmd\.exe\b/i,
  /\/c\s+/i,               // /c flag (cmd.exe)
  /-[Cc]ommand\s*/,        // PowerShell -Command
  /-EncodedCommand\b/i,    // PowerShell -EncodedCommand
];

// ---------------------------------------------------------------------------
// Allowlist Definition
// ---------------------------------------------------------------------------

export interface AllowedCommandEntry {
  /** Command executable name (lowercase). */
  command: string;
  /** If set, only these subcommands/args are permitted. null means no per-arg restriction. */
  allowedSubcommands?: ReadonlySet<string> | null;
  /** Patterns that are blocked in the args for this command. */
  blockedArgPatterns?: ReadonlyArray<RegExp>;
  /** Risk classification. */
  riskLevel: 'safe' | 'elevated';
  description: string;
}

/**
 * The canonical allowlist. Only commands listed here may execute.
 *
 * POLICY:
 *  - "safe"     → auto-approvable read/query operations
 *  - "elevated" → write/modify operations (still require approval via P5 pipeline)
 */
const ALLOWED_COMMANDS: ReadonlyArray<AllowedCommandEntry> = [
  // ---------------------------------------------------------------------------
  // node
  // ---------------------------------------------------------------------------
  {
    command: 'node',
    allowedSubcommands: null, // validated at arg level below
    blockedArgPatterns: [
      /^-e$/i,           // node -e "<code>" — arbitrary code execution
      /^--eval$/i,
      /^-p$/i,           // node -p "<code>"
      /^--print$/i,
    ],
    riskLevel: 'elevated',
    description: 'Node.js runtime for version checks and safe script execution',
  },

  // ---------------------------------------------------------------------------
  // npm
  // ---------------------------------------------------------------------------
  {
    command: 'npm',
    allowedSubcommands: new Set([
      'test', 'run', 'build', 'lint', 'typecheck',
      '--version', 'version', '-v',
      'install',  // allowed but flagged elevated
    ]),
    blockedArgPatterns: [
      /^publish$/i,
      /^unpublish$/i,
      /^uninstall$/i,
      /^remove$/i,
      /^rm$/i,
      /^cache$/i,
      /^exec$/i,
      /^x$/i,           // npm x = npx shorthand for arbitrary package exec
      /^fund$/i,
      /^pack$/i,
      /^deprecate$/i,
      /^logout$/i,
      /^adduser$/i,
      /^whoami$/i,
      /^token$/i,
      /^audit\s+fix$/i,
    ],
    riskLevel: 'elevated',
    description: 'npm for running defined project scripts (test, build, lint, typecheck)',
  },

  // ---------------------------------------------------------------------------
  // npx
  // ---------------------------------------------------------------------------
  {
    command: 'npx',
    allowedSubcommands: new Set([
      'tsc',            // TypeScript compiler
    ]),
    riskLevel: 'elevated',
    description: 'npx limited to tsc (TypeScript compiler) only',
  },

  // ---------------------------------------------------------------------------
  // git (read-only operations only)
  // ---------------------------------------------------------------------------
  {
    command: 'git',
    allowedSubcommands: new Set([
      'status',
      'diff',
      'log',
      'show',
      'branch',
      '--version',
      'version',
      '-v',
      '--no-pager',   // git --no-pager <subcommand> — safe prefix
    ]),
    blockedArgPatterns: [
      /^push$/i,
      /^reset$/i,
      /^clean$/i,
      /^checkout$/i,
      /^restore$/i,
      /^rebase$/i,
      /^merge$/i,
      /^commit$/i,
      /^tag$/i,
      /^stash$/i,
      /^bisect$/i,
      /^cherry-pick$/i,
      /^revert$/i,
      /^am$/i,
      /^apply$/i,
      /^fetch$/i,
      /^pull$/i,
      /^clone$/i,
      /^submodule$/i,
      /^config$/i,
      /^remote$/i,
      /--force/i,
      /--hard/i,
      /--soft/i,
      /--mixed/i,
    ],
    riskLevel: 'safe',
    description: 'git for read-only status, diff, log, and branch inspection',
  },

  // ---------------------------------------------------------------------------
  // python / python3
  // ---------------------------------------------------------------------------
  {
    command: 'python',
    allowedSubcommands: null,
    blockedArgPatterns: [
      /^-c$/i,     // python -c "<code>" — arbitrary code execution
      /^-m\s*pip/i, // python -m pip — package installation
    ],
    riskLevel: 'elevated',
    description: 'Python runtime for version checks and safe script execution',
  },
  {
    command: 'python3',
    allowedSubcommands: null,
    blockedArgPatterns: [
      /^-c$/i,
      /^-m\s*pip/i,
    ],
    riskLevel: 'elevated',
    description: 'Python3 runtime for version checks and safe script execution',
  },

  // ---------------------------------------------------------------------------
  // pytest
  // ---------------------------------------------------------------------------
  {
    command: 'pytest',
    allowedSubcommands: null,
    blockedArgPatterns: [],
    riskLevel: 'elevated',
    description: 'pytest test runner for Python projects',
  },

  // ---------------------------------------------------------------------------
  // tsc (TypeScript compiler)
  // ---------------------------------------------------------------------------
  {
    command: 'tsc',
    allowedSubcommands: null,
    blockedArgPatterns: [],
    riskLevel: 'elevated',
    description: 'TypeScript compiler for type-checking and compilation',
  },
];

// Build lookup map for O(1) access
const ALLOWED_COMMAND_MAP: ReadonlyMap<string, AllowedCommandEntry> = new Map(
  ALLOWED_COMMANDS.map((entry) => [entry.command.toLowerCase(), entry])
);

// ---------------------------------------------------------------------------
// TerminalCommandPolicy Class
// ---------------------------------------------------------------------------

export class TerminalCommandPolicy {
  private logger: Logger;

  constructor(logLevel: LogLevel = 'info') {
    this.logger = new Logger('TerminalCommandPolicy', logLevel);
  }

  /**
   * Evaluate whether a command invocation is permitted.
   *
   * @param params The structured terminal execute params.
   * @returns Deterministic CommandPolicyResult.
   */
  evaluate(params: TerminalExecuteParams): CommandPolicyResult {
    // 1. Basic structural validation
    if (!params || typeof params !== 'object') {
      return this.deny('INVALID_REQUEST', 'Terminal execute params must be a structured object.', 'blocked');
    }

    if (!params.command || typeof params.command !== 'string' || params.command.trim() === '') {
      return this.deny('INVALID_REQUEST', 'Terminal execute params must specify a non-empty command string.', 'blocked');
    }

    if (!Array.isArray(params.args)) {
      return this.deny('INVALID_REQUEST', 'Terminal execute params.args must be an array.', 'blocked');
    }

    // 2. Null byte check on command
    if (params.command.includes('\0')) {
      return this.deny('INVALID_REQUEST', 'Command contains a null byte character.', 'blocked');
    }

    const commandLower = params.command.trim().toLowerCase();

    // 3. Permanently blocked commands check
    if (PERMANENTLY_BLOCKED_COMMANDS.has(commandLower)) {
      this.logger.warn(`Command policy: permanently blocked command rejected`, {
        command: params.command,
      });
      return this.deny('COMMAND_NOT_ALLOWED', `Command '${params.command}' is permanently blocked by security policy.`, 'blocked');
    }

    // 4. Shell operator check on command itself
    for (const pattern of SHELL_OPERATOR_PATTERNS) {
      if (pattern.test(params.command)) {
        this.logger.warn(`Command policy: shell operator detected in command`, {
          command: params.command,
          pattern: pattern.toString(),
        });
        return this.deny('INVALID_COMMAND_POLICY', `Command '${params.command}' contains a shell operator or injection pattern.`, 'blocked');
      }
    }

    // 5. Allowlist check
    const entry = ALLOWED_COMMAND_MAP.get(commandLower);
    if (!entry) {
      this.logger.warn(`Command policy: command not in allowlist`, {
        command: params.command,
      });
      return this.deny('COMMAND_NOT_ALLOWED', `Command '${params.command}' is not in the terminal execution allowlist.`, 'blocked');
    }

    // 6. Validate each argument
    for (const arg of params.args) {
      if (typeof arg !== 'string') {
        return this.deny('INVALID_REQUEST', 'All args must be strings.', 'blocked');
      }

      // Null byte in arg
      if (arg.includes('\0')) {
        return this.deny('INVALID_REQUEST', `Argument contains a null byte character.`, 'blocked');
      }

      // Global shell operator patterns in args
      for (const pattern of SHELL_OPERATOR_PATTERNS) {
        if (pattern.test(arg)) {
          this.logger.warn(`Command policy: shell operator detected in argument`, {
            command: params.command,
            arg,
            pattern: pattern.toString(),
          });
          return this.deny('INVALID_COMMAND_POLICY', `Argument '${this.sanitizeForLog(arg)}' contains a shell operator or injection pattern.`, 'blocked');
        }
      }

      // Global blocked arg patterns
      for (const pattern of BLOCKED_ARG_PATTERNS) {
        if (pattern.test(arg)) {
          return this.deny('INVALID_COMMAND_POLICY', `Argument '${this.sanitizeForLog(arg)}' contains a blocked pattern.`, 'blocked');
        }
      }

      // Per-command blocked arg patterns
      if (entry.blockedArgPatterns) {
        for (const pattern of entry.blockedArgPatterns) {
          if (pattern.test(arg)) {
            this.logger.warn(`Command policy: blocked argument pattern matched`, {
              command: params.command,
              arg,
              pattern: pattern.toString(),
            });
            return this.deny('COMMAND_NOT_ALLOWED', `Argument '${this.sanitizeForLog(arg)}' is not permitted for command '${params.command}'.`, 'blocked');
          }
        }
      }
    }

    // 7. Subcommand validation (if entry has restricted subcommand set)
    if (entry.allowedSubcommands !== null && entry.allowedSubcommands !== undefined) {
      // Find the first "subcommand" arg (first non-flag arg)
      const firstArg = params.args[0];
      if (!firstArg) {
        // No subcommand provided — may be valid (e.g. --version) — allow
      } else {
        const firstArgLower = firstArg.toLowerCase();
        if (!entry.allowedSubcommands.has(firstArgLower) && !firstArgLower.startsWith('-')) {
          this.logger.warn(`Command policy: subcommand not in allowlist`, {
            command: params.command,
            subcommand: firstArg,
          });
          return this.deny('COMMAND_NOT_ALLOWED', `Subcommand '${firstArg}' is not permitted for '${params.command}'.`, 'blocked');
        }
      }
    }

    // 8. Git-specific: check all args for blocked git subcommands
    if (commandLower === 'git' && entry.blockedArgPatterns) {
      for (const arg of params.args) {
        for (const pattern of entry.blockedArgPatterns) {
          if (pattern.test(arg)) {
            this.logger.warn(`Command policy: blocked git argument`, {
              command: 'git',
              arg,
            });
            return this.deny('COMMAND_NOT_ALLOWED', `git argument '${this.sanitizeForLog(arg)}' is blocked by security policy (destructive git operations are not permitted).`, 'blocked');
          }
        }
      }
    }

    // All checks passed
    this.logger.info(`Command policy: ALLOWED`, {
      command: params.command,
      riskLevel: entry.riskLevel,
      argCount: params.args.length,
    });

    return {
      allowed: true,
      decision: 'ALLOWED',
      reason: `Command '${params.command}' is permitted by the terminal execution policy.`,
      riskLevel: entry.riskLevel,
      resolvedCommand: params.command.trim(),
      resolvedArgs: [...params.args],
    };
  }

  /**
   * Returns the list of all allowed command names.
   */
  getAllowedCommands(): string[] {
    return ALLOWED_COMMANDS.map((e) => e.command);
  }

  private deny(
    decision: 'COMMAND_NOT_ALLOWED' | 'INVALID_REQUEST' | 'PATH_TRAVERSAL_DENIED' | 'INVALID_COMMAND_POLICY',
    reason: string,
    riskLevel: 'blocked'
  ): CommandPolicyResult {
    return {
      allowed: false,
      decision,
      reason,
      riskLevel,
    };
  }

  private sanitizeForLog(arg: string): string {
    // Truncate and remove control characters for safe logging
    return arg.slice(0, 80).replace(/[\x00-\x1f\x7f]/g, '?');
  }
}
