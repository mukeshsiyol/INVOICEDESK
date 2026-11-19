import cookieParser from 'cookie-parser';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { ensureSchema, isoNow } from './db.ts';
import { seedInitialDatabase } from './fixtures.ts';
import { recoverStaleRuns } from './pipeline.ts';
import { createApiRouter } from './routes.ts';

let initPromise: Promise<void> | null = null;
let appPromise: Promise<Express> | null = null;

export async function ensureBackendInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await ensureSchema();
      await seedInitialDatabase();
      await recoverStaleRuns();
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

export async function createApiApp(): Promise<Express> {
  if (!appPromise) {
    appPromise = (async () => {
      await ensureBackendInitialized();
      const app = express();
      app.set('trust proxy', 1);
      app.use(cookieParser());
      app.use(express.json({ limit: '2mb' }));
      app.use(
        '/api/v1',
        (_req, res, next) => {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
          next();
        },
        createApiRouter()
      );

      // Structured JSON 404 for unknown API endpoints
      app.use('/api', (req, res) => {
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: `API endpoint ${req.method} ${req.originalUrl} not found.`,
            request_id: req.requestId ?? 'req_not_found',
            details: {},
          },
        });
      });

      // Global Express error handler (catches invalid JSON bodies & forwarded async route errors)
      app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
          return;
        }
        if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
          res.status(400).json({
            error: {
              code: 'INVALID_JSON',
              message: 'Malformed JSON request body.',
              request_id: req.requestId ?? 'req_bad_json',
              details: {},
            },
          });
          return;
        }
        if (err?.type === 'entity.too.large') {
          res.status(413).json({
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: 'Request payload exceeds maximum allowed size.',
              request_id: req.requestId ?? 'req_too_large',
              details: {},
            },
          });
          return;
        }
        console.error(`[API Error ${req.method} ${req.originalUrl}]:`, err);
        res.status(typeof err?.status === 'number' ? err.status : 500).json({
          error: {
            code: typeof err?.code === 'string' ? err.code : 'INTERNAL_SERVER_ERROR',
            message:
              err instanceof Error && err.message
                ? err.message
                : 'An unexpected internal server error occurred.',
            request_id: req.requestId ?? `req_${Date.now()}`,
            details: { timestamp: isoNow() },
          },
        });
      });

      return app;
    })().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}
