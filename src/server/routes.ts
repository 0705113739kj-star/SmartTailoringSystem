import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Response } from 'express';
import { createProxiedDb, registerCorePosRoutes } from '../shared/coreRoutes.ts';
import type { AppRouter } from '../shared/router.ts';
import type { AuthenticatedRequest } from './auth.ts';
import {
  createDatabaseBackup,
  formatBackupFilename,
  getPreferences,
  restoreDatabaseFromBackup,
  validateBackupFile,
} from './backup.ts';
import type { DbClient, DbHolder } from './db.ts';

export function createApiRouter(dbOrHolder: DbClient | DbHolder) {
  const holder: DbHolder =
    'current' in dbOrHolder ? dbOrHolder : { current: dbOrHolder };
  const db = createProxiedDb(holder);

  const router = express.Router();
  registerCorePosRoutes(router as unknown as AppRouter, holder);

  // =========================================================================
  // LOCAL SQLITE DATABASE BACKUP, VALIDATION & RESTORE (Node / Electron)
  // =========================================================================

  router.get('/backup/status', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const bid = req.auth!.businessId;
      const prefs = await getPreferences(db, bid);
      const schemaVersion = await db.getSchemaVersion();
      const dbPath = db.dbPath;
      let fileSizeBytes = 0;
      if (dbPath && dbPath !== ':memory:' && fs.existsSync(dbPath)) {
        fileSizeBytes = fs.statSync(dbPath).size;
      }

      const [custCnt, ordCnt, payCnt, matCnt] = await Promise.all([
        db.queryOne<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM customers WHERE business_id = $1`, [bid]),
        db.queryOne<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM tailoring_orders WHERE business_id = $1`, [bid]),
        db.queryOne<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM payments WHERE business_id = $1`, [bid]),
        db.queryOne<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM materials WHERE business_id = $1`, [bid]),
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
        dbPath,
        schemaVersion,
        fileSizeBytes,
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
      console.error('Backup status error:', err);
      return res.status(500).json({ error: 'Failed to inspect local database status.' });
    }
  });

  router.get('/backup/export', async (req: AuthenticatedRequest, res: Response) => {
    const filename = formatBackupFilename();
    const tempFile = path.join(
      os.tmpdir(),
      `sts-export-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    try {
      await createDatabaseBackup(db, tempFile, req.auth!.businessId);
      const buffer = fs.readFileSync(tempFile);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Backup-Filename', filename);
      return res.send(buffer);
    } catch (err) {
      console.error('Backup export error:', err);
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to create database backup.',
      });
    } finally {
      if (fs.existsSync(tempFile)) {
        try {
          fs.unlinkSync(tempFile);
        } catch {
          // ignore cleanup failure
        }
      }
    }
  });

  router.post(
    '/backup/validate',
    express.raw({ type: 'application/octet-stream', limit: '250mb' }),
    async (req: AuthenticatedRequest, res: Response) => {
      const tempFile = path.join(
        os.tmpdir(),
        `sts-validate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      );
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ valid: false, error: 'No backup file payload received.' });
        }
        fs.writeFileSync(tempFile, req.body);
        const validation = validateBackupFile(tempFile);
        if (!validation.valid) {
          return res.status(400).json(validation);
        }
        return res.json(validation);
      } catch (err) {
        return res.status(400).json({
          valid: false,
          error: err instanceof Error ? err.message : 'Backup validation failed.',
        });
      } finally {
        if (fs.existsSync(tempFile)) {
          try {
            fs.unlinkSync(tempFile);
          } catch {
            // ignore cleanup failure
          }
        }
      }
    }
  );

  router.post(
    '/backup/restore',
    express.raw({ type: 'application/octet-stream', limit: '250mb' }),
    async (req: AuthenticatedRequest, res: Response) => {
      const tempFile = path.join(
        os.tmpdir(),
        `sts-restore-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      );
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'No backup file payload received.' });
        }
        fs.writeFileSync(tempFile, req.body);
        const result = await restoreDatabaseFromBackup(holder, tempFile);
        return res.json({
          ...result,
          message:
            'Database restored successfully from backup. All local records have been reloaded.',
        });
      } catch (err) {
        console.error('Backup restore error:', err);
        return res.status(400).json({
          error: err instanceof Error ? err.message : 'Failed to restore database backup.',
        });
      } finally {
        if (fs.existsSync(tempFile)) {
          try {
            fs.unlinkSync(tempFile);
          } catch {
            // ignore cleanup failure
          }
        }
      }
    }
  );

  return router;
}
