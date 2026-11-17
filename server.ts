import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createApiApp } from './server/app.ts';
import { config } from './server/config.ts';

async function bootstrap() {
  const app = await createApiApp();

  if (config.nodeEnv === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`InvoiceDesk server listening on http://0.0.0.0:${config.port} (env=${config.nodeEnv})`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start InvoiceDesk server:', err);
  process.exit(1);
});
