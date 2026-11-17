import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApiApp } from '../server/app.ts';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await createApiApp();
  return app(req as any, res as any);
}
