#!/usr/bin/env node
/**
 * NEXUS AI — P7-J: CLI Distribution Entry Point (bin shim)
 *
 * This file is the `bin` target for the npm package (`nexus` command).
 * It ensures NODE_ENV=production so that productionPaths.ts resolves
 * user-portable paths (%APPDATA%\NEXUS AI on Windows, ~/.nexus-ai elsewhere)
 * instead of developer-relative paths.
 *
 * Do NOT add business logic here — keep this shim minimal.
 * All CLI logic lives in main.ts / agentRunner.ts.
 */

// Set production environment BEFORE any module imports so that
// productionPaths.ts sees the correct NODE_ENV during path resolution.
if (!process.env['NODE_ENV']) {
  process.env['NODE_ENV'] = 'production';
}

// Delegate to the full CLI entry point
import './main.js';
