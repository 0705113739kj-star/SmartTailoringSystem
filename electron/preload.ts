import { contextBridge, ipcRenderer } from 'electron';

export interface SmartTailoringDesktopApi {
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
    summary?: unknown;
  }>;
  restoreBackup: (filePath: string) => Promise<{
    restored?: boolean;
    safetyBackupPath?: string;
    summary?: unknown;
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

const desktopBridge: SmartTailoringDesktopApi = {
  isElectron: true,
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke('desktop:get-app-info'),
  createBackup: (businessId: number) => ipcRenderer.invoke('desktop:create-backup', { businessId }),
  pickAndValidateBackup: () => ipcRenderer.invoke('desktop:pick-and-validate-backup'),
  restoreBackup: (filePath: string) => ipcRenderer.invoke('desktop:restore-backup', { filePath }),
  saveFile: (options) =>
    ipcRenderer.invoke('desktop:save-file', {
      defaultPath: options.defaultPath,
      data: Array.from(options.data),
      filters: options.filters,
    }),
  nativePrint: () => ipcRenderer.invoke('desktop:print'),
  openExternal: (url: string) => ipcRenderer.invoke('desktop:open-external', { url }),
};

contextBridge.exposeInMainWorld('smartTailoringDesktop', desktopBridge);
