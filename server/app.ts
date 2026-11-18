import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { seedInitialDatabase } from './fixtures.ts';
import { recoverStaleRuns } from './pipeline.ts';
import { createApiRouter } from './routes.ts';

let initPromise: Promise<void> | null = null;

export async function ensureBackendInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await seedInitialDatabase();
      recoverStaleRuns();
    })();
  }
  await initPromise;
}

export async function createApiApp(): Promise<Express> {
  await ensureBackendInitialized();
  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/v1', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  }, createApiRouter());
  return app;
}
