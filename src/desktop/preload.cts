import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopProbeResult, DesktopRuntimeState, DesktopSettings } from './runtime.js';

const api = {
  chooseWorkspace: (): Promise<string | null> => ipcRenderer.invoke('workspaceguard:choose-workspace'),
  getState: (): Promise<DesktopRuntimeState> => ipcRenderer.invoke('workspaceguard:get-state'),
  start: (settings: DesktopSettings): Promise<DesktopRuntimeState> => ipcRenderer.invoke('workspaceguard:start', settings),
  stop: (): Promise<DesktopRuntimeState> => ipcRenderer.invoke('workspaceguard:stop'),
  runMcpProbe: (): Promise<DesktopProbeResult> => ipcRenderer.invoke('workspaceguard:run-mcp-probe'),
  onState: (listener: (state: DesktopRuntimeState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopRuntimeState) => listener(state);
    ipcRenderer.on('workspaceguard:state', handler);
    return () => ipcRenderer.removeListener('workspaceguard:state', handler);
  },
};

contextBridge.exposeInMainWorld('workspaceGuard', api);
