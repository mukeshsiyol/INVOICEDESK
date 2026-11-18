import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  History,
  Lock,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useRole } from '../hooks/useRole';
import { apiFetch, downloadCsv, formatDateTime } from '../lib/api';
import {
  Button,
  Card,
  DecisionBadge,
  EmptyState,
  ErrorBanner,
  ReviewBadge,
  TableSkeleton,
} from '../components/ui/Primitives';

const ACTION_OPTIONS = [
  'ALL',
  'DECISION_GENERATED',
  'AI_DECISION_EXPLAINED',
  'REVIEW_OVERRIDE_APPROVED',
  'REVIEW_OVERRIDE_REJECTED',
  'AI_REJECTION_DRAFT_GENERATED',
  'INVOICE_UPLOADED',
  'RUN_STARTED_MANUALLY',
  'RUN_RETRIED',
  'VENDOR_CREATED',
  'VENDOR_UPDATED',
  'PO_CREATED',
  'PO_UPDATED',
  'SETTINGS_UPDATED',
  'USER_CREATED',
  'USER_UPDATED',
  'AUTH_DEMO_SWITCH',
];

const RESOURCE_TYPE_OPTIONS = ['ALL', 'INVOICE', 'PURCHASE_ORDER', 'VENDOR', 'SETTINGS', 'USER'];

function formatAuditDecision(val: string | null | undefined) {
  if (!val) return null;
  if (val === 'APPROVE' || val === 'REVIEW' || val === 'REJECT' || val === 'PENDING') {
    return <DecisionBadge outcome={val} />;
  }
  if (val === 'APPROVED_BY_HUMAN' || val === 'REJECTED_BY_HUMAN' || val === 'PENDING_REVIEW') {
    return <ReviewBadge status={val} />;
  }
  return <span className="font-mono text-xs text-slate-600 dark:text-slate-300">{val}</span>;
}

function summarizeAuditDetails(row: any): { tag: string | null; text: string } {
  const d = (row.details || {}) as Record<string, any>;
  if (row.action === 'AI_DECISION_EXPLAINED') {
    return {
      tag: d.model ? String(d.model) : 'GEMINI_FLASH',
      text: d.explanation
        ? String(d.explanation)
        : `Generated Gemini Flash explanation (${d.primary_reason_code || 'DECISION'}).`,
    };
  }
  if (d.primary_reason_code || d.explanation) {
    return {
      tag: d.primary_reason_code ? String(d.primary_reason_code) : null,
      text: d.explanation ? String(d.explanation) : String(d.primary_reason_code),
    };
  }
  if (row.action === 'REVIEW_OVERRIDE_APPROVED' || row.action === 'REVIEW_OVERRIDE_REJECTED') {
    return {
      tag: 'HUMAN_OVERRIDE',
      text: d.note ? String(d.note) : 'Manual reviewer override recorded.',
    };
  }
  if (row.action === 'AI_REJECTION_DRAFT_GENERATED') {
    return {
      tag: d.model ? String(d.model) : 'AI_DRAFT',
      text: `Generated ${d.tone || 'formal'} rejection draft${d.subject ? `: "${d.subject}"` : '.'}`,
    };
  }
  if (row.action === 'INVOICE_UPLOADED') {
    return {
      tag: null,
      text: `Uploaded ${d.filename || 'PDF'}${typeof d.size_bytes === 'number' ? ` (${(d.size_bytes / 1024).toFixed(1)} KB)` : ''}`,
    };
  }
  if (row.action === 'RUN_RETRIED' || row.action === 'RUN_STARTED_MANUALLY') {
    return {
      tag: d.run_number ? `RUN #${d.run_number}` : null,
      text: d.reason ? String(d.reason) : 'Pipeline execution triggered manually.',
    };
  }
  if (row.action === 'SETTINGS_UPDATED') {
    return {
      tag: 'POLICY_CHANGE',
      text: 'Updated workspace processing thresholds or email templates.',
    };
  }
  if (row.action === 'VENDOR_CREATED' || row.action === 'VENDOR_UPDATED') {
    return {
      tag: d.vendor_code ? String(d.vendor_code) : null,
      text: d.canonical_name
        ? `${d.canonical_name} registered`
        : d.after?.canonical_name
          ? `Updated ${d.after.canonical_name} (${d.after.verification_status || ''})`
          : 'Vendor master record updated.',
    };
  }
  if (row.action === 'PO_CREATED' || row.action === 'PO_UPDATED') {
    return {
      tag: d.po_number ? String(d.po_number) : null,
      text: d.original_amount
        ? `PO ${d.po_number} created ($${d.original_amount})`
        : d.after_status
          ? `Status changed: ${d.before_status} -> ${d.after_status}`
          : 'Purchase order updated.',
    };
  }
  if (row.action === 'AUTH_DEMO_SWITCH') {
    return {
      tag: null,
      text: `Switched demo role ${d.previous_role || '—'} -> ${d.new_role || '—'}`,
    };
  }
  if (row.action === 'USER_CREATED' || row.action === 'USER_UPDATED') {
    return {
      tag: d.role ? String(d.role) : null,
      text: d.email ? `${d.email} (${d.role})` : `Updated role to ${d.role || '—'}`,
    };
  }
  const firstEntry = Object.entries(d)[0];
  return {
    tag: null,
    text: firstEntry ? `${firstEntry[0]}: ${typeof firstEntry[1] === 'string' ? firstEntry[1] : JSON.stringify(firstEntry[1])}` : 'No additional metadata',
  };
}

export function AuditTrailPage() {
  const { role, hasAccess: isAuthorized } = useRole({ capability: 'view_audit_trail' });
  const [q, setQ] = useState('');
  const [action, setAction] = useState('ALL');
  const [resourceType, setResourceType] = useState('ALL');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const pageSize = 25;

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['audit-logs', q, action, resourceType, page],
    queryFn: () =>
      apiFetch<{ items: any[]; total: number; page: number; page_size: number }>(
        `/audit-logs?q=${encodeURIComponent(q)}&action=${encodeURIComponent(action)}&resource_type=${encodeURIComponent(resourceType)}&page=${page}&page_size=${pageSize}`
      ),
    enabled: isAuthorized,
  });

  if (!isAuthorized) {
    return (
      <Card className="p-10 text-center max-w-lg mx-auto mt-10 space-y-3">
        <div className="w-10 h-10 rounded-lg bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center mx-auto">
          <Lock className="w-5 h-5" />
        </div>
        <h1 className="text-lg font-display font-semibold text-slate-900 dark:text-slate-100">
          403 — Access Restricted
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          The immutable Audit Trail is restricted to <span className="font-mono">REVIEWER</span>,{' '}
          <span className="font-mono">AUDITOR</span>, and{' '}
          <span className="font-mono">ADMIN</span> roles. Your current role is{' '}
          <span className="font-mono font-medium">{role}</span>.
        </p>
        <div className="pt-2">
          <Link to="/">
            <Button variant="secondary" size="sm">
              Return to Overview
            </Button>
          </Link>
        </div>
      </Card>
    );
  }

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));

  const handleExportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const qs = new URLSearchParams({ q, action, resource_type: resourceType });
      await downloadCsv(`/audit-logs/export?${qs.toString()}`, 'invoicedesk_audit.csv');
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Unable to export audit CSV.');
    } finally {
      setExporting(false);
    }
  };

  const handleCopyPayload = async (rowId: number, details: Record<string, unknown>) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(details, null, 2));
      setCopiedId(rowId);
      window.setTimeout(() => setCopiedId((prev) => (prev === rowId ? null : prev)), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-display font-semibold tracking-tight text-slate-900 dark:text-slate-50">
              Audit Trail
            </h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60">
              <ShieldCheck className="w-3 h-3" />
              Append-Only Ledger
            </span>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Immutable compliance history capturing automated pipeline decisions, human overrides, and policy changes
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          loading={exporting}
          onClick={() => void handleExportCsv()}
        >
          <Download className="w-3.5 h-3.5" />
          Export CSV
        </Button>
      </div>

      {exportError && <ErrorBanner message={exportError} />}

      <Card className="p-4">
        <div className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="Search event #, actor, invoice/PO/vendor, reason code, or explanation..."
              className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <select
            value={resourceType}
            onChange={(e) => {
              setResourceType(e.target.value);
              setPage(1);
            }}
            className="h-9 px-3 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
          >
            {RESOURCE_TYPE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt === 'ALL' ? 'All Resource Types' : opt}
              </option>
            ))}
          </select>
          <select
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
            className="h-9 px-3 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
          >
            {ACTION_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt === 'ALL' ? 'All Event Actions' : opt}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {isError && <ErrorBanner message="Failed to load audit log entries." onRetry={() => void refetch()} />}

      <Card className="overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={8} />
        ) : !data?.items?.length ? (
          <div className="p-6">
            <EmptyState
              icon={History}
              title="No matching audit events"
              description="Adjust your search query or filters to view historical compliance records."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/60 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="py-2.5 px-4 w-8" />
                  <th className="py-2.5 px-4">Event / Time</th>
                  <th className="py-2.5 px-4">Actor</th>
                  <th className="py-2.5 px-4">Action & Summary</th>
                  <th className="py-2.5 px-4">Resource</th>
                  <th className="py-2.5 px-4">Decision Delta</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {data.items.map((row) => {
                  const isExpanded = expandedId === row.id;
                  const summary = summarizeAuditDetails(row);
                  const detailsObj = (row.details || {}) as Record<string, any>;
                  const hasBeforeAfter =
                    detailsObj.before &&
                    detailsObj.after &&
                    typeof detailsObj.before === 'object' &&
                    typeof detailsObj.after === 'object';

                  return (
                    <React.Fragment key={row.id}>
                      <tr
                        onClick={() => setExpandedId(isExpanded ? null : row.id)}
                        className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer transition-colors ${
                          isExpanded ? 'bg-slate-50/80 dark:bg-slate-800/30' : ''
                        }`}
                      >
                        <td className="py-3 px-4 text-slate-400 align-top">
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 mt-0.5" />
                          ) : (
                            <ChevronRight className="w-4 h-4 mt-0.5" />
                          )}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap align-top">
                          <div className="font-mono text-xs font-semibold text-slate-700 dark:text-slate-200">
                            Event #{row.id}
                          </div>
                          <div className="font-mono tabular-nums text-[11px] text-slate-500">
                            {formatDateTime(row.created_at)}
                          </div>
                        </td>
                        <td className="py-3 px-4 align-top">
                          <div className="text-xs font-medium text-slate-900 dark:text-slate-100">
                            {row.actor_name || (row.actor_type === 'SYSTEM' ? 'Automated Pipeline' : 'User')}
                          </div>
                          <div className="text-[11px] font-mono text-slate-500">
                            {row.actor_role} {row.actor_email ? `· ${row.actor_email}` : ''}
                          </div>
                        </td>
                        <td className="py-3 px-4 align-top max-w-md">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="inline-flex px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono text-[11px] font-medium text-slate-700 dark:text-slate-300">
                              {row.action}
                            </span>
                            {summary.tag && (
                              <span className="inline-flex px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800/60 font-mono text-[10px] font-medium text-blue-700 dark:text-blue-300">
                                {summary.tag}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 line-clamp-2">
                            {summary.text}
                          </p>
                        </td>
                        <td className="py-3 px-4 text-xs align-top" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                              {row.resource_type}
                            </span>
                            {row.resource_type === 'INVOICE' ? (
                              <Link
                                to={`/invoices/${row.resource_id}`}
                                className="font-mono font-medium text-blue-600 dark:text-blue-400 hover:underline truncate max-w-[160px]"
                                title={row.resource_id}
                              >
                                {row.resource_label || row.resource_id.slice(0, 12)}
                              </Link>
                            ) : row.resource_type === 'PURCHASE_ORDER' ? (
                              <Link
                                to={`/purchase-orders?po=${row.resource_id}`}
                                className="font-mono font-medium text-blue-600 dark:text-blue-400 hover:underline truncate max-w-[160px]"
                                title={row.resource_id}
                              >
                                {row.resource_label || row.resource_id.slice(0, 12)}
                              </Link>
                            ) : row.resource_type === 'VENDOR' ? (
                              <Link
                                to={`/vendors?vendor=${row.resource_id}`}
                                className="font-mono font-medium text-blue-600 dark:text-blue-400 hover:underline truncate max-w-[160px]"
                                title={row.resource_id}
                              >
                                {row.resource_label || row.resource_id.slice(0, 12)}
                              </Link>
                            ) : (
                              <span className="font-mono text-slate-700 dark:text-slate-300 truncate max-w-[160px]">
                                {row.resource_label || row.resource_id}
                              </span>
                            )}
                          </div>
                          {row.resource_sublabel && (
                            <div className="text-[11px] text-slate-500 mt-0.5 truncate max-w-[200px]">
                              {row.resource_sublabel}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 align-top">
                          {row.original_decision || row.new_decision ? (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {row.original_decision && formatAuditDecision(row.original_decision)}
                              {row.original_decision && row.new_decision && (
                                <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                              )}
                              {row.new_decision && formatAuditDecision(row.new_decision)}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-slate-50/90 dark:bg-slate-950/60">
                          <td colSpan={6} className="px-6 py-4 space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-2.5">
                                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                                  Immutable Event Payload (Event #{row.id})
                                </span>
                                {row.event_hash && (
                                  <span
                                    className="font-mono text-[11px] px-2 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                                    title={`SHA-256: ${row.event_hash}`}
                                  >
                                    SHA256:{String(row.event_hash).slice(0, 14)}…
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                {row.resource_type === 'INVOICE' && (
                                  <Link
                                    to={`/invoices/${row.resource_id}`}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-slate-50 dark:hover:bg-slate-800"
                                  >
                                    Open Invoice Workspace <ExternalLink className="w-3 h-3" />
                                  </Link>
                                )}
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => void handleCopyPayload(row.id, detailsObj)}
                                >
                                  {copiedId === row.id ? (
                                    <>
                                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                                      Copied JSON
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="w-3.5 h-3.5" />
                                      Copy JSON
                                    </>
                                  )}
                                </Button>
                              </div>
                            </div>

                            {/* Human-readable compliance breakdown */}
                            <div className="p-3.5 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-2.5">
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                                <div>
                                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                                    Resource
                                  </div>
                                  <div className="font-medium text-slate-800 dark:text-slate-100 mt-0.5">
                                    {row.resource_label || row.resource_id}
                                  </div>
                                  <div className="font-mono text-[11px] text-slate-400 truncate">
                                    {row.resource_type} · {row.resource_id}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                                    {detailsObj.primary_reason_code ? 'Primary Reason Code' : 'Action / Actor Type'}
                                  </div>
                                  <div className="font-mono font-medium text-slate-800 dark:text-slate-100 mt-0.5">
                                    {detailsObj.primary_reason_code || row.action}
                                  </div>
                                  <div className="text-[11px] text-slate-500">
                                    {row.actor_type} · {row.actor_role}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                                    Recorded At
                                  </div>
                                  <div className="font-mono text-slate-800 dark:text-slate-100 mt-0.5">
                                    {row.created_at}
                                  </div>
                                  {detailsObj.run_id && (
                                    <div className="font-mono text-[11px] text-slate-400 truncate">
                                      Run: {String(detailsObj.run_id)}
                                    </div>
                                  )}
                                </div>
                              </div>

                              {(detailsObj.explanation || detailsObj.note) && (
                                <div className="pt-2 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-200 leading-relaxed">
                                  <span className="font-semibold text-slate-500 dark:text-slate-400 mr-1.5">
                                    {detailsObj.note ? 'Reviewer Note:' : 'Explanation:'}
                                  </span>
                                  {String(detailsObj.explanation || detailsObj.note)}
                                </div>
                              )}

                              {hasBeforeAfter && (
                                <div className="pt-2 border-t border-slate-100 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                                  <div>
                                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                                      Before
                                    </div>
                                    <pre className="p-2 rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono text-[11px] overflow-x-auto">
                                      {JSON.stringify(detailsObj.before, null, 2)}
                                    </pre>
                                  </div>
                                  <div>
                                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                                      After
                                    </div>
                                    <pre className="p-2 rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono text-[11px] overflow-x-auto">
                                      {JSON.stringify(detailsObj.after, null, 2)}
                                    </pre>
                                  </div>
                                </div>
                              )}
                            </div>

                            <details className="group">
                              <summary className="text-[11px] font-medium text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 cursor-pointer select-none">
                                Raw Event JSON
                              </summary>
                              <pre className="mt-2 p-3 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 font-mono text-xs text-slate-700 dark:text-slate-300 overflow-x-auto">
                                {JSON.stringify(detailsObj, null, 2)}
                              </pre>
                            </details>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {(data?.total ?? 0) > pageSize && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500">
            <span className="font-mono tabular-nums">
              Page {page} of {totalPages} ({data?.total} events)
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
