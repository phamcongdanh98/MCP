import { contextBridge, ipcRenderer } from 'electron';

import type { TunnelDraft, TunnelPreferences } from './connection-store.js';
import type { DesktopProbeResult, DesktopRuntimeState, DesktopSettings } from './runtime.js';

const api = {
  chooseWorkspace: (): Promise<string | null> => ipcRenderer.invoke('workspaceguard:choose-workspace'),
  chooseTunnelClient: (): Promise<string | null> => ipcRenderer.invoke('workspaceguard:choose-tunnel-client'),
  getState: (): Promise<DesktopRuntimeState> => ipcRenderer.invoke('workspaceguard:get-state'),
  getConnection: (): Promise<TunnelPreferences & { hasApiKey: boolean }> => ipcRenderer.invoke('workspaceguard:get-connection'),
  start: (settings: DesktopSettings): Promise<DesktopRuntimeState> => ipcRenderer.invoke('workspaceguard:start', settings),
  stop: (): Promise<DesktopRuntimeState> => ipcRenderer.invoke('workspaceguard:stop'),
  disconnectTunnel: (): Promise<DesktopRuntimeState> => ipcRenderer.invoke('workspaceguard:disconnect-tunnel'),
  connectTunnel: (draft: TunnelDraft): Promise<DesktopRuntimeState> => ipcRenderer.invoke('workspaceguard:connect-tunnel', draft),
  runMcpProbe: (): Promise<DesktopProbeResult> => ipcRenderer.invoke('workspaceguard:run-mcp-probe'),
  onState: (listener: (state: DesktopRuntimeState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopRuntimeState) => listener(state);
    ipcRenderer.on('workspaceguard:state', handler);
    return () => ipcRenderer.removeListener('workspaceguard:state', handler);
  },
};

contextBridge.exposeInMainWorld('workspaceGuard', api);
