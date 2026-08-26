import type { DesktopRuntimeState, DesktopSettings } from './runtime.js';

declare global {
  interface Window {
    workspaceGuard: {
      chooseWorkspace(): Promise<string | null>;
      getState(): Promise<DesktopRuntimeState>;
      start(settings: DesktopSettings): Promise<DesktopRuntimeState>;
      stop(): Promise<DesktopRuntimeState>;
      onState(listener: (state: DesktopRuntimeState) => void): () => void;
    };
  }
}

export {};
