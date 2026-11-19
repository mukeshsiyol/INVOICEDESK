import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Decimal from 'decimal.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import {
  clearSessionCookie,
  getUserFromRequest,
  hashPassword,
  requireAuth,
  requireRoles,
  setSessionCookie,
  signSessionToken,
  verifyPassword,
  writeAuditLog,
  type AuthUser,
  type UserRole,
} from './auth.ts';
import { config } from './config.ts';
import { getDb, isoNow, withTransaction } from './db.ts';
import { normalizeDocNumber, normalizeVendorName, parseDecimalSafe } from './engine.ts';
import { buildExplanationRecord } from './explanation.ts';
import {
  GeminiConfigurationError,
  extractQuickInvoiceSignals,
  generateDecisionExplanation,
  generateRejectionNoticeDraft,
  persistValidatedPdf,
  readStoredPdf,
  validatePdfBuffer,
  type RejectionNoticeTone,
} from './extraction.ts';
import {
  DEMO_FIXTURES,
  ensureDemoFixturesGenerated,
  regenerateSeededInvoicePdfIfMissing,
  resetDemoDatabase,
} from './fixtures.ts';
import { buildOpenApiSpec } from './openapi.ts';
import {
  createWorkspaceNotification,
  listMissedNotificationsSince,
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
  notificationBroker,
  type NotificationStreamPayload,
} from './notifications.ts';
import { sseBroker, startProcessingRun, type SseEventPayload } from './pipeline.ts';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadBytes,
    files: config.maxBatchFiles,
  },
});

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => unknown
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function parsePositiveInt(val: unknown, fallback: number, max = 1000): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(num)));
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function sanitizeHeaderFilename(name: string, fallback = 'document.pdf'): string {
  const cleaned = path
    .basename(name || fallback)
    .replace(/[\r\n"\\]/g, '_')
    .trim();
  return cleaned || fallback;
}

function safeSseWrite(res: Response, chunk: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function sendError(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {}
): void {
  res.status(status).json({
    error: {
      code,
      message,
      request_id: req.requestId ?? 'req_unknown',
      details,
    },
  });
}

function csvEscape(val: unknown): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function windowStartIso(windowParam: string): string | null {
  const now = Date.now();
  if (windowParam === '7d') return new Date(now - 7 * 86400_000).toISOString();
  if (windowParam === '30d') return new Date(now - 30 * 86400_000).toISOString();
  if (windowParam === '90d') return new Date(now - 90 * 86400_000).toISOString();
  return null;
}

function buildInvoiceFilterQuery(query: Request['query'], idsParam: string[] = []) {
  const q = String(query.q ?? '').trim().toLowerCase();
  const decision = String(query.decision ?? '').trim();
  const procStatus = String(query.processing_status ?? '').trim();
  const reviewStatus = String(query.review_status ?? '').trim();
  const vendorId = String(query.vendor_id ?? '').trim();
  const win = String(query.window ?? '').trim();
  const attention = query.attention === 'true';
  const sortParam = String(query.sort ?? '-created_at');

  const where: string[] = ['1=1'];
  const params: any[] = [];

  if (idsParam.length > 0) {
    where.push(`i.id IN (${idsParam.map(() => '?').join(',')})`);
    params.push(...idsParam);
  } else {
    if (q) {
      where.push(
        `(LOWER(COALESCE(i.invoice_number,'')) LIKE ? OR LOWER(i.original_filename) LIKE ? OR LOWER(COALESCE(i.extracted_vendor_name,'')) LIKE ? OR LOWER(COALESCE(v.canonical_name,'')) LIKE ? OR LOWER(COALESCE(po.po_number,'')) LIKE ? OR LOWER(COALESCE(i.extracted_po_number,'')) LIKE ?)`
      );
      const like = `%${q}%`;
      params.push(like, like, like, like, like, like);
    }
    if (decision && decision !== 'ALL') {
      where.push('i.business_decision = ?');
      params.push(decision);
    }
    if (procStatus && procStatus !== 'ALL') {
      where.push('i.processing_status = ?');
      params.push(procStatus);
    }
    if (reviewStatus && reviewStatus !== 'ALL') {
      where.push('i.review_status = ?');
      params.push(reviewStatus);
    }
    if (vendorId && vendorId !== 'ALL') {
      where.push('i.vendor_id = ?');
      params.push(vendorId);
    }
    if (win && win !== 'all') {
      const startIso = windowStartIso(win);
      if (startIso) {
        where.push('i.created_at >= ?');
        params.push(startIso);
      }
    }
    if (attention) {
      where.push(`(i.review_status = 'PENDING_REVIEW' OR i.processing_status = 'FAILED')`);
    }
  }

  const sortMap: Record<string, string> = {
    '-created_at': 'i.created_at DESC',
    created_at: 'i.created_at ASC',
    '-total_amount': 'CAST(COALESCE(i.total_amount, 0) AS REAL) DESC',
    total_amount: 'CAST(COALESCE(i.total_amount, 0) AS REAL) ASC',
    '-overall_confidence': 'COALESCE(i.overall_confidence, 0) DESC',
  };
  const orderBy = sortMap[sortParam] ?? 'i.created_at DESC';

  return { whereSql: where.join(' AND '), params, orderBy };
}

async function buildVendorReportRows(
  db: ReturnType<typeof getDb>,
  opts: { q?: string; status?: string; vendorId?: string; window?: string }
) {
  const q = String(opts.q ?? '').trim().toLowerCase();
  const status = String(opts.status ?? '').trim();
  const vendorId = String(opts.vendorId ?? '').trim();
  const win = String(opts.window ?? 'all').trim();
  const startIso = win && win !== 'all' ? windowStartIso(win) : null;

  const vendors = (await db.prepare('SELECT * FROM vendors ORDER BY vendor_code ASC').all() as any[])
    .map((v) => ({
      ...v,
      aliases: safeJsonParse<string[]>(v.aliases, []),
    }))
    .filter((v) => {
      if (vendorId && vendorId !== 'ALL' && v.id !== vendorId) return false;
      if (status && status !== 'ALL' && v.verification_status !== status) return false;
      if (!q) return true;
      return (
        v.canonical_name.toLowerCase().includes(q) ||
        v.vendor_code.toLowerCase().includes(q) ||
        (v.tax_id || '').toLowerCase().includes(q) ||
        v.aliases.some((a: string) => a.toLowerCase().includes(q))
      );
    });

  const allPos = await db
    .prepare('SELECT id, vendor_id, currency, original_amount, consumed_amount, status FROM purchase_orders')
    .all() as any[];

  const invSql = startIso
    ? 'SELECT id, vendor_id, total_amount, overall_confidence, processing_status, business_decision, review_status, invoice_date, created_at FROM invoices WHERE created_at >= ?'
    : 'SELECT id, vendor_id, total_amount, overall_confidence, processing_status, business_decision, review_status, invoice_date, created_at FROM invoices';
  const allInvoices = (startIso ? await db.prepare(invSql).all(startIso) : await db.prepare(invSql).all()) as any[];

  return vendors.map((v) => {
    const vendorPos = allPos.filter((p) => p.vendor_id === v.id);
    const activePos = vendorPos.filter((p) => p.status !== 'CANCELLED');
    const openPoCount = vendorPos.filter((p) => ['OPEN', 'PARTIALLY_CONSUMED'].includes(p.status)).length;

    let poCommitted = new Decimal(0);
    let poConsumed = new Decimal(0);
    for (const po of activePos) {
      poCommitted = poCommitted.plus(parseDecimalSafe(po.original_amount) ?? 0);
      poConsumed = poConsumed.plus(parseDecimalSafe(po.consumed_amount) ?? 0);
    }
    const poRemaining = Decimal.max(new Decimal(0), poCommitted.minus(poConsumed));
    const poUtilPct = poCommitted.gt(0) ? poConsumed.div(poCommitted).mul(100).toFixed(1) : '0.0';

    const vendorInvoices = allInvoices.filter((i) => i.vendor_id === v.id);
    const decided = vendorInvoices.filter((i) => ['APPROVE', 'REVIEW', 'REJECT'].includes(i.business_decision));
    const approvedCount = decided.filter((i) => i.business_decision === 'APPROVE').length;
    const reviewCount = decided.filter((i) => i.business_decision === 'REVIEW').length;
    const rejectedCount = decided.filter((i) => i.business_decision === 'REJECT').length;
    const failedCount = vendorInvoices.filter((i) => i.processing_status === 'FAILED').length;
    const exceptionRatePct =
      decided.length > 0 ? (((reviewCount + rejectedCount) / decided.length) * 100).toFixed(1) : '0.0';

    let totalInvoiced = new Decimal(0);
    let approvedSpend = new Decimal(0);
    const confs: number[] = [];
    let lastInvoiceDate: string | null = null;

    for (const inv of vendorInvoices) {
      if (inv.total_amount && inv.processing_status === 'COMPLETED') {
        const amt = parseDecimalSafe(inv.total_amount);
        if (amt) {
          totalInvoiced = totalInvoiced.plus(amt);
          if (inv.business_decision === 'APPROVE' || inv.review_status === 'APPROVED_BY_HUMAN') {
            approvedSpend = approvedSpend.plus(amt);
          }
        }
      }
      if (typeof inv.overall_confidence === 'number') {
        confs.push(inv.overall_confidence);
      }
      const d = inv.invoice_date || inv.created_at;
      if (d && (!lastInvoiceDate || String(d) > lastInvoiceDate)) {
        lastInvoiceDate = String(d).slice(0, 10);
      }
    }

    const meanConfPct =
      confs.length > 0 ? ((confs.reduce((a, b) => a + b, 0) / confs.length) * 100).toFixed(1) : '';

    return {
      vendor_id: v.id,
      vendor_code: v.vendor_code,
      canonical_name: v.canonical_name,
      tax_id: v.tax_id || '',
      default_currency: v.default_currency || 'USD',
      verification_status: v.verification_status,
      payment_terms_days: v.payment_terms_days,
      aliases: v.aliases.join('; '),
      open_po_count: openPoCount,
      total_po_count: vendorPos.length,
      po_committed_amount: poCommitted.toFixed(2),
      po_consumed_amount: poConsumed.toFixed(2),
      po_remaining_amount: poRemaining.toFixed(2),
      po_utilization_pct: poUtilPct,
      total_invoices: vendorInvoices.length,
      approved_invoices: approvedCount,
      review_invoices: reviewCount,
      rejected_invoices: rejectedCount,
      failed_invoices: failedCount,
      exception_rate_pct: exceptionRatePct,
      total_invoiced_amount: totalInvoiced.toFixed(2),
      approved_spend_amount: approvedSpend.toFixed(2),
      mean_confidence_pct: meanConfPct,
      last_invoice_date: lastInvoiceDate || '',
      created_at: v.created_at,
    };
  });
}

async function ingestBufferAndQueueRun(params: {
  buffer: Buffer;
  originalFilename: string;
  userId: string;
  autoStart: boolean;
}): Promise<{
  invoice_id: string;
  run_id: string;
  original_filename: string;
  file_sha256: string;
  processing_status: string;
  error_stage: number | null;
  error_message: string | null;
  serverless_async: boolean;
}> {
  const db = getDb();
  const invoiceId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const sha256 = crypto.createHash('sha256').update(params.buffer).digest('hex');
  const storageKey = await persistValidatedPdf({
    invoiceId,
    fileSha256: sha256,
    buffer: params.buffer,
  });
  const now = isoNow();
  const safeDisplayFilename = path.basename(params.originalFilename).slice(0, 200) || 'invoice.pdf';

  await withTransaction(db, async () => {
    await db.prepare(
      `INSERT INTO invoices (id, uploaded_by, original_filename, storage_key, file_sha256, file_size_bytes, processing_status, business_decision, review_status, latest_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', 'PENDING', 'NOT_REQUIRED', ?, ?, ?)`
    ).run(invoiceId, params.userId, safeDisplayFilename, storageKey, sha256, params.buffer.length, runId, now, now);

    await db.prepare(
      `INSERT INTO processing_runs (id, invoice_id, run_number, trigger_type, triggered_by, status, current_stage, created_at)
       VALUES (?, ?, 1, 'INITIAL', ?, 'QUEUED', 0, ?)`
    ).run(runId, invoiceId, params.userId, now);

    await writeAuditLog({
      actorId: params.userId,
      actorType: 'USER',
      actorRole: 'UPLOADER',
      action: 'INVOICE_UPLOADED',
      resourceType: 'INVOICE',
      resourceId: invoiceId,
      details: { filename: safeDisplayFilename, sha256, size_bytes: params.buffer.length, run_id: runId },
    });
  });

  const uploaderRow = await db
    .prepare('SELECT full_name FROM users WHERE id = ?')
    .get(params.userId) as { full_name: string } | undefined;

  await createWorkspaceNotification({
    eventType: 'INVOICE_UPLOADED',
    severity: 'INFO',
    title: 'New Invoice Uploaded',
    message: `${safeDisplayFilename} uploaded${uploaderRow?.full_name ? ` by ${uploaderRow.full_name}` : ''} and queued for verification.`,
    invoiceId,
    runId,
    actorId: params.userId,
    metadata: { filename: safeDisplayFilename, file_size_bytes: params.buffer.length },
  });

  if (params.autoStart && !config.isServerless) {
    void startProcessingRun(runId);
  }

  const persistedRun = await db
    .prepare('SELECT status, error_stage, error_message FROM processing_runs WHERE id = ?')
    .get(runId) as { status: string; error_stage: number | null; error_message: string | null } | undefined;

  return {
    invoice_id: invoiceId,
    run_id: runId,
    original_filename: safeDisplayFilename,
    file_sha256: sha256,
    processing_status: persistedRun?.status || 'QUEUED',
    error_stage: persistedRun?.error_stage ?? null,
    error_message: persistedRun?.error_message ?? null,
    serverless_async: config.isServerless && params.autoStart,
  };
}

export function createApiRouter(): express.Router {
  const rawRouter = express.Router();
  const router = new Proxy(rawRouter, {
    get(target, prop, receiver) {
      if (prop === 'get' || prop === 'post' || prop === 'patch' || prop === 'put' || prop === 'delete') {
        const orig = Reflect.get(target, prop, target).bind(target);
        return (pathPattern: any, ...handlers: any[]) =>
          orig(
            pathPattern,
            ...handlers.map((h) => (typeof h === 'function' && h.length < 4 ? asyncHandler(h) : h))
          );
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  router.use((req, _res, next) => {
    req.requestId = `req_${crypto.randomBytes(6).toString('hex')}`;
    next();
  });

  // ==================== HEALTH ====================
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'invoicedesk-api',
      demo_mode: config.enableDemoRoleSwitcher,
      auth_paused: config.pauseAuthForDemo,
      timestamp: isoNow(),
    });
  });

  router.get('/openapi.json', (req, res) => {
    const proto = req.header('x-forwarded-proto') || req.protocol || 'http';
    const host = req.header('host') || `localhost:${config.port}`;
    res.json(buildOpenApiSpec(`${proto}://${host}`));
  });

  // ==================== AUTH ====================
  router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'Email and password are required.');
      return;
    }
    const db = getDb();
    const userRow = await db
      .prepare('SELECT id, email, full_name, password_hash, role, theme_preference, is_active FROM users WHERE email = ?')
      .get(String(email).trim().toLowerCase()) as (AuthUser & { password_hash: string }) | undefined;

    if (!userRow || !userRow.is_active || !verifyPassword(String(password), userRow.password_hash)) {
      sendError(req, res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
      return;
    }

    const user: AuthUser = {
      id: userRow.id,
      email: userRow.email,
      full_name: userRow.full_name,
      role: userRow.role,
      theme_preference: userRow.theme_preference,
      is_active: userRow.is_active,
    };
    setSessionCookie(res, signSessionToken(user), req);
    res.json({ ...user, demo_mode: config.enableDemoRoleSwitcher, auth_paused: config.pauseAuthForDemo });
  });

  router.post('/auth/logout', (req, res) => {
    clearSessionCookie(res, !config.pauseAuthForDemo, req);
    res.json({ ok: true, auth_paused: config.pauseAuthForDemo });
  });

  router.post('/auth/demo-bootstrap', async (req, res) => {
    if (!config.enableDemoRoleSwitcher && !config.pauseAuthForDemo) {
      sendError(req, res, 404, 'NOT_FOUND', 'Demo bootstrap disabled.');
      return;
    }
    if (!config.pauseAuthForDemo && req.cookies?.[config.signedOutCookieName] === '1') {
      sendError(req, res, 401, 'SIGNED_OUT', 'User explicitly signed out.');
      return;
    }
    const existing = await getUserFromRequest(req);
    if (existing) {
      setSessionCookie(res, signSessionToken(existing), req);
      res.json({ ...existing, demo_mode: config.enableDemoRoleSwitcher, auth_paused: config.pauseAuthForDemo });
      return;
    }
    const db = getDb();
    const defaultUser = await db
      .prepare("SELECT id, email, full_name, role, theme_preference, is_active FROM users WHERE role = 'ADMIN' AND is_active = 1 LIMIT 1")
      .get() as AuthUser | undefined;
    if (!defaultUser) {
      sendError(req, res, 500, 'SEED_ERROR', 'No demo user available.');
      return;
    }
    setSessionCookie(res, signSessionToken(defaultUser), req);
    res.json({ ...defaultUser, demo_mode: config.enableDemoRoleSwitcher, auth_paused: config.pauseAuthForDemo });
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    res.json({ ...req.user!, demo_mode: config.enableDemoRoleSwitcher, auth_paused: config.pauseAuthForDemo });
  });

  router.get('/auth/users', requireAuth, async (req, res) => {
    if (!config.enableDemoRoleSwitcher && !config.pauseAuthForDemo) {
      sendError(req, res, 404, 'NOT_FOUND', 'User switcher is disabled.');
      return;
    }
    const db = getDb();
    const users = await db
      .prepare(
        `SELECT id, email, full_name, role
         FROM users
         WHERE is_active = 1
         ORDER BY CASE role
           WHEN 'ADMIN' THEN 1
           WHEN 'REVIEWER' THEN 2
           WHEN 'OPERATOR' THEN 3
           WHEN 'AUDITOR' THEN 4
           ELSE 5
         END, created_at ASC`
      )
      .all();
    res.json({ items: users });
  });

  router.post('/auth/demo-switch', async (req, res) => {
    if (!config.enableDemoRoleSwitcher && !config.pauseAuthForDemo) {
      sendError(req, res, 404, 'NOT_FOUND', 'Demo role switcher is disabled.');
      return;
    }
    const db = getDb();
    const userId = req.body?.user_id ? String(req.body.user_id).trim() : '';
    let target: AuthUser | undefined;

    if (userId) {
      target = await db
        .prepare('SELECT id, email, full_name, role, theme_preference, is_active FROM users WHERE id = ? AND is_active = 1 LIMIT 1')
        .get(userId) as AuthUser | undefined;
      if (!target) {
        sendError(req, res, 404, 'NOT_FOUND', 'Selected active user not found.');
        return;
      }
    } else {
      const role = String(req.body?.role ?? '').toUpperCase() as UserRole;
      if (!['OPERATOR', 'REVIEWER', 'AUDITOR', 'ADMIN'].includes(role)) {
        sendError(req, res, 422, 'VALIDATION_ERROR', 'Role must be OPERATOR, REVIEWER, AUDITOR, or ADMIN.');
        return;
      }
      target = await db
        .prepare('SELECT id, email, full_name, role, theme_preference, is_active FROM users WHERE role = ? AND is_active = 1 ORDER BY created_at ASC LIMIT 1')
        .get(role) as AuthUser | undefined;
      if (!target) {
        sendError(req, res, 404, 'NOT_FOUND', `No active user with role ${role}.`);
        return;
      }
    }

    const prev = await getUserFromRequest(req);
    setSessionCookie(res, signSessionToken(target), req);
    await writeAuditLog({
      actorId: target.id,
      actorType: 'USER',
      actorRole: target.role,
      action: 'AUTH_DEMO_SWITCH',
      resourceType: 'USER',
      resourceId: target.id,
      details: { previous_user_id: prev?.id ?? null, previous_role: prev?.role ?? null, new_user_id: target.id, new_role: target.role },
    });
    res.json({ ...target, demo_mode: true, auth_paused: config.pauseAuthForDemo });
  });

  // ==================== FIXTURES (REAL DOWNLOADABLE DEMO PDFS) ====================
  router.get('/fixtures', requireAuth, (_req, res) => {
    res.json({ items: DEMO_FIXTURES });
  });

  router.get('/fixtures/:key.pdf', requireAuth, async (req, res) => {
    const meta = DEMO_FIXTURES.find((f) => f.key === req.params.key);
    if (!meta) {
      sendError(req, res, 404, 'NOT_FOUND', 'Sample fixture not found.');
      return;
    }
    const filePath = path.join(config.fixturesDir, `${meta.key}.pdf`);
    let buf: Buffer;
    try {
      buf = await fs.readFile(filePath);
    } catch {
      await ensureDemoFixturesGenerated();
      buf = await fs.readFile(filePath);
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeHeaderFilename(meta.filename)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  });

  // ==================== UPLOAD & PRECHECK ====================
  router.post('/invoices/precheck-hash', requireAuth, requireRoles('OPERATOR', 'REVIEWER', 'ADMIN'), async (req, res) => {
    const hashes = Array.isArray(req.body?.hashes) ? req.body.hashes.slice(0, 50) : [];
    const db = getDb();
    const matches = await Promise.all(hashes.map(async (h: { client_id?: string; sha256?: string }) => {
      if (!h?.sha256) return { client_id: h?.client_id, is_duplicate: false };
      const existing = await db
        .prepare(
          `SELECT id, original_filename, invoice_number, business_decision
           FROM invoices WHERE file_sha256 = ? AND processing_status = 'COMPLETED'
           ORDER BY created_at ASC LIMIT 1`
        )
        .get(String(h.sha256)) as
        | { id: string; original_filename: string; invoice_number: string | null; business_decision: string }
        | undefined;
      if (!existing) return { client_id: h.client_id, is_duplicate: false };
      return {
        client_id: h.client_id,
        is_duplicate: true,
        existing_invoice_id: existing.id,
        existing_filename: existing.original_filename,
        existing_invoice_number: existing.invoice_number,
        existing_decision: existing.business_decision,
      };
    }));
    res.json({ matches });
  });

  router.post(
    '/invoices/precheck-duplicates',
    requireAuth,
    requireRoles('OPERATOR', 'REVIEWER', 'ADMIN'),
    (req, res, next) => {
      upload.array('files', config.maxBatchFiles)(req, res, (err: any) => {
        if (err) {
          sendError(req, res, 400, 'PRECHECK_ERROR', err.message || 'Unable to inspect files for duplicates.');
          return;
        }
        next();
      });
    },
    async (req, res) => {
      const files = (req.files as Express.Multer.File[]) || [];
      let clientIds: string[] = [];
      try {
        const rawIds = req.body?.client_ids;
        if (typeof rawIds === 'string') {
          const parsed = JSON.parse(rawIds);
          if (Array.isArray(parsed)) clientIds = parsed.map((v) => String(v));
        }
      } catch {
        clientIds = [];
      }

      const db = getDb();
      const vendorRows = await db
        .prepare('SELECT id, canonical_name, aliases FROM vendors')
        .all() as Array<{ id: string; canonical_name: string; aliases: string }>;
      const knownVendors = vendorRows.map((v) => {
        let aliases: string[] = [];
        try {
          const parsed = JSON.parse(v.aliases || '[]');
          if (Array.isArray(parsed)) aliases = parsed.map((a) => String(a));
        } catch {
          aliases = [];
        }
        return { id: v.id, canonical_name: v.canonical_name, aliases };
      });

      const existingInvoices = await db
        .prepare(
          `SELECT i.id, i.original_filename, i.file_sha256, i.vendor_id, i.extracted_vendor_name,
                  v.canonical_name AS vendor_canonical_name,
                  i.invoice_number, i.normalized_invoice_number, i.invoice_date, i.total_amount,
                  i.business_decision, i.created_at
           FROM invoices i
           LEFT JOIN vendors v ON v.id = i.vendor_id
           WHERE i.processing_status = 'COMPLETED' AND i.business_decision != 'REJECT'
           ORDER BY i.created_at ASC`
        )
        .all() as Array<{
        id: string;
        original_filename: string;
        file_sha256: string;
        vendor_id: string | null;
        extracted_vendor_name: string | null;
        vendor_canonical_name: string | null;
        invoice_number: string | null;
        normalized_invoice_number: string | null;
        invoice_date: string | null;
        total_amount: string | null;
        business_decision: string;
        created_at: string;
      }>;

      const vendorsMatch = (
        vIdA: string | null,
        vNameA: string | null,
        vIdB: string | null,
        vNameB: string | null
      ) => {
        if (vIdA && vIdB && vIdA === vIdB) return true;
        const nA = normalizeVendorName(vNameA);
        const nB = normalizeVendorName(vNameB);
        return Boolean(nA && nB && nA === nB);
      };

      const stagedPeers: Array<{
        client_id: string;
        filename: string;
        sha256: string;
        vendorId: string | null;
        vendorName: string | null;
        normInvNo: string | null;
        invoiceNumber: string | null;
        invoiceDate: string | null;
        totalAmount: string | null;
      }> = [];

      const matches: Array<Record<string, unknown>> = [];

      const inspectedFiles = await Promise.all(
        files.map(async (file, i) => {
          const clientId = clientIds[i] || `file_${i}`;
          const pdfCheck = validatePdfBuffer(file.buffer);
          if (!pdfCheck.valid) {
            return { valid: false as const, file, clientId };
          }
          const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
          const fallbackSignals = {
            vendorId: null,
            vendorName: null,
            invoiceNumber: null,
            invoiceDate: null,
            totalAmount: null,
            hasNativeText: false,
          };
          let timer: ReturnType<typeof setTimeout> | undefined;
          const signals = await Promise.race([
            extractQuickInvoiceSignals(file.buffer, file.originalname, knownVendors).catch(() => fallbackSignals),
            new Promise<typeof fallbackSignals>((resolve) => {
              timer = setTimeout(() => resolve(fallbackSignals), 4000);
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer);
          });
          return { valid: true as const, file, clientId, sha256, signals };
        })
      );

      for (const item of inspectedFiles) {
        if (!item.valid) {
          matches.push({ client_id: item.clientId, is_duplicate: false, match_type: 'NONE', matched_fields: [] });
          continue;
        }
        const { file, clientId, sha256, signals } = item;
        const normInv = normalizeDocNumber(signals.invoiceNumber);
        const currDateMs = signals.invoiceDate ? Date.parse(signals.invoiceDate) : Number.NaN;

        const extractedPreview = {
          vendor_name: signals.vendorName,
          invoice_number: signals.invoiceNumber,
          invoice_date: signals.invoiceDate,
          total_amount: signals.totalAmount,
          has_native_text: signals.hasNativeText,
        };

        let foundMatch: Record<string, unknown> | null = null;

        // 1. Exact binary SHA-256 match against existing invoices
        const exactFile = existingInvoices.find((inv) => inv.file_sha256 === sha256);
        if (exactFile) {
          const matchedFields = ['FILE_SHA256'];
          if (vendorsMatch(signals.vendorId, signals.vendorName, exactFile.vendor_id, exactFile.vendor_canonical_name ?? exactFile.extracted_vendor_name)) {
            matchedFields.push('VENDOR');
          }
          if (normInv && exactFile.normalized_invoice_number === normInv) {
            matchedFields.push('INVOICE_NUMBER');
          }
          if (signals.invoiceDate && exactFile.invoice_date === signals.invoiceDate) {
            matchedFields.push('INVOICE_DATE');
          }
          foundMatch = {
            client_id: clientId,
            is_duplicate: true,
            warning_severity: 'HIGH',
            match_type: 'FILE_SHA256',
            matched_fields: matchedFields,
            reason: `Identical PDF file (SHA-256) already processed as '${exactFile.original_filename}' (${exactFile.invoice_number || 'Unnumbered'}).`,
            extracted_preview: extractedPreview,
            existing_invoice_id: exactFile.id,
            existing_filename: exactFile.original_filename,
            existing_invoice_number: exactFile.invoice_number,
            existing_vendor_name: exactFile.vendor_canonical_name ?? exactFile.extracted_vendor_name,
            existing_invoice_date: exactFile.invoice_date,
            existing_decision: exactFile.business_decision,
            batch_peer_filename: null,
          };
        }

        // 2. Vendor + Normalized Invoice Number (+ optional Date) match
        if (!foundMatch && normInv && (signals.vendorId || normalizeVendorName(signals.vendorName))) {
          const bizDup = existingInvoices.find(
            (inv) =>
              inv.normalized_invoice_number === normInv &&
              vendorsMatch(
                signals.vendorId,
                signals.vendorName,
                inv.vendor_id,
                inv.vendor_canonical_name ?? inv.extracted_vendor_name
              )
          );
          if (bizDup) {
            const matchedFields = ['VENDOR', 'INVOICE_NUMBER'];
            const bDateMs = bizDup.invoice_date ? Date.parse(bizDup.invoice_date) : Number.NaN;
            if (!Number.isNaN(currDateMs) && !Number.isNaN(bDateMs) && Math.abs(currDateMs - bDateMs) <= 3 * 86400_000) {
              matchedFields.push('INVOICE_DATE');
            }
            const vendorDisplay = bizDup.vendor_canonical_name ?? bizDup.extracted_vendor_name ?? signals.vendorName ?? 'Vendor';
            const datePart = bizDup.invoice_date ? ` dated ${bizDup.invoice_date}` : '';
            foundMatch = {
              client_id: clientId,
              is_duplicate: true,
              warning_severity: 'HIGH',
              match_type: 'VENDOR_INVOICE_KEY',
              matched_fields: matchedFields,
              reason: `Matches existing ${vendorDisplay} invoice ${bizDup.invoice_number ?? signals.invoiceNumber}${datePart} (${bizDup.original_filename}).`,
              extracted_preview: extractedPreview,
              existing_invoice_id: bizDup.id,
              existing_filename: bizDup.original_filename,
              existing_invoice_number: bizDup.invoice_number,
              existing_vendor_name: vendorDisplay,
              existing_invoice_date: bizDup.invoice_date,
              existing_decision: bizDup.business_decision,
              batch_peer_filename: null,
            };
          }
        }

        // 3. Vendor + Date (±3 days) potential redundancy check
        if (!foundMatch && !Number.isNaN(currDateMs) && (signals.vendorId || normalizeVendorName(signals.vendorName))) {
          for (const cand of existingInvoices) {
            if (
              !vendorsMatch(
                signals.vendorId,
                signals.vendorName,
                cand.vendor_id,
                cand.vendor_canonical_name ?? cand.extracted_vendor_name
              )
            ) {
              continue;
            }
            if (!cand.invoice_date) continue;
            const cDateMs = Date.parse(cand.invoice_date);
            if (Number.isNaN(cDateMs)) continue;
            const diffDays = Math.abs(currDateMs - cDateMs) / 86400_000;
            if (diffDays > 3) continue;

            let amountClose = false;
            if (signals.totalAmount && cand.total_amount) {
              try {
                const a = new Decimal(signals.totalAmount);
                const b = new Decimal(cand.total_amount);
                const maxAmt = Decimal.max(a.abs(), b.abs());
                amountClose = maxAmt.gt(0) && a.minus(b).abs().div(maxAmt).lte('0.10');
              } catch {
                amountClose = false;
              }
            }

            if (diffDays === 0 || amountClose) {
              const matchedFields = ['VENDOR', 'INVOICE_DATE'];
              if (amountClose && signals.totalAmount === cand.total_amount) matchedFields.push('AMOUNT');
              const vendorDisplay = cand.vendor_canonical_name ?? cand.extracted_vendor_name ?? signals.vendorName ?? 'Vendor';
              foundMatch = {
                client_id: clientId,
                is_duplicate: true,
                warning_severity: diffDays === 0 ? 'HIGH' : 'MEDIUM',
                match_type: 'VENDOR_DATE_REDUNDANCY',
                matched_fields: matchedFields,
                reason: `Potential redundancy: ${vendorDisplay} already has invoice ${cand.invoice_number || cand.original_filename} dated ${cand.invoice_date}${diffDays === 0 ? ' (same invoice date)' : ` (within ${Math.round(diffDays)} day(s))`}.`,
                extracted_preview: extractedPreview,
                existing_invoice_id: cand.id,
                existing_filename: cand.original_filename,
                existing_invoice_number: cand.invoice_number,
                existing_vendor_name: vendorDisplay,
                existing_invoice_date: cand.invoice_date,
                existing_decision: cand.business_decision,
                batch_peer_filename: null,
              };
              break;
            }
          }
        }

        // 4. Fallback: Invoice Number + Date match even if vendor alias was unrecognized
        if (!foundMatch && normInv && signals.invoiceDate) {
          const invDateDup = existingInvoices.find(
            (inv) => inv.normalized_invoice_number === normInv && inv.invoice_date === signals.invoiceDate
          );
          if (invDateDup) {
            const vendorDisplay = invDateDup.vendor_canonical_name ?? invDateDup.extracted_vendor_name;
            foundMatch = {
              client_id: clientId,
              is_duplicate: true,
              warning_severity: 'MEDIUM',
              match_type: 'VENDOR_INVOICE_KEY',
              matched_fields: ['INVOICE_NUMBER', 'INVOICE_DATE'],
              reason: `Invoice number ${invDateDup.invoice_number ?? signals.invoiceNumber} dated ${signals.invoiceDate} already exists (${invDateDup.original_filename}).`,
              extracted_preview: extractedPreview,
              existing_invoice_id: invDateDup.id,
              existing_filename: invDateDup.original_filename,
              existing_invoice_number: invDateDup.invoice_number,
              existing_vendor_name: vendorDisplay,
              existing_invoice_date: invDateDup.invoice_date,
              existing_decision: invDateDup.business_decision,
              batch_peer_filename: null,
            };
          }
        }

        // 5. Intra-batch duplicate / redundancy check against earlier files in the same upload queue
        if (!foundMatch) {
          for (const peer of stagedPeers) {
            if (peer.sha256 === sha256) {
              foundMatch = {
                client_id: clientId,
                is_duplicate: true,
                warning_severity: 'HIGH',
                match_type: 'INTRA_BATCH_DUPLICATE',
                matched_fields: ['FILE_SHA256'],
                reason: `Identical PDF content to staged file '${peer.filename}' in this upload batch.`,
                extracted_preview: extractedPreview,
                existing_invoice_id: null,
                existing_filename: peer.filename,
                existing_invoice_number: peer.invoiceNumber,
                existing_vendor_name: peer.vendorName,
                existing_invoice_date: peer.invoiceDate,
                existing_decision: null,
                batch_peer_filename: peer.filename,
              };
              break;
            }
            const samePeerVendor = vendorsMatch(signals.vendorId, signals.vendorName, peer.vendorId, peer.vendorName);
            if (samePeerVendor && normInv && peer.normInvNo && normInv === peer.normInvNo) {
              const matchedFields = ['VENDOR', 'INVOICE_NUMBER'];
              if (signals.invoiceDate && peer.invoiceDate && signals.invoiceDate === peer.invoiceDate) {
                matchedFields.push('INVOICE_DATE');
              }
              foundMatch = {
                client_id: clientId,
                is_duplicate: true,
                warning_severity: 'HIGH',
                match_type: 'INTRA_BATCH_DUPLICATE',
                matched_fields: matchedFields,
                reason: `Duplicates staged file '${peer.filename}' in this batch (${signals.vendorName || 'same vendor'} · ${signals.invoiceNumber}).`,
                extracted_preview: extractedPreview,
                existing_invoice_id: null,
                existing_filename: peer.filename,
                existing_invoice_number: peer.invoiceNumber,
                existing_vendor_name: peer.vendorName,
                existing_invoice_date: peer.invoiceDate,
                existing_decision: null,
                batch_peer_filename: peer.filename,
              };
              break;
            }
            if (samePeerVendor && signals.invoiceDate && peer.invoiceDate && signals.invoiceDate === peer.invoiceDate) {
              foundMatch = {
                client_id: clientId,
                is_duplicate: true,
                warning_severity: 'MEDIUM',
                match_type: 'INTRA_BATCH_DUPLICATE',
                matched_fields: ['VENDOR', 'INVOICE_DATE'],
                reason: `Same vendor and invoice date (${signals.invoiceDate}) as staged file '${peer.filename}' in this batch.`,
                extracted_preview: extractedPreview,
                existing_invoice_id: null,
                existing_filename: peer.filename,
                existing_invoice_number: peer.invoiceNumber,
                existing_vendor_name: peer.vendorName,
                existing_invoice_date: peer.invoiceDate,
                existing_decision: null,
                batch_peer_filename: peer.filename,
              };
              break;
            }
          }
        }

        stagedPeers.push({
          client_id: clientId,
          filename: file.originalname,
          sha256,
          vendorId: signals.vendorId,
          vendorName: signals.vendorName,
          normInvNo: normInv,
          invoiceNumber: signals.invoiceNumber,
          invoiceDate: signals.invoiceDate,
          totalAmount: signals.totalAmount,
        });

        matches.push(
          foundMatch ?? {
            client_id: clientId,
            is_duplicate: false,
            warning_severity: null,
            match_type: 'NONE',
            matched_fields: [],
            reason: null,
            extracted_preview: extractedPreview,
          }
        );
      }

      res.json({ matches });
    }
  );

  router.post(
    '/invoices/upload',
    requireAuth,
    requireRoles('OPERATOR', 'REVIEWER', 'ADMIN'),
    (req, res, next) => {
      upload.array('files', config.maxBatchFiles)(req, res, (err: any) => {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            sendError(req, res, 413, 'PAYLOAD_TOO_LARGE', 'File exceeds 25 MB maximum upload size.');
            return;
          }
          if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
            sendError(req, res, 400, 'UPLOAD_LIMIT_EXCEEDED', `Maximum ${config.maxBatchFiles} files allowed per batch under field "files".`);
            return;
          }
          sendError(req, res, 400, 'UPLOAD_ERROR', err.message || 'Upload failed.');
          return;
        }
        next();
      });
    },
    async (req, res) => {
      const files = (req.files as Express.Multer.File[]) || [];
      if (files.length === 0) {
        sendError(req, res, 400, 'NO_FILES', 'Please attach at least one PDF file.');
        return;
      }

      const autoStart = req.body?.auto_start !== 'false';
      const accepted: any[] = [];
      const rejected_files: Array<{ filename: string; reason: string }> = [];

      for (const file of files) {
        const check = validatePdfBuffer(file.buffer);
        if (!check.valid) {
          rejected_files.push({ filename: file.originalname, reason: check.reason || 'Invalid PDF' });
          continue;
        }
        const entry = await ingestBufferAndQueueRun({
          buffer: file.buffer,
          originalFilename: file.originalname,
          userId: req.user!.id,
          autoStart,
        });
        accepted.push(entry);
      }

      if (accepted.length === 0) {
        sendError(
          req,
          res,
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          rejected_files[0]?.reason || 'All uploaded files failed PDF validation.',
          { rejected_files }
        );
        return;
      }

      res.status(202).json({ accepted, rejected_files });
    }
  );

  router.post('/invoices/upload-fixture', requireAuth, requireRoles('OPERATOR', 'REVIEWER', 'ADMIN'), async (req, res) => {
    const key = String(req.body?.fixture_key ?? '');
    const meta = DEMO_FIXTURES.find((f) => f.key === key);
    if (!meta) {
      sendError(req, res, 404, 'NOT_FOUND', 'Demo fixture key not found.');
      return;
    }
    const fixturePath = path.join(config.fixturesDir, `${meta.key}.pdf`);
    let buf: Buffer;
    try {
      buf = await fs.readFile(fixturePath);
    } catch {
      await ensureDemoFixturesGenerated();
      buf = await fs.readFile(fixturePath);
    }
    const entry = await ingestBufferAndQueueRun({
      buffer: buf,
      originalFilename: meta.filename,
      userId: req.user!.id,
      autoStart: true,
    });
    res.status(202).json({ accepted: [entry], rejected_files: [] });
  });

  // ==================== INVOICES LIST, EXPORT, DETAIL, DOCUMENT ====================
  router.get('/invoices', requireAuth, async (req, res) => {
    const db = getDb();
    const page = parsePositiveInt(req.query.page, 1, 10_000);
    const pageSize = parsePositiveInt(req.query.page_size, 20, 100);
    const { whereSql, params, orderBy } = buildInvoiceFilterQuery(req.query);

    const total = (
      await db
        .prepare(
          `SELECT COUNT(*) AS c
           FROM invoices i
           LEFT JOIN vendors v ON v.id = i.vendor_id
           LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id
           WHERE ${whereSql}`
        )
        .get(...params) as { c: number }
    ).c;

    const rows = await db
      .prepare(
        `SELECT i.*, v.canonical_name AS vendor_canonical_name, v.verification_status AS vendor_verification_status,
                po.po_number AS matched_po_number, d.primary_reason_code, d.explanation AS decision_explanation,
                r.extraction_mode, r.duration_ms AS run_duration_ms, r.started_at AS run_started_at
         FROM invoices i
         LEFT JOIN vendors v ON v.id = i.vendor_id
         LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id
         LEFT JOIN decisions d ON d.id = i.latest_decision_id
         LEFT JOIN processing_runs r ON r.id = i.latest_run_id
         WHERE ${whereSql}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, (page - 1) * pageSize);

    res.json({ items: rows, total, page, page_size: pageSize });
  });

  router.get('/invoices/export', requireAuth, async (req, res) => {
    const db = getDb();
    const idsParam = req.query.ids
      ? String(req.query.ids)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 500)
      : [];
    const { whereSql, params, orderBy } = buildInvoiceFilterQuery(req.query, idsParam);

    const rows = await db
      .prepare(
        `SELECT i.id, i.invoice_number, i.document_type, i.original_filename,
                COALESCE(v.canonical_name, i.extracted_vendor_name) AS vendor_name,
                v.verification_status AS vendor_status,
                COALESCE(po.po_number, i.extracted_po_number) AS po_number,
                i.invoice_date, i.due_date, i.currency,
                i.subtotal_amount, i.tax_amount, i.discount_amount, i.total_amount,
                i.overall_confidence, r.extraction_mode, i.processing_status, i.business_decision,
                d.primary_reason_code, i.review_status, i.created_at
         FROM invoices i
         LEFT JOIN vendors v ON v.id = i.vendor_id
         LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id
         LEFT JOIN decisions d ON d.id = i.latest_decision_id
         LEFT JOIN processing_runs r ON r.id = i.latest_run_id
         WHERE ${whereSql}
         ORDER BY ${orderBy}`
      )
      .all(...params) as any[];

    const headers = [
      'id',
      'invoice_number',
      'document_type',
      'original_filename',
      'vendor_name',
      'vendor_status',
      'po_number',
      'invoice_date',
      'due_date',
      'currency',
      'subtotal_amount',
      'tax_amount',
      'discount_amount',
      'total_amount',
      'overall_confidence',
      'extraction_mode',
      'processing_status',
      'business_decision',
      'primary_reason_code',
      'review_status',
      'created_at',
    ];
    const csv = [
      headers.join(','),
      ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="invoicedesk_invoices_${isoNow().slice(0, 10)}.csv"`);
    res.send(csv);
  });

  router.get('/invoices/:invoiceId', requireAuth, async (req, res) => {
    const db = getDb();
    const invoice = await db
      .prepare(
        `SELECT i.*, v.canonical_name AS vendor_canonical_name, v.vendor_code, v.verification_status AS vendor_verification_status,
                po.po_number AS matched_po_number, po.original_amount AS po_original_amount, po.consumed_amount AS po_consumed_amount,
                po.status AS po_status, po.currency AS po_currency
         FROM invoices i
         LEFT JOIN vendors v ON v.id = i.vendor_id
         LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id
         WHERE i.id = ?`
      )
      .get(req.params.invoiceId) as any;

    if (!invoice) {
      sendError(req, res, 404, 'NOT_FOUND', 'Invoice not found.');
      return;
    }

    const requestedRunId = req.query.run_id ? String(req.query.run_id) : invoice.latest_run_id;
    const runsHistory = await db
      .prepare(
        `SELECT id, run_number, trigger_type, status, current_stage, extraction_mode, error_stage, error_message, started_at, completed_at, duration_ms, created_at
         FROM processing_runs WHERE invoice_id = ? ORDER BY run_number DESC`
      )
      .all(invoice.id) as any[];

    const activeRun =
      (requestedRunId
        ? await db.prepare('SELECT * FROM processing_runs WHERE id = ? AND invoice_id = ?').get(requestedRunId, invoice.id)
        : null) || runsHistory[0] || null;

    const stageEvents = activeRun
      ? (await db
          .prepare('SELECT * FROM stage_events WHERE run_id = ? ORDER BY id ASC')
          .all(activeRun.id) as any[]).map((ev) => ({
          ...ev,
          evidence: safeJsonParse<Record<string, unknown>>(ev.evidence_json, {}),
        }))
      : [];

    const lineItems = activeRun
      ? await db.prepare('SELECT * FROM invoice_lines WHERE run_id = ? ORDER BY line_number ASC').all(activeRun.id)
      : [];

    const decisionRow = activeRun
      ? (await db.prepare('SELECT * FROM decisions WHERE run_id = ?').get(activeRun.id) as any)
      : null;
    const decision = decisionRow
      ? {
          ...decisionRow,
          triggered_rules: safeJsonParse<any[]>(decisionRow.triggered_rules, []),
          evidence_snapshot: safeJsonParse<Record<string, unknown>>(decisionRow.evidence_snapshot, {}),
          explanation_details: safeJsonParse<Record<string, unknown>>(decisionRow.explanation_json, {}),
        }
      : null;

    const reviewActions = await db
      .prepare(
        `SELECT ra.*, u.full_name AS reviewer_name, u.email AS reviewer_email, u.role AS reviewer_role
         FROM review_actions ra
         JOIN users u ON u.id = ra.reviewer_id
         WHERE ra.invoice_id = ? ORDER BY ra.created_at DESC`
      )
      .all(invoice.id);

    const priorPoInvoices = invoice.purchase_order_id
      ? await db
          .prepare(
            `SELECT id, invoice_number, original_filename, total_amount, business_decision, review_status, created_at
             FROM invoices WHERE purchase_order_id = ? AND po_consumed_applied = 1 AND id != ?
             ORDER BY created_at ASC`
          )
          .all(invoice.purchase_order_id, invoice.id)
      : [];

    const rawExtracted = safeJsonParse<any>(activeRun?.raw_extracted_json, null);

    res.json({
      invoice,
      active_run: activeRun ? { ...activeRun, raw_extracted: rawExtracted } : null,
      runs_history: runsHistory,
      stage_events: stageEvents,
      line_items: lineItems,
      decision,
      review_actions: reviewActions,
      prior_po_invoices: priorPoInvoices,
    });
  });

  router.get('/invoices/:invoiceId/document', requireAuth, async (req, res) => {
    const db = getDb();
    const inv = await db
      .prepare('SELECT id, original_filename, storage_key FROM invoices WHERE id = ?')
      .get(req.params.invoiceId) as { id: string; original_filename: string; storage_key: string } | undefined;

    if (!inv) {
      sendError(req, res, 404, 'NOT_FOUND', 'Invoice not found.');
      return;
    }

    try {
      let buf: Buffer;
      try {
        buf = await readStoredPdf(inv.storage_key);
      } catch {
        const regenerated = await regenerateSeededInvoicePdfIfMissing(inv.id);
        if (!regenerated) throw new Error('DOCUMENT_MISSING');
        buf = regenerated;
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${sanitizeHeaderFilename(inv.original_filename)}"`
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(buf);
    } catch {
      sendError(req, res, 404, 'DOCUMENT_MISSING', 'Stored PDF file could not be read.');
    }
  });

  router.get('/invoices/:invoiceId/ocr-text', requireAuth, async (req, res) => {
    const db = getDb();
    const inv = await db.prepare('SELECT latest_run_id FROM invoices WHERE id = ?').get(req.params.invoiceId) as
      | { latest_run_id: string | null }
      | undefined;
    if (!inv?.latest_run_id) {
      sendError(req, res, 404, 'NOT_FOUND', 'Extraction data not found.');
      return;
    }
    const run = await db
      .prepare('SELECT extraction_mode, raw_extracted_json FROM processing_runs WHERE id = ?')
      .get(inv.latest_run_id) as { extraction_mode: string | null; raw_extracted_json: string | null } | undefined;

    let pages: any[] = [];
    if (run?.raw_extracted_json) {
      try {
        const parsed = JSON.parse(run.raw_extracted_json);
        pages = parsed.raw_ocr_pages || [];
      } catch {
        pages = [];
      }
    }
    res.json({ extraction_mode: run?.extraction_mode ?? 'NATIVE_TEXT', pages });
  });

  router.post('/invoices/:invoiceId/start', requireAuth, requireRoles('OPERATOR', 'REVIEWER', 'ADMIN'), async (req, res) => {
    const db = getDb();
    const inv = await db
      .prepare('SELECT id, latest_run_id, processing_status FROM invoices WHERE id = ?')
      .get(req.params.invoiceId) as
      | { id: string; latest_run_id: string | null; processing_status: string }
      | undefined;

    if (!inv || !inv.latest_run_id) {
      sendError(req, res, 404, 'NOT_FOUND', 'Invoice or queued run not found.');
      return;
    }

    const ifQueued = req.body?.if_queued === true;
    const run = await db
      .prepare('SELECT id, run_number, status, started_at, error_stage, error_message FROM processing_runs WHERE id = ?')
      .get(inv.latest_run_id) as
      | { id: string; run_number: number; status: string; started_at: string | null; error_stage: number | null; error_message: string | null }
      | undefined;

    if (!run || run.status !== 'QUEUED' || run.started_at) {
      if (run && ifQueued) {
        res.status(202).json({
          invoice_id: inv.id,
          run_id: run.id,
          run_number: run.run_number,
          processing_status: run.status,
          run_status: run.status,
          error_stage: run.error_stage ?? null,
          error_message: run.error_message ?? null,
          already_started: true,
        });
        return;
      }
      sendError(req, res, 409, 'INVALID_RUN_STATE', 'Only unstarted QUEUED runs can be started manually.');
      return;
    }

    await writeAuditLog({
      actorId: req.user!.id,
      actorType: 'USER',
      actorRole: req.user!.role,
      action: 'RUN_STARTED_MANUALLY',
      resourceType: 'INVOICE',
      resourceId: inv.id,
      details: { run_id: run.id, run_number: run.run_number },
    });

    const p = startProcessingRun(run.id);
    if (config.isServerless) {
      await p;
    }
    const finishedRun = await db
      .prepare('SELECT status, error_stage, error_message FROM processing_runs WHERE id = ?')
      .get(run.id) as { status: string; error_stage: number | null; error_message: string | null } | undefined;
    res.status(202).json({
      invoice_id: inv.id,
      run_id: run.id,
      run_number: run.run_number,
      processing_status: finishedRun?.status || 'QUEUED',
      run_status: finishedRun?.status || 'QUEUED',
      error_stage: finishedRun?.error_stage ?? null,
      error_message: finishedRun?.error_message ?? null,
    });
  });

  router.post('/invoices/:invoiceId/retry', requireAuth, requireRoles('OPERATOR', 'REVIEWER', 'ADMIN'), async (req, res) => {
    const db = getDb();
    const inv = await db
      .prepare(
        'SELECT id, processing_status, purchase_order_id, total_amount, po_consumed_applied FROM invoices WHERE id = ?'
      )
      .get(req.params.invoiceId) as
      | {
          id: string;
          processing_status: string;
          purchase_order_id: string | null;
          total_amount: string | null;
          po_consumed_applied: number;
        }
      | undefined;
    if (!inv) {
      sendError(req, res, 404, 'NOT_FOUND', 'Invoice not found.');
      return;
    }
    if (inv.processing_status === 'QUEUED' || inv.processing_status === 'RUNNING') {
      sendError(req, res, 409, 'RUN_ALREADY_ACTIVE', 'A processing run is already in progress for this invoice.');
      return;
    }

    const newRunId = crypto.randomUUID();
    const now = isoNow();

    const nextRunNumber = await withTransaction(db, async () => {
      // Reverse prior PO consumption if this invoice previously debited a PO so retry evaluates cleanly
      if (inv.po_consumed_applied === 1 && inv.purchase_order_id && inv.total_amount) {
        const totalDec = parseDecimalSafe(inv.total_amount);
        const po = await db
          .prepare('SELECT id, original_amount, consumed_amount, status FROM purchase_orders WHERE id = ?')
          .get(inv.purchase_order_id) as
          | { id: string; original_amount: string; consumed_amount: string; status: string }
          | undefined;
        if (po && totalDec && totalDec.gt(0) && po.status !== 'CANCELLED' && po.status !== 'CLOSED') {
          const orig = parseDecimalSafe(po.original_amount) ?? new Decimal(0);
          const currConsumed = parseDecimalSafe(po.consumed_amount) ?? new Decimal(0);
          const nextConsumed = Decimal.max(new Decimal(0), currConsumed.minus(totalDec));
          const nextPoStatus = nextConsumed.gte(orig)
            ? 'FULLY_CONSUMED'
            : nextConsumed.gt(0)
              ? 'PARTIALLY_CONSUMED'
              : 'OPEN';
          await db.prepare('UPDATE purchase_orders SET consumed_amount = ?, status = ?, updated_at = ? WHERE id = ?').run(
            nextConsumed.toFixed(4),
            nextPoStatus,
            now,
            po.id
          );
        }
      }

      const lastRun = await db
        .prepare('SELECT MAX(run_number) AS max_num FROM processing_runs WHERE invoice_id = ?')
        .get(inv.id) as { max_num: number | null };
      const runNumber = (lastRun?.max_num ?? 0) + 1;

      await db.prepare(
        `INSERT INTO processing_runs (id, invoice_id, run_number, trigger_type, triggered_by, status, current_stage, created_at)
         VALUES (?, ?, ?, 'RETRY', ?, 'QUEUED', 0, ?)`
      ).run(newRunId, inv.id, runNumber, req.user!.id, now);

      await db.prepare(
        `UPDATE invoices SET
           processing_status = 'QUEUED',
           business_decision = 'PENDING',
           review_status = 'NOT_REQUIRED',
           vendor_id = NULL,
           purchase_order_id = NULL,
           po_consumed_applied = 0,
           latest_run_id = ?,
           latest_decision_id = NULL,
           updated_at = ?
         WHERE id = ?`
      ).run(newRunId, now, inv.id);

      await writeAuditLog({
        actorId: req.user!.id,
        actorType: 'USER',
        actorRole: req.user!.role,
        action: 'RUN_RETRIED',
        resourceType: 'INVOICE',
        resourceId: inv.id,
        details: { new_run_id: newRunId, run_number: runNumber, reason: req.body?.reason ?? 'Manual retry' },
      });

      return runNumber;
    });

    if (!config.isServerless) {
      void startProcessingRun(newRunId);
    }
    const persistedRun = await db
      .prepare('SELECT status, error_stage, error_message FROM processing_runs WHERE id = ?')
      .get(newRunId) as { status: string; error_stage: number | null; error_message: string | null } | undefined;
    res.status(202).json({
      invoice_id: inv.id,
      run_id: newRunId,
      run_number: nextRunNumber,
      processing_status: persistedRun?.status || 'QUEUED',
      run_status: persistedRun?.status || 'QUEUED',
      error_stage: persistedRun?.error_stage ?? null,
      error_message: persistedRun?.error_message ?? null,
      serverless_async: config.isServerless,
    });
  });

  // ==================== PROCESSING RUNS & SSE STREAM ====================
  router.get('/runs', requireAuth, async (req, res) => {
    const db = getDb();
    const status = String(req.query.status ?? '').trim();
    const page = parsePositiveInt(req.query.page, 1, 10_000);
    const pageSize = parsePositiveInt(req.query.page_size, 25, 100);

    const where = status && status !== 'ALL' ? 'WHERE r.status = ?' : '';
    const params = status && status !== 'ALL' ? [status] : [];

    const total = (
      await db.prepare(`SELECT COUNT(*) AS c FROM processing_runs r ${where}`).get(...params) as { c: number }
    ).c;

    const items = await db
      .prepare(
        `SELECT r.*, i.original_filename, i.invoice_number, i.business_decision, i.total_amount, i.currency,
                COALESCE(v.canonical_name, i.extracted_vendor_name) AS vendor_name
         FROM processing_runs r
         JOIN invoices i ON i.id = r.invoice_id
         LEFT JOIN vendors v ON v.id = i.vendor_id
         ${where}
         ORDER BY r.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, (page - 1) * pageSize);

    res.json({ items, total, page, page_size: pageSize });
  });

  router.get('/runs/:runId', requireAuth, async (req, res) => {
    const db = getDb();
    const run = await db.prepare('SELECT * FROM processing_runs WHERE id = ?').get(req.params.runId) as any;
    if (!run) {
      sendError(req, res, 404, 'NOT_FOUND', 'Processing run not found.');
      return;
    }
    const events = (
      await db.prepare('SELECT * FROM stage_events WHERE run_id = ? ORDER BY id ASC').all(run.id) as any[]
    ).map((ev) => ({ ...ev, evidence: safeJsonParse<Record<string, unknown>>(ev.evidence_json, {}) }));
    res.json({ run, stage_events: events });
  });

  router.get('/runs/:runId/events', requireAuth, async (req, res) => {
    const runId = String(req.params.runId);
    const db = getDb();
    const run = await db.prepare('SELECT id, invoice_id, status, duration_ms FROM processing_runs WHERE id = ?').get(runId) as
      | { id: string; invoice_id: string; status: string; duration_ms: number | null }
      | undefined;

    if (!run) {
      sendError(req, res, 404, 'NOT_FOUND', 'Processing run not found.');
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    safeSseWrite(res, 'retry: 3000\n\n');

    const lastEventIdHeader = req.header('Last-Event-ID') || String(req.query.lastEventId ?? '0');
    let lastSentId = Number.parseInt(lastEventIdHeader, 10) || 0;

    const writeSse = (payload: SseEventPayload) => {
      if (payload.id <= lastSentId && payload.event !== 'run_completed' && payload.event !== 'run_failed') {
        return;
      }
      lastSentId = Math.max(lastSentId, payload.id);
      safeSseWrite(res, `id: ${payload.id}\nevent: ${payload.event}\ndata: ${JSON.stringify(payload.data)}\n\n`);
    };

    const replayAndCheckTerminal = async (): Promise<boolean> => {
      const missed = await db
        .prepare('SELECT * FROM stage_events WHERE run_id = ? AND id > ? ORDER BY id ASC')
        .all(runId, lastSentId) as any[];

      for (const ev of missed) {
        const evType =
          ev.status === 'STARTED'
            ? 'stage_started'
            : ev.status === 'FAILED'
              ? 'stage_failed'
              : 'stage_completed';
        writeSse({
          id: ev.id,
          event: evType,
          data: {
            id: ev.id,
            run_id: ev.run_id,
            stage_number: ev.stage_number,
            stage_code: ev.stage_code,
            status: ev.status,
            summary: ev.summary,
            duration_ms: ev.duration_ms,
            evidence: safeJsonParse<Record<string, unknown>>(ev.evidence_json, {}),
            timestamp: ev.created_at,
          },
        });
      }

      const currentRun = await db
        .prepare('SELECT status, error_stage, error_message, duration_ms FROM processing_runs WHERE id = ?')
        .get(runId) as
        | { status: string; error_stage: number | null; error_message: string | null; duration_ms: number | null }
        | undefined;

      if (!currentRun) {
        if (!res.writableEnded) res.end();
        return true;
      }

      if (currentRun.status === 'COMPLETED') {
        const inv = await db
          .prepare('SELECT business_decision, review_status FROM invoices WHERE id = ?')
          .get(run.invoice_id) as { business_decision: string; review_status: string } | undefined;
        safeSseWrite(
          res,
          `id: ${lastSentId + 1}\nevent: run_completed\ndata: ${JSON.stringify({
            run_id: runId,
            invoice_id: run.invoice_id,
            processing_status: 'COMPLETED',
            business_decision: inv?.business_decision ?? 'PENDING',
            review_status: inv?.review_status ?? 'NOT_REQUIRED',
            duration_ms: currentRun.duration_ms,
          })}\n\n`
        );
        if (!res.writableEnded) res.end();
        return true;
      }

      if (currentRun.status === 'FAILED') {
        safeSseWrite(
          res,
          `id: ${lastSentId + 1}\nevent: run_failed\ndata: ${JSON.stringify({
            run_id: runId,
            invoice_id: run.invoice_id,
            processing_status: 'FAILED',
            error_stage: currentRun.error_stage,
            error_message: currentRun.error_message,
          })}\n\n`
        );
        if (!res.writableEnded) res.end();
        return true;
      }

      return false;
    };

    if (await replayAndCheckTerminal()) {
      return;
    }

    const onEvent = (payload: SseEventPayload) => {
      writeSse(payload);
      if (payload.event === 'run_completed' || payload.event === 'run_failed') {
        cleanup();
        if (!res.writableEnded) res.end();
      }
    };

    const heartbeat = setInterval(() => {
      if (!safeSseWrite(res, ': heartbeat\n\n')) {
        cleanup();
      }
    }, 15000);

    const dbPoll = config.isServerless
      ? setInterval(async () => {
          if (await replayAndCheckTerminal()) {
            cleanup();
          }
        }, 1500)
      : null;

    // Gracefully end SSE before Vercel's 60s maxDuration so EventSource reconnects cleanly
    const serverlessMaxLifetime = config.isServerless
      ? setTimeout(() => {
          cleanup();
          if (!res.writableEnded) res.end();
        }, 45_000)
      : null;

    const cleanup = () => {
      clearInterval(heartbeat);
      if (dbPoll) clearInterval(dbPoll);
      if (serverlessMaxLifetime) clearTimeout(serverlessMaxLifetime);
      sseBroker.off(`run:${runId}`, onEvent);
    };

    sseBroker.on(`run:${runId}`, onEvent);
    req.on('close', cleanup);
  });

  // ==================== REVIEW QUEUE & OVERRIDES ====================
  router.get('/reviews', requireAuth, async (req, res) => {
    const db = getDb();
    const status = String(req.query.status ?? 'PENDING_REVIEW');
    const category = String(req.query.category ?? 'ALL');

    let statusWhere = "i.review_status = 'PENDING_REVIEW'";
    if (status === 'RESOLVED') {
      statusWhere = "i.review_status IN ('APPROVED_BY_HUMAN', 'REJECTED_BY_HUMAN')";
    }

    const rows = await db
      .prepare(
        `SELECT i.*, COALESCE(v.canonical_name, i.extracted_vendor_name) AS vendor_name,
                po.po_number AS matched_po_number, po.original_amount AS po_original_amount, po.consumed_amount AS po_consumed_amount,
                d.outcome AS original_decision, d.primary_reason_code, d.triggered_rules, d.explanation,
                d.explanation_source, d.explanation_provider, d.explanation_model, d.explanation_status,
                d.explanation_fallback_reason, d.explanation_json,
                u.full_name AS assigned_reviewer_name
         FROM invoices i
         LEFT JOIN vendors v ON v.id = i.vendor_id
         LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id
         LEFT JOIN decisions d ON d.id = i.latest_decision_id
         LEFT JOIN users u ON u.id = i.assigned_reviewer_id
         WHERE ${statusWhere}
         ORDER BY i.created_at DESC`
      )
      .all() as any[];

    const mapped = rows
      .map((r) => ({
        ...r,
        triggered_rules: safeJsonParse<any[]>(r.triggered_rules, []),
        explanation_details: safeJsonParse<Record<string, unknown>>(r.explanation_json, {}),
      }))
      .filter((r) => {
        if (category === 'ALL') return true;
        const code = r.primary_reason_code || '';
        if (category === 'VARIANCE') return code === 'TOLERANCE_EXCEEDED' || code === 'EXCEEDS_AUTO_APPROVE_CAP';
        if (category === 'CONFIDENCE_MISSING')
          return code === 'LOW_EXTRACTION_CONFIDENCE' || code === 'MISSING_REQUIRED_FIELD' || code === 'ARITHMETIC_MISMATCH';
        if (category === 'VENDOR_PO')
          return code.startsWith('VENDOR_') || code.startsWith('PO_') || code === 'CREDIT_NOTE_REVIEW';
        return true;
      });

    res.json({ items: mapped, total: mapped.length });
  });

  router.post('/reviews/:invoiceId/assign', requireAuth, requireRoles('REVIEWER', 'ADMIN'), async (req, res) => {
    const db = getDb();
    const reviewerId = String(req.body?.reviewer_id || req.user!.id).trim();
    const targetReviewer = await db
      .prepare('SELECT id, full_name, role, is_active FROM users WHERE id = ?')
      .get(reviewerId) as { id: string; full_name: string; role: string; is_active: number } | undefined;

    if (!targetReviewer || targetReviewer.is_active !== 1 || !['REVIEWER', 'ADMIN'].includes(targetReviewer.role)) {
      sendError(
        req,
        res,
        422,
        'VALIDATION_ERROR',
        'Assigned reviewer must be an active user with REVIEWER or ADMIN role.'
      );
      return;
    }

    const inv = await db
      .prepare('SELECT id, latest_decision_id, review_status FROM invoices WHERE id = ?')
      .get(req.params.invoiceId) as { id: string; latest_decision_id: string | null; review_status: string } | undefined;

    if (!inv) {
      sendError(req, res, 404, 'NOT_FOUND', 'Invoice not found.');
      return;
    }
    if (!inv.latest_decision_id || inv.review_status !== 'PENDING_REVIEW') {
      sendError(
        req,
        res,
        409,
        'INVALID_STATE',
        `Only PENDING_REVIEW invoices can be assigned (current status: ${inv.review_status}).`
      );
      return;
    }

    const now = isoNow();
    await withTransaction(db, async () => {
      await db.prepare('UPDATE invoices SET assigned_reviewer_id = ?, updated_at = ? WHERE id = ?').run(
        reviewerId,
        now,
        inv.id
      );
      await db.prepare(
        `INSERT INTO review_actions (id, invoice_id, decision_id, reviewer_id, action, note, created_at)
         VALUES (?, ?, ?, ?, 'ASSIGN', ?, ?)`
      ).run(crypto.randomUUID(), inv.id, inv.latest_decision_id, req.user!.id, `Assigned reviewer ${targetReviewer.full_name}`, now);

      await writeAuditLog({
        actorId: req.user!.id,
        actorType: 'USER',
        actorRole: req.user!.role,
        action: 'REVIEW_ASSIGNED',
        resourceType: 'INVOICE',
        resourceId: inv.id,
        details: { assigned_reviewer_id: reviewerId, assigned_reviewer_name: targetReviewer.full_name },
      });
    });

    res.json({ ok: true, assigned_reviewer_id: reviewerId, assigned_reviewer_name: targetReviewer.full_name });
  });

  router.post('/invoices/:invoiceId/review', requireAuth, requireRoles('REVIEWER', 'ADMIN'), async (req, res) => {
    const action = String(req.body?.action ?? '');
    const note = String(req.body?.note ?? '').trim();

    if (!['APPROVE_OVERRIDE', 'REJECT_OVERRIDE'].includes(action)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'Action must be APPROVE_OVERRIDE or REJECT_OVERRIDE.');
      return;
    }
    if (note.length < 10) {
      sendError(
        req,
        res,
        422,
        'VALIDATION_ERROR',
        'Mandatory reviewer justification note must be at least 10 characters.',
        { field: 'note' }
      );
      return;
    }

    const db = getDb();
    const now = isoNow();

    const outcome = await db.transaction(async () => {
      const inv = await db
        .prepare(
          `SELECT id, uploaded_by, invoice_number, original_filename, purchase_order_id, total_amount, po_consumed_applied, business_decision, review_status, latest_decision_id
           FROM invoices WHERE id = ?`
        )
        .get(req.params.invoiceId) as any;

      if (!inv) {
        sendError(req, res, 404, 'NOT_FOUND', 'Invoice not found.');
        return null;
      }
      if (!inv.latest_decision_id) {
        sendError(req, res, 409, 'INVALID_STATE', 'Invoice has not completed automated processing yet.');
        return null;
      }

      if (inv.review_status !== 'PENDING_REVIEW') {
        sendError(
          req,
          res,
          409,
          'CONCURRENT_REVIEW_CONFLICT',
          `This invoice was already resolved (${inv.review_status}).`
        );
        return null;
      }

      const policySettings = await db
        .prepare('SELECT enforce_separation_of_duties, reviewer_approval_limit FROM application_settings WHERE id = 1')
        .get() as
        | { enforce_separation_of_duties?: number; reviewer_approval_limit?: string | null }
        | undefined;

      if ((policySettings?.enforce_separation_of_duties ?? 1) === 1 && inv.uploaded_by === req.user!.id) {
        sendError(
          req,
          res,
          403,
          'SEPARATION_OF_DUTIES_VIOLATION',
          'Separation of duties prevents you from reviewing an invoice you uploaded. Another Reviewer or Administrator must resolve this exception.',
          { uploaded_by: inv.uploaded_by, actor_id: req.user!.id }
        );
        return null;
      }

      const limitDec = parseDecimalSafe(policySettings?.reviewer_approval_limit);
      const totalDec = parseDecimalSafe(inv.total_amount);
      if (action === 'APPROVE_OVERRIDE' && req.user!.role === 'REVIEWER' && limitDec && totalDec) {
        if (totalDec.gt(limitDec)) {
          sendError(
            req,
            res,
            403,
            'APPROVAL_LIMIT_EXCEEDED',
            `Invoice total ($${totalDec.toFixed(2)}) exceeds the Reviewer override cap ($${limitDec.toFixed(2)}). An Administrator must approve this override.`,
            {
              invoice_total: totalDec.toFixed(2),
              reviewer_approval_limit: limitDec.toFixed(2),
            }
          );
          return null;
        }
      }

      const newReviewStatus = action === 'APPROVE_OVERRIDE' ? 'APPROVED_BY_HUMAN' : 'REJECTED_BY_HUMAN';

      // Atomic PO debit on human approval if not already applied
      if (action === 'APPROVE_OVERRIDE' && inv.purchase_order_id && inv.po_consumed_applied === 0 && totalDec) {
        const po = await db
          .prepare('SELECT id, original_amount, consumed_amount, status FROM purchase_orders WHERE id = ?')
          .get(inv.purchase_order_id) as
          | { id: string; original_amount: string; consumed_amount: string; status: string }
          | undefined;
        if (po && po.status !== 'CANCELLED') {
          const orig = parseDecimalSafe(po.original_amount) ?? new Decimal(0);
          const currConsumed = parseDecimalSafe(po.consumed_amount) ?? new Decimal(0);
          const newConsumed = Decimal.max(new Decimal(0), currConsumed.plus(totalDec));
          const newPoStatus =
            po.status === 'CLOSED'
              ? 'CLOSED'
              : newConsumed.gte(orig)
                ? 'FULLY_CONSUMED'
                : newConsumed.gt(0)
                  ? 'PARTIALLY_CONSUMED'
                  : 'OPEN';
          await db.prepare('UPDATE purchase_orders SET consumed_amount = ?, status = ?, updated_at = ? WHERE id = ?').run(
            newConsumed.toFixed(4),
            newPoStatus,
            now,
            po.id
          );
          await db.prepare('UPDATE invoices SET po_consumed_applied = 1 WHERE id = ?').run(inv.id);
        }
      }

      await db.prepare('UPDATE invoices SET review_status = ?, updated_at = ? WHERE id = ?').run(
        newReviewStatus,
        now,
        inv.id
      );

      const actionId = crypto.randomUUID();
      await db.prepare(
        `INSERT INTO review_actions (id, invoice_id, decision_id, reviewer_id, action, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(actionId, inv.id, inv.latest_decision_id, req.user!.id, action, note, now);

      await writeAuditLog({
        actorId: req.user!.id,
        actorType: 'USER',
        actorRole: req.user!.role,
        action: action === 'APPROVE_OVERRIDE' ? 'REVIEW_OVERRIDE_APPROVED' : 'REVIEW_OVERRIDE_REJECTED',
        resourceType: 'INVOICE',
        resourceId: inv.id,
        originalDecision: inv.business_decision,
        newDecision: newReviewStatus,
        details: { note, decision_id: inv.latest_decision_id, review_action_id: actionId },
      });

      return { inv, newReviewStatus, actionId };
    });

    if (!outcome) return;
    const { inv, newReviewStatus, actionId } = outcome;

    await createWorkspaceNotification({
      eventType: 'REVIEW_RESOLVED',
      severity: 'INFO',
      title: action === 'APPROVE_OVERRIDE' ? 'Manual Review Approved' : 'Manual Review Rejected',
      message: `${inv.invoice_number || inv.original_filename} resolved by ${req.user!.full_name} (${newReviewStatus}).`,
      invoiceId: inv.id,
      actorId: req.user!.id,
      metadata: { action, review_status: newReviewStatus },
    });

    res.json({
      ok: true,
      invoice_id: inv.id,
      original_decision: inv.business_decision,
      review_status: newReviewStatus,
      review_action_id: actionId,
    });
  });

  // ==================== GEMINI FLASH DECISION EXPLANATION ====================
  router.post('/invoices/:invoiceId/explain', requireAuth, requireRoles('REVIEWER', 'ADMIN'), async (req, res) => {
    const db = getDb();
    const inv = await db
      .prepare(
        `SELECT i.*, v.canonical_name AS vendor_canonical_name, v.verification_status AS vendor_verification_status,
                po.po_number AS matched_po_number
         FROM invoices i
         LEFT JOIN vendors v ON v.id = i.vendor_id
         LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id
         WHERE i.id = ?`
      )
      .get(req.params.invoiceId) as any;

    if (!inv) {
      sendError(req, res, 404, 'NOT_FOUND', 'Invoice not found.');
      return;
    }

    if (inv.processing_status !== 'COMPLETED' || !inv.latest_decision_id) {
      sendError(
        req,
        res,
        409,
        'INVALID_STATE',
        'Gemini Flash decision explanations are available after the processing pipeline completes.'
      );
      return;
    }

    const decisionRow = await db
      .prepare('SELECT * FROM decisions WHERE id = ?')
      .get(inv.latest_decision_id) as any;

    if (!decisionRow) {
      sendError(req, res, 404, 'NOT_FOUND', 'Decision record not found for this invoice.');
      return;
    }

    const triggeredRules = safeJsonParse<any[]>(decisionRow.triggered_rules, []);
    const evidenceSnapshot = safeJsonParse<Record<string, any>>(decisionRow.evidence_snapshot, {});
    const deterministicSummary =
      typeof evidenceSnapshot.deterministic_rule_summary === 'string' &&
      evidenceSnapshot.deterministic_rule_summary.trim()
        ? evidenceSnapshot.deterministic_rule_summary
        : decisionRow.explanation;

    let candidatePos: Array<{ po_number: string; remaining_amount: string; currency?: string }> =
      Array.isArray(evidenceSnapshot.poMatch?.candidatePos)
        ? evidenceSnapshot.poMatch.candidatePos
        : [];

    if (candidatePos.length === 0 && inv.vendor_id) {
      const openPos = await db
        .prepare(
          `SELECT po_number, original_amount, consumed_amount, currency
           FROM purchase_orders
           WHERE vendor_id = ? AND status IN ('OPEN', 'PARTIALLY_CONSUMED')
           ORDER BY created_at DESC LIMIT 5`
        )
        .all(inv.vendor_id) as Array<{
        po_number: string;
        original_amount: string;
        consumed_amount: string;
        currency: string;
      }>;
      candidatePos = openPos.map((po) => {
        const orig = parseDecimalSafe(po.original_amount) ?? new Decimal(0);
        const cons = parseDecimalSafe(po.consumed_amount) ?? new Decimal(0);
        const rem = Decimal.max(new Decimal(0), orig.minus(cons));
        return {
          po_number: po.po_number,
          remaining_amount: rem.toFixed(2),
          currency: po.currency,
        };
      });
    }

    try {
      const result = await generateDecisionExplanation({
        outcome: decisionRow.outcome,
        primaryReasonCode: decisionRow.primary_reason_code,
        deterministicSummary,
        triggeredRules,
        invoice: {
          vendor_name: inv.vendor_canonical_name || inv.extracted_vendor_name || null,
          invoice_number: inv.invoice_number || null,
          invoice_date: inv.invoice_date || null,
          po_number: inv.matched_po_number || inv.extracted_po_number || null,
          currency: inv.currency || null,
          subtotal_amount: inv.subtotal_amount || null,
          tax_amount: inv.tax_amount || null,
          total_amount: inv.total_amount || null,
        },
        evidenceSummary: {
          vendor_match: evidenceSnapshot.vendor?.matchMethod ?? null,
          vendor_status: inv.vendor_verification_status ?? evidenceSnapshot.vendor?.vendorStatus ?? null,
          duplicate_match: evidenceSnapshot.duplicate?.matchType ?? null,
          po_match_status: evidenceSnapshot.poMatch?.matchStatus ?? null,
          po_remaining_before: evidenceSnapshot.tolerance?.remainingBefore ?? null,
          po_remaining_after: evidenceSnapshot.tolerance?.remainingAfter ?? null,
          overrun_amount: evidenceSnapshot.tolerance?.overrunAmount ?? null,
          allowed_cap: evidenceSnapshot.tolerance?.allowedCap ?? null,
        },
        candidatePos,
        throwOnError: true,
      });

      const explanationRecord = buildExplanationRecord({
        input: {
          outcome: decisionRow.outcome,
          primaryReasonCode: decisionRow.primary_reason_code,
          triggeredRules,
          evidenceSnapshot,
          invoice: {
            filename: inv.original_filename,
            vendor: inv.vendor_canonical_name || inv.extracted_vendor_name || null,
            invoiceNumber: inv.invoice_number || null,
            currency: inv.currency || null,
            subtotal: inv.subtotal_amount || null,
            tax: inv.tax_amount || null,
            total: inv.total_amount || null,
            purchaseOrder: inv.matched_po_number || inv.extracted_po_number || null,
          },
        },
        aiExplanation: result,
      });

      const aiReviewerBrief =
        decisionRow.outcome !== 'APPROVE'
          ? {
              summary: result.explanation,
              recommended_action: result.recommended_action,
              verification_checks: result.verification_checks,
              suggested_po_number: result.suggested_po_number,
              generated_by_model: result.generated_by_model,
            }
          : null;

      const updatedSnapshot: Record<string, unknown> = {
        ...evidenceSnapshot,
        deterministic_rule_summary: deterministicSummary,
        ai_decision_explanation: result,
      };
      delete updatedSnapshot.ai_explanation_error;
      if (aiReviewerBrief) {
        updatedSnapshot.ai_reviewer_brief = aiReviewerBrief;
      }

      await db.prepare(
        `UPDATE decisions SET
           explanation = ?,
           evidence_snapshot = ?,
           explanation_source = ?,
           explanation_provider = ?,
           explanation_model = ?,
           explanation_prompt_version = ?,
           explanation_status = ?,
           explanation_generated_at = ?,
           explanation_input_tokens = ?,
           explanation_output_tokens = ?,
           explanation_fallback_reason = ?,
           explanation_json = ?
         WHERE id = ?`
      ).run(
        result.explanation,
        JSON.stringify(updatedSnapshot),
        explanationRecord.explanation_source,
        explanationRecord.explanation_provider,
        explanationRecord.explanation_model,
        explanationRecord.prompt_version,
        explanationRecord.generation_status,
        explanationRecord.generated_at,
        explanationRecord.token_usage.input,
        explanationRecord.token_usage.output,
        explanationRecord.fallback_reason,
        JSON.stringify(explanationRecord),
        decisionRow.id
      );

      await writeAuditLog({
        actorId: req.user!.id,
        actorType: 'USER',
        actorRole: req.user!.role,
        action: 'AI_DECISION_EXPLAINED',
        resourceType: 'INVOICE',
        resourceId: inv.id,
        originalDecision: decisionRow.outcome,
        newDecision: decisionRow.outcome,
        details: {
          decision_id: decisionRow.id,
          primary_reason_code: decisionRow.primary_reason_code,
          explanation: result.explanation,
          model: result.generated_by_model,
        },
      });

      res.json({
        explanation: result.explanation,
        ai_decision_explanation: result,
        ai_reviewer_brief: aiReviewerBrief,
        explanation_details: explanationRecord,
      });
    } catch (err) {
      if (err instanceof GeminiConfigurationError) {
        sendError(req, res, 503, 'GEMINI_NOT_CONFIGURED', err.message);
        return;
      }
      const message = err instanceof Error ? err.message : 'Unable to generate Gemini Flash explanation.';
      const status =
        /\b403\b|PERMISSION_DENIED/i.test(message)
          ? 403
          : /\b429\b|RESOURCE_EXHAUSTED/i.test(message)
            ? 429
            : /\b400\b|API_KEY_INVALID/i.test(message)
              ? 400
              : 502;
      sendError(req, res, status, 'GEMINI_GENERATION_FAILED', message);
    }
  });

  router.post('/invoices/:invoiceId/rejection-draft', requireAuth, requireRoles('REVIEWER', 'ADMIN'), async (req, res) => {
    const rawTone = String(req.body?.tone ?? 'formal').toLowerCase();
    const tone: RejectionNoticeTone =
      rawTone === 'collaborative' || rawTone === 'concise' ? rawTone : 'formal';
    const customInstructions =
      typeof req.body?.custom_instructions === 'string'
        ? req.body.custom_instructions.trim().slice(0, 300)
        : null;

    const db = getDb();
    const inv = await db
      .prepare(
        `SELECT i.*, v.canonical_name AS vendor_canonical_name, v.verification_status AS vendor_verification_status,
                po.po_number AS matched_po_number
         FROM invoices i
         LEFT JOIN vendors v ON v.id = i.vendor_id
         LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id
         WHERE i.id = ?`
      )
      .get(req.params.invoiceId) as any;

    if (!inv || !inv.latest_decision_id) {
      sendError(req, res, 404, 'NOT_FOUND', 'Invoice or decision record not found.');
      return;
    }

    const decisionRow = await db
      .prepare('SELECT * FROM decisions WHERE id = ?')
      .get(inv.latest_decision_id) as any;

    if (!decisionRow) {
      sendError(req, res, 404, 'NOT_FOUND', 'Decision record not found for this invoice.');
      return;
    }

    const isEligible =
      decisionRow.outcome === 'REJECT' ||
      decisionRow.outcome === 'REVIEW' ||
      inv.business_decision === 'REJECT' ||
      inv.review_status === 'REJECTED_BY_HUMAN';

    if (!isEligible) {
      sendError(
        req,
        res,
        409,
        'INVALID_STATE',
        'AI rejection explanations and vendor rejection emails are only available for rejected or exception-review invoices.'
      );
      return;
    }

    const latestRejectOverride = await db
      .prepare(
        `SELECT ra.action, ra.note, ra.created_at, u.full_name AS reviewer_name, u.role AS reviewer_role
         FROM review_actions ra
         JOIN users u ON u.id = ra.reviewer_id
         WHERE ra.invoice_id = ? AND ra.action IN ('REJECT_OVERRIDE', 'COMMENT')
         ORDER BY ra.created_at DESC LIMIT 1`
      )
      .get(inv.id) as
      | {
          action: string;
          note: string;
          created_at: string;
          reviewer_name: string;
          reviewer_role: string;
        }
      | undefined;

    const appSettings = await db
      .prepare(
        'SELECT workspace_name, rejection_email_subject_template, rejection_email_body_template FROM application_settings WHERE id = 1'
      )
      .get() as
      | {
          workspace_name: string;
          rejection_email_subject_template?: string;
          rejection_email_body_template?: string;
        }
      | undefined;

    const subjectTemplate =
      typeof req.body?.subject_template === 'string' && req.body.subject_template.trim()
        ? req.body.subject_template.trim().slice(0, 300)
        : appSettings?.rejection_email_subject_template || null;
    const bodyTemplate =
      typeof req.body?.body_template === 'string' && req.body.body_template.trim()
        ? req.body.body_template.trim().slice(0, 4000)
        : appSettings?.rejection_email_body_template || null;

    const triggeredRules = safeJsonParse<any[]>(decisionRow.triggered_rules, []);
    const evidenceSnapshot = safeJsonParse<Record<string, any>>(decisionRow.evidence_snapshot, {});

    try {
      const draft = await generateRejectionNoticeDraft({
        workspaceName: appSettings?.workspace_name || 'InvoiceDesk',
        tone,
        customInstructions,
        subjectTemplate,
        bodyTemplate,
        invoice: {
          id: inv.id,
          invoice_number: inv.invoice_number,
          original_filename: inv.original_filename,
          document_type: inv.document_type,
          vendor_name: inv.vendor_canonical_name || inv.extracted_vendor_name || null,
          vendor_status: inv.vendor_verification_status || null,
          po_number: inv.matched_po_number || inv.extracted_po_number || null,
          invoice_date: inv.invoice_date,
          due_date: inv.due_date,
          currency: inv.currency,
          subtotal_amount: inv.subtotal_amount,
          tax_amount: inv.tax_amount,
          total_amount: inv.total_amount,
          business_decision: inv.business_decision,
          review_status: inv.review_status,
        },
        decision: {
          outcome: decisionRow.outcome,
          primary_reason_code: decisionRow.primary_reason_code,
          explanation: decisionRow.explanation,
          triggered_rules: triggeredRules,
          evidence_snapshot: evidenceSnapshot,
        },
        humanReviewOverride: latestRejectOverride ?? null,
      });

      const updatedSnapshot = {
        ...evidenceSnapshot,
        ai_rejection_notice: draft,
      };
      await db.prepare('UPDATE decisions SET evidence_snapshot = ? WHERE id = ?').run(
        JSON.stringify(updatedSnapshot),
        decisionRow.id
      );

      await writeAuditLog({
        actorId: req.user!.id,
        actorType: 'USER',
        actorRole: req.user!.role,
        action: 'AI_REJECTION_DRAFT_GENERATED',
        resourceType: 'INVOICE',
        resourceId: inv.id,
        originalDecision: decisionRow.outcome,
        newDecision: inv.review_status === 'REJECTED_BY_HUMAN' ? 'REJECTED_BY_HUMAN' : decisionRow.outcome,
        details: {
          tone: draft.tone,
          model: draft.generated_by_model,
          decision_id: decisionRow.id,
          has_custom_instructions: Boolean(customInstructions),
        },
      });

      res.json({ draft });
    } catch (err) {
      if (err instanceof GeminiConfigurationError) {
        sendError(req, res, 503, 'GEMINI_NOT_CONFIGURED', err.message);
        return;
      }
      const message = err instanceof Error ? err.message : 'Unable to generate AI rejection draft.';
      const status =
        /\b403\b|PERMISSION_DENIED/i.test(message)
          ? 403
          : /\b429\b|RESOURCE_EXHAUSTED/i.test(message)
            ? 429
            : /\b400\b|API_KEY_INVALID/i.test(message)
              ? 400
              : 502;
      sendError(req, res, status, 'GEMINI_GENERATION_FAILED', message);
    }
  });

  // ==================== VENDORS ====================
  router.get('/vendors', requireAuth, async (req, res) => {
    const db = getDb();
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const status = String(req.query.status ?? '').trim();

    const rows = await db
      .prepare(
        `SELECT v.*,
                (SELECT COUNT(*) FROM purchase_orders po WHERE po.vendor_id = v.id AND po.status IN ('OPEN','PARTIALLY_CONSUMED')) AS open_po_count,
                (SELECT COUNT(*) FROM invoices i WHERE i.vendor_id = v.id) AS invoice_count,
                (SELECT COUNT(*) FROM invoices i WHERE i.vendor_id = v.id AND i.business_decision IN ('REVIEW','REJECT')) AS exception_count
         FROM vendors v
         ORDER BY v.vendor_code ASC`
      )
      .all() as any[];

    const items = rows
      .map((v) => ({
        ...v,
        aliases: safeJsonParse<string[]>(v.aliases, []),
      }))
      .filter((v) => {
        if (status && status !== 'ALL' && v.verification_status !== status) return false;
        if (!q) return true;
        return (
          v.canonical_name.toLowerCase().includes(q) ||
          v.vendor_code.toLowerCase().includes(q) ||
          (v.tax_id || '').toLowerCase().includes(q) ||
          v.aliases.some((a: string) => a.toLowerCase().includes(q))
        );
      });

    res.json({ items, total: items.length });
  });

  router.get('/vendors/report', requireAuth, async (req, res) => {
    const db = getDb();
    const items = await buildVendorReportRows(db, {
      q: String(req.query.q ?? ''),
      status: String(req.query.status ?? ''),
      vendorId: String(req.query.vendor_id ?? ''),
      window: String(req.query.window ?? 'all'),
    });
    res.json({ items, total: items.length });
  });

  router.get('/vendors/export', requireAuth, async (req, res) => {
    const db = getDb();
    const rows = await buildVendorReportRows(db, {
      q: String(req.query.q ?? ''),
      status: String(req.query.status ?? ''),
      vendorId: String(req.query.vendor_id ?? ''),
      window: String(req.query.window ?? 'all'),
    });

    const headers = [
      'vendor_id',
      'vendor_code',
      'canonical_name',
      'tax_id',
      'default_currency',
      'verification_status',
      'payment_terms_days',
      'aliases',
      'open_po_count',
      'total_po_count',
      'po_committed_amount',
      'po_consumed_amount',
      'po_remaining_amount',
      'po_utilization_pct',
      'total_invoices',
      'approved_invoices',
      'review_invoices',
      'rejected_invoices',
      'failed_invoices',
      'exception_rate_pct',
      'total_invoiced_amount',
      'approved_spend_amount',
      'mean_confidence_pct',
      'last_invoice_date',
      'created_at',
    ];
    const csv = [
      headers.join(','),
      ...rows.map((r: any) => headers.map((h) => csvEscape(r[h])).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="invoicedesk_vendor_report_${isoNow().slice(0, 10)}.csv"`
    );
    res.send(csv);
  });

  router.get('/vendors/:vendorId/export', requireAuth, async (req, res) => {
    const db = getDb();
    const vendor = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.vendorId) as any;
    if (!vendor) {
      sendError(req, res, 404, 'NOT_FOUND', 'Vendor not found.');
      return;
    }

    const summary = (await buildVendorReportRows(db, { vendorId: vendor.id }))[0];
    const purchaseOrders = await db
      .prepare('SELECT * FROM purchase_orders WHERE vendor_id = ? ORDER BY issued_date DESC')
      .all(vendor.id) as any[];
    const invoices = await db
      .prepare(
        `SELECT i.id, i.invoice_number, i.original_filename, i.invoice_date, i.currency, i.total_amount,
                i.overall_confidence, i.processing_status, i.business_decision, i.review_status,
                i.created_at, d.primary_reason_code, po.po_number AS matched_po_number
         FROM invoices i
         LEFT JOIN decisions d ON d.id = i.latest_decision_id
         LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id
         WHERE i.vendor_id = ?
         ORDER BY i.created_at DESC`
      )
      .all(vendor.id) as any[];

    const headers = [
      'record_type',
      'vendor_code',
      'vendor_name',
      'reference_id',
      'reference_number',
      'date',
      'status',
      'decision',
      'reason_code',
      'currency',
      'amount',
      'secondary_amount',
      'utilization_or_confidence_pct',
      'notes_or_filename',
    ];

    const records: Array<Record<string, unknown>> = [
      {
        record_type: 'VENDOR_SUMMARY',
        vendor_code: vendor.vendor_code,
        vendor_name: vendor.canonical_name,
        reference_id: vendor.id,
        reference_number: vendor.tax_id || '',
        date: summary?.last_invoice_date || '',
        status: vendor.verification_status,
        decision: `${summary?.approved_invoices ?? 0} APPROVED / ${summary?.review_invoices ?? 0} REVIEW / ${summary?.rejected_invoices ?? 0} REJECT`,
        reason_code: `EXCEPTION_RATE_${summary?.exception_rate_pct ?? '0.0'}%`,
        currency: vendor.default_currency,
        amount: summary?.total_invoiced_amount ?? '0.00',
        secondary_amount: summary?.po_consumed_amount ?? '0.00',
        utilization_or_confidence_pct: summary?.po_utilization_pct ?? '0.0',
        notes_or_filename: `Aliases: ${summary?.aliases || 'None'}`,
      },
      ...purchaseOrders.map((po) => {
        const orig = parseDecimalSafe(po.original_amount) ?? new Decimal(0);
        const cons = parseDecimalSafe(po.consumed_amount) ?? new Decimal(0);
        const util = orig.gt(0) ? cons.div(orig).mul(100).toFixed(1) : '0.0';
        return {
          record_type: 'PURCHASE_ORDER',
          vendor_code: vendor.vendor_code,
          vendor_name: vendor.canonical_name,
          reference_id: po.id,
          reference_number: po.po_number,
          date: po.issued_date,
          status: po.status,
          decision: '',
          reason_code: '',
          currency: po.currency,
          amount: orig.toFixed(2),
          secondary_amount: cons.toFixed(2),
          utilization_or_confidence_pct: util,
          notes_or_filename: po.notes || '',
        };
      }),
      ...invoices.map((inv) => ({
        record_type: 'INVOICE',
        vendor_code: vendor.vendor_code,
        vendor_name: vendor.canonical_name,
        reference_id: inv.id,
        reference_number: inv.invoice_number || inv.original_filename,
        date: inv.invoice_date || String(inv.created_at).slice(0, 10),
        status: inv.review_status !== 'NOT_REQUIRED' ? inv.review_status : inv.processing_status,
        decision: inv.business_decision,
        reason_code: inv.primary_reason_code || '',
        currency: inv.currency || vendor.default_currency,
        amount: inv.total_amount ?? '',
        secondary_amount: inv.matched_po_number || '',
        utilization_or_confidence_pct:
          typeof inv.overall_confidence === 'number' ? (inv.overall_confidence * 100).toFixed(1) : '',
        notes_or_filename: inv.original_filename,
      })),
    ];

    const csv = [
      headers.join(','),
      ...records.map((r) => headers.map((h) => csvEscape(r[h])).join(',')),
    ].join('\n');

    const safeCode = String(vendor.vendor_code || vendor.id).replace(/[^A-Za-z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sanitizeHeaderFilename(`invoicedesk_vendor_${safeCode}_${isoNow().slice(0, 10)}.csv`)}"`
    );
    res.send(csv);
  });

  router.get('/vendors/:vendorId', requireAuth, async (req, res) => {
    const db = getDb();
    const vendor = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.vendorId) as any;
    if (!vendor) {
      sendError(req, res, 404, 'NOT_FOUND', 'Vendor not found.');
      return;
    }
    const purchaseOrders = await db
      .prepare('SELECT * FROM purchase_orders WHERE vendor_id = ? ORDER BY issued_date DESC')
      .all(vendor.id);
    const invoices = await db
      .prepare(
        `SELECT id, invoice_number, original_filename, total_amount, currency, business_decision, review_status, created_at
         FROM invoices WHERE vendor_id = ? ORDER BY created_at DESC`
      )
      .all(vendor.id);
    res.json({
      vendor: { ...vendor, aliases: safeJsonParse<string[]>(vendor.aliases, []) },
      purchase_orders: purchaseOrders,
      invoices,
    });
  });

  router.post('/vendors', requireAuth, requireRoles('ADMIN'), async (req, res) => {
    const { canonical_name, aliases, tax_id, default_currency, verification_status, payment_terms_days } = req.body ?? {};
    const trimmedName = typeof canonical_name === 'string' ? canonical_name.trim() : '';
    if (!trimmedName) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'canonical_name is required.');
      return;
    }

    const currencyCode = String(default_currency || 'USD').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyCode)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'default_currency must be a 3-letter ISO currency code.');
      return;
    }

    const status = verification_status === undefined ? 'UNVERIFIED' : String(verification_status).toUpperCase();
    if (!['APPROVED', 'UNVERIFIED', 'BLOCKED'].includes(status)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'verification_status must be APPROVED, UNVERIFIED, or BLOCKED.');
      return;
    }

    const terms = payment_terms_days === undefined ? 30 : Number(payment_terms_days);
    if (!Number.isInteger(terms) || terms < 0 || terms > 365) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'payment_terms_days must be an integer between 0 and 365.');
      return;
    }

    const db = getDb();
    const existingCodes = await db.prepare('SELECT vendor_code FROM vendors').all() as Array<{ vendor_code: string }>;
    let maxNum = 0;
    const usedCodes = new Set<string>();
    for (const row of existingCodes) {
      usedCodes.add(row.vendor_code);
      const m = row.vendor_code.match(/^V-(\d+)$/i);
      if (m) maxNum = Math.max(maxNum, Number(m[1]));
    }
    let nextNum = maxNum + 1;
    let vendorCode = `V-${String(nextNum).padStart(3, '0')}`;
    while (usedCodes.has(vendorCode)) {
      nextNum++;
      vendorCode = `V-${String(nextNum).padStart(3, '0')}`;
    }

    const id = crypto.randomUUID();
    const now = isoNow();
    const aliasArr = Array.isArray(aliases) ? aliases.map((a) => String(a).trim()).filter(Boolean) : [];
    const normName = normalizeVendorName(trimmedName) || trimmedName.toLowerCase();

    await db.prepare(
      `INSERT INTO vendors (id, vendor_code, canonical_name, normalized_name, aliases, tax_id, default_currency, verification_status, payment_terms_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      vendorCode,
      trimmedName,
      normName,
      JSON.stringify(aliasArr),
      typeof tax_id === 'string' && tax_id.trim() ? tax_id.trim() : null,
      currencyCode,
      status,
      terms,
      now,
      now
    );

    await writeAuditLog({
      actorId: req.user!.id,
      actorType: 'USER',
      actorRole: req.user!.role,
      action: 'VENDOR_CREATED',
      resourceType: 'VENDOR',
      resourceId: id,
      details: { canonical_name: trimmedName, vendor_code: vendorCode },
    });

    res.status(201).json({ id, vendor_code: vendorCode });
  });

  router.patch('/vendors/:vendorId', requireAuth, requireRoles('ADMIN', 'REVIEWER'), async (req, res) => {
    const db = getDb();
    const existing = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.vendorId) as any;
    if (!existing) {
      sendError(req, res, 404, 'NOT_FOUND', 'Vendor not found.');
      return;
    }

    const { verification_status, aliases, canonical_name, tax_id } = req.body ?? {};
    if (req.user!.role === 'REVIEWER' && (aliases !== undefined || canonical_name !== undefined || tax_id !== undefined)) {
      sendError(req, res, 403, 'FORBIDDEN', 'Reviewers can only update vendor verification status.');
      return;
    }

    const nextStatus =
      verification_status !== undefined ? String(verification_status).toUpperCase() : existing.verification_status;
    if (!['APPROVED', 'UNVERIFIED', 'BLOCKED'].includes(nextStatus)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'verification_status must be APPROVED, UNVERIFIED, or BLOCKED.');
      return;
    }

    let nextName = existing.canonical_name;
    if (canonical_name !== undefined) {
      const trimmed = String(canonical_name).trim();
      if (!trimmed) {
        sendError(req, res, 422, 'VALIDATION_ERROR', 'canonical_name cannot be empty.');
        return;
      }
      nextName = trimmed;
    }

    const nextAliases = Array.isArray(aliases)
      ? JSON.stringify(aliases.map((a) => String(a).trim()).filter(Boolean))
      : existing.aliases;
    const nextTax = tax_id !== undefined ? (tax_id ? String(tax_id).trim() : null) : existing.tax_id;
    const now = isoNow();

    await db.prepare(
      `UPDATE vendors SET canonical_name = ?, normalized_name = ?, aliases = ?, tax_id = ?, verification_status = ?, updated_at = ? WHERE id = ?`
    ).run(
      nextName,
      normalizeVendorName(nextName) || nextName.toLowerCase(),
      nextAliases,
      nextTax,
      nextStatus,
      now,
      existing.id
    );

    await writeAuditLog({
      actorId: req.user!.id,
      actorType: 'USER',
      actorRole: req.user!.role,
      action: 'VENDOR_UPDATED',
      resourceType: 'VENDOR',
      resourceId: existing.id,
      details: {
        before: { verification_status: existing.verification_status, canonical_name: existing.canonical_name },
        after: { verification_status: nextStatus, canonical_name: nextName },
      },
    });

    res.json({ ok: true });
  });

  // ==================== PURCHASE ORDERS ====================
  router.get('/purchase-orders', requireAuth, async (req, res) => {
    const db = getDb();
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const status = String(req.query.status ?? '').trim();
    const sort = String(req.query.sort ?? 'issued_desc');

    const rows = await db
      .prepare(
        `SELECT po.*, v.canonical_name AS vendor_name, v.vendor_code,
                (SELECT COUNT(*) FROM invoices i WHERE i.purchase_order_id = po.id) AS linked_invoice_count
         FROM purchase_orders po
         JOIN vendors v ON v.id = po.vendor_id`
      )
      .all() as any[];

    const mapped = rows
      .map((po) => {
        const orig = parseDecimalSafe(po.original_amount) ?? new Decimal(0);
        const cons = parseDecimalSafe(po.consumed_amount) ?? new Decimal(0);
        const rem = Decimal.max(new Decimal(0), orig.minus(cons));
        const utilPct = orig.gt(0) ? cons.div(orig).mul(100).toNumber() : 0;
        return {
          ...po,
          remaining_amount: rem.toFixed(4),
          utilization_pct: Number(utilPct.toFixed(1)),
        };
      })
      .filter((po) => {
        if (status && status !== 'ALL' && po.status !== status) return false;
        if (!q) return true;
        return po.po_number.toLowerCase().includes(q) || po.vendor_name.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        if (sort === 'utilization_desc') return b.utilization_pct - a.utilization_pct;
        return String(b.issued_date || '').localeCompare(String(a.issued_date || ''));
      });

    res.json({ items: mapped, total: mapped.length });
  });

  router.get('/purchase-orders/:poId', requireAuth, async (req, res) => {
    const db = getDb();
    const po = await db
      .prepare(
        `SELECT po.*, v.canonical_name AS vendor_name, v.vendor_code
         FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id
         WHERE po.id = ?`
      )
      .get(req.params.poId) as any;

    if (!po) {
      sendError(req, res, 404, 'NOT_FOUND', 'Purchase order not found.');
      return;
    }

    const lines = await db
      .prepare('SELECT * FROM purchase_order_lines WHERE purchase_order_id = ? ORDER BY line_number ASC')
      .all(po.id);
    const invoices = await db
      .prepare(
        `SELECT id, invoice_number, original_filename, total_amount, currency, po_consumed_applied, processing_status, business_decision, review_status, created_at
         FROM invoices WHERE purchase_order_id = ? ORDER BY created_at DESC`
      )
      .all(po.id);

    const orig = parseDecimalSafe(po.original_amount) ?? new Decimal(0);
    const cons = parseDecimalSafe(po.consumed_amount) ?? new Decimal(0);
    res.json({
      purchase_order: {
        ...po,
        remaining_amount: Decimal.max(new Decimal(0), orig.minus(cons)).toFixed(4),
        utilization_pct: orig.gt(0) ? Number(cons.div(orig).mul(100).toFixed(1)) : 0,
      },
      lines,
      invoices,
    });
  });

  router.post('/purchase-orders', requireAuth, requireRoles('ADMIN'), async (req, res) => {
    const { po_number, vendor_id, currency, original_amount, issued_date, notes, lines } = req.body ?? {};
    const poNumStr = typeof po_number === 'string' ? po_number.trim() : '';
    const vendorIdStr = typeof vendor_id === 'string' ? vendor_id.trim() : '';
    if (!poNumStr || !vendorIdStr || original_amount === undefined || original_amount === null || original_amount === '') {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'po_number, vendor_id, and original_amount are required.');
      return;
    }
    const origDec = parseDecimalSafe(String(original_amount));
    if (!origDec || origDec.lte(0)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'original_amount must be a positive number.');
      return;
    }
    const currencyCode = String(currency || 'USD').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyCode)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'currency must be a 3-letter ISO currency code.');
      return;
    }

    const db = getDb();
    const vendorExists = await db.prepare('SELECT id FROM vendors WHERE id = ?').get(vendorIdStr);
    if (!vendorExists) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'Referenced vendor_id does not exist.');
      return;
    }

    const id = crypto.randomUUID();
    const now = isoNow();
    const normPo = normalizeDocNumber(poNumStr) || poNumStr.toUpperCase();

    const parsedLines: Array<{ description: string; qty: Decimal; unit: Decimal }> = [];
    if (Array.isArray(lines)) {
      for (const l of lines) {
        const qty = parseDecimalSafe(l?.quantity !== undefined ? String(l.quantity) : '1');
        const unit = parseDecimalSafe(l?.unit_price !== undefined ? String(l.unit_price) : origDec.toFixed(2));
        if (!qty || !unit || qty.lte(0) || unit.lt(0)) {
          sendError(req, res, 422, 'VALIDATION_ERROR', 'PO line items must have valid numeric quantity (> 0) and unit_price (>= 0).');
          return;
        }
        parsedLines.push({
          description: String(l?.description || 'Line Item').trim() || 'Line Item',
          qty,
          unit,
        });
      }
    }

    try {
      await withTransaction(db, async () => {
        await db.prepare(
          `INSERT INTO purchase_orders (id, po_number, normalized_po_number, vendor_id, currency, original_amount, consumed_amount, status, issued_date, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '0.0000', 'OPEN', ?, ?, ?, ?)`
        ).run(
          id,
          poNumStr,
          normPo,
          vendorIdStr,
          currencyCode,
          origDec.toFixed(4),
          typeof issued_date === 'string' && issued_date.trim() ? issued_date.trim().slice(0, 10) : now.slice(0, 10),
          notes ? String(notes) : null,
          now,
          now
        );

        for (const [idx, l] of parsedLines.entries()) {
          await db.prepare(
            `INSERT INTO purchase_order_lines (id, purchase_order_id, line_number, description, quantity, unit_price, line_total)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(
            crypto.randomUUID(),
            id,
            idx + 1,
            l.description,
            l.qty.toFixed(4),
            l.unit.toFixed(4),
            l.qty.mul(l.unit).toFixed(4)
          );
        }

        await writeAuditLog({
          actorId: req.user!.id,
          actorType: 'USER',
          actorRole: req.user!.role,
          action: 'PO_CREATED',
          resourceType: 'PURCHASE_ORDER',
          resourceId: id,
          details: { po_number: poNumStr, original_amount: origDec.toFixed(2) },
        });
      });
    } catch (err: any) {
      if (String(err?.message || '').includes('UNIQUE')) {
        sendError(req, res, 409, 'DUPLICATE_PO_NUMBER', `Purchase order ${poNumStr} already exists.`);
        return;
      }
      throw err;
    }

    res.status(201).json({ id, po_number: poNumStr });
  });

  router.patch('/purchase-orders/:poId', requireAuth, requireRoles('ADMIN'), async (req, res) => {
    const db = getDb();
    const po = await db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.poId) as any;
    if (!po) {
      sendError(req, res, 404, 'NOT_FOUND', 'Purchase order not found.');
      return;
    }

    const { status, original_amount, notes } = req.body ?? {};
    const nextOrig =
      original_amount !== undefined ? parseDecimalSafe(String(original_amount)) : parseDecimalSafe(po.original_amount);
    if (!nextOrig || nextOrig.lte(0)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'original_amount must be a positive number.');
      return;
    }
    const consumedDec = parseDecimalSafe(po.consumed_amount) ?? new Decimal(0);
    if (nextOrig.lt(consumedDec)) {
      sendError(
        req,
        res,
        422,
        'VALIDATION_ERROR',
        `Cannot reduce original_amount below already consumed amount ($${consumedDec.toFixed(2)}).`
      );
      return;
    }

    const nextStatus = status !== undefined ? String(status).toUpperCase() : po.status;
    if (!['OPEN', 'PARTIALLY_CONSUMED', 'FULLY_CONSUMED', 'CLOSED', 'CANCELLED'].includes(nextStatus)) {
      sendError(
        req,
        res,
        422,
        'VALIDATION_ERROR',
        'status must be OPEN, PARTIALLY_CONSUMED, FULLY_CONSUMED, CLOSED, or CANCELLED.'
      );
      return;
    }

    const now = isoNow();
    await db.prepare('UPDATE purchase_orders SET original_amount = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?').run(
      nextOrig.toFixed(4),
      nextStatus,
      notes !== undefined ? notes : po.notes,
      now,
      po.id
    );

    await writeAuditLog({
      actorId: req.user!.id,
      actorType: 'USER',
      actorRole: req.user!.role,
      action: 'PO_UPDATED',
      resourceType: 'PURCHASE_ORDER',
      resourceId: po.id,
      details: { before_status: po.status, after_status: nextStatus },
    });

    res.json({ ok: true });
  });

  // ==================== ANALYTICS & OVERVIEW ====================

  router.get('/analytics/overview', requireAuth, async (req, res) => {
    const db = getDb();
    const win = String(req.query.window ?? '30d');
    const startIso = windowStartIso(win);
    const whereClause = startIso ? 'WHERE created_at >= ?' : '';
    const params = startIso ? [startIso] : [];

    const invoices = await db
      .prepare(`SELECT id, total_amount, processing_status, business_decision, review_status, created_at FROM invoices ${whereClause}`)
      .all(...params) as any[];

    let totalProcessed = 0;
    let approvedCount = 0;
    let approvedTotal = new Decimal(0);
    let pendingReviewCount = 0;
    let pendingReviewTotal = new Decimal(0);
    let rejectedCount = 0;
    let failedCount = 0;

    const trendMap = new Map<string, { date: string; APPROVE: number; REVIEW: number; REJECT: number; FAILED: number }>();

    for (const inv of invoices) {
      const amt = parseDecimalSafe(inv.total_amount) ?? new Decimal(0);
      const day = String(inv.created_at).slice(0, 10);
      if (!trendMap.has(day)) {
        trendMap.set(day, { date: day, APPROVE: 0, REVIEW: 0, REJECT: 0, FAILED: 0 });
      }
      const bucket = trendMap.get(day)!;

      if (inv.processing_status === 'COMPLETED') totalProcessed++;
      if (inv.processing_status === 'FAILED') {
        failedCount++;
        bucket.FAILED++;
      }
      if (inv.business_decision === 'APPROVE') {
        approvedCount++;
        approvedTotal = approvedTotal.plus(amt);
        bucket.APPROVE++;
      } else if (inv.business_decision === 'REVIEW') {
        bucket.REVIEW++;
      } else if (inv.business_decision === 'REJECT') {
        rejectedCount++;
        bucket.REJECT++;
      }
      if (inv.review_status === 'PENDING_REVIEW') {
        pendingReviewCount++;
        pendingReviewTotal = pendingReviewTotal.plus(amt);
      }
    }

    const recentActivity = (await db
      .prepare(
        `SELECT a.*, u.full_name AS actor_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.id DESC LIMIT 8`
      )
      .all())
      .map((a: any) => ({ ...a, details: safeJsonParse<Record<string, unknown>>(a.details_json, {}) }));

    res.json({
      window: win,
      kpis: {
        total_invoices: invoices.length,
        total_processed: totalProcessed,
        approved_count: approvedCount,
        approved_amount: approvedTotal.toFixed(2),
        pending_reviews: pendingReviewCount,
        pending_review_amount: pendingReviewTotal.toFixed(2),
        rejected_count: rejectedCount,
        failed_count: failedCount,
      },
      volume_trend: Array.from(trendMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      decision_distribution: [
        { name: 'APPROVE', value: approvedCount },
        { name: 'REVIEW', value: invoices.filter((i) => i.business_decision === 'REVIEW').length },
        { name: 'REJECT', value: rejectedCount },
      ],
      recent_activity: recentActivity,
    });
  });

  router.get('/analytics/metrics', requireAuth, async (req, res) => {
    const db = getDb();
    const win = String(req.query.window ?? '30d');
    const vendorId = String(req.query.vendor_id ?? '');
    const startIso = windowStartIso(win);

    const clauses: string[] = ['1=1'];
    const params: any[] = [];
    if (startIso) {
      clauses.push('i.created_at >= ?');
      params.push(startIso);
    }
    if (vendorId && vendorId !== 'ALL') {
      clauses.push('i.vendor_id = ?');
      params.push(vendorId);
    }

    const rows = await db
      .prepare(
        `SELECT i.id, i.overall_confidence, i.business_decision, i.review_status, d.primary_reason_code,
                r.duration_ms, r.extraction_mode
         FROM invoices i
         LEFT JOIN decisions d ON d.id = i.latest_decision_id
         LEFT JOIN processing_runs r ON r.id = i.latest_run_id
         WHERE ${clauses.join(' AND ')}`
      )
      .all(...params) as any[];

    const decided = rows.filter((r) => ['APPROVE', 'REVIEW', 'REJECT'].includes(r.business_decision));
    const denom = decided.length;
    const approveNum = decided.filter((r) => r.business_decision === 'APPROVE').length;
    const reviewNum = decided.filter((r) => r.business_decision === 'REVIEW').length;
    const rejectNum = decided.filter((r) => r.business_decision === 'REJECT').length;

    const durations = rows.map((r) => r.duration_ms).filter((d): d is number => typeof d === 'number').sort((a, b) => a - b);
    const medianDuration = durations.length > 0 ? durations[Math.floor(durations.length / 2)] : 0;
    const p95Duration = durations.length > 0 ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : 0;

    const confs = rows.map((r) => r.overall_confidence).filter((c): c is number => typeof c === 'number');
    const meanConfidence = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;

    const exceptionCounts: Record<string, number> = {};
    for (const r of decided) {
      if (r.business_decision !== 'APPROVE' && r.primary_reason_code) {
        exceptionCounts[r.primary_reason_code] = (exceptionCounts[r.primary_reason_code] || 0) + 1;
      }
    }

    const confBuckets = [
      { bucket: '0–60%', count: confs.filter((c) => c < 0.6).length },
      { bucket: '60–80%', count: confs.filter((c) => c >= 0.6 && c < 0.8).length },
      { bucket: '80–90%', count: confs.filter((c) => c >= 0.8 && c < 0.9).length },
      { bucket: '90–100%', count: confs.filter((c) => c >= 0.9).length },
    ];

    const pos = await db
      .prepare("SELECT po_number, original_amount, consumed_amount FROM purchase_orders WHERE status != 'CANCELLED'")
      .all() as any[];
    let poOrigTotal = new Decimal(0);
    let poConsTotal = new Decimal(0);
    for (const p of pos) {
      poOrigTotal = poOrigTotal.plus(parseDecimalSafe(p.original_amount) ?? 0);
      poConsTotal = poConsTotal.plus(parseDecimalSafe(p.consumed_amount) ?? 0);
    }
    const poUtilPct = poOrigTotal.gt(0) ? Number(poConsTotal.div(poOrigTotal).mul(100).toFixed(1)) : 0;

    const overriddenCount = decided.filter(
      (r) => r.business_decision === 'REVIEW' && ['APPROVED_BY_HUMAN', 'REJECTED_BY_HUMAN'].includes(r.review_status)
    ).length;

    res.json({
      window: win,
      total_decided: denom,
      approval_rate: denom > 0 ? Number(((approveNum / denom) * 100).toFixed(1)) : 0,
      review_rate: denom > 0 ? Number(((reviewNum / denom) * 100).toFixed(1)) : 0,
      rejection_rate: denom > 0 ? Number(((rejectNum / denom) * 100).toFixed(1)) : 0,
      median_duration_ms: medianDuration,
      p95_duration_ms: p95Duration,
      mean_confidence: Number((meanConfidence * 100).toFixed(1)),
      po_utilization_pct: poUtilPct,
      po_consumed_total: poConsTotal.toFixed(2),
      po_original_total: poOrigTotal.toFixed(2),
      human_override_rate: reviewNum > 0 ? Number(((overriddenCount / reviewNum) * 100).toFixed(1)) : 0,
      exception_distribution: Object.entries(exceptionCounts).map(([reason_code, count]) => ({
        reason_code,
        count,
      })),
      confidence_distribution: confBuckets,
      latency_by_mode: ['NATIVE_TEXT', 'OCR'].map((mode) => {
        const subset = rows.filter((r) => r.extraction_mode === mode && typeof r.duration_ms === 'number');
        const avg = subset.length > 0 ? Math.round(subset.reduce((a, b) => a + b.duration_ms, 0) / subset.length) : 0;
        return { mode, count: subset.length, avg_duration_ms: avg };
      }),
    });
  });

  // ==================== GLOBAL SEARCH & NOTIFICATIONS ====================
  router.get('/search', requireAuth, async (req, res) => {
    const db = getDb();
    const q = String(req.query.q ?? '').trim().slice(0, 120).toLowerCase();
    if (!q) {
      res.json({ invoices: [], purchase_orders: [], vendors: [] });
      return;
    }
    const like = `%${q}%`;
    const invoices = await db
      .prepare(
        `SELECT id, invoice_number, original_filename, total_amount, currency, business_decision
         FROM invoices
         WHERE LOWER(COALESCE(invoice_number,'')) LIKE ? OR LOWER(original_filename) LIKE ? OR LOWER(COALESCE(extracted_vendor_name,'')) LIKE ?
         ORDER BY created_at DESC LIMIT 5`
      )
      .all(like, like, like);
    const purchase_orders = await db
      .prepare(
        `SELECT po.id, po.po_number, po.original_amount, po.consumed_amount, po.status, v.canonical_name AS vendor_name
         FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id
         WHERE LOWER(po.po_number) LIKE ? OR LOWER(v.canonical_name) LIKE ?
         LIMIT 5`
      )
      .all(like, like);
    const vendors = await db
      .prepare(
        `SELECT id, vendor_code, canonical_name, verification_status
         FROM vendors
         WHERE LOWER(canonical_name) LIKE ? OR LOWER(aliases) LIKE ?
         LIMIT 5`
      )
      .all(like, like);

    res.json({ invoices, purchase_orders, vendors });
  });

  router.get('/notifications', requireAuth, async (req, res) => {
    const type = String(req.query.type ?? 'ALL');
    const unreadOnly = req.query.unread_only === 'true';
    const limit = parsePositiveInt(req.query.limit, 30, 100);
    const data = await listNotificationsForUser(req.user!.id, { type, unreadOnly, limit });
    res.json(data);
  });

  router.get('/notifications/stream', requireAuth, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    safeSseWrite(res, 'retry: 15000\n\n');

    const lastEventIdHeader = req.header('Last-Event-ID') || String(req.query.lastEventId ?? '0');
    let lastSentId = Number.parseInt(lastEventIdHeader, 10) || 0;

    if (lastSentId > 0) {
      const missed = await listMissedNotificationsSince(lastSentId);
      for (const item of missed) {
        lastSentId = Math.max(lastSentId, item.id);
        safeSseWrite(res, `id: ${item.id}\nevent: notification_created\ndata: ${JSON.stringify(item)}\n\n`);
      }
    }

    const onNotification = (payload: NotificationStreamPayload) => {
      if (payload.event === 'notification_created') {
        if (payload.id <= lastSentId) return;
        lastSentId = Math.max(lastSentId, payload.id);
      }
      safeSseWrite(res, `id: ${payload.id}\nevent: ${payload.event}\ndata: ${JSON.stringify(payload.data)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      if (!safeSseWrite(res, ': heartbeat\n\n')) {
        cleanup();
      }
    }, 15000);

    // Gracefully end SSE before Vercel's 60s maxDuration so EventSource reconnects cleanly
    const serverlessMaxLifetime = config.isServerless
      ? setTimeout(() => {
          cleanup();
          if (!res.writableEnded) res.end();
        }, 45_000)
      : null;

    const cleanup = () => {
      clearInterval(heartbeat);
      if (serverlessMaxLifetime) clearTimeout(serverlessMaxLifetime);
      notificationBroker.off('workspace:notification', onNotification);
    };

    notificationBroker.on('workspace:notification', onNotification);
    req.on('close', cleanup);
  });

  router.post('/notifications/:notificationId/read', requireAuth, async (req, res) => {
    const id = Number(req.params.notificationId);
    if (!Number.isFinite(id) || id <= 0) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'Invalid notification ID.');
      return;
    }
    await markNotificationRead(req.user!.id, id);
    res.json({ ok: true, id });
  });

  router.post('/notifications/read-all', requireAuth, async (req, res) => {
    const marked = await markAllNotificationsRead(req.user!.id);
    res.json({ ok: true, marked_count: marked });
  });

  // ==================== AUDIT TRAIL ====================
  async function queryFilteredAuditLogs(params: { q: string; action: string; resourceType: string }) {
    const db = getDb();
    const rows = await db
      .prepare(
        `SELECT a.*,
                u.email AS actor_email,
                u.full_name AS actor_name,
                inv.invoice_number AS inv_number,
                inv.original_filename AS inv_filename,
                inv.extracted_vendor_name AS inv_vendor_name,
                inv.total_amount AS inv_total_amount,
                inv.currency AS inv_currency,
                po.po_number AS po_number,
                po.status AS po_status,
                v.vendor_code AS vendor_code,
                v.canonical_name AS vendor_name,
                ru.email AS target_user_email,
                ru.full_name AS target_user_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_id
         LEFT JOIN invoices inv ON a.resource_type = 'INVOICE' AND inv.id = a.resource_id
         LEFT JOIN purchase_orders po ON a.resource_type = 'PURCHASE_ORDER' AND po.id = a.resource_id
         LEFT JOIN vendors v ON a.resource_type = 'VENDOR' AND v.id = a.resource_id
         LEFT JOIN users ru ON a.resource_type = 'USER' AND ru.id = a.resource_id
         ORDER BY a.id DESC`
      )
      .all() as any[];

    const qLower = params.q.trim().toLowerCase();
    const actionFilter = params.action.trim();
    const resTypeFilter = params.resourceType.trim();

    return rows
      .map((r) => {
        let details: Record<string, unknown> = {};
        try {
          details = JSON.parse(r.details_json || '{}');
        } catch {
          details = {};
        }

        let resourceLabel = r.resource_id;
        let resourceSublabel: string | null = null;
        if (r.resource_type === 'INVOICE') {
          resourceLabel = r.inv_number || r.inv_filename || (typeof details.filename === 'string' ? details.filename : r.resource_id);
          resourceSublabel = r.inv_vendor_name || (r.inv_filename && r.inv_number ? r.inv_filename : null);
        } else if (r.resource_type === 'PURCHASE_ORDER') {
          resourceLabel = r.po_number || (typeof details.po_number === 'string' ? details.po_number : r.resource_id);
          resourceSublabel = r.po_status ? `Status: ${r.po_status}` : null;
        } else if (r.resource_type === 'VENDOR') {
          resourceLabel = r.vendor_name || (typeof details.canonical_name === 'string' ? details.canonical_name : r.resource_id);
          resourceSublabel = r.vendor_code || (typeof details.vendor_code === 'string' ? details.vendor_code : null);
        } else if (r.resource_type === 'USER') {
          resourceLabel = r.target_user_name || r.target_user_email || (typeof details.email === 'string' ? details.email : r.resource_id);
          resourceSublabel = r.target_user_email || null;
        } else if (r.resource_type === 'SETTINGS') {
          resourceLabel = 'Workspace Policy Settings';
          resourceSublabel = 'application_settings';
        }

        const eventHash = crypto
          .createHash('sha256')
          .update(
            [
              r.id,
              r.created_at,
              r.actor_id ?? '',
              r.actor_type,
              r.actor_role,
              r.action,
              r.resource_type,
              r.resource_id,
              r.original_decision ?? '',
              r.new_decision ?? '',
              r.details_json || '{}',
            ].join('|')
          )
          .digest('hex');

        const {
          inv_number: _in,
          inv_filename: _ifn,
          inv_vendor_name: _ivn,
          inv_total_amount: _ita,
          inv_currency: _ic,
          po_number: _pn,
          po_status: _ps,
          vendor_code: _vc,
          vendor_name: _vn,
          target_user_email: _tue,
          target_user_name: _tun,
          ...base
        } = r;

        return {
          ...base,
          details,
          resource_label: resourceLabel,
          resource_sublabel: resourceSublabel,
          event_hash: eventHash,
        };
      })
      .filter((r) => {
        if (actionFilter && actionFilter !== 'ALL' && r.action !== actionFilter) return false;
        if (resTypeFilter && resTypeFilter !== 'ALL' && r.resource_type !== resTypeFilter) return false;
        if (!qLower) return true;
        return (
          String(r.id) === qLower ||
          r.action.toLowerCase().includes(qLower) ||
          r.resource_id.toLowerCase().includes(qLower) ||
          (r.resource_label || '').toLowerCase().includes(qLower) ||
          (r.resource_sublabel || '').toLowerCase().includes(qLower) ||
          (r.actor_email || '').toLowerCase().includes(qLower) ||
          (r.actor_name || '').toLowerCase().includes(qLower) ||
          JSON.stringify(r.details).toLowerCase().includes(qLower)
        );
      });
  }

  router.get('/audit-logs', requireAuth, requireRoles('REVIEWER', 'AUDITOR', 'ADMIN'), async (req, res) => {
    const q = String(req.query.q ?? '');
    const action = String(req.query.action ?? '');
    const resourceType = String(req.query.resource_type ?? '');
    const page = parsePositiveInt(req.query.page, 1, 10_000);
    const pageSize = parsePositiveInt(req.query.page_size, 30, 100);

    const filtered = await queryFilteredAuditLogs({ q, action, resourceType });
    const paged = filtered.slice((page - 1) * pageSize, page * pageSize);
    res.json({ items: paged, total: filtered.length, page, page_size: pageSize });
  });

  router.get('/audit-logs/export', requireAuth, requireRoles('REVIEWER', 'AUDITOR', 'ADMIN'), async (req, res) => {
    const q = String(req.query.q ?? '');
    const action = String(req.query.action ?? '');
    const resourceType = String(req.query.resource_type ?? '');
    const rows = await queryFilteredAuditLogs({ q, action, resourceType });
    const headers = [
      'id',
      'created_at',
      'actor_type',
      'actor_role',
      'actor_email',
      'action',
      'resource_type',
      'resource_id',
      'resource_label',
      'original_decision',
      'new_decision',
      'event_hash',
      'details_json',
    ];
    const csv = [
      headers.join(','),
      ...rows.map((r) =>
        headers
          .map((h) => csvEscape(h === 'actor_email' ? r.actor_email || 'SYSTEM' : r[h]))
          .join(',')
      ),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="invoicedesk_audit_${isoNow().slice(0, 10)}.csv"`);
    res.send(csv);
  });

  // ==================== SETTINGS & USERS ====================
  router.get('/settings', requireAuth, async (_req, res) => {
    const db = getDb();
    const settings = await db.prepare('SELECT * FROM application_settings WHERE id = 1').get() as any;
    res.json({
      ...settings,
      active_extraction_provider: `Gemini Flash (${config.geminiModel})`,
      gemini_configured: Boolean(config.geminiApiKey && config.geminiApiKey !== 'MY_GEMINI_API_KEY'),
    });
  });

  router.patch('/settings', requireAuth, requireRoles('ADMIN'), async (req, res) => {
    const db = getDb();
    const before = await db.prepare('SELECT * FROM application_settings WHERE id = 1').get() as any;
    const body = req.body ?? {};

    const tolPct =
      body.tolerance_pct !== undefined
        ? parseDecimalSafe(String(body.tolerance_pct))
        : parseDecimalSafe(before.tolerance_pct);
    const tolAbs =
      body.tolerance_abs !== undefined
        ? parseDecimalSafe(String(body.tolerance_abs))
        : parseDecimalSafe(before.tolerance_abs);
    const confThresh =
      body.confidence_threshold !== undefined
        ? parseDecimalSafe(String(body.confidence_threshold))
        : parseDecimalSafe(before.confidence_threshold);

    if (!tolPct || tolPct.lt(0) || tolPct.gt(25)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'tolerance_pct must be between 0 and 25.');
      return;
    }
    if (!tolAbs || tolAbs.lt(0)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'tolerance_abs must be 0 or greater.');
      return;
    }
    if (!confThresh || confThresh.lt(0.3) || confThresh.gt(0.99)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'confidence_threshold must be between 0.30 and 0.99.');
      return;
    }

    const tolMode = body.tolerance_mode !== undefined ? String(body.tolerance_mode) : before.tolerance_mode;
    if (!['MIN_OF_PCT_AND_ABS', 'MAX_OF_PCT_AND_ABS', 'PCT_ONLY'].includes(tolMode)) {
      sendError(
        req,
        res,
        422,
        'VALIDATION_ERROR',
        'tolerance_mode must be MIN_OF_PCT_AND_ABS, MAX_OF_PCT_AND_ABS, or PCT_ONLY.'
      );
      return;
    }

    const ocrMinChars =
      body.ocr_min_chars_per_page !== undefined
        ? Number(body.ocr_min_chars_per_page)
        : Number(before.ocr_min_chars_per_page);
    if (!Number.isInteger(ocrMinChars) || ocrMinChars < 0 || ocrMinChars > 5000) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'ocr_min_chars_per_page must be an integer between 0 and 5000.');
      return;
    }

    const nextCurrency = String(body.default_currency ?? before.default_currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(nextCurrency)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'default_currency must be a 3-letter ISO currency code.');
      return;
    }

    const nextWorkspaceName = String(body.workspace_name ?? before.workspace_name).trim();
    if (!nextWorkspaceName || nextWorkspaceName.length > 120) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'workspace_name must be 1–120 characters.');
      return;
    }

    const now = isoNow();
    let autoCap: string | null = before.auto_approve_max_amount ?? null;
    if (body.auto_approve_max_amount === null || body.auto_approve_max_amount === '') {
      autoCap = null;
    } else if (body.auto_approve_max_amount !== undefined) {
      const parsedCap = parseDecimalSafe(String(body.auto_approve_max_amount));
      if (!parsedCap || parsedCap.lt(0)) {
        sendError(req, res, 422, 'VALIDATION_ERROR', 'auto_approve_max_amount must be 0 or greater.');
        return;
      }
      autoCap = parsedCap.toFixed(4);
    }

    let reviewerLimit: string | null = before.reviewer_approval_limit ?? null;
    if (body.reviewer_approval_limit === null || body.reviewer_approval_limit === '') {
      reviewerLimit = null;
    } else if (body.reviewer_approval_limit !== undefined) {
      const parsedLimit = parseDecimalSafe(String(body.reviewer_approval_limit));
      if (!parsedLimit || parsedLimit.lt(0)) {
        sendError(req, res, 422, 'VALIDATION_ERROR', 'reviewer_approval_limit must be 0 or greater.');
        return;
      }
      reviewerLimit = parsedLimit.toFixed(4);
    }

    const enforceSod =
      body.enforce_separation_of_duties !== undefined
        ? body.enforce_separation_of_duties
          ? 1
          : 0
        : (before.enforce_separation_of_duties ?? 1);

    const nextSubjectTemplate =
      body.rejection_email_subject_template !== undefined
        ? String(body.rejection_email_subject_template).trim()
        : before.rejection_email_subject_template;
    const nextBodyTemplate =
      body.rejection_email_body_template !== undefined
        ? String(body.rejection_email_body_template).trim()
        : before.rejection_email_body_template;

    if (!nextSubjectTemplate || nextSubjectTemplate.length > 300) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'rejection_email_subject_template must be 1–300 characters.');
      return;
    }
    if (!nextBodyTemplate || nextBodyTemplate.length > 4000) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'rejection_email_body_template must be 1–4000 characters.');
      return;
    }

    await db.prepare(
      `UPDATE application_settings SET
        workspace_name = ?,
        default_currency = ?,
        ocr_min_chars_per_page = ?,
        force_ocr = ?,
        tolerance_pct = ?,
        tolerance_abs = ?,
        tolerance_mode = ?,
        confidence_threshold = ?,
        auto_approve_max_amount = ?,
        reviewer_approval_limit = ?,
        enforce_separation_of_duties = ?,
        notify_on_upload = ?,
        notify_on_review = ?,
        notify_on_failure = ?,
        rejection_email_subject_template = ?,
        rejection_email_body_template = ?,
        updated_by = ?,
        updated_at = ?
       WHERE id = 1`
    ).run(
      nextWorkspaceName,
      nextCurrency,
      ocrMinChars,
      body.force_ocr !== undefined ? (body.force_ocr ? 1 : 0) : before.force_ocr,
      tolPct.toFixed(2),
      tolAbs.toFixed(4),
      tolMode,
      confThresh.toFixed(3),
      autoCap,
      reviewerLimit,
      enforceSod,
      body.notify_on_upload !== undefined ? (body.notify_on_upload ? 1 : 0) : (before.notify_on_upload ?? 1),
      body.notify_on_review !== undefined ? (body.notify_on_review ? 1 : 0) : before.notify_on_review,
      body.notify_on_failure !== undefined ? (body.notify_on_failure ? 1 : 0) : before.notify_on_failure,
      nextSubjectTemplate,
      nextBodyTemplate,
      req.user!.id,
      now
    );

    await writeAuditLog({
      actorId: req.user!.id,
      actorType: 'USER',
      actorRole: req.user!.role,
      action: 'SETTINGS_UPDATED',
      resourceType: 'SETTINGS',
      resourceId: 'application_settings:1',
      details: {
        before: {
          tolerance_pct: before.tolerance_pct,
          tolerance_abs: before.tolerance_abs,
          confidence_threshold: before.confidence_threshold,
          force_ocr: before.force_ocr,
          reviewer_approval_limit: before.reviewer_approval_limit ?? null,
          enforce_separation_of_duties: Boolean(before.enforce_separation_of_duties ?? 1),
          rejection_email_template_changed:
            nextSubjectTemplate !== before.rejection_email_subject_template ||
            nextBodyTemplate !== before.rejection_email_body_template,
        },
        after: {
          tolerance_pct: tolPct.toFixed(2),
          tolerance_abs: tolAbs.toFixed(4),
          confidence_threshold: confThresh.toFixed(3),
          force_ocr: body.force_ocr ?? Boolean(before.force_ocr),
          reviewer_approval_limit: reviewerLimit,
          enforce_separation_of_duties: Boolean(enforceSod),
          rejection_email_subject_template: nextSubjectTemplate,
        },
      },
    });

    res.json({ ok: true });
  });

  router.patch('/users/me/preferences', requireAuth, async (req, res) => {
    const theme = String(req.body?.theme_preference ?? '');
    if (!['light', 'dark', 'system'].includes(theme)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'theme_preference must be light, dark, or system.');
      return;
    }
    const db = getDb();
    await db.prepare('UPDATE users SET theme_preference = ?, updated_at = ? WHERE id = ?').run(
      theme,
      isoNow(),
      req.user!.id
    );
    res.json({ ok: true, theme_preference: theme });
  });

  router.get('/users', requireAuth, requireRoles('ADMIN'), async (_req, res) => {
    const db = getDb();
    const users = await db
      .prepare('SELECT id, email, full_name, role, is_active, created_at FROM users ORDER BY created_at ASC')
      .all();
    res.json({ items: users });
  });

  router.post('/users', requireAuth, requireRoles('ADMIN'), async (req, res) => {
    const { email, full_name, role, password } = req.body ?? {};
    const emailStr = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const fullNameStr = typeof full_name === 'string' ? full_name.trim() : '';
    const roleStr = typeof role === 'string' ? role.trim().toUpperCase() : '';
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr) ||
      !fullNameStr ||
      !['OPERATOR', 'REVIEWER', 'AUDITOR', 'ADMIN'].includes(roleStr)
    ) {
      sendError(
        req,
        res,
        422,
        'VALIDATION_ERROR',
        'Valid email, full_name, and role (OPERATOR, REVIEWER, AUDITOR, ADMIN) are required.'
      );
      return;
    }
    const db = getDb();
    const id = crypto.randomUUID();
    const now = isoNow();
    try {
      await db.prepare(
        `INSERT INTO users (id, email, full_name, password_hash, role, theme_preference, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'light', 1, ?, ?)`
      ).run(
        id,
        emailStr,
        fullNameStr,
        hashPassword(String(password || 'InvoiceDesk2026!')),
        roleStr,
        now,
        now
      );
    } catch (err: any) {
      if (String(err?.message || '').includes('UNIQUE')) {
        sendError(req, res, 409, 'DUPLICATE_EMAIL', 'A user with that email already exists.');
        return;
      }
      throw err;
    }
    await writeAuditLog({
      actorId: req.user!.id,
      actorType: 'USER',
      actorRole: req.user!.role,
      action: 'USER_CREATED',
      resourceType: 'USER',
      resourceId: id,
      details: { email: emailStr, role: roleStr },
    });
    res.status(201).json({ id, email: emailStr, role: roleStr });
  });

  router.patch('/users/:userId', requireAuth, requireRoles('ADMIN'), async (req, res) => {
    const db = getDb();
    const existing = await db.prepare('SELECT id, email, role, is_active FROM users WHERE id = ?').get(req.params.userId) as any;
    if (!existing) {
      sendError(req, res, 404, 'NOT_FOUND', 'User not found.');
      return;
    }
    const nextRole = req.body?.role !== undefined ? String(req.body.role).toUpperCase() : existing.role;
    if (!['OPERATOR', 'REVIEWER', 'AUDITOR', 'ADMIN'].includes(nextRole)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'Role must be OPERATOR, REVIEWER, AUDITOR, or ADMIN.');
      return;
    }
    const nextActive = req.body?.is_active !== undefined ? (req.body.is_active ? 1 : 0) : existing.is_active;

    if (existing.id === req.user!.id && (nextRole !== 'ADMIN' || !nextActive)) {
      sendError(
        req,
        res,
        409,
        'SELF_LOCKOUT_PREVENTED',
        'Administrators cannot demote or deactivate their own active account.'
      );
      return;
    }

    if (existing.role === 'ADMIN' && existing.is_active === 1 && (nextRole !== 'ADMIN' || !nextActive)) {
      const remainingAdmins = await db
        .prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'ADMIN' AND is_active = 1 AND id != ?")
        .get(existing.id) as { cnt: number };
      if ((remainingAdmins?.cnt ?? 0) === 0) {
        sendError(
          req,
          res,
          409,
          'LAST_ADMIN_REQUIRED',
          'At least one active Administrator must remain in the workspace.'
        );
        return;
      }
    }

    await db.prepare('UPDATE users SET role = ?, is_active = ?, updated_at = ? WHERE id = ?').run(
      nextRole,
      nextActive,
      isoNow(),
      existing.id
    );
    await writeAuditLog({
      actorId: req.user!.id,
      actorType: 'USER',
      actorRole: req.user!.role,
      action: 'USER_UPDATED',
      resourceType: 'USER',
      resourceId: existing.id,
      details: {
        email: existing.email,
        before: { role: existing.role, is_active: Boolean(existing.is_active) },
        after: { role: nextRole, is_active: Boolean(nextActive) },
      },
    });
    res.json({ ok: true });
  });

  router.post('/demo/reset', requireAuth, async (req, res) => {
    if (!config.enableDemoRoleSwitcher && !config.pauseAuthForDemo && req.user?.role !== 'ADMIN') {
      sendError(req, res, 403, 'FORBIDDEN', 'Demo reset is restricted to Administrators in production mode.');
      return;
    }
    await resetDemoDatabase();
    res.json({
      ok: true,
      message: 'Demo baseline restored (3 baseline invoices, pristine PO-104/205/300 balances).',
    });
  });

  return rawRouter;
}
