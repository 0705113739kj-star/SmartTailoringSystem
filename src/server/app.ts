import cookieParser from 'cookie-parser';
import express from 'express';
import { type DbClient, type DbHolder } from './db.ts';
import { createApiRouter } from './routes.ts';

export function createExpressApp(dbOrHolder: DbClient | DbHolder) {
  const holder: DbHolder =
    'current' in dbOrHolder ? dbOrHolder : { current: dbOrHolder };

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '5mb' }));
  app.use(cookieParser());

  app.get('/api/health', async (_req, res) => {
    const schemaVersion = await holder.current.getSchemaVersion().catch(() => 0);
    res.json({
      status: 'ok',
      app: 'SmartTailoringSystem',
      dialect: holder.current.dialect,
      schemaVersion,
    });
  });

  app.use('/api', createApiRouter(holder));

  return app;
}
