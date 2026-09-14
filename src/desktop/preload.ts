/**
 * NEXUS AI — Desktop Preload Script (P7-E)
 *
 * Context-isolated preload script.
 * Exposes ONLY safe, read-only application metadata (`version`, `platform`, `isElectron`).
 *
 * SECURITY INVARIANT:
 *  - ZERO direct Node.js execution exposed to renderer.
 *  - ZERO shell execution APIs.
 *  - ZERO filesystem read/write APIs exposed.
 *  - ZERO arbitrary IPC handler execution.
 */

import { contextBridge } from 'electron';

// Expose safe, non-sensitive desktop app metadata API to renderer
contextBridge.exposeInMainWorld('nexusDesktop', {
  isElectron: true,
  platform: process.platform,
  version: '0.1.0',
});
