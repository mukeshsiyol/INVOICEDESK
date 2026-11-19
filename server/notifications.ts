import { EventEmitter } from 'node:events';
import { getDb, isoNow, withTransaction } from './db.ts';

export type NotificationEventType =
  | 'INVOICE_UPLOADED'
  | 'MANUAL_REVIEW_REQUIRED'
  | 'PIPELINE_FAILED'
  | 'REVIEW_RESOLVED';

export type NotificationSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface WorkspaceNotificationItem {
  id: number;
  event_type: NotificationEventType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  invoice_id: string | null;
  run_id: string | null;
  actor_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  is_read: boolean;
  read_at: string | null;
  invoice_number: string | null;
  original_filename: string | null;
  processing_status: string | null;
  business_decision: string | null;
  review_status: string | null;
  primary_reason_code: string | null;
  total_amount: string | null;
  currency: string | null;
  vendor_name: string | null;
}

export interface NotificationStreamPayload {
  id: number;
  event: 'notification_created' | 'notifications_sync';
  data: Record<string, unknown>;
}

class WorkspaceNotificationBroker extends EventEmitter {
  publish(payload: NotificationStreamPayload): void {
    this.emit('workspace:notification', payload);
  }
}

export const notificationBroker = new WorkspaceNotificationBroker();
notificationBroker.setMaxListeners(100);

async function getEnabledEventTypes(): Promise<NotificationEventType[]> {
  const db = getDb();
  const settings = await db
    .prepare('SELECT notify_on_upload, notify_on_review, notify_on_failure FROM application_settings WHERE id = 1')
    .get() as { notify_on_upload?: number; notify_on_review?: number; notify_on_failure?: number } | undefined;

  const enabled: NotificationEventType[] = ['REVIEW_RESOLVED'];
  if (settings?.notify_on_upload !== 0) enabled.push('INVOICE_UPLOADED');
  if (settings?.notify_on_review !== 0) enabled.push('MANUAL_REVIEW_REQUIRED');
  if (settings?.notify_on_failure !== 0) enabled.push('PIPELINE_FAILED');
  return enabled;
}

function hydrateNotificationRow(row: any): WorkspaceNotificationItem {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata_json || '{}');
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    event_type: row.event_type,
    severity: row.severity,
    title: row.title,
    message: row.message,
    invoice_id: row.invoice_id ?? null,
    run_id: row.run_id ?? null,
    actor_id: row.actor_id ?? null,
    metadata,
    created_at: row.created_at,
    is_read: Boolean(row.read_at),
    read_at: row.read_at ?? null,
    invoice_number: row.invoice_number ?? null,
    original_filename: row.original_filename ?? null,
    processing_status: row.processing_status ?? null,
    business_decision: row.business_decision ?? null,
    review_status: row.review_status ?? null,
    primary_reason_code: row.primary_reason_code ?? null,
    total_amount: row.total_amount ?? null,
    currency: row.currency ?? null,
    vendor_name: row.vendor_name ?? null,
  };
}

export async function getNotificationById(notificationId: number, userId?: string): Promise<WorkspaceNotificationItem | null> {
  const db = getDb();
  const row = await db
    .prepare(
      `SELECT n.*, nr.read_at,
              i.invoice_number, i.original_filename, i.processing_status, i.business_decision, i.review_status,
              i.total_amount, i.currency, COALESCE(v.canonical_name, i.extracted_vendor_name) AS vendor_name,
              d.primary_reason_code
       FROM notifications n
       LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = ?
       LEFT JOIN invoices i ON i.id = n.invoice_id
       LEFT JOIN vendors v ON v.id = i.vendor_id
       LEFT JOIN decisions d ON d.id = i.latest_decision_id
       WHERE n.id = ?`
    )
    .get(userId ?? '', notificationId) as any;

  return row ? hydrateNotificationRow(row) : null;
}

export async function createWorkspaceNotification(params: {
  eventType: NotificationEventType;
  severity?: NotificationSeverity;
  title: string;
  message: string;
  invoiceId?: string | null;
  runId?: string | null;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
  bypassSettingsCheck?: boolean;
}): Promise<WorkspaceNotificationItem | null> {
  if (!params.bypassSettingsCheck) {
    const enabled = await getEnabledEventTypes();
    if (!enabled.includes(params.eventType)) {
      return null;
    }
  }

  const db = getDb();
  const now = isoNow();
  const severity: NotificationSeverity =
    params.severity ??
    (params.eventType === 'PIPELINE_FAILED'
      ? 'CRITICAL'
      : params.eventType === 'MANUAL_REVIEW_REQUIRED'
        ? 'WARNING'
        : 'INFO');

  const res = await db
    .prepare(
      `INSERT INTO notifications (event_type, severity, title, message, invoice_id, run_id, actor_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.eventType,
      severity,
      params.title,
      params.message,
      params.invoiceId ?? null,
      params.runId ?? null,
      params.actorId ?? null,
      JSON.stringify(params.metadata ?? {}),
      now
    );

  const id = Number(res.lastInsertRowid);
  const item = await getNotificationById(id);
  if (item) {
    notificationBroker.publish({
      id,
      event: 'notification_created',
      data: item as unknown as Record<string, unknown>,
    });
  }
  return item;
}

export async function listNotificationsForUser(
  userId: string,
  opts: { type?: string; unreadOnly?: boolean; limit?: number } = {}
): Promise<{
  items: WorkspaceNotificationItem[];
  unread_count: number;
  pending_review_count: number;
  failed_count: number;
  enabled_types: NotificationEventType[];
}> {
  const db = getDb();
  const enabledTypes = await getEnabledEventTypes();
  const placeholders = enabledTypes.map(() => '?').join(',');
  const rawLimit = Number(opts.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 30;

  const whereClauses: string[] = [`n.event_type IN (${placeholders})`];
  const params: any[] = [userId, ...enabledTypes];

  if (opts.type && opts.type !== 'ALL') {
    whereClauses.push('n.event_type = ?');
    params.push(opts.type);
  }
  if (opts.unreadOnly) {
    whereClauses.push('nr.read_at IS NULL');
  }

  const rows = await db
    .prepare(
      `SELECT n.*, nr.read_at,
              i.invoice_number, i.original_filename, i.processing_status, i.business_decision, i.review_status,
              i.total_amount, i.currency, COALESCE(v.canonical_name, i.extracted_vendor_name) AS vendor_name,
              d.primary_reason_code
       FROM notifications n
       LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = ?
       LEFT JOIN invoices i ON i.id = n.invoice_id
       LEFT JOIN vendors v ON v.id = i.vendor_id
       LEFT JOIN decisions d ON d.id = i.latest_decision_id
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY n.id DESC
       LIMIT ?`
    )
    .all(...params, limit) as any[];

  const unreadRow = await db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM notifications n
       LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = ?
       WHERE n.event_type IN (${placeholders}) AND nr.read_at IS NULL`
    )
    .get(userId, ...enabledTypes) as { c: number };

  const pendingRow = await db
    .prepare("SELECT COUNT(*) AS c FROM invoices WHERE review_status = 'PENDING_REVIEW'")
    .get() as { c: number };

  const failedRow = await db
    .prepare("SELECT COUNT(*) AS c FROM invoices WHERE processing_status = 'FAILED'")
    .get() as { c: number };

  return {
    items: rows.map(hydrateNotificationRow),
    unread_count: unreadRow.c,
    pending_review_count: pendingRow.c,
    failed_count: failedRow.c,
    enabled_types: enabledTypes,
  };
}

export async function listMissedNotificationsSince(lastEventId: number): Promise<WorkspaceNotificationItem[]> {
  const db = getDb();
  const enabledTypes = await getEnabledEventTypes();
  const placeholders = enabledTypes.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT n.*, NULL AS read_at,
              i.invoice_number, i.original_filename, i.processing_status, i.business_decision, i.review_status,
              i.total_amount, i.currency, COALESCE(v.canonical_name, i.extracted_vendor_name) AS vendor_name,
              d.primary_reason_code
       FROM notifications n
       LEFT JOIN invoices i ON i.id = n.invoice_id
       LEFT JOIN vendors v ON v.id = i.vendor_id
       LEFT JOIN decisions d ON d.id = i.latest_decision_id
       WHERE n.id > ? AND n.event_type IN (${placeholders})
       ORDER BY n.id ASC
       LIMIT 50`
    )
    .all(lastEventId, ...enabledTypes) as any[];

  return rows.map(hydrateNotificationRow);
}

export async function markNotificationRead(userId: string, notificationId: number): Promise<void> {
  const db = getDb();
  const now = isoNow();
  await db.prepare(
    `INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at)
     VALUES (?, ?, ?)`
  ).run(notificationId, userId, now);

  notificationBroker.publish({
    id: Date.now(),
    event: 'notifications_sync',
    data: { user_id: userId, notification_id: notificationId, action: 'read' },
  });
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  const db = getDb();
  const now = isoNow();
  const unread = await db
    .prepare(
      `SELECT n.id
       FROM notifications n
       LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = ?
       WHERE nr.read_at IS NULL`
    )
    .all(userId) as Array<{ id: number }>;

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) VALUES (?, ?, ?)`
  );
  await withTransaction(db, async () => {
    for (const row of unread) {
      await stmt.run(row.id, userId, now);
    }
  });

  notificationBroker.publish({
    id: Date.now(),
    event: 'notifications_sync',
    data: { user_id: userId, action: 'read_all' },
  });

  return unread.length;
}
