/**
 * NEXUS AI — Desktop App Main Entry Point (P7-E)
 *
 * Electron main process bootstrap.
 * Owns single-instance enforcement, ApplicationApi core initialization,
 * local UIServer startup, AppWindow creation, and clean shutdown lifecycle.
 *
 * SECURITY INVARIANT:
 *  - Single Backend Core: Bootstraps ApplicationApi directly. Zero secondary backend.
 *  - Localhost Binding: UIServer binds strictly to 127.0.0.1.
 *  - Single Instance Lock: Prevents duplicate database writers or port conflicts.
 */

import { app, BrowserWindow } from 'electron';
import { ConfigService } from '../config/index.js';
import { ApplicationApi } from '../api/index.js';
import { UIServer } from '../ui/server.js';
import { AppWindow } from './appWindow.js';
import { Logger } from '../common/logger.js';

let appApi: ApplicationApi | null = null;
let uiServer: UIServer | null = null;
let appWindow: AppWindow | null = null;
let isShuttingDown = false;

// 1. Single Instance Lock
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  console.log('[NEXUS Desktop] Secondary instance detected. Focusing existing window and exiting.');
  app.quit();
} else {
  app.on('second-instance', () => {
    // Focus existing window if second instance launched
    const win = appWindow?.getWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // 2. Application Bootstrap
  app.whenReady().then(async () => {
    const configService = new ConfigService();
    const config = configService.getConfig();
    const logger = new Logger('DesktopMain', config.logLevel);

    logger.info(`Bootstrapping NEXUS Desktop App shell in [${config.environment}] mode`);

    appApi = new ApplicationApi(config);
    await appApi.bootstrap();

    // Start local UI server
    uiServer = new UIServer(appApi, config.port, config.logLevel);
    const listeningPort = await uiServer.start();
    logger.info(`NEXUS Desktop UI Server listening on port ${listeningPort}`);

    // Create desktop window
    appWindow = new AppWindow();
    appWindow.createWindow(listeningPort);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && uiServer) {
        appWindow?.createWindow(uiServer.getPort());
      }
    });
  });

  // 3. Graceful Shutdown Lifecycle
  const performCleanShutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('[NEXUS Desktop] Closing application core cleanly...');

    try {
      if (uiServer) {
        await uiServer.stop();
        uiServer = null;
      }
      if (appApi) {
        appApi.close();
        appApi = null;
      }
    } catch (err) {
      console.error('[NEXUS Desktop] Error during shutdown:', err);
    }
  };

  app.on('window-all-closed', async () => {
    await performCleanShutdown();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', async () => {
    await performCleanShutdown();
  });
}
