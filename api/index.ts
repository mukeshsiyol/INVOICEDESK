import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApiApp } from '../server/app.ts';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const app = await createApiApp();
    return app(req as any, res as any);
  } catch (err) {
    console.error('[Vercel API Handler Error]:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: {
            code: 'SERVERLESS_INIT_FAILED',
            message: err instanceof Error ? err.message : 'Failed to initialize backend.',
            request_id: 'req_serverless_init',
            details: {},
          },
        })
      );
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}
