import {
  formatBackupFilename,
  formatSafetySnapshotFilename,
  getPreferences,
  setPreference,
} from '../shared/backupShared.ts';
import { registerCorePosRoutes } from '../shared/coreRoutes.ts';
import { setRuntimeSessionSecret } from '../shared/crypto.ts';
import type { AppHandler, AppRequest, AppResponse, AppRouter } from '../shared/router.ts';
import { type DbHolder, nowIso } from '../shared/schema.ts';
import {
  type BinaryPersistenceAdapter,
  createCapacitorPersistenceAdapter,
  createSqlJsDatabase,
  restoreSqlJsFromBytes,
  validateSqlJsBackupBytes,
} from './sqlJsDb.ts';

interface RouteEntry {
  method: string;
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handlers: AppHandler[];
}

function compileRoutePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const parts = pattern
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
  const regex = new RegExp(`^/${parts.join('/')}$`);
  return { regex, paramNames };
}

class MemoryAppRouter implements AppRouter {
  private middlewares: AppHandler[] = [];
  private routes: RouteEntry[] = [];

  use(handler: AppHandler): void {
    this.middlewares.push(handler);
  }

  private addRoute(method: string, pattern: string, handlers: AppHandler[]): void {
    const { regex, paramNames } = compileRoutePattern(pattern);
    this.routes.push({
      method,
      pattern,
      regex,
      paramNames,
      handlers: [...this.middlewares, ...handlers],
    });
  }

  get(pattern: string, ...handlers: AppHandler[]): void {
    this.addRoute('GET', pattern, handlers);
  }
  post(pattern: string, ...handlers: AppHandler[]): void {
    this.addRoute('POST', pattern, handlers);
  }
  put(pattern: string, ...handlers: AppHandler[]): void {
    this.addRoute('PUT', pattern, handlers);
  }
  patch(pattern: string, ...handlers: AppHandler[]): void {
    this.addRoute('PATCH', pattern, handlers);
  }
  delete(pattern: string, ...handlers: AppHandler[]): void {
    this.addRoute('DELETE', pattern, handlers);
  }

  async dispatch(input: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: unknown;
  }> {
    const method = input.method.toUpperCase();
    const parsedUrl = new URL(input.url, 'http://localhost');
    let pathname = parsedUrl.pathname;
    if (pathname.startsWith('/api')) {
      pathname = pathname.slice(4) || '/';
    }

    const query: Record<string, string> = {};
    parsedUrl.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    const normalizedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers || {})) {
      normalizedHeaders[k.toLowerCase()] = v;
    }

    const matched = this.routes.find(
      (r) => r.method === method && r.regex.test(pathname)
    );
    if (!matched) {
      return {
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: { error: `Route not found: ${method} ${pathname}` },
      };
    }

    const regexMatch = pathname.match(matched.regex)!;
    const params: Record<string, string> = {};
    matched.paramNames.forEach((name, idx) => {
      params[name] = decodeURIComponent(regexMatch[idx + 1] || '');
    });

    const req: AppRequest = {
      method,
      path: pathname,
      params,
      query,
      headers: normalizedHeaders,
      cookies: {},
      body: input.body,
      secure: false,
    };

    let statusCode = 200;
    const outHeaders: Record<string, string> = {};
    let sentBody: unknown = undefined;
    let isSent = false;

    const res: AppResponse = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(body: unknown) {
        outHeaders['content-type'] = 'application/json';
        sentBody = body;
        isSent = true;
        return res;
      },
      send(body: unknown) {
        sentBody = body;
        isSent = true;
        return res;
      },
      setHeader(name: string, value: string) {
        outHeaders[name.toLowerCase()] = value;
        return res;
      },
      cookie() {
        return res;
      },
      clearCookie() {
        return res;
      },
    };

    const chain: AppHandler[] = matched.handlers;
    let index = 0;
    const runNext = async (err?: unknown): Promise<void> => {
      if (err) throw err;
      if (isSent || index >= chain.length) return;
      const fn = chain[index++];
      let nextCalled = false;
      await fn(req, res, async (nextErr?: unknown) => {
        nextCalled = true;
        await runNext(nextErr);
      });
      if (!isSent && !nextCalled && index < chain.length && fn.length < 3) {
        await runNext();
      }
    };

    await runNext();
    return {
      status: statusCode,
      headers: outHeaders,
      body: sentBody,
    };
  }
}

export interface MobileBackendInstance {
  holder: DbHolder;
  router: MemoryAppRouter;
  dispatch: MemoryAppRouter['dispatch'];
  close: () => Promise<void>;
}

export async function createMobileBackend(
  persistence: BinaryPersistenceAdapter = createCapacitorPersistenceAdapter()
): Promise<MobileBackendInstance> {
  const secret = await persistence.loadOrCreateSessionSecret();
  setRuntimeSessionSecret(secret);

  const db = await createSqlJsDatabase(persistence);
  const holder: DbHolder = { current: db };
  const router = new MemoryAppRouter();

  router.get('/health', async (_req, res) => {
    const schemaVersion = await holder.current.getSchemaVersion().catch(() => 0);
    return res.json({
      status: 'ok',
      app: 'SmartTailoringSystem',
      platform: 'android',
      dialect: 'sqlite',
      schemaVersion,
    });
  });

  registerCorePosRoutes(router, holder);

  router.get('/backup/status', async (req, res) => {
    try {
      const bid = req.auth!.businessId;
      const currentDb = holder.current;
      const prefs = await getPreferences(currentDb, bid);
      const schemaVersion = await currentDb.getSchemaVersion();
      const dbBytes = currentDb.exportBytes ? await currentDb.exportBytes() : new Uint8Array(0);

      const [custCnt, ordCnt, payCnt, matCnt] = await Promise.all([
        currentDb.queryOne<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM customers WHERE business_id = $1`, [bid]),
        currentDb.queryOne<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM tailoring_orders WHERE business_id = $1`, [bid]),
        currentDb.queryOne<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM payments WHERE business_id = $1`, [bid]),
        currentDb.queryOne<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM materials WHERE business_id = $1`, [bid]),
      ]);

      const reminderDays = Number(prefs.backup_reminder_days ?? 7);
      const lastBackupAt = prefs.last_backup_at || '';
      let reminderDue = false;
      if (reminderDays > 0) {
        if (!lastBackupAt) {
          reminderDue = Number(ordCnt?.cnt || 0) > 0 || Number(custCnt?.cnt || 0) > 0;
        } else {
          const elapsedDays =
            (Date.now() - new Date(lastBackupAt).getTime()) / (1000 * 60 * 60 * 24);
          reminderDue = elapsedDays >= reminderDays;
        }
      }

      return res.json({
        dbPath: currentDb.dbPath,
        schemaVersion,
        fileSizeBytes: dbBytes.length,
        suggestedFilename: formatBackupFilename(),
        lastBackupAt,
        lastBackupPath: prefs.last_backup_path || '',
        reminderDays,
        reminderDue,
        counts: {
          customers: Number(custCnt?.cnt || 0),
          orders: Number(ordCnt?.cnt || 0),
          payments: Number(payCnt?.cnt || 0),
          materials: Number(matCnt?.cnt || 0),
        },
      });
    } catch (err) {
      console.error('Mobile backup status error:', err);
      return res.status(500).json({ error: 'Failed to inspect local database status.' });
    }
  });

  router.get('/backup/export', async (req, res) => {
    try {
      const currentDb = holder.current;
      const filename = formatBackupFilename();
      const bytes = currentDb.exportBytes ? await currentDb.exportBytes() : new Uint8Array(0);
      await setPreference(currentDb, req.auth!.businessId, 'last_backup_at', nowIso());
      await setPreference(currentDb, req.auth!.businessId, 'last_backup_path', filename);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Backup-Filename', filename);
      return res.send(bytes);
    } catch (err) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to create database backup.',
      });
    }
  });

  router.post('/backup/validate', async (req, res) => {
    try {
      const payload = req.body instanceof Uint8Array ? req.body : new Uint8Array(0);
      if (payload.length === 0) {
        return res.status(400).json({ valid: false, error: 'No backup file payload received.' });
      }
      const validation = await validateSqlJsBackupBytes(payload);
      if (!validation.valid) {
        return res.status(400).json(validation);
      }
      return res.json(validation);
    } catch (err) {
      return res.status(400).json({
        valid: false,
        error: err instanceof Error ? err.message : 'Backup validation failed.',
      });
    }
  });

  router.post('/backup/restore', async (req, res) => {
    try {
      const payload = req.body instanceof Uint8Array ? req.body : new Uint8Array(0);
      if (payload.length === 0) {
        return res.status(400).json({ error: 'No backup file payload received.' });
      }
      const result = await restoreSqlJsFromBytes(
        holder,
        persistence,
        payload,
        formatSafetySnapshotFilename
      );
      return res.json({
        ...result,
        message: 'Database restored successfully from backup. All local records have been reloaded.',
      });
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to restore database backup.',
      });
    }
  });

  return {
    holder,
    router,
    dispatch: (input) => router.dispatch(input),
    close: () => holder.current.close(),
  };
}

let singletonPromise: Promise<MobileBackendInstance> | null = null;

export function getMobileBackend(): Promise<MobileBackendInstance> {
  if (!singletonPromise) {
    singletonPromise = createMobileBackend();
  }
  return singletonPromise;
}
