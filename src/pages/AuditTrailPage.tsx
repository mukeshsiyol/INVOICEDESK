import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Download,
  History,
  Lock,
  Search,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiFetch, formatDateTime } from '../lib/api';
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
  'REVIEW_OVERRIDE_APPROVED',
  'REVIEW_OVERRIDE_REJECTED',
  'INVOICE_UPLOADED',
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

export function AuditTrailPage() {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const [action, setAction] = useState('ALL');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const pageSize = 25;

  const isAuthorized = user?.role === 'REVIEWER' || user?.role === 'ADMIN';

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['audit-logs', q, action, page],
    queryFn: () =>
      apiFetch<{ items: any[]; total: number; page: number; page_size: number }>(
        `/audit-logs?q=${encodeURIComponent(q)}&action=${encodeURIComponent(action)}&page=${page}&page_size=${pageSize}`
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
          The immutable Audit Trail is restricted to <span className="font-mono">REVIEWER</span> and{' '}
          <span className="font-mono">ADMIN</span> roles. Your current role is{' '}
          <span className="font-mono font-medium">{user?.role}</span>.
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

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Audit Trail
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Append-only financial compliance log preserving automated decisions alongside human overrides
          </p>
        </div>
        {user?.role === 'ADMIN' && (
          <a href="/api/v1/audit-logs/export">
            <Button variant="secondary" size="sm">
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </Button>
          </a>
        )}
      </div>

      <Card className="p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="Search actor email, resource ID, reason code, or note..."
              className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
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
              description="Adjust your search query or action filter to view historical compliance records."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/60 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="py-2.5 px-4 w-8" />
                  <th className="py-2.5 px-4">Timestamp</th>
                  <th className="py-2.5 px-4">Actor</th>
                  <th className="py-2.5 px-4">Action</th>
                  <th className="py-2.5 px-4">Resource</th>
                  <th className="py-2.5 px-4">Decision Delta</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {data.items.map((row) => {
                  const isExpanded = expandedId === row.id;
                  return (
                    <React.Fragment key={row.id}>
                      <tr
                        onClick={() => setExpandedId(isExpanded ? null : row.id)}
                        className="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                      >
                        <td className="py-3 px-4 text-slate-400">
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4" />
                          ) : (
                            <ChevronRight className="w-4 h-4" />
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-500 whitespace-nowrap">
                          {formatDateTime(row.created_at)}
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-xs font-medium text-slate-900 dark:text-slate-100">
                            {row.actor_name || (row.actor_type === 'SYSTEM' ? 'Automated Pipeline' : 'User')}
                          </div>
                          <div className="text-[11px] font-mono text-slate-500">
                            {row.actor_role} {row.actor_email ? `· ${row.actor_email}` : ''}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <span className="inline-flex px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono text-[11px] font-medium text-slate-700 dark:text-slate-300">
                            {row.action}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-xs" onClick={(e) => e.stopPropagation()}>
                          <span className="text-[11px] font-mono text-slate-400 mr-1.5">{row.resource_type}</span>
                          {row.resource_type === 'INVOICE' ? (
                            <Link
                              to={`/invoices/${row.resource_id}`}
                              className="font-mono text-blue-600 dark:text-blue-400 hover:underline"
                            >
                              {row.resource_id.slice(0, 12)}…
                            </Link>
                          ) : row.resource_type === 'PURCHASE_ORDER' ? (
                            <Link
                              to={`/purchase-orders?po=${row.resource_id}`}
                              className="font-mono text-blue-600 dark:text-blue-400 hover:underline"
                            >
                              {row.resource_id.slice(0, 12)}…
                            </Link>
                          ) : row.resource_type === 'VENDOR' ? (
                            <Link
                              to={`/vendors?vendor=${row.resource_id}`}
                              className="font-mono text-blue-600 dark:text-blue-400 hover:underline"
                            >
                              {row.resource_id.slice(0, 12)}…
                            </Link>
                          ) : (
                            <span className="font-mono text-slate-600 dark:text-slate-300">{row.resource_id}</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
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
                        <tr className="bg-slate-50/80 dark:bg-slate-950/50">
                          <td colSpan={6} className="px-6 py-4">
                            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
                              Immutable Event Payload (Event #{row.id})
                            </div>
                            <pre className="p-3 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 font-mono text-xs text-slate-700 dark:text-slate-300 overflow-x-auto">
                              {JSON.stringify(row.details, null, 2)}
                            </pre>
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
