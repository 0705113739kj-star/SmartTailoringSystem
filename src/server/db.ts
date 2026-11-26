import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CURRENT_SCHEMA_VERSION,
  type DbClient,
  type DbDialect,
  type DbHolder,
  normalizeSqliteParams,
  nowIso,
  runMigrations,
  todayDate,
  translateSqlForSqlite,
} from '../shared/schema.ts';

export {
  CURRENT_SCHEMA_VERSION,
  type DbClient,
  type DbDialect,
  type DbHolder,
  nowIso,
  runMigrations,
  todayDate,
};

export function getDefaultDbPath(): string {
  const override = String(process.env.SMARTTAILORING_DB_PATH || '').trim();
  if (override) {
    return override.startsWith('sqlite:') ? override.replace(/^sqlite:/, '') : override;
  }

  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'SmartTailoringSystem', 'data', 'smarttailoring.db');
  }

  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'SmartTailoringSystem',
      'data',
      'smarttailoring.db'
    );
  }

  return path.resolve(process.cwd(), 'data', 'smarttailoring.db');
}

function escapeSqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function createSqliteClient(sqliteDb: DatabaseSync, dbPath: string): DbClient {
  let closed = false;

  const client: DbClient = {
    dialect: 'sqlite',
    dbPath,
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const { sql: q, params: p } = translateSqlForSqlite(sql, params);
      const stmt = sqliteDb.prepare(q);
      const rows = stmt.all(...normalizeSqliteParams(p));
      return rows as unknown as T[];
    },
    async queryOne<T = Record<string, unknown>>(
      sql: string,
      params: unknown[] = []
    ): Promise<T | undefined> {
      const { sql: q, params: p } = translateSqlForSqlite(sql, params);
      const stmt = sqliteDb.prepare(q);
      const row = stmt.get(...normalizeSqliteParams(p));
      return (row as unknown as T) || undefined;
    },
    async execute(
      sql: string,
      params: unknown[] = []
    ): Promise<{ rowCount: number; lastInsertId?: number }> {
      const { sql: q, params: p } = translateSqlForSqlite(sql, params);
      const stmt = sqliteDb.prepare(q);
      const res = stmt.run(...normalizeSqliteParams(p));
      return {
        rowCount: Number(res.changes || 0),
        lastInsertId:
          res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : undefined,
      };
    },
    async insert(sql: string, params: unknown[] = []): Promise<number> {
      const res = await client.execute(sql, params);
      return Number(res.lastInsertId || 0);
    },
    async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      sqliteDb.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(client);
        sqliteDb.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          sqliteDb.exec('ROLLBACK');
        } catch {
          // ignore rollback error
        }
        throw err;
      }
    },
    async checkpoint(): Promise<void> {
      if (dbPath !== ':memory:') {
        sqliteDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      }
    },
    async backupTo(destPath: string): Promise<void> {
      const resolvedDest = path.resolve(destPath);
      fs.mkdirSync(path.dirname(resolvedDest), { recursive: true });
      const tempDest = `${resolvedDest}.tmp-${Date.now()}`;
      if (fs.existsSync(tempDest)) {
        fs.unlinkSync(tempDest);
      }
      if (dbPath !== ':memory:') {
        sqliteDb.exec('PRAGMA wal_checkpoint(PASSIVE);');
      }
      try {
        sqliteDb.exec(`VACUUM INTO ${escapeSqlStringLiteral(tempDest)}`);
        fs.renameSync(tempDest, resolvedDest);
      } catch (err) {
        if (fs.existsSync(tempDest)) {
          try {
            fs.unlinkSync(tempDest);
          } catch {
            // ignore cleanup failure
          }
        }
        throw err;
      }
    },
    async getSchemaVersion(): Promise<number> {
      const row = sqliteDb.prepare('PRAGMA user_version').get() as
        | { user_version?: number }
        | undefined;
      return Number(row?.user_version || 0);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        if (dbPath !== ':memory:') {
          sqliteDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        }
      } catch {
        // ignore checkpoint error on close
      }
      sqliteDb.close();
    },
  };
  return client;
}

export async function createDatabase(dbPathInput?: string): Promise<DbClient> {
  const rawPath = dbPathInput
    ? dbPathInput.startsWith('sqlite:')
      ? dbPathInput.replace(/^sqlite:/, '')
      : dbPathInput
    : getDefaultDbPath();

  const dbPath = rawPath === ':memory:' ? ':memory:' : path.resolve(rawPath);

  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec('PRAGMA busy_timeout = 5000;');
  if (dbPath !== ':memory:') {
    sqlite.exec('PRAGMA journal_mode = WAL;');
    sqlite.exec('PRAGMA synchronous = NORMAL;');
  }

  const db = createSqliteClient(sqlite, dbPath);
  await runMigrations(db);
  return db;
}
