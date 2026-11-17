import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const isServerless = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY
);
const DATA_DIR = isServerless
  ? path.join('/tmp', 'invoicedesk-data')
  : path.resolve(process.cwd(), 'data');
const STORAGE_DIR = path.join(DATA_DIR, 'storage', 'invoices');
const FIXTURES_DIR = path.join(DATA_DIR, 'fixtures');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(FIXTURES_DIR, { recursive: true });

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  isServerless,
  appEnv: process.env.APP_ENV || 'demo',
  enableDemoRoleSwitcher:
    (process.env.ENABLE_DEMO_ROLE_SWITCHER ?? 'true').toLowerCase() === 'true' &&
    (process.env.APP_ENV ?? 'demo') === 'demo',
  pauseAuthForDemo:
    (process.env.PAUSE_AUTH_FOR_DEMO ?? 'true').toLowerCase() === 'true',
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-4-hydrogen',
  geminiFallbackModel: 'gemini-3.1-flash-lite',
  jwtSecret:
    process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16
      ? process.env.JWT_SECRET
      : crypto.createHash('sha256').update(process.cwd() + '_invoicedesk_dev_secret').digest('hex'),
  sessionCookieName: 'invoicedesk_session',
  signedOutCookieName: 'invoicedesk_signed_out',
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'invoicedesk.db'),
  storageDir: STORAGE_DIR,
  fixturesDir: FIXTURES_DIR,
  maxUploadBytes: 25 * 1024 * 1024,
  maxBatchFiles: 10,
};
