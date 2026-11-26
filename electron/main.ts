import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { createExpressApp } from '../src/server/app.ts';
import { createDatabase, type DbHolder } from '../src/server/db.ts';
import {
  createDatabaseBackup,
  formatBackupFilename,
  restoreDatabaseFromBackup,
  validateBackupFile,
} from '../src/server/backup.ts';

const APP_NAME = 'SmartTailoringSystem';
app.setName(APP_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId('com.smarttailoringsystem.pos');
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let localServer: http.Server | null = null;
let dbHolder: DbHolder | null = null;
let localOrigin = '';

function resolvePersistentDataDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || app.getPath('appData');
    return path.join(localAppData, APP_NAME, 'data');
  }
  return path.join(app.getPath('userData'), 'data');
}

function ensurePersistentSessionSecret(dataDir: string): string {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length >= 16) {
    return process.env.SESSION_SECRET.trim();
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const secretPath = path.join(dataDir, '.session-secret');
  try {
    if (fs.existsSync(secretPath)) {
      const existing = fs.readFileSync(secretPath, 'utf8').trim();
      if (existing.length >= 32) {
        return existing;
      }
    }
  } catch {
    // regenerate if unreadable
  }
  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretPath, generated, { encoding: 'utf8', mode: 0o600 });
  return generated;
}

function resolveAppIconPath(): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(app.getAppPath(), 'build', 'icon.ico'),
          path.join(process.resourcesPath || app.getAppPath(), 'build', 'icon.ico'),
          path.join(app.getAppPath(), 'build', 'icon.png'),
        ]
      : [
          path.join(app.getAppPath(), 'build', 'icon.png'),
          path.join(process.resourcesPath || app.getAppPath(), 'build', 'icon.png'),
        ];
  return candidates.find((p) => fs.existsSync(p));
}

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

async function startEmbeddedBackend(): Promise<string> {
  const dataDir = resolvePersistentDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'smarttailoring.db');
  process.env.SMARTTAILORING_DB_PATH = dbPath;
  process.env.SESSION_SECRET = ensurePersistentSessionSecret(dataDir);

  const db = await createDatabase(dbPath);
  dbHolder = { current: db };

  const expressApp = createExpressApp(dbHolder);
  const distDir = path.join(app.getAppPath(), 'dist');

  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    expressApp.use(express.static(distDir));
    expressApp.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    expressApp.get('*', (_req, res) => {
      res.status(500).send('SmartTailoringSystem frontend bundle (dist/) not found.');
    });
  }

  localServer = http.createServer(expressApp);
  await new Promise<void>((resolve, reject) => {
    localServer!.once('error', reject);
    localServer!.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = localServer.address() as { port: number };
  localOrigin = `http://127.0.0.1:${addr.port}`;
  return localOrigin;
}

function createApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Print Current View',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            mainWindow?.webContents.print({ silent: false, printBackground: true });
          },
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit SmartTailoringSystem' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow(startUrl: string): void {
  const preloadPath = path.join(__dirname, 'preload.cjs');
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#f8fafc',
    icon: resolveAppIconPath(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow?.setTitle(APP_NAME);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (localOrigin && targetUrl.startsWith(localOrigin)) {
      return;
    }
    event.preventDefault();
    if (isAllowedExternalUrl(targetUrl)) {
      void shell.openExternal(targetUrl);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(startUrl);
}

function registerIpcHandlers(): void {
  ipcMain.handle('desktop:get-app-info', async () => {
    return {
      name: APP_NAME,
      version: app.getVersion(),
      dbPath: dbHolder?.current.dbPath || path.join(resolvePersistentDataDir(), 'smarttailoring.db'),
      userDataPath: resolvePersistentDataDir(),
    };
  });

  ipcMain.handle('desktop:create-backup', async (_event, payload?: { businessId?: number }) => {
    if (!dbHolder) {
      return { error: 'Local database is not initialized.' };
    }
    const win = mainWindow ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const defaultDir = app.getPath('documents');
    const saveResult = await dialog.showSaveDialog(win as BrowserWindow, {
      title: 'Save SmartTailoringSystem Database Backup',
      defaultPath: path.join(defaultDir, formatBackupFilename()),
      filters: [{ name: 'SmartTailoringSystem SQLite Backup', extensions: ['db'] }],
    });
    if (saveResult.canceled || !saveResult.filePath) {
      return { cancelled: true };
    }

    try {
      const backupRes = await createDatabaseBackup(
        dbHolder.current,
        saveResult.filePath,
        payload?.businessId ? Number(payload.businessId) : undefined
      );
      return backupRes;
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to create database backup.' };
    }
  });

  ipcMain.handle('desktop:pick-and-validate-backup', async () => {
    const win = mainWindow ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const openResult = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Select SmartTailoringSystem Database Backup (.db)',
      defaultPath: app.getPath('documents'),
      properties: ['openFile'],
      filters: [{ name: 'SQLite Database Files', extensions: ['db', 'sqlite', 'sqlite3'] }],
    });
    if (openResult.canceled || openResult.filePaths.length === 0) {
      return { cancelled: true };
    }
    const filePath = openResult.filePaths[0];
    const validation = validateBackupFile(filePath);
    return {
      filePath,
      fileName: path.basename(filePath),
      ...validation,
    };
  });

  ipcMain.handle('desktop:restore-backup', async (_event, payload?: { filePath?: string }) => {
    if (!dbHolder) {
      return { error: 'Local database is not initialized.' };
    }
    const filePath = String(payload?.filePath || '').trim();
    if (!filePath || !fs.existsSync(filePath)) {
      return { error: 'Selected backup file could not be found.' };
    }
    try {
      return await restoreDatabaseFromBackup(dbHolder, filePath);
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to restore database.' };
    }
  });

  ipcMain.handle(
    'desktop:save-file',
    async (
      _event,
      payload?: {
        defaultPath?: string;
        data?: number[];
        filters?: Array<{ name: string; extensions: string[] }>;
      }
    ) => {
      if (!payload || !Array.isArray(payload.data)) {
        return { error: 'No file data provided.' };
      }
      const win = mainWindow ?? BrowserWindow.getFocusedWindow() ?? undefined;
      const safeName = path.basename(String(payload.defaultPath || 'export.pdf'));
      const saveResult = await dialog.showSaveDialog(win as BrowserWindow, {
        title: `Save ${safeName}`,
        defaultPath: path.join(app.getPath('documents'), safeName),
        filters: payload.filters || [{ name: 'All Files', extensions: ['*'] }],
      });
      if (saveResult.canceled || !saveResult.filePath) {
        return { cancelled: true };
      }
      fs.writeFileSync(saveResult.filePath, Buffer.from(payload.data));
      return { path: saveResult.filePath };
    }
  );

  ipcMain.handle('desktop:print', async () => {
    if (!mainWindow) return { printed: false };
    return new Promise<{ printed: boolean }>((resolve) => {
      mainWindow!.webContents.print({ silent: false, printBackground: true }, (success) => {
        resolve({ printed: success });
      });
    });
  });

  ipcMain.handle('desktop:open-external', async (_event, payload?: { url?: string }) => {
    const rawUrl = String(payload?.url || '').trim();
    if (!isAllowedExternalUrl(rawUrl)) {
      return { opened: false, error: 'Only valid HTTP or HTTPS URLs can be opened externally.' };
    }
    await shell.openExternal(rawUrl);
    return { opened: true };
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  try {
    registerIpcHandlers();
    createApplicationMenu();
    const devUrl = process.env.SMARTTAILORING_DEV_URL;
    if (devUrl && devUrl.startsWith('http://127.0.0.1:')) {
      localOrigin = devUrl;
      createMainWindow(devUrl);
    } else {
      const origin = await startEmbeddedBackend();
      createMainWindow(origin);
    }
  } catch (err) {
    dialog.showErrorBox(
      `${APP_NAME} Startup Error`,
      err instanceof Error ? err.message : 'Unable to start local POS database engine.'
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (localServer) {
    localServer.close();
    localServer = null;
  }
  if (dbHolder) {
    await dbHolder.current.close().catch(() => {});
    dbHolder = null;
  }
});
