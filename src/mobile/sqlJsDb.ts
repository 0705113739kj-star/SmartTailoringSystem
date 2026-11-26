import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import {
  type BackupValidationResult,
  REQUIRED_TABLES,
  SQLITE_HEADER,
} from '../shared/backupShared.ts';
import {
  type DbClient,
  type DbHolder,
  normalizeSqliteParams,
  runMigrations,
  translateSqlForSqlite,
} from '../shared/schema.ts';

export interface BinaryPersistenceAdapter {
  getDisplayDbPath(): string;
  loadDatabaseBytes(): Promise<Uint8Array | null>;
  saveDatabaseBytes(bytes: Uint8Array): Promise<void>;
  saveSafetyBackup(filename: string, bytes: Uint8Array): Promise<string>;
  loadOrCreateSessionSecret(): Promise<string>;
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

export function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    parts.push(String.fromCharCode.apply(null, Array.from(slice)));
  }
  return btoa(parts.join(''));
}

export function base64ToUint8(b64: string): Uint8Array {
  const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      if (typeof window === 'undefined' && typeof process !== 'undefined') {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const wasmPath = path.resolve(
          process.cwd(),
          'node_modules',
          'sql.js',
          'dist',
          'sql-wasm.wasm'
        );
        const wasmBinary = fs.readFileSync(wasmPath);
        return initSqlJs({ wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) });
      }
      return initSqlJs({
        locateFile: (file: string) => `/wasm/${file}`,
      });
    })();
  }
  return sqlJsPromise;
}

export function createInMemoryPersistenceAdapter(displayPath = ':memory:'): BinaryPersistenceAdapter {
  let savedBytes: Uint8Array | null = null;
  let secret = '';
  return {
    getDisplayDbPath: () => displayPath,
    loadDatabaseBytes: async () => savedBytes,
    saveDatabaseBytes: async (bytes) => {
      savedBytes = new Uint8Array(bytes);
    },
    saveSafetyBackup: async (filename) => `memory://backups/${filename}`,
    loadOrCreateSessionSecret: async () => {
      if (!secret) {
        const arr = new Uint8Array(32);
        globalThis.crypto.getRandomValues(arr);
        secret = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
      }
      return secret;
    },
  };
}

export function createCapacitorPersistenceAdapter(): BinaryPersistenceAdapter {
  const DB_FILE = 'smarttailoring.db';
  const SECRET_FILE = '.session-secret';

  return {
    getDisplayDbPath: () => 'Android App Private Storage (smarttailoring.db)',
    loadDatabaseBytes: async () => {
      const { Directory, Filesystem } = await import('@capacitor/filesystem');
      try {
        const res = await Filesystem.readFile({
          path: DB_FILE,
          directory: Directory.Data,
        });
        if (typeof res.data === 'string' && res.data.length > 0) {
          return base64ToUint8(res.data);
        }
      } catch {
        // First launch — file does not exist yet
      }
      return null;
    },
    saveDatabaseBytes: async (bytes: Uint8Array) => {
      const { Directory, Filesystem } = await import('@capacitor/filesystem');
      await Filesystem.writeFile({
        path: DB_FILE,
        data: uint8ToBase64(bytes),
        directory: Directory.Data,
        recursive: true,
      });
    },
    saveSafetyBackup: async (filename: string, bytes: Uint8Array) => {
      const { Directory, Filesystem } = await import('@capacitor/filesystem');
      const relPath = `backups/${filename}`;
      await Filesystem.writeFile({
        path: relPath,
        data: uint8ToBase64(bytes),
        directory: Directory.Data,
        recursive: true,
      });
      return relPath;
    },
    loadOrCreateSessionSecret: async () => {
      const { Directory, Encoding, Filesystem } = await import('@capacitor/filesystem');
      try {
        const res = await Filesystem.readFile({
          path: SECRET_FILE,
          directory: Directory.Data,
          encoding: Encoding.UTF8,
        });
        if (typeof res.data === 'string' && res.data.trim().length >= 32) {
          return res.data.trim();
        }
      } catch {
        // Generate once on first run
      }
      const arr = new Uint8Array(48);
      globalThis.crypto.getRandomValues(arr);
      const generated = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
      try {
        await Filesystem.writeFile({
          path: SECRET_FILE,
          data: generated,
          directory: Directory.Data,
          encoding: Encoding.UTF8,
          recursive: true,
        });
      } catch {
        // ignore if unable to persist secret
      }
      return generated;
    },
  };
}

function wrapSqlJsDatabase(
  sqliteDb: Database,
  persistence: BinaryPersistenceAdapter
): DbClient & { flush: () => Promise<void> } {
  let closed = false;
  let inTransaction = false;
  let persistChain: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (closed) return Promise.resolve();
    const bytes = sqliteDb.export();
    persistChain = persistChain.then(() => persistence.saveDatabaseBytes(bytes));
    return persistChain;
  };

  const client: DbClient & { flush: () => Promise<void> } = {
    dialect: 'sqlite',
    dbPath: persistence.getDisplayDbPath(),
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const { sql: q, params: p } = translateSqlForSqlite(sql, params);
      const stmt = sqliteDb.prepare(q);
      try {
        stmt.bind(normalizeSqliteParams(p));
        const rows: T[] = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject() as unknown as T);
        }
        return rows;
      } finally {
        stmt.free();
      }
    },
    async queryOne<T = Record<string, unknown>>(
      sql: string,
      params: unknown[] = []
    ): Promise<T | undefined> {
      const rows = await client.query<T>(sql, params);
      return rows[0];
    },
    async execute(
      sql: string,
      params: unknown[] = []
    ): Promise<{ rowCount: number; lastInsertId?: number }> {
      const { sql: q, params: p } = translateSqlForSqlite(sql, params);
      sqliteDb.run(q, normalizeSqliteParams(p));
      const changes = sqliteDb.getRowsModified();
      const idRes = sqliteDb.exec('SELECT last_insert_rowid() AS id');
      const lastInsertId =
        idRes.length > 0 && idRes[0].values.length > 0
          ? Number(idRes[0].values[0][0] || 0)
          : undefined;
      if (!inTransaction) {
        await flush();
      }
      return { rowCount: Number(changes || 0), lastInsertId };
    },
    async insert(sql: string, params: unknown[] = []): Promise<number> {
      const res = await client.execute(sql, params);
      return Number(res.lastInsertId || 0);
    },
    async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      if (inTransaction) {
        return fn(client);
      }
      inTransaction = true;
      sqliteDb.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(client);
        sqliteDb.exec('COMMIT');
        inTransaction = false;
        await flush();
        return result;
      } catch (err) {
        try {
          sqliteDb.exec('ROLLBACK');
        } catch {
          // ignore rollback error
        }
        inTransaction = false;
        throw err;
      }
    },
    async checkpoint(): Promise<void> {
      await flush();
    },
    async backupTo(): Promise<void> {
      await flush();
    },
    async exportBytes(): Promise<Uint8Array> {
      return sqliteDb.export();
    },
    async getSchemaVersion(): Promise<number> {
      const res = sqliteDb.exec('PRAGMA user_version');
      if (res.length > 0 && res[0].values.length > 0) {
        return Number(res[0].values[0][0] || 0);
      }
      return 0;
    },
    async close(): Promise<void> {
      if (closed) return;
      await persistChain.catch(() => undefined);
      closed = true;
      sqliteDb.close();
    },
    flush,
  };

  return client;
}

export async function createSqlJsDatabase(
  persistence: BinaryPersistenceAdapter,
  initialBytes?: Uint8Array | null
): Promise<DbClient & { flush: () => Promise<void> }> {
  const SQL = await getSqlJs();
  const existingBytes = initialBytes !== undefined ? initialBytes : await persistence.loadDatabaseBytes();
  const sqliteDb = existingBytes && existingBytes.length > 0
    ? new SQL.Database(existingBytes)
    : new SQL.Database();

  sqliteDb.exec('PRAGMA foreign_keys = ON;');
  const client = wrapSqlJsDatabase(sqliteDb, persistence);
  await runMigrations(client);
  await client.flush();
  return client;
}

export async function validateSqlJsBackupBytes(bytes: Uint8Array): Promise<BackupValidationResult> {
  try {
    if (!bytes || bytes.length < 4096) {
      return {
        valid: false,
        error: 'Selected file is too small to be a valid SmartTailoringSystem database backup.',
      };
    }

    const headerStr = Array.from(bytes.slice(0, 16), (b) => String.fromCharCode(b)).join('');
    if (headerStr !== SQLITE_HEADER) {
      return {
        valid: false,
        error: 'Selected file is not a valid SQLite database (.db) file.',
      };
    }

    const SQL = await getSqlJs();
    const testDb = new SQL.Database(bytes);
    try {
      const integrityRes = testDb.exec('PRAGMA integrity_check');
      const integrityVal = integrityRes[0]?.values?.[0]?.[0];
      if (integrityVal !== 'ok') {
        return {
          valid: false,
          error: 'Database integrity check failed. The backup file may be corrupted.',
        };
      }

      const tablesRes = testDb.exec(`SELECT name FROM sqlite_master WHERE type = 'table'`);
      const existingTables = new Set<string>(
        (tablesRes[0]?.values || []).map((row) => String(row[0] || ''))
      );
      const missingTables = REQUIRED_TABLES.filter((t) => !existingTables.has(t));
      if (missingTables.length > 0) {
        return {
          valid: false,
          error: `Backup file is missing required SmartTailoringSystem tables (${missingTables.join(', ')}).`,
        };
      }

      const verRes = testDb.exec('PRAGMA user_version');
      const countOf = (table: string) => {
        const res = testDb.exec(`SELECT COUNT(*) AS cnt FROM ${table}`);
        return Number(res[0]?.values?.[0]?.[0] || 0);
      };

      return {
        valid: true,
        summary: {
          schemaVersion: Number(verRes[0]?.values?.[0]?.[0] || 0),
          fileSizeBytes: bytes.length,
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

export async function restoreSqlJsFromBytes(
  holder: DbHolder,
  persistence: BinaryPersistenceAdapter,
  backupBytes: Uint8Array,
  formatSafetyFilename: () => string
): Promise<{
  restored: boolean;
  safetyBackupPath: string;
  summary: NonNullable<BackupValidationResult['summary']>;
}> {
  const validation = await validateSqlJsBackupBytes(backupBytes);
  if (!validation.valid || !validation.summary) {
    throw new Error(validation.error || 'Backup file validation failed.');
  }

  const prevBytes = holder.current.exportBytes
    ? await holder.current.exportBytes()
    : new Uint8Array(0);
  const safetyBackupPath = prevBytes.length > 0
    ? await persistence.saveSafetyBackup(formatSafetyFilename(), prevBytes)
    : '';

  const oldDb = holder.current;
  try {
    const nextDb = await createSqlJsDatabase(persistence, new Uint8Array(backupBytes));
    holder.current = nextDb;
    await oldDb.close();
    return {
      restored: true,
      safetyBackupPath,
      summary: validation.summary,
    };
  } catch (err) {
    if (prevBytes.length > 0 && holder.current === oldDb) {
      await persistence.saveDatabaseBytes(prevBytes);
    }
    throw err;
  }
}
