import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain } from 'electron';

import type { DesktopSettings } from './runtime.js';
import { DesktopRuntimeController } from './runtime.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const rendererFile = path.join(directory, 'renderer', 'index.html');
const preloadFile = path.join(directory, 'preload.cjs');
const serverEntry = path.join(directory, '..', 'index.js');
const runtime = new DesktopRuntimeController({ serverEntry, environment: { ELECTRON_RUN_AS_NODE: '1' } });

let mainWindow: BrowserWindow | null = null;
let quitting = false;

function isDesktopSettings(value: unknown): value is DesktopSettings {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.root === 'string' &&
    typeof candidate.port === 'number' &&
    Array.isArray(candidate.allowedCommands) && candidate.allowedCommands.every((command) => typeof command === 'string') &&
    (candidate.mode === 'read-only' || candidate.mode === 'workspace-write' || candidate.mode === 'command');
}

function sendState(): void {
  mainWindow?.webContents.send('workspaceguard:state', runtime.snapshot());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 760,
    minHeight: 620,
    title: 'WorkspaceGuard MCP',
    webPreferences: {
      preload: preloadFile,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    console.error(`[workspaceguard renderer] ${message}`);
  });
  void mainWindow.loadFile(rendererFile);
  mainWindow.on('closed', () => { mainWindow = null; });
}

runtime.on('state', sendState);

ipcMain.handle('workspaceguard:choose-workspace', async () => {
  try {
    mainWindow?.focus();
    const options = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  } catch (error) {
    console.error('[workspaceguard] Folder picker failed:', error);
    throw error;
  }
});
ipcMain.handle('workspaceguard:get-state', () => runtime.snapshot());
ipcMain.handle('workspaceguard:start', async (_event, settings: unknown) => {
  if (!isDesktopSettings(settings)) throw new Error('Cấu hình giao diện không hợp lệ.');
  return runtime.start(settings);
});
ipcMain.handle('workspaceguard:stop', () => runtime.stop());
ipcMain.handle('workspaceguard:run-mcp-probe', () => runtime.runMcpProbe());

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  void runtime.stop().finally(() => {
    quitting = true;
    app.quit();
  });
});
