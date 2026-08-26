import type { DesktopProbeResult, DesktopRuntimeState, DesktopSettings } from './runtime.js';

declare global {
  interface Window {
    workspaceGuard: {
      chooseWorkspace(): Promise<string | null>;
      getState(): Promise<DesktopRuntimeState>;
      start(settings: DesktopSettings): Promise<DesktopRuntimeState>;
      stop(): Promise<DesktopRuntimeState>;
      runMcpProbe(): Promise<DesktopProbeResult>;
      onState(listener: (state: DesktopRuntimeState) => void): () => void;
    };
  }
}

export {};
