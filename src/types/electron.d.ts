/**
 * NEXUS AI — Electron Type Declarations (P7-E)
 */

declare module 'electron' {
  export interface WebContents {
    on(event: 'will-navigate', listener: (event: { preventDefault: () => void }, navigationUrl: string) => void): void;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void;
  }

  export interface WebPreferences {
    contextIsolation?: boolean;
    nodeIntegration?: boolean;
    sandbox?: boolean;
    webSecurity?: boolean;
    preload?: string;
  }

  export interface BrowserWindowOptions {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    title?: string;
    backgroundColor?: string;
    show?: boolean;
    autoHideMenuBar?: boolean;
    webPreferences?: WebPreferences;
  }

  export class BrowserWindow {
    constructor(options?: BrowserWindowOptions);
    webContents: WebContents;
    once(event: 'ready-to-show', listener: () => void): void;
    on(event: 'closed', listener: () => void): void;
    loadURL(url: string): Promise<void>;
    show(): void;
    focus(): void;
    restore(): void;
    isMinimized(): boolean;
    isDestroyed(): boolean;
    close(): void;
    static getAllWindows(): BrowserWindow[];
  }

  export const app: {
    requestSingleInstanceLock(): boolean;
    whenReady(): Promise<void>;
    quit(): void;
    getPath(name: string): string;
    on(event: string, listener: (...args: unknown[]) => void): void;
  };

  export const shell: {
    openExternal(url: string): Promise<void>;
  };

  export const contextBridge: {
    exposeInMainWorld(apiKey: string, api: unknown): void;
  };
}
