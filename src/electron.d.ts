import type { BackupSummary } from './types';

export interface SmartTailoringDesktopBridge {
  isElectron: true;
  platform: string;
  getAppInfo: () => Promise<{
    name: string;
    version: string;
    dbPath: string;
    userDataPath: string;
  }>;
  createBackup: (businessId: number) => Promise<{
    cancelled?: boolean;
    path?: string;
    sizeBytes?: number;
    backedUpAt?: string;
    error?: string;
  }>;
  pickAndValidateBackup: () => Promise<{
    cancelled?: boolean;
    filePath?: string;
    fileName?: string;
    valid?: boolean;
    error?: string;
    summary?: BackupSummary;
  }>;
  restoreBackup: (filePath: string) => Promise<{
    restored?: boolean;
    safetyBackupPath?: string;
    summary?: BackupSummary;
    error?: string;
  }>;
  saveFile: (options: {
    defaultPath: string;
    data: Uint8Array;
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => Promise<{ cancelled?: boolean; path?: string; error?: string }>;
  nativePrint: () => Promise<{ printed: boolean }>;
  openExternal: (url: string) => Promise<{ opened: boolean; error?: string }>;
}

declare global {
  interface Window {
    smartTailoringDesktop?: SmartTailoringDesktopBridge;
  }
}

export {};
