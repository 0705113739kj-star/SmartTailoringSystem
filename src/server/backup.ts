import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type BackupSummary,
  type BackupValidationResult,
  formatBackupFilename,
  formatSafetySnapshotFilename,
  getPreferences,
  REQUIRED_TABLES,
  setPreference,
  SQLITE_HEADER,
} from '../shared/backupShared.ts';
import {
  createDatabase,
  type DbClient,
  type DbHolder,
  nowIso,
} from './db.ts';

export {
  type BackupSummary,
  type BackupValidationResult,
  formatBackupFilename,
  formatSafetySnapshotFilename,
  getPreferences,
  setPreference,
};

export function validateBackupFile(filePath: string): BackupValidationResult {
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      return { valid: false, error: 'Selected backup file does not exist.' };
    }

    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size < 4096) {
      return { valid: false, error: 'Selected file is too small to be a valid SmartTailoringSystem database backup.' };
    }

    const fd = fs.openSync(resolved, 'r');
    try {
      const headerBuf = Buffer.alloc(16);
      const bytesRead = fs.readSync(fd, headerBuf, 0, 16, 0);
      if (bytesRead < 16 || headerBuf.toString('utf8') !== SQLITE_HEADER) {
        return { valid: false, error: 'Selected file is not a valid SQLite database (.db) file.' };
      }
    } finally {
      fs.closeSync(fd);
    }

    const testDb = new DatabaseSync(resolved, { readOnly: true });
    try {
      const integrityRow = testDb.prepare('PRAGMA integrity_check').get() as
        | { integrity_check?: string }
        | undefined;
      if (integrityRow?.integrity_check !== 'ok') {
        return { valid: false, error: 'Database integrity check failed. The backup file may be corrupted.' };
      }

      const tableRows = testDb
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string }>;
      const existingTables = new Set(tableRows.map((r) => r.name));
      const missingTables = REQUIRED_TABLES.filter((t) => !existingTables.has(t));
      if (missingTables.length > 0) {
        return {
          valid: false,
          error: `Backup file is missing required SmartTailoringSystem tables (${missingTables.join(', ')}).`,
        };
      }

      const verRow = testDb.prepare('PRAGMA user_version').get() as
        | { user_version?: number }
        | undefined;
      const countOf = (table: string) => {
        const r = testDb.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt?: number };
        return Number(r?.cnt || 0);
      };

      return {
        valid: true,
        summary: {
          schemaVersion: Number(verRow?.user_version || 0),
          fileSizeBytes: stat.size,
          businesses: countOf('businesses'),
          customers: countOf('customers'),
          orders: countOf('tailoring_orders'),
          payments: countOf('payments'),
          materials: countOf('materials'),
        },
      };
    } finally {
      testDb.close();
    }
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Unable to inspect backup file.',
    };
  }
}

export async function createDatabaseBackup(
  db: DbClient,
  destPath: string,
  businessId?: number
): Promise<{ path: string; sizeBytes: number; backedUpAt: string }> {
  const resolvedDest = path.resolve(destPath);
  if (db.dbPath !== ':memory:' && resolvedDest === path.resolve(db.dbPath)) {
    throw new Error('Backup destination cannot overwrite the active live database file.');
  }

  await db.backupTo(resolvedDest);
  const stat = fs.statSync(resolvedDest);
  const backedUpAt = nowIso();

  if (businessId) {
    await setPreference(db, businessId, 'last_backup_at', backedUpAt);
    await setPreference(db, businessId, 'last_backup_path', resolvedDest);
  }

  return {
    path: resolvedDest,
    sizeBytes: stat.size,
    backedUpAt,
  };
}

export async function restoreDatabaseFromBackup(
  dbHolder: DbHolder,
  backupFilePath: string
): Promise<{
  restored: boolean;
  safetyBackupPath: string;
  summary: BackupSummary;
}> {
  const resolvedBackup = path.resolve(backupFilePath);
  const validation = validateBackupFile(resolvedBackup);
  if (!validation.valid || !validation.summary) {
    throw new Error(validation.error || 'Backup file validation failed.');
  }

  const livePath = dbHolder.current.dbPath;
  if (!livePath || livePath === ':memory:') {
    throw new Error('Cannot restore a database file onto an in-memory test database.');
  }
  if (resolvedBackup === path.resolve(livePath)) {
    throw new Error('Selected file is already the active database.');
  }

  const safetyDir = path.join(path.dirname(livePath), 'backups');
  fs.mkdirSync(safetyDir, { recursive: true });
  const safetyBackupPath = path.join(safetyDir, formatSafetySnapshotFilename());

  await dbHolder.current.backupTo(safetyBackupPath);

  await dbHolder.current.close();
  for (const sidecar of [`${livePath}-wal`, `${livePath}-shm`]) {
    if (fs.existsSync(sidecar)) {
      fs.unlinkSync(sidecar);
    }
  }

  const stagedPath = `${livePath}.restore-tmp-${Date.now()}`;
  try {
    fs.copyFileSync(resolvedBackup, stagedPath);
    fs.renameSync(stagedPath, livePath);

    const nextDb = await createDatabase(livePath);
    dbHolder.current = nextDb;

    return {
      restored: true,
      safetyBackupPath,
      summary: validation.summary,
    };
  } catch (err) {
    if (fs.existsSync(stagedPath)) {
      try {
        fs.unlinkSync(stagedPath);
      } catch {
        // ignore cleanup error
      }
    }
    try {
      if (fs.existsSync(safetyBackupPath)) {
        fs.copyFileSync(safetyBackupPath, livePath);
      }
      dbHolder.current = await createDatabase(livePath);
    } catch {
      // ignore rollback secondary failure
    }
    throw err;
  }
}
