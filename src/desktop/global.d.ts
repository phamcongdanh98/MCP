import type { TunnelDraft, TunnelPreferences } from './connection-store.js';
import type { DesktopProbeResult, DesktopRuntimeState, DesktopSettings } from './runtime.js';

declare global {
  interface Window {
    workspaceGuard: {
      chooseWorkspace(): Promise<string | null>;
      chooseTunnelClient(): Promise<string | null>;
      getState(): Promise<DesktopRuntimeState>;
      getConnection(): Promise<TunnelPreferences & { hasApiKey: boolean }>;
      start(settings: DesktopSettings): Promise<DesktopRuntimeState>;
      stop(): Promise<DesktopRuntimeState>;
      disconnectTunnel(): Promise<DesktopRuntimeState>;
      connectTunnel(draft: TunnelDraft): Promise<DesktopRuntimeState>;
      runMcpProbe(): Promise<DesktopProbeResult>;
      onState(listener: (state: DesktopRuntimeState) => void): () => void;
    };
  }
}

export {};
