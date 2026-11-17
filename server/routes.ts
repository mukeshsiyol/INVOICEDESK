import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Decimal from 'decimal.js';
import express, { type Request, type Response } from 'express';
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
import { getDb, isoNow } from './db.ts';
import { normalizeDocNumber, normalizeVendorName } from './engine.ts';
import { persistValidatedPdf, readStoredPdf, validatePdfBuffer } from './extraction.ts';
import { DEMO_FIXTURES } from './fixtures.ts';
import { buildOpenApiSpec } from './openapi.ts';
import { sseBroker, startProcessingRun, type SseEventPayload } from './pipeline.ts';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadBytes,
    files: config.maxBatchFiles,
  },
});

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

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(
      `INSERT INTO invoices (id, uploaded_by, original_filename, storage_key, file_sha256, file_size_bytes, processing_status, business_decision, review_status, latest_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', 'PENDING', 'NOT_REQUIRED', ?, ?, ?)`
    ).run(invoiceId, params.userId, safeDisplayFilename, storageKey, sha256, params.buffer.length, runId, now, now);

    db.prepare(
      `INSERT INTO processing_runs (id, invoice_id, run_number, trigger_type, triggered_by, status, current_stage, created_at)
       VALUES (?, ?, 1, 'INITIAL', ?, 'QUEUED', 0, ?)`
    ).run(runId, invoiceId, params.userId, now);

    writeAuditLog({
      actorId: params.userId,
      actorType: 'USER',
      actorRole: 'UPLOADER',
      action: 'INVOICE_UPLOADED',
      resourceType: 'INVOICE',
      resourceId: invoiceId,
      details: { filename: safeDisplayFilename, sha256, size_bytes: params.buffer.length, run_id: runId },
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  if (params.autoStart) {
    const p = startProcessingRun(runId);
    if (config.isServerless) {
      await p;
    }
  }

  return {
    invoice_id: invoiceId,
    run_id: runId,
    original_filename: safeDisplayFilename,
    file_sha256: sha256,
    processing_status: 'QUEUED',
  };
}

export function createApiRouter(): express.Router {
  const router = express.Router();

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
  router.post('/auth/login', (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'Email and password are required.');
      return;
    }
    const db = getDb();
    const userRow = db
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
    clearSessionCookie(res, !config.pauseAuthForDemo);
    res.json({ ok: true, auth_paused: config.pauseAuthForDemo });
  });

  router.post('/auth/demo-bootstrap', (req, res) => {
    if (!config.enableDemoRoleSwitcher && !config.pauseAuthForDemo) {
      sendError(req, res, 404, 'NOT_FOUND', 'Demo bootstrap disabled.');
      return;
    }
    if (!config.pauseAuthForDemo && req.cookies?.[config.signedOutCookieName] === '1') {
      sendError(req, res, 401, 'SIGNED_OUT', 'User explicitly signed out.');
      return;
    }
    const existing = getUserFromRequest(req);
    if (existing) {
      setSessionCookie(res, signSessionToken(existing), req);
      res.json({ ...existing, demo_mode: config.enableDemoRoleSwitcher, auth_paused: config.pauseAuthForDemo });
      return;
    }
    const db = getDb();
    const defaultUser = db
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

  router.post('/auth/demo-switch', (req, res) => {
    if (!config.enableDemoRoleSwitcher) {
      sendError(req, res, 404, 'NOT_FOUND', 'Demo role switcher is disabled.');
      return;
    }
    const role = String(req.body?.role ?? '').toUpperCase() as UserRole;
    if (!['OPERATOR', 'REVIEWER', 'ADMIN'].includes(role)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'Role must be OPERATOR, REVIEWER, or ADMIN.');
      return;
    }
    const db = getDb();
    const target = db
      .prepare('SELECT id, email, full_name, role, theme_preference, is_active FROM users WHERE role = ? AND is_active = 1 LIMIT 1')
      .get(role) as AuthUser | undefined;
    if (!target) {
      sendError(req, res, 404, 'NOT_FOUND', `No active user with role ${role}.`);
      return;
    }
    const prev = getUserFromRequest(req);
    setSessionCookie(res, signSessionToken(target), req);
    writeAuditLog({
      actorId: target.id,
      actorType: 'USER',
      actorRole: target.role,
      action: 'AUTH_DEMO_SWITCH',
      resourceType: 'USER',
      resourceId: target.id,
      details: { previous_role: prev?.role ?? null, new_role: target.role },
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
    const buf = await fs.readFile(filePath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${meta.filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  });

  // ==================== UPLOAD & PRECHECK ====================
  router.post('/invoices/precheck-hash', requireAuth, (req, res) => {
    const hashes = Array.isArray(req.body?.hashes) ? req.body.hashes : [];
    const db = getDb();
    const matches = hashes.map((h: { client_id?: string; sha256?: string }) => {
      if (!h?.sha256) return { client_id: h?.client_id, is_duplicate: false };
      const existing = db
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
    });
    res.json({ matches });
  });

  router.post(
    '/invoices/upload',
    requireAuth,
    (req, res, next) => {
      upload.array('files', config.maxBatchFiles)(req, res, (err: any) => {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            sendError(req, res, 413, 'PAYLOAD_TOO_LARGE', 'File exceeds 25 MB maximum upload size.');
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

  router.post('/invoices/upload-fixture', requireAuth, async (req, res) => {
    const key = String(req.body?.fixture_key ?? '');
    const meta = DEMO_FIXTURES.find((f) => f.key === key);
    if (!meta) {
      sendError(req, res, 404, 'NOT_FOUND', 'Demo fixture key not found.');
      return;
    }
    const buf = await fs.readFile(path.join(config.fixturesDir, `${meta.key}.pdf`));
    const entry = await ingestBufferAndQueueRun({
      buffer: buf,
      originalFilename: meta.filename,
      userId: req.user!.id,
      autoStart: true,
    });
    res.status(202).json({ accepted: [entry], rejected_files: [] });
  });

  // ==================== INVOICES LIST, EXPORT, DETAIL, DOCUMENT ====================
  router.get('/invoices', requireAuth, (req, res) => {
    const db = getDb();
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const decision = String(req.query.decision ?? '').trim();
    const procStatus = String(req.query.processing_status ?? '').trim();
    const reviewStatus = String(req.query.review_status ?? '').trim();
    const attention = req.query.attention === 'true';
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size || 20)));
    const sortParam = String(req.query.sort ?? '-created_at');

    const where: string[] = ['1=1'];
    const params: any[] = [];

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
    if (attention) {
      where.push(`(i.review_status = 'PENDING_REVIEW' OR i.processing_status = 'FAILED')`);
    }

    const sortMap: Record<string, string> = {
      '-created_at': 'i.created_at DESC',
      created_at: 'i.created_at ASC',
      '-total_amount': 'CAST(COALESCE(i.total_amount, 0) AS REAL) DESC',
      total_amount: 'CAST(COALESCE(i.total_amount, 0) AS REAL) ASC',
      '-overall_confidence': 'COALESCE(i.overall_confidence, 0) DESC',
    };
    const orderBy = sortMap[sortParam] ?? 'i.created_at DESC';
    const whereSql = where.join(' AND ');

    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS c
           FROM invoices i
           LEFT JOIN vendors v ON v.id = i.vendor_id
           LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id
           WHERE ${whereSql}`
        )
        .get(...params) as { c: number }
    ).c;

    const rows = db
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

  router.get('/invoices/export', requireAuth, (req, res) => {
    const db = getDb();
    const idsParam = req.query.ids ? String(req.query.ids).split(',').filter(Boolean) : [];
    const rows = idsParam.length
      ? (db
          .prepare(
            `SELECT i.id, i.invoice_number, i.original_filename, COALESCE(v.canonical_name, i.extracted_vendor_name) AS vendor_name,
                    COALESCE(po.po_number, i.extracted_po_number) AS po_number, i.invoice_date, i.currency, i.total_amount,
                    i.overall_confidence, i.processing_status, i.business_decision, d.primary_reason_code, i.review_status, i.created_at
             FROM invoices i
             LEFT JOIN vendors v ON v.id = i.vendor_id
             LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id
             LEFT JOIN decisions d ON d.id = i.latest_decision_id
             WHERE i.id IN (${idsParam.map(() => '?').join(',')})
             ORDER BY i.created_at DESC`
          )
          .all(...idsParam) as any[])
      : (db
          .prepare(
            `SELECT i.id, i.invoice_number, i.original_filename, COALESCE(v.canonical_name, i.extracted_vendor_name) AS vendor_name,
                    COALESCE(po.po_number, i.extracted_po_number) AS po_number, i.invoice_date, i.currency, i.total_amount,
                    i.overall_confidence, i.processing_status, i.business_decision, d.primary_reason_code, i.review_status, i.created_at
             FROM invoices i
             LEFT JOIN vendors v ON v.id = i.vendor_id
             LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id
             LEFT JOIN decisions d ON d.id = i.latest_decision_id
             ORDER BY i.created_at DESC`
          )
          .all() as any[]);

    const headers = [
      'id',
      'invoice_number',
      'original_filename',
      'vendor_name',
      'po_number',
      'invoice_date',
      'currency',
      'total_amount',
      'overall_confidence',
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

  router.get('/invoices/:invoiceId', requireAuth, (req, res) => {
    const db = getDb();
    const invoice = db
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
    const runsHistory = db
      .prepare(
        `SELECT id, run_number, trigger_type, status, current_stage, extraction_mode, error_stage, error_message, started_at, completed_at, duration_ms, created_at
         FROM processing_runs WHERE invoice_id = ? ORDER BY run_number DESC`
      )
      .all(invoice.id) as any[];

    const activeRun =
      (requestedRunId
        ? db.prepare('SELECT * FROM processing_runs WHERE id = ? AND invoice_id = ?').get(requestedRunId, invoice.id)
        : null) || runsHistory[0] || null;

    const stageEvents = activeRun
      ? (db
          .prepare('SELECT * FROM stage_events WHERE run_id = ? ORDER BY id ASC')
          .all(activeRun.id) as any[]).map((ev) => ({
          ...ev,
          evidence: JSON.parse(ev.evidence_json || '{}'),
        }))
      : [];

    const lineItems = activeRun
      ? db.prepare('SELECT * FROM invoice_lines WHERE run_id = ? ORDER BY line_number ASC').all(activeRun.id)
      : [];

    const decisionRow = activeRun
      ? (db.prepare('SELECT * FROM decisions WHERE run_id = ?').get(activeRun.id) as any)
      : null;
    const decision = decisionRow
      ? {
          ...decisionRow,
          triggered_rules: JSON.parse(decisionRow.triggered_rules || '[]'),
          evidence_snapshot: JSON.parse(decisionRow.evidence_snapshot || '{}'),
        }
      : null;

    const reviewActions = db
      .prepare(
        `SELECT ra.*, u.full_name AS reviewer_name, u.email AS reviewer_email, u.role AS reviewer_role
         FROM review_actions ra
         JOIN users u ON u.id = ra.reviewer_id
         WHERE ra.invoice_id = ? ORDER BY ra.created_at DESC`
      )
      .all(invoice.id);

    const priorPoInvoices = invoice.purchase_order_id
      ? db
          .prepare(
            `SELECT id, invoice_number, original_filename, total_amount, business_decision, review_status, created_at
             FROM invoices WHERE purchase_order_id = ? AND po_consumed_applied = 1 AND id != ?
             ORDER BY created_at ASC`
          )
          .all(invoice.purchase_order_id, invoice.id)
      : [];

    let rawExtracted: any = null;
    if (activeRun?.raw_extracted_json) {
      try {
        rawExtracted = JSON.parse(activeRun.raw_extracted_json);
      } catch {
        rawExtracted = null;
      }
    }

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
    const inv = db
      .prepare('SELECT original_filename, storage_key FROM invoices WHERE id = ?')
      .get(req.params.invoiceId) as { original_filename: string; storage_key: string } | undefined;

    if (!inv) {
      sendError(req, res, 404, 'NOT_FOUND', 'Invoice not found.');
      return;
    }

    try {
      const buf = await readStoredPdf(inv.storage_key);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${inv.original_filename.replace(/"/g, '')}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(buf);
    } catch {
      sendError(req, res, 404, 'DOCUMENT_MISSING', 'Stored PDF file could not be read.');
    }
  });

  router.get('/invoices/:invoiceId/ocr-text', requireAuth, (req, res) => {
    const db = getDb();
    const inv = db.prepare('SELECT latest_run_id FROM invoices WHERE id = ?').get(req.params.invoiceId) as
      | { latest_run_id: string | null }
      | undefined;
    if (!inv?.latest_run_id) {
      sendError(req, res, 404, 'NOT_FOUND', 'Extraction data not found.');
      return;
    }
    const run = db
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

  router.post('/invoices/:invoiceId/start', requireAuth, async (req, res) => {
    const db = getDb();
    const inv = db
      .prepare('SELECT id, latest_run_id, processing_status FROM invoices WHERE id = ?')
      .get(req.params.invoiceId) as
      | { id: string; latest_run_id: string | null; processing_status: string }
      | undefined;

    if (!inv || !inv.latest_run_id) {
      sendError(req, res, 404, 'NOT_FOUND', 'Invoice or queued run not found.');
      return;
    }

    const run = db
      .prepare('SELECT id, run_number, status, started_at FROM processing_runs WHERE id = ?')
      .get(inv.latest_run_id) as
      | { id: string; run_number: number; status: string; started_at: string | null }
      | undefined;

    if (!run || run.status !== 'QUEUED' || run.started_at) {
      sendError(req, res, 409, 'INVALID_RUN_STATE', 'Only unstarted QUEUED runs can be started manually.');
      return;
    }

    writeAuditLog({
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
    res.status(202).json({
      invoice_id: inv.id,
      run_id: run.id,
      run_number: run.run_number,
      processing_status: 'QUEUED',
    });
  });

  router.post('/invoices/:invoiceId/retry', requireAuth, async (req, res) => {
    const db = getDb();
    const inv = db
      .prepare('SELECT id, processing_status FROM invoices WHERE id = ?')
      .get(req.params.invoiceId) as { id: string; processing_status: string } | undefined;
    if (!inv) {
      sendError(req, res, 404, 'NOT_FOUND', 'Invoice not found.');
      return;
    }
    if (inv.processing_status === 'QUEUED' || inv.processing_status === 'RUNNING') {
      sendError(req, res, 409, 'RUN_ALREADY_ACTIVE', 'A processing run is already in progress for this invoice.');
      return;
    }

    const lastRun = db
      .prepare('SELECT MAX(run_number) AS max_num FROM processing_runs WHERE invoice_id = ?')
      .get(inv.id) as { max_num: number | null };
    const nextRunNumber = (lastRun?.max_num ?? 0) + 1;
    const newRunId = crypto.randomUUID();
    const now = isoNow();

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(
        `INSERT INTO processing_runs (id, invoice_id, run_number, trigger_type, triggered_by, status, current_stage, created_at)
         VALUES (?, ?, ?, 'RETRY', ?, 'QUEUED', 0, ?)`
      ).run(newRunId, inv.id, nextRunNumber, req.user!.id, now);

      db.prepare(
        `UPDATE invoices SET processing_status = 'QUEUED', latest_run_id = ?, updated_at = ? WHERE id = ?`
      ).run(newRunId, now, inv.id);

      writeAuditLog({
        actorId: req.user!.id,
        actorType: 'USER',
        actorRole: req.user!.role,
        action: 'RUN_RETRIED',
        resourceType: 'INVOICE',
        resourceId: inv.id,
        details: { new_run_id: newRunId, run_number: nextRunNumber, reason: req.body?.reason ?? 'Manual retry' },
      });

      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    const p = startProcessingRun(newRunId);
    if (config.isServerless) {
      await p;
    }
    res.status(202).json({
      invoice_id: inv.id,
      run_id: newRunId,
      run_number: nextRunNumber,
      processing_status: 'QUEUED',
    });
  });

  // ==================== PROCESSING RUNS & SSE STREAM ====================
  router.get('/runs', requireAuth, (req, res) => {
    const db = getDb();
    const status = String(req.query.status ?? '').trim();
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size || 25)));

    const where = status && status !== 'ALL' ? 'WHERE r.status = ?' : '';
    const params = status && status !== 'ALL' ? [status] : [];

    const total = (
      db.prepare(`SELECT COUNT(*) AS c FROM processing_runs r ${where}`).get(...params) as { c: number }
    ).c;

    const items = db
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

  router.get('/runs/:runId', requireAuth, (req, res) => {
    const db = getDb();
    const run = db.prepare('SELECT * FROM processing_runs WHERE id = ?').get(req.params.runId) as any;
    if (!run) {
      sendError(req, res, 404, 'NOT_FOUND', 'Processing run not found.');
      return;
    }
    const events = (
      db.prepare('SELECT * FROM stage_events WHERE run_id = ? ORDER BY id ASC').all(run.id) as any[]
    ).map((ev) => ({ ...ev, evidence: JSON.parse(ev.evidence_json || '{}') }));
    res.json({ run, stage_events: events });
  });

  router.get('/runs/:runId/events', requireAuth, (req, res) => {
    const runId = String(req.params.runId);
    const db = getDb();
    const run = db.prepare('SELECT id, invoice_id, status, duration_ms FROM processing_runs WHERE id = ?').get(runId) as
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

    const lastEventIdHeader = req.header('Last-Event-ID') || String(req.query.lastEventId ?? '0');
    let lastSentId = Number.parseInt(lastEventIdHeader, 10) || 0;

    const writeSse = (payload: SseEventPayload) => {
      if (payload.id <= lastSentId && payload.event !== 'run_completed' && payload.event !== 'run_failed') {
        return;
      }
      lastSentId = Math.max(lastSentId, payload.id);
      res.write(`id: ${payload.id}\nevent: ${payload.event}\ndata: ${JSON.stringify(payload.data)}\n\n`);
    };

    // 1. Replay missed persisted events from DB
    const missed = db
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
          evidence: JSON.parse(ev.evidence_json || '{}'),
          timestamp: ev.created_at,
        },
      });
    }

    // Re-check terminal status immediately after replay
    const currentRun = db
      .prepare('SELECT status, error_stage, error_message, duration_ms FROM processing_runs WHERE id = ?')
      .get(runId) as { status: string; error_stage: number | null; error_message: string | null; duration_ms: number | null };

    if (currentRun.status === 'COMPLETED') {
      const inv = db
        .prepare('SELECT business_decision, review_status FROM invoices WHERE id = ?')
        .get(run.invoice_id) as { business_decision: string; review_status: string };
      res.write(
        `id: ${lastSentId + 1}\nevent: run_completed\ndata: ${JSON.stringify({
          run_id: runId,
          invoice_id: run.invoice_id,
          processing_status: 'COMPLETED',
          business_decision: inv.business_decision,
          review_status: inv.review_status,
          duration_ms: currentRun.duration_ms,
        })}\n\n`
      );
      res.end();
      return;
    }

    if (currentRun.status === 'FAILED') {
      res.write(
        `id: ${lastSentId + 1}\nevent: run_failed\ndata: ${JSON.stringify({
          run_id: runId,
          invoice_id: run.invoice_id,
          processing_status: 'FAILED',
          error_stage: currentRun.error_stage,
          error_message: currentRun.error_message,
        })}\n\n`
      );
      res.end();
      return;
    }

    const onEvent = (payload: SseEventPayload) => {
      writeSse(payload);
      if (payload.event === 'run_completed' || payload.event === 'run_failed') {
        cleanup();
        res.end();
      }
    };

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      sseBroker.off(`run:${runId}`, onEvent);
    };

    sseBroker.on(`run:${runId}`, onEvent);
    req.on('close', cleanup);
  });

  // ==================== REVIEW QUEUE & OVERRIDES ====================
  router.get('/reviews', requireAuth, (req, res) => {
    const db = getDb();
    const status = String(req.query.status ?? 'PENDING_REVIEW');
    const category = String(req.query.category ?? 'ALL');

    let statusWhere = "i.review_status = 'PENDING_REVIEW'";
    if (status === 'RESOLVED') {
      statusWhere = "i.review_status IN ('APPROVED_BY_HUMAN', 'REJECTED_BY_HUMAN')";
    }

    const rows = db
      .prepare(
        `SELECT i.*, COALESCE(v.canonical_name, i.extracted_vendor_name) AS vendor_name,
                po.po_number AS matched_po_number, po.original_amount AS po_original_amount, po.consumed_amount AS po_consumed_amount,
                d.outcome AS original_decision, d.primary_reason_code, d.triggered_rules, d.explanation,
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
        triggered_rules: r.triggered_rules ? JSON.parse(r.triggered_rules) : [],
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

  router.post('/reviews/:invoiceId/assign', requireAuth, requireRoles('REVIEWER', 'ADMIN'), (req, res) => {
    const db = getDb();
    const reviewerId = String(req.body?.reviewer_id || req.user!.id);
    const inv = db
      .prepare('SELECT id, latest_decision_id, review_status FROM invoices WHERE id = ?')
      .get(req.params.invoiceId) as { id: string; latest_decision_id: string | null; review_status: string } | undefined;

    if (!inv || !inv.latest_decision_id) {
      sendError(req, res, 404, 'NOT_FOUND', 'Invoice or decision not found.');
      return;
    }

    const now = isoNow();
    db.prepare('UPDATE invoices SET assigned_reviewer_id = ?, updated_at = ? WHERE id = ?').run(
      reviewerId,
      now,
      inv.id
    );
    db.prepare(
      `INSERT INTO review_actions (id, invoice_id, decision_id, reviewer_id, action, note, created_at)
       VALUES (?, ?, ?, ?, 'ASSIGN', ?, ?)`
    ).run(crypto.randomUUID(), inv.id, inv.latest_decision_id, req.user!.id, `Assigned reviewer ${reviewerId}`, now);

    res.json({ ok: true, assigned_reviewer_id: reviewerId });
  });

  router.post('/invoices/:invoiceId/review', requireAuth, requireRoles('REVIEWER', 'ADMIN'), (req, res) => {
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

    db.exec('BEGIN IMMEDIATE;');
    try {
      const inv = db
        .prepare(
          `SELECT id, purchase_order_id, total_amount, po_consumed_applied, business_decision, review_status, latest_decision_id
           FROM invoices WHERE id = ?`
        )
        .get(req.params.invoiceId) as any;

      if (!inv || !inv.latest_decision_id) {
        db.exec('ROLLBACK;');
        sendError(req, res, 404, 'NOT_FOUND', 'Invoice not found.');
        return;
      }

      if (inv.review_status !== 'PENDING_REVIEW') {
        db.exec('ROLLBACK;');
        sendError(
          req,
          res,
          409,
          'CONCURRENT_REVIEW_CONFLICT',
          `This invoice was already resolved (${inv.review_status}).`
        );
        return;
      }

      const newReviewStatus = action === 'APPROVE_OVERRIDE' ? 'APPROVED_BY_HUMAN' : 'REJECTED_BY_HUMAN';

      // Atomic PO debit on human approval if not already applied
      if (action === 'APPROVE_OVERRIDE' && inv.purchase_order_id && inv.po_consumed_applied === 0 && inv.total_amount) {
        const po = db
          .prepare('SELECT id, original_amount, consumed_amount FROM purchase_orders WHERE id = ?')
          .get(inv.purchase_order_id) as { id: string; original_amount: string; consumed_amount: string } | undefined;
        if (po) {
          const orig = new Decimal(po.original_amount);
          const newConsumed = new Decimal(po.consumed_amount).plus(new Decimal(inv.total_amount));
          const newPoStatus = newConsumed.gte(orig) ? 'FULLY_CONSUMED' : 'PARTIALLY_CONSUMED';
          db.prepare('UPDATE purchase_orders SET consumed_amount = ?, status = ?, updated_at = ? WHERE id = ?').run(
            newConsumed.toFixed(4),
            newPoStatus,
            now,
            po.id
          );
          db.prepare('UPDATE invoices SET po_consumed_applied = 1 WHERE id = ?').run(inv.id);
        }
      }

      db.prepare('UPDATE invoices SET review_status = ?, updated_at = ? WHERE id = ?').run(
        newReviewStatus,
        now,
        inv.id
      );

      const actionId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO review_actions (id, invoice_id, decision_id, reviewer_id, action, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(actionId, inv.id, inv.latest_decision_id, req.user!.id, action, note, now);

      writeAuditLog({
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

      db.exec('COMMIT;');
      res.json({
        ok: true,
        invoice_id: inv.id,
        original_decision: inv.business_decision,
        review_status: newReviewStatus,
        review_action_id: actionId,
      });
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  });

  // ==================== VENDORS ====================
  router.get('/vendors', requireAuth, (req, res) => {
    const db = getDb();
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const status = String(req.query.status ?? '').trim();

    const rows = db
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
        aliases: JSON.parse(v.aliases || '[]'),
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

  router.get('/vendors/:vendorId', requireAuth, (req, res) => {
    const db = getDb();
    const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.vendorId) as any;
    if (!vendor) {
      sendError(req, res, 404, 'NOT_FOUND', 'Vendor not found.');
      return;
    }
    const purchaseOrders = db
      .prepare('SELECT * FROM purchase_orders WHERE vendor_id = ? ORDER BY issued_date DESC')
      .all(vendor.id);
    const invoices = db
      .prepare(
        `SELECT id, invoice_number, original_filename, total_amount, currency, business_decision, review_status, created_at
         FROM invoices WHERE vendor_id = ? ORDER BY created_at DESC`
      )
      .all(vendor.id);
    res.json({
      vendor: { ...vendor, aliases: JSON.parse(vendor.aliases || '[]') },
      purchase_orders: purchaseOrders,
      invoices,
    });
  });

  router.post('/vendors', requireAuth, requireRoles('ADMIN'), (req, res) => {
    const { canonical_name, aliases, tax_id, default_currency, verification_status } = req.body ?? {};
    if (!canonical_name?.trim()) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'canonical_name is required.');
      return;
    }
    const db = getDb();
    const count = (db.prepare('SELECT COUNT(*) AS c FROM vendors').get() as { c: number }).c;
    const vendorCode = `V-${String(count + 1).padStart(3, '0')}`;
    const id = crypto.randomUUID();
    const now = isoNow();
    const aliasArr = Array.isArray(aliases) ? aliases.map((a) => String(a).trim()).filter(Boolean) : [];

    db.prepare(
      `INSERT INTO vendors (id, vendor_code, canonical_name, normalized_name, aliases, tax_id, default_currency, verification_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      vendorCode,
      canonical_name.trim(),
      normalizeVendorName(canonical_name),
      JSON.stringify(aliasArr),
      tax_id?.trim() || null,
      (default_currency || 'USD').toUpperCase(),
      ['APPROVED', 'UNVERIFIED', 'BLOCKED'].includes(verification_status) ? verification_status : 'UNVERIFIED',
      now,
      now
    );

    writeAuditLog({
      actorId: req.user!.id,
      actorType: 'USER',
      actorRole: req.user!.role,
      action: 'VENDOR_CREATED',
      resourceType: 'VENDOR',
      resourceId: id,
      details: { canonical_name, vendor_code: vendorCode },
    });

    res.status(201).json({ id, vendor_code: vendorCode });
  });

  router.patch('/vendors/:vendorId', requireAuth, requireRoles('ADMIN', 'REVIEWER'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.vendorId) as any;
    if (!existing) {
      sendError(req, res, 404, 'NOT_FOUND', 'Vendor not found.');
      return;
    }

    const { verification_status, aliases, canonical_name, tax_id } = req.body ?? {};
    if (req.user!.role === 'REVIEWER' && (aliases !== undefined || canonical_name !== undefined || tax_id !== undefined)) {
      sendError(req, res, 403, 'FORBIDDEN', 'Reviewers can only update vendor verification status.');
      return;
    }

    const nextStatus = verification_status ?? existing.verification_status;
    const nextAliases = Array.isArray(aliases) ? JSON.stringify(aliases) : existing.aliases;
    const nextName = canonical_name ? String(canonical_name).trim() : existing.canonical_name;
    const nextTax = tax_id !== undefined ? tax_id : existing.tax_id;
    const now = isoNow();

    db.prepare(
      `UPDATE vendors SET canonical_name = ?, normalized_name = ?, aliases = ?, tax_id = ?, verification_status = ?, updated_at = ? WHERE id = ?`
    ).run(nextName, normalizeVendorName(nextName), nextAliases, nextTax, nextStatus, now, existing.id);

    writeAuditLog({
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
  router.get('/purchase-orders', requireAuth, (req, res) => {
    const db = getDb();
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const status = String(req.query.status ?? '').trim();
    const sort = String(req.query.sort ?? 'issued_desc');

    const rows = db
      .prepare(
        `SELECT po.*, v.canonical_name AS vendor_name, v.vendor_code,
                (SELECT COUNT(*) FROM invoices i WHERE i.purchase_order_id = po.id) AS linked_invoice_count
         FROM purchase_orders po
         JOIN vendors v ON v.id = po.vendor_id`
      )
      .all() as any[];

    const mapped = rows
      .map((po) => {
        const orig = new Decimal(po.original_amount);
        const cons = new Decimal(po.consumed_amount);
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
        return b.issued_date.localeCompare(a.issued_date);
      });

    res.json({ items: mapped, total: mapped.length });
  });

  router.get('/purchase-orders/:poId', requireAuth, (req, res) => {
    const db = getDb();
    const po = db
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

    const lines = db
      .prepare('SELECT * FROM purchase_order_lines WHERE purchase_order_id = ? ORDER BY line_number ASC')
      .all(po.id);
    const invoices = db
      .prepare(
        `SELECT id, invoice_number, original_filename, total_amount, currency, po_consumed_applied, processing_status, business_decision, review_status, created_at
         FROM invoices WHERE purchase_order_id = ? ORDER BY created_at DESC`
      )
      .all(po.id);

    const orig = new Decimal(po.original_amount);
    const cons = new Decimal(po.consumed_amount);
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

  router.post('/purchase-orders', requireAuth, requireRoles('ADMIN'), (req, res) => {
    const { po_number, vendor_id, currency, original_amount, issued_date, notes, lines } = req.body ?? {};
    if (!po_number?.trim() || !vendor_id || !original_amount) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'po_number, vendor_id, and original_amount are required.');
      return;
    }
    const origDec = new Decimal(String(original_amount));
    if (origDec.lte(0)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'original_amount must be positive.');
      return;
    }

    const db = getDb();
    const id = crypto.randomUUID();
    const now = isoNow();
    const normPo = normalizeDocNumber(po_number) || po_number.toUpperCase();

    db.prepare(
      `INSERT INTO purchase_orders (id, po_number, normalized_po_number, vendor_id, currency, original_amount, consumed_amount, status, issued_date, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '0.0000', 'OPEN', ?, ?, ?, ?)`
    ).run(
      id,
      po_number.trim(),
      normPo,
      vendor_id,
      (currency || 'USD').toUpperCase(),
      origDec.toFixed(4),
      issued_date || now.slice(0, 10),
      notes || null,
      now,
      now
    );

    if (Array.isArray(lines)) {
      lines.forEach((l: any, idx: number) => {
        const qty = new Decimal(String(l.quantity || 1));
        const unit = new Decimal(String(l.unit_price || origDec.toFixed(2)));
        db.prepare(
          `INSERT INTO purchase_order_lines (id, purchase_order_id, line_number, description, quantity, unit_price, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          crypto.randomUUID(),
          id,
          idx + 1,
          String(l.description || 'Line Item'),
          qty.toFixed(4),
          unit.toFixed(4),
          qty.mul(unit).toFixed(4)
        );
      });
    }

    writeAuditLog({
      actorId: req.user!.id,
      actorType: 'USER',
      actorRole: req.user!.role,
      action: 'PO_CREATED',
      resourceType: 'PURCHASE_ORDER',
      resourceId: id,
      details: { po_number, original_amount: origDec.toFixed(2) },
    });

    res.status(201).json({ id, po_number });
  });

  router.patch('/purchase-orders/:poId', requireAuth, requireRoles('ADMIN'), (req, res) => {
    const db = getDb();
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.poId) as any;
    if (!po) {
      sendError(req, res, 404, 'NOT_FOUND', 'Purchase order not found.');
      return;
    }

    const { status, original_amount, notes } = req.body ?? {};
    const nextOrig = original_amount !== undefined ? new Decimal(String(original_amount)) : new Decimal(po.original_amount);
    if (nextOrig.lt(new Decimal(po.consumed_amount))) {
      sendError(
        req,
        res,
        422,
        'VALIDATION_ERROR',
        `Cannot reduce original_amount below already consumed amount ($${new Decimal(po.consumed_amount).toFixed(2)}).`
      );
      return;
    }

    const nextStatus = status ?? po.status;
    const now = isoNow();
    db.prepare('UPDATE purchase_orders SET original_amount = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?').run(
      nextOrig.toFixed(4),
      nextStatus,
      notes !== undefined ? notes : po.notes,
      now,
      po.id
    );

    writeAuditLog({
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
  function windowStartIso(windowParam: string): string | null {
    const now = Date.now();
    if (windowParam === '7d') return new Date(now - 7 * 86400_000).toISOString();
    if (windowParam === '30d') return new Date(now - 30 * 86400_000).toISOString();
    if (windowParam === '90d') return new Date(now - 90 * 86400_000).toISOString();
    return null;
  }

  router.get('/analytics/overview', requireAuth, (req, res) => {
    const db = getDb();
    const win = String(req.query.window ?? '30d');
    const startIso = windowStartIso(win);
    const whereClause = startIso ? 'WHERE created_at >= ?' : '';
    const params = startIso ? [startIso] : [];

    const invoices = db
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
      const amt = inv.total_amount ? new Decimal(inv.total_amount) : new Decimal(0);
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

    const recentActivity = db
      .prepare(
        `SELECT a.*, u.full_name AS actor_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.id DESC LIMIT 8`
      )
      .all()
      .map((a: any) => ({ ...a, details: JSON.parse(a.details_json || '{}') }));

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

  router.get('/analytics/metrics', requireAuth, (req, res) => {
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

    const rows = db
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

    const pos = db
      .prepare("SELECT po_number, original_amount, consumed_amount FROM purchase_orders WHERE status != 'CANCELLED'")
      .all() as any[];
    let poOrigTotal = new Decimal(0);
    let poConsTotal = new Decimal(0);
    for (const p of pos) {
      poOrigTotal = poOrigTotal.plus(p.original_amount);
      poConsTotal = poConsTotal.plus(p.consumed_amount);
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
  router.get('/search', requireAuth, (req, res) => {
    const db = getDb();
    const q = String(req.query.q ?? '').trim().toLowerCase();
    if (!q) {
      res.json({ invoices: [], purchase_orders: [], vendors: [] });
      return;
    }
    const like = `%${q}%`;
    const invoices = db
      .prepare(
        `SELECT id, invoice_number, original_filename, total_amount, currency, business_decision
         FROM invoices
         WHERE LOWER(COALESCE(invoice_number,'')) LIKE ? OR LOWER(original_filename) LIKE ? OR LOWER(COALESCE(extracted_vendor_name,'')) LIKE ?
         ORDER BY created_at DESC LIMIT 5`
      )
      .all(like, like, like);
    const purchase_orders = db
      .prepare(
        `SELECT po.id, po.po_number, po.original_amount, po.consumed_amount, po.status, v.canonical_name AS vendor_name
         FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id
         WHERE LOWER(po.po_number) LIKE ? OR LOWER(v.canonical_name) LIKE ?
         LIMIT 5`
      )
      .all(like, like);
    const vendors = db
      .prepare(
        `SELECT id, vendor_code, canonical_name, verification_status
         FROM vendors
         WHERE LOWER(canonical_name) LIKE ? OR LOWER(aliases) LIKE ?
         LIMIT 5`
      )
      .all(like, like);

    res.json({ invoices, purchase_orders, vendors });
  });

  router.get('/notifications', requireAuth, (_req, res) => {
    const db = getDb();
    const items = db
      .prepare(
        `SELECT i.id AS invoice_id, i.invoice_number, i.original_filename, i.processing_status, i.business_decision, i.review_status, i.updated_at,
                d.primary_reason_code
         FROM invoices i
         LEFT JOIN decisions d ON d.id = i.latest_decision_id
         WHERE i.review_status = 'PENDING_REVIEW' OR i.processing_status = 'FAILED'
         ORDER BY i.updated_at DESC LIMIT 10`
      )
      .all();
    res.json({ items, unread_count: items.length });
  });

  // ==================== AUDIT TRAIL ====================
  router.get('/audit-logs', requireAuth, requireRoles('REVIEWER', 'ADMIN'), (req, res) => {
    const db = getDb();
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const action = String(req.query.action ?? '').trim();
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size || 30)));

    const rows = db
      .prepare(
        `SELECT a.*, u.email AS actor_email, u.full_name AS actor_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.id DESC`
      )
      .all() as any[];

    const filtered = rows
      .map((r) => ({ ...r, details: JSON.parse(r.details_json || '{}') }))
      .filter((r) => {
        if (action && action !== 'ALL' && r.action !== action) return false;
        if (!q) return true;
        return (
          r.action.toLowerCase().includes(q) ||
          r.resource_id.toLowerCase().includes(q) ||
          (r.actor_email || '').toLowerCase().includes(q) ||
          JSON.stringify(r.details).toLowerCase().includes(q)
        );
      });

    const paged = filtered.slice((page - 1) * pageSize, page * pageSize);
    res.json({ items: paged, total: filtered.length, page, page_size: pageSize });
  });

  router.get('/audit-logs/export', requireAuth, requireRoles('ADMIN'), (_req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT a.id, a.created_at, a.actor_type, a.actor_role, COALESCE(u.email,'SYSTEM') AS actor_email,
                a.action, a.resource_type, a.resource_id, a.original_decision, a.new_decision, a.details_json
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC`
      )
      .all() as any[];
    const headers = [
      'id',
      'created_at',
      'actor_type',
      'actor_role',
      'actor_email',
      'action',
      'resource_type',
      'resource_id',
      'original_decision',
      'new_decision',
      'details_json',
    ];
    const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="invoicedesk_audit_${isoNow().slice(0, 10)}.csv"`);
    res.send(csv);
  });

  // ==================== SETTINGS & USERS ====================
  router.get('/settings', requireAuth, (_req, res) => {
    const db = getDb();
    const settings = db.prepare('SELECT * FROM application_settings WHERE id = 1').get() as any;
    res.json({
      ...settings,
      active_extraction_provider: `Gemini (${config.geminiModel})`,
      gemini_configured: Boolean(config.geminiApiKey && config.geminiApiKey !== 'MY_GEMINI_API_KEY'),
    });
  });

  router.patch('/settings', requireAuth, requireRoles('ADMIN'), (req, res) => {
    const db = getDb();
    const before = db.prepare('SELECT * FROM application_settings WHERE id = 1').get() as any;
    const body = req.body ?? {};

    const tolPct = body.tolerance_pct !== undefined ? new Decimal(String(body.tolerance_pct)) : new Decimal(before.tolerance_pct);
    const tolAbs = body.tolerance_abs !== undefined ? new Decimal(String(body.tolerance_abs)) : new Decimal(before.tolerance_abs);
    const confThresh =
      body.confidence_threshold !== undefined
        ? new Decimal(String(body.confidence_threshold))
        : new Decimal(before.confidence_threshold);

    if (tolPct.lt(0) || tolPct.gt(25)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'tolerance_pct must be between 0 and 25.');
      return;
    }
    if (confThresh.lt(0.3) || confThresh.gt(0.99)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'confidence_threshold must be between 0.30 and 0.99.');
      return;
    }

    const now = isoNow();
    const autoCap =
      body.auto_approve_max_amount === null || body.auto_approve_max_amount === ''
        ? null
        : body.auto_approve_max_amount !== undefined
          ? new Decimal(String(body.auto_approve_max_amount)).toFixed(4)
          : before.auto_approve_max_amount;

    db.prepare(
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
        notify_on_review = ?,
        notify_on_failure = ?,
        updated_by = ?,
        updated_at = ?
       WHERE id = 1`
    ).run(
      body.workspace_name ?? before.workspace_name,
      (body.default_currency ?? before.default_currency).toUpperCase(),
      Number(body.ocr_min_chars_per_page ?? before.ocr_min_chars_per_page),
      body.force_ocr !== undefined ? (body.force_ocr ? 1 : 0) : before.force_ocr,
      tolPct.toFixed(2),
      tolAbs.toFixed(4),
      body.tolerance_mode ?? before.tolerance_mode,
      confThresh.toFixed(3),
      autoCap,
      body.notify_on_review !== undefined ? (body.notify_on_review ? 1 : 0) : before.notify_on_review,
      body.notify_on_failure !== undefined ? (body.notify_on_failure ? 1 : 0) : before.notify_on_failure,
      req.user!.id,
      now
    );

    writeAuditLog({
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
        },
        after: {
          tolerance_pct: tolPct.toFixed(2),
          tolerance_abs: tolAbs.toFixed(4),
          confidence_threshold: confThresh.toFixed(3),
          force_ocr: body.force_ocr ?? Boolean(before.force_ocr),
        },
      },
    });

    res.json({ ok: true });
  });

  router.patch('/users/me/preferences', requireAuth, (req, res) => {
    const theme = String(req.body?.theme_preference ?? '');
    if (!['light', 'dark', 'system'].includes(theme)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'theme_preference must be light, dark, or system.');
      return;
    }
    const db = getDb();
    db.prepare('UPDATE users SET theme_preference = ?, updated_at = ? WHERE id = ?').run(
      theme,
      isoNow(),
      req.user!.id
    );
    res.json({ ok: true, theme_preference: theme });
  });

  router.get('/users', requireAuth, requireRoles('ADMIN'), (_req, res) => {
    const db = getDb();
    const users = db
      .prepare('SELECT id, email, full_name, role, is_active, created_at FROM users ORDER BY created_at ASC')
      .all();
    res.json({ items: users });
  });

  router.post('/users', requireAuth, requireRoles('ADMIN'), (req, res) => {
    const { email, full_name, role, password } = req.body ?? {};
    if (!email || !full_name || !['OPERATOR', 'REVIEWER', 'ADMIN'].includes(role)) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'Valid email, full_name, and role are required.');
      return;
    }
    const db = getDb();
    const id = crypto.randomUUID();
    const now = isoNow();
    try {
      db.prepare(
        `INSERT INTO users (id, email, full_name, password_hash, role, theme_preference, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'light', 1, ?, ?)`
      ).run(id, String(email).trim().toLowerCase(), String(full_name).trim(), hashPassword(String(password || 'InvoiceDesk2026!')), role, now, now);
    } catch {
      sendError(req, res, 409, 'DUPLICATE_EMAIL', 'A user with that email already exists.');
      return;
    }
    writeAuditLog({
      actorId: req.user!.id,
      actorType: 'USER',
      actorRole: req.user!.role,
      action: 'USER_CREATED',
      resourceType: 'USER',
      resourceId: id,
      details: { email, role },
    });
    res.status(201).json({ id, email, role });
  });

  router.patch('/users/:userId', requireAuth, requireRoles('ADMIN'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(req.params.userId) as any;
    if (!existing) {
      sendError(req, res, 404, 'NOT_FOUND', 'User not found.');
      return;
    }
    const nextRole = req.body?.role ?? existing.role;
    const nextActive = req.body?.is_active !== undefined ? (req.body.is_active ? 1 : 0) : existing.is_active;
    db.prepare('UPDATE users SET role = ?, is_active = ?, updated_at = ? WHERE id = ?').run(
      nextRole,
      nextActive,
      isoNow(),
      existing.id
    );
    writeAuditLog({
      actorId: req.user!.id,
      actorType: 'USER',
      actorRole: req.user!.role,
      action: 'USER_UPDATED',
      resourceType: 'USER',
      resourceId: existing.id,
      details: { role: nextRole, is_active: Boolean(nextActive) },
    });
    res.json({ ok: true });
  });

  return router;
}
