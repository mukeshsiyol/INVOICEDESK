import { AsyncLocalStorage } from 'node:async_hooks';
import type { Client, InValue, ResultSet, Transaction } from '@libsql/client';
import { config } from './config.ts';
import {
  DEFAULT_REJECTION_BODY_TEMPLATE,
  DEFAULT_REJECTION_SUBJECT_TEMPLATE,
} from '../src/lib/rejectionTemplate.ts';

/**
 * Async SQLite access through libSQL.
 *
 * - Locally (no TURSO_DATABASE_URL) this is a plain SQLite file under ./data.
 * - On Vercel/serverless it MUST point at a shared Turso database, because every
 *   function instance has its own private /tmp — data written by one instance is
 *   invisible to the next, which is what caused "Unable to load invoice workspace".
 *
 * The API mirrors node:sqlite (prepare().get/all/run, exec) but every call returns
 * a Promise. Transactions go through db.transaction(fn); statements issued inside
 * fn (including from helper functions that call getDb()) automatically join it.
 */

type Params = unknown[];
export type RunResult = { changes: number; lastInsertRowid: number | bigint | undefined };

const txStorage = new AsyncLocalStorage<Transaction>();
// In-process lock so a transaction never interleaves with other statements from this
// instance (matches the old synchronous semantics and avoids SQLITE_BUSY locally).
let txQueue: Promise<void> = Promise.resolve();
let txActive: Promise<void> | null = null;

function normalizeValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return value;
}

function rowsToObjects(rs: ResultSet): any[] {
  const out: any[] = [];
  for (const row of rs.rows) {
    const obj: Record<string, unknown> = {};
    rs.columns.forEach((col, i) => {
      obj[col] = normalizeValue((row as any)[i]);
    });
    out.push(obj);
  }
  return out;
}

function toArgs(params: Params): InValue[] {
  return params.map((p) => (p === undefined ? null : (p as InValue)));
}

export class AsyncStatement {
  constructor(private readonly db: AsyncDatabase, private readonly sql: string) {}

  async all(...params: Params): Promise<any[]> {
    return rowsToObjects(await this.db.execute(this.sql, params));
  }

  async get(...params: Params): Promise<any> {
    const rows = rowsToObjects(await this.db.execute(this.sql, params));
    return rows[0];
  }

  async run(...params: Params): Promise<RunResult> {
    const rs = await this.db.execute(this.sql, params);
    return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid };
  }
}

export class AsyncDatabase {
  constructor(private readonly clientPromise: Promise<Client>) {}

  get client(): Promise<Client> {
    return this.clientPromise;
  }

  prepare(sql: string): AsyncStatement {
    return new AsyncStatement(this, sql);
  }

  /** Runs one or more semicolon-separated statements. */
  async exec(sql: string): Promise<void> {
    const tx = txStorage.getStore();
    if (tx) {
      await tx.executeMultiple(sql);
      return;
    }
    await this.waitForOtherTransactions();
    await (await this.clientPromise).executeMultiple(sql);
  }

  async execute(sql: string, params: Params): Promise<ResultSet> {
    const tx = txStorage.getStore();
    if (tx) return tx.execute({ sql, args: toArgs(params) });
    await this.waitForOtherTransactions();
    return (await this.clientPromise).execute({ sql, args: toArgs(params) });
  }

  /** Runs fn inside a write transaction. Nested calls join the outer transaction. */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (txStorage.getStore()) return fn();

    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const previous = txQueue;
    txQueue = previous.then(() => mine);
    await previous;
    txActive = mine;

    try {
      const tx = await this.beginWithRetry();
      try {
        const result = await txStorage.run(tx, fn);
        await tx.commit();
        return result;
      } catch (err) {
        try {
          await tx.rollback();
        } catch {
          /* connection may already be closed */
        }
        throw err;
      } finally {
        tx.close();
      }
    } finally {
      txActive = null;
      release();
    }
  }

  private async beginWithRetry(): Promise<Transaction> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await (await this.clientPromise).transaction('write');
      } catch (err) {
        lastErr = err;
        if (!/SQLITE_BUSY|database is locked/i.test(String((err as Error)?.message))) throw err;
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  private async waitForOtherTransactions(): Promise<void> {
    while (txActive) await txActive;
  }
}

let dbInstance: AsyncDatabase | null = null;
let schemaPromise: Promise<void> | null = null;

async function openClient(): Promise<Client> {
  if (config.databaseUrl.startsWith('file:')) {
    // Local SQLite file (native driver). Only used for local dev / Docker.
    const { createClient } = await import('@libsql/client');
    return createClient({
      url: config.databaseUrl,
      // Busy timeout (ms); applies to every pooled connection.
      timeout: 5000,
    });
  }
  // Remote Turso database over HTTP — pure JS, no native binary needed on Vercel.
  const { createClient } = await import('@libsql/client/web');
  return createClient({
    url: config.databaseUrl,
    authToken: config.databaseAuthToken || undefined,
  });
}

export function getDb(): AsyncDatabase {
  if (!dbInstance) {
    const clientPromise = openClient();
    clientPromise.catch(() => {
      dbInstance = null; // allow a later call to retry
    });
    dbInstance = new AsyncDatabase(clientPromise);
  }
  return dbInstance;
}

/** Kept for call-site compatibility; nested calls join the outer transaction. */
export async function withTransaction<T>(db: AsyncDatabase, fn: () => Promise<T> | T): Promise<T> {
  return db.transaction(async () => fn());
}

/** Creates/migrates the schema once per process. Call before handling requests. */
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getDb();
      if (config.databaseUrl.startsWith('file:')) {
        await db.exec('PRAGMA journal_mode = WAL;');
      }
      await initSchema(db);
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

async function initSchema(db: AsyncDatabase): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('OPERATOR', 'REVIEWER', 'AUDITOR', 'ADMIN')),
      theme_preference TEXT NOT NULL DEFAULT 'light' CHECK (theme_preference IN ('light', 'dark', 'system')),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id TEXT PRIMARY KEY,
      vendor_code TEXT NOT NULL UNIQUE,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      tax_id TEXT,
      default_currency TEXT NOT NULL DEFAULT 'USD',
      verification_status TEXT NOT NULL CHECK (verification_status IN ('APPROVED', 'UNVERIFIED', 'BLOCKED')),
      payment_terms_days INTEGER NOT NULL DEFAULT 30,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vendors_norm_name ON vendors(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(verification_status);

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      po_number TEXT NOT NULL UNIQUE,
      normalized_po_number TEXT NOT NULL UNIQUE,
      vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
      currency TEXT NOT NULL DEFAULT 'USD',
      original_amount TEXT NOT NULL,
      consumed_amount TEXT NOT NULL DEFAULT '0.0000',
      status TEXT NOT NULL CHECK (status IN ('OPEN', 'PARTIALLY_CONSUMED', 'FULLY_CONSUMED', 'CLOSED', 'CANCELLED')),
      issued_date TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_po_vendor_status ON purchase_orders(vendor_id, status);

    CREATE TABLE IF NOT EXISTS purchase_order_lines (
      id TEXT PRIMARY KEY,
      purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      line_number INTEGER NOT NULL,
      description TEXT NOT NULL,
      quantity TEXT NOT NULL,
      unit_price TEXT NOT NULL,
      line_total TEXT NOT NULL,
      UNIQUE (purchase_order_id, line_number)
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      original_filename TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL,
      page_count INTEGER,
      document_type TEXT NOT NULL DEFAULT 'INVOICE' CHECK (document_type IN ('INVOICE', 'CREDIT_NOTE', 'UNKNOWN')),
      vendor_id TEXT REFERENCES vendors(id),
      extracted_vendor_name TEXT,
      purchase_order_id TEXT REFERENCES purchase_orders(id),
      extracted_po_number TEXT,
      invoice_number TEXT,
      normalized_invoice_number TEXT,
      invoice_date TEXT,
      due_date TEXT,
      currency TEXT,
      subtotal_amount TEXT,
      tax_amount TEXT,
      discount_amount TEXT,
      total_amount TEXT,
      overall_confidence REAL,
      po_consumed_applied INTEGER NOT NULL DEFAULT 0,
      processing_status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (processing_status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
      business_decision TEXT NOT NULL DEFAULT 'PENDING' CHECK (business_decision IN ('PENDING', 'APPROVE', 'REVIEW', 'REJECT')),
      review_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (review_status IN ('NOT_REQUIRED', 'PENDING_REVIEW', 'APPROVED_BY_HUMAN', 'REJECTED_BY_HUMAN')),
      assigned_reviewer_id TEXT REFERENCES users(id),
      latest_run_id TEXT,
      latest_decision_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inv_sha256 ON invoices(file_sha256);
    CREATE INDEX IF NOT EXISTS idx_inv_dup_key ON invoices(vendor_id, normalized_invoice_number);
    CREATE INDEX IF NOT EXISTS idx_inv_statuses ON invoices(business_decision, review_status);
    CREATE INDEX IF NOT EXISTS idx_inv_created ON invoices(created_at DESC);

    CREATE TABLE IF NOT EXISTS processing_runs (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      run_number INTEGER NOT NULL,
      trigger_type TEXT NOT NULL CHECK (trigger_type IN ('INITIAL', 'RETRY', 'REPROCESS')),
      triggered_by TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
      current_stage INTEGER NOT NULL DEFAULT 0,
      extraction_mode TEXT,
      raw_extracted_json TEXT,
      error_stage INTEGER,
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (invoice_id, run_number)
    );
    CREATE INDEX IF NOT EXISTS idx_runs_invoice ON processing_runs(invoice_id, run_number DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON processing_runs(status, started_at DESC);

    CREATE TABLE IF NOT EXISTS invoice_lines (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES processing_runs(id) ON DELETE CASCADE,
      line_number INTEGER NOT NULL,
      description TEXT NOT NULL,
      is_bundled INTEGER NOT NULL DEFAULT 0,
      quantity TEXT,
      unit_price TEXT,
      tax_amount TEXT,
      line_total TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inv_lines_run ON invoice_lines(run_id, line_number);

    CREATE TABLE IF NOT EXISTS stage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES processing_runs(id) ON DELETE CASCADE,
      stage_number INTEGER NOT NULL CHECK (stage_number BETWEEN 1 AND 8),
      stage_code TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'WARNING', 'FAILED')),
      summary TEXT NOT NULL,
      duration_ms INTEGER,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_stage_events_run ON stage_events(run_id, id ASC);

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES processing_runs(id) ON DELETE CASCADE,
      invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL CHECK (outcome IN ('APPROVE', 'REVIEW', 'REJECT')),
      primary_reason_code TEXT NOT NULL,
      triggered_rules TEXT NOT NULL,
      explanation TEXT NOT NULL,
      evidence_snapshot TEXT NOT NULL,
      explanation_source TEXT NOT NULL DEFAULT 'DETERMINISTIC_FALLBACK',
      explanation_provider TEXT NOT NULL DEFAULT 'deterministic',
      explanation_model TEXT,
      explanation_prompt_version TEXT NOT NULL DEFAULT 'invoice-explanation-v1',
      explanation_status TEXT NOT NULL DEFAULT 'FALLBACK',
      explanation_generated_at TEXT,
      explanation_input_tokens INTEGER,
      explanation_output_tokens INTEGER,
      explanation_fallback_reason TEXT,
      explanation_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_invoice ON decisions(invoice_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS review_actions (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      decision_id TEXT NOT NULL REFERENCES decisions(id),
      reviewer_id TEXT NOT NULL REFERENCES users(id),
      action TEXT NOT NULL CHECK (action IN ('APPROVE_OVERRIDE', 'REJECT_OVERRIDE', 'ASSIGN', 'COMMENT')),
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_review_actions_inv ON review_actions(invoice_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT REFERENCES users(id),
      actor_type TEXT NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM')),
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      original_decision TEXT,
      new_decision TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);

    CREATE TABLE IF NOT EXISTS application_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_name TEXT NOT NULL DEFAULT 'InvoiceDesk',
      default_currency TEXT NOT NULL DEFAULT 'USD',
      max_upload_mb INTEGER NOT NULL DEFAULT 25,
      ocr_min_chars_per_page INTEGER NOT NULL DEFAULT 50,
      force_ocr INTEGER NOT NULL DEFAULT 0,
      tolerance_pct TEXT NOT NULL DEFAULT '2.00',
      tolerance_abs TEXT NOT NULL DEFAULT '10.0000',
      tolerance_mode TEXT NOT NULL DEFAULT 'MIN_OF_PCT_AND_ABS',
      confidence_threshold TEXT NOT NULL DEFAULT '0.850',
      auto_approve_max_amount TEXT DEFAULT '25000.0000',
      reviewer_approval_limit TEXT DEFAULT '10000.0000',
      enforce_separation_of_duties INTEGER NOT NULL DEFAULT 1,
      notify_on_upload INTEGER NOT NULL DEFAULT 1,
      notify_on_review INTEGER NOT NULL DEFAULT 1,
      notify_on_failure INTEGER NOT NULL DEFAULT 1,
      rejection_email_subject_template TEXT NOT NULL DEFAULT '',
      rejection_email_body_template TEXT NOT NULL DEFAULT '',
      updated_by TEXT REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL CHECK (event_type IN ('INVOICE_UPLOADED', 'MANUAL_REVIEW_REQUIRED', 'PIPELINE_FAILED', 'REVIEW_RESOLVED')),
      severity TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      invoice_id TEXT REFERENCES invoices(id) ON DELETE CASCADE,
      run_id TEXT,
      actor_id TEXT REFERENCES users(id),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(id DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_invoice ON notifications(invoice_id, id DESC);

    CREATE TABLE IF NOT EXISTS documents (
      storage_key TEXT PRIMARY KEY,
      content BLOB NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notification_reads (
      notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (notification_id, user_id)
    );
  `);

  // Safe migration for existing SQLite databases
  const usersTableMeta = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get() as { sql?: string } | undefined;
  if (usersTableMeta?.sql && !usersTableMeta.sql.includes("'AUDITOR'")) {
    await db.exec('PRAGMA foreign_keys = OFF;');
    try {
      withTransaction(db, async () => {
        await db.exec(`
          CREATE TABLE users_new (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            full_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('OPERATOR', 'REVIEWER', 'AUDITOR', 'ADMIN')),
            theme_preference TEXT NOT NULL DEFAULT 'light' CHECK (theme_preference IN ('light', 'dark', 'system')),
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO users_new (id, email, full_name, password_hash, role, theme_preference, is_active, created_at, updated_at)
          SELECT id, email, full_name, password_hash, role, theme_preference, is_active, created_at, updated_at FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
        `);
      });
    } finally {
      await db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  const cols = await db.prepare('PRAGMA table_info(application_settings)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'notify_on_upload')) {
    await db.exec('ALTER TABLE application_settings ADD COLUMN notify_on_upload INTEGER NOT NULL DEFAULT 1;');
  }
  if (!cols.some((c) => c.name === 'rejection_email_subject_template')) {
    await db.exec("ALTER TABLE application_settings ADD COLUMN rejection_email_subject_template TEXT NOT NULL DEFAULT '';");
  }
  if (!cols.some((c) => c.name === 'rejection_email_body_template')) {
    await db.exec("ALTER TABLE application_settings ADD COLUMN rejection_email_body_template TEXT NOT NULL DEFAULT '';");
  }
  if (!cols.some((c) => c.name === 'reviewer_approval_limit')) {
    await db.exec("ALTER TABLE application_settings ADD COLUMN reviewer_approval_limit TEXT DEFAULT '10000.0000';");
  }
  if (!cols.some((c) => c.name === 'enforce_separation_of_duties')) {
    await db.exec('ALTER TABLE application_settings ADD COLUMN enforce_separation_of_duties INTEGER NOT NULL DEFAULT 1;');
  }

  await db.prepare(
    `UPDATE application_settings
     SET rejection_email_subject_template = CASE
           WHEN COALESCE(TRIM(rejection_email_subject_template), '') = '' THEN ?
           ELSE rejection_email_subject_template
         END,
         rejection_email_body_template = CASE
           WHEN COALESCE(TRIM(rejection_email_body_template), '') = '' THEN ?
           ELSE rejection_email_body_template
         END
     WHERE id = 1`
  ).run(DEFAULT_REJECTION_SUBJECT_TEMPLATE, DEFAULT_REJECTION_BODY_TEMPLATE);

  // Additive migration for databases created before explanation provenance existed.
  const decisionColumns = new Set(
    (await db.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map((column) => column.name)
  );
  const explanationColumns: Array<[string, string]> = [
    ['explanation_source', "TEXT NOT NULL DEFAULT 'DETERMINISTIC_FALLBACK'"],
    ['explanation_provider', "TEXT NOT NULL DEFAULT 'deterministic'"],
    ['explanation_model', 'TEXT'],
    ['explanation_prompt_version', "TEXT NOT NULL DEFAULT 'invoice-explanation-v1'"],
    ['explanation_status', "TEXT NOT NULL DEFAULT 'FALLBACK'"],
    ['explanation_generated_at', 'TEXT'],
    ['explanation_input_tokens', 'INTEGER'],
    ['explanation_output_tokens', 'INTEGER'],
    ['explanation_fallback_reason', 'TEXT'],
    ['explanation_json', "TEXT NOT NULL DEFAULT '{}'"],
  ];
  for (const [column, definition] of explanationColumns) {
    if (!decisionColumns.has(column)) {
      await db.exec(`ALTER TABLE decisions ADD COLUMN ${column} ${definition}`);
    }
  }
}

export function isoNow(): string {
  return new Date().toISOString();
}
