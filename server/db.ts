import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import {
  DEFAULT_REJECTION_BODY_TEMPLATE,
  DEFAULT_REJECTION_SUBJECT_TEMPLATE,
} from '../src/lib/rejectionTemplate.ts';

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(config.dbPath);
    dbInstance.exec('PRAGMA journal_mode = WAL;');
    dbInstance.exec('PRAGMA foreign_keys = ON;');
    dbInstance.exec('PRAGMA busy_timeout = 5000;');
    initSchema(dbInstance);
  }
  return dbInstance;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
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

    CREATE TABLE IF NOT EXISTS notification_reads (
      notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (notification_id, user_id)
    );
  `);

  // Safe migration for existing SQLite databases
  const usersTableMeta = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get() as { sql?: string } | undefined;
  if (usersTableMeta?.sql && !usersTableMeta.sql.includes("'AUDITOR'")) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(`
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
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  const cols = db.prepare('PRAGMA table_info(application_settings)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'notify_on_upload')) {
    db.exec('ALTER TABLE application_settings ADD COLUMN notify_on_upload INTEGER NOT NULL DEFAULT 1;');
  }
  if (!cols.some((c) => c.name === 'rejection_email_subject_template')) {
    db.exec("ALTER TABLE application_settings ADD COLUMN rejection_email_subject_template TEXT NOT NULL DEFAULT '';");
  }
  if (!cols.some((c) => c.name === 'rejection_email_body_template')) {
    db.exec("ALTER TABLE application_settings ADD COLUMN rejection_email_body_template TEXT NOT NULL DEFAULT '';");
  }
  if (!cols.some((c) => c.name === 'reviewer_approval_limit')) {
    db.exec("ALTER TABLE application_settings ADD COLUMN reviewer_approval_limit TEXT DEFAULT '10000.0000';");
  }
  if (!cols.some((c) => c.name === 'enforce_separation_of_duties')) {
    db.exec('ALTER TABLE application_settings ADD COLUMN enforce_separation_of_duties INTEGER NOT NULL DEFAULT 1;');
  }

  db.prepare(
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
    (db.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map((column) => column.name)
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
      db.exec(`ALTER TABLE decisions ADD COLUMN ${column} ${definition}`);
    }
  }
}

export function isoNow(): string {
  return new Date().toISOString();
}
