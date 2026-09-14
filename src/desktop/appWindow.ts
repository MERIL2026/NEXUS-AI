/**
 * NEXUS AI — Desktop App Window Manager (P7-E)
 *
 * Manages the Electron BrowserWindow lifecycle and security configuration.
 *
 * SECURITY INVARIANTS:
 *  - contextIsolation: true
 *  - nodeIntegration: false
 *  - sandbox: true
 *  - webSecurity: true
 *  - Navigates ONLY to http://127.0.0.1:${port}
 *  - Blocks external popups and arbitrary web navigation.
 */

import { BrowserWindow, shell } from 'electron';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AppWindow {
  private window: BrowserWindow | null = null;

  createWindow(port: number): BrowserWindow {
    const preloadPath = path.join(__dirname, 'preload.js');

    this.window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1280,
      minHeight: 720,
      title: 'NEXUS AI Workstation',
      backgroundColor: '#0b0f19',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        preload: preloadPath,
      },
    });

    // Show window smoothly when ready-to-show
    this.window.once('ready-to-show', () => {
      this.window?.show();
    });

    // Load local UI server URL
    const targetUrl = `http://127.0.0.1:${port}`;
    this.window.loadURL(targetUrl);

    // SECURITY GUARD: Lock navigation to local UI server only
    this.window.webContents.on('will-navigate', (event, navigationUrl) => {
      const parsed = new URL(navigationUrl);
      if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
        event.preventDefault();
        shell.openExternal(navigationUrl);
      }
    });

    // SECURITY GUARD: Handle external link clicks safely in default OS browser
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      const parsed = new URL(url);
      if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    this.window.on('closed', () => {
      this.window = null;
    });

    return this.window;
  }

  getWindow(): BrowserWindow | null {
    return this.window;
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
  }
}
