import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, Play, Plus, RefreshCw, Search } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useRole } from '../hooks/useRole';
import { apiFetch, downloadCsv, formatCurrency, formatShortDate } from '../lib/api';
import {
  Button,
  Card,
  DecisionBadge,
  EmptyState,
  ErrorBanner,
  ProcessingBadge,
  ReviewBadge,
  TableSkeleton,
} from '../components/ui/Primitives';

interface InvoiceListItem {
  id: string;
  invoice_number: string | null;
  original_filename: string;
  vendor_canonical_name: string | null;
  extracted_vendor_name: string | null;
  vendor_verification_status: string | null;
  matched_po_number: string | null;
  extracted_po_number: string | null;
  invoice_date: string | null;
  created_at: string;
  total_amount: string | null;
  currency: string | null;
  overall_confidence: number | null;
  processing_status: string;
  business_decision: string;
  primary_reason_code: string | null;
  review_status: string;
  run_started_at?: string | null;
}

export function InvoicesPage() {
  const { RoleGate } = useRole();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [q, setQ] = useState(searchParams.get('q') || '');
  const decision = searchParams.get('decision') || 'ALL';
  const procStatus = searchParams.get('processing_status') || 'ALL';
  const reviewStatus = searchParams.get('review_status') || 'ALL';
  const sort = searchParams.get('sort') || '-created_at';
  const page = Number(searchParams.get('page') || 1);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  const updateParam = (key: string, val: string) => {
    const next = new URLSearchParams(searchParams);
    if (!val || val === 'ALL') next.delete(key);
    else next.set(key, val);
    if (key !== 'page') next.delete('page');
    setSearchParams(next);
  };

  const queryStr = useMemo(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (decision !== 'ALL') p.set('decision', decision);
    if (procStatus !== 'ALL') p.set('processing_status', procStatus);
    if (reviewStatus !== 'ALL') p.set('review_status', reviewStatus);
    p.set('sort', sort);
    p.set('page', String(page));
    p.set('page_size', '20');
    return p.toString();
  }, [q, decision, procStatus, reviewStatus, sort, page]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['invoices', queryStr],
    queryFn: () =>
      apiFetch<{ items: InvoiceListItem[]; total: number; page: number; page_size: number }>(
        `/invoices?${queryStr}`
      ),
    refetchInterval: (query) => {
      const hasActive = query.state.data?.items?.some(
        (i) => i.processing_status === 'QUEUED' || i.processing_status === 'RUNNING'
      );
      return hasActive ? 2500 : false;
    },
  });

  const startMutation = useMutation({
    mutationFn: (invoiceId: string) =>
      apiFetch(`/invoices/${invoiceId}/start`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (_res, invoiceId) => {
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      navigate(`/invoices/${invoiceId}?live=true`);
    },
  });

  const retryMutation = useMutation({
    mutationFn: (invoiceId: string) =>
      apiFetch(`/invoices/${invoiceId}/retry`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (_res, invoiceId) => {
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      navigate(`/invoices/${invoiceId}?live=true`);
    },
  });

  const items = data?.items || [];
  const selectedList = Object.entries(selectedIds)
    .filter(([, checked]) => checked)
    .map(([id]) => id);

  const [exportingCsv, setExportingCsv] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const hasActiveFilters = Boolean(
    q.trim() || decision !== 'ALL' || procStatus !== 'ALL' || reviewStatus !== 'ALL'
  );

  const exportCsvPath = useMemo(() => {
    const p = new URLSearchParams();
    if (selectedList.length > 0) {
      p.set('ids', selectedList.join(','));
    } else {
      if (q.trim()) p.set('q', q.trim());
      if (decision !== 'ALL') p.set('decision', decision);
      if (procStatus !== 'ALL') p.set('processing_status', procStatus);
      if (reviewStatus !== 'ALL') p.set('review_status', reviewStatus);
      p.set('sort', sort);
    }
    return `/invoices/export?${p.toString()}`;
  }, [selectedList, q, decision, procStatus, reviewStatus, sort]);

  const handleExportCsv = async () => {
    setExportError(null);
    setExportingCsv(true);
    try {
      await downloadCsv(exportCsvPath, 'invoicedesk_invoices.csv');
    } catch (err: any) {
      setExportError(err?.message || 'Unable to export invoices CSV.');
    } finally {
      setExportingCsv(false);
    }
  };

  const allSelected = Boolean(items.length) && items.every((item) => selectedIds[item.id]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Invoices Ledger
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Search, filter, export, and inspect every processed invoice and decision
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="secondary" loading={exportingCsv} onClick={() => void handleExportCsv()}>
            <Download className="w-4 h-4" />
            {selectedList.length
              ? `Export (${selectedList.length}) CSV`
              : hasActiveFilters
                ? 'Export Filtered CSV'
                : 'Export CSV'}
          </Button>
          <RoleGate capability="operate_pipeline">
            <Button variant="primary" onClick={() => navigate('/upload')}>
              <Plus className="w-4 h-4" />
              Upload Invoice
            </Button>
          </RoleGate>
        </div>
      </div>

      {exportError && <ErrorBanner message={exportError} />}

      {/* Filter Bar */}
      <Card className="p-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                updateParam('q', e.target.value);
              }}
              placeholder="Search invoice #, filename, vendor, or PO #..."
              className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <select
            value={decision}
            onChange={(e) => updateParam('decision', e.target.value)}
            aria-label="Filter by decision"
            className="h-9 px-3 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
          >
            <option value="ALL">Decision: All</option>
            <option value="APPROVE">Decision: APPROVE</option>
            <option value="REVIEW">Decision: REVIEW</option>
            <option value="REJECT">Decision: REJECT</option>
            <option value="PENDING">Decision: PENDING</option>
          </select>

          <select
            value={procStatus}
            onChange={(e) => updateParam('processing_status', e.target.value)}
            aria-label="Filter by processing status"
            className="h-9 px-3 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
          >
            <option value="ALL">Processing: All</option>
            <option value="COMPLETED">Completed</option>
            <option value="RUNNING">Running</option>
            <option value="FAILED">Failed</option>
          </select>

          <select
            value={reviewStatus}
            onChange={(e) => updateParam('review_status', e.target.value)}
            aria-label="Filter by review status"
            className="h-9 px-3 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
          >
            <option value="ALL">Review: All</option>
            <option value="PENDING_REVIEW">Pending Review</option>
            <option value="APPROVED_BY_HUMAN">Human Approved</option>
            <option value="REJECTED_BY_HUMAN">Human Rejected</option>
          </select>

          <select
            value={sort}
            onChange={(e) => updateParam('sort', e.target.value)}
            aria-label="Sort invoices"
            className="h-9 px-3 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
          >
            <option value="-created_at">Newest First</option>
            <option value="created_at">Oldest First</option>
            <option value="-total_amount">Highest Amount</option>
            <option value="total_amount">Lowest Amount</option>
            <option value="-overall_confidence">Highest Confidence</option>
          </select>
        </div>
      </Card>

      {isError && <ErrorBanner message="Unable to load invoices." onRetry={() => void refetch()} />}

      <Card className="overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={8} />
        ) : !items.length ? (
          <div className="p-6">
            <EmptyState
              icon={FileText}
              title="No invoices found"
              description={
                q || decision !== 'ALL' || procStatus !== 'ALL' || reviewStatus !== 'ALL'
                  ? 'No invoices match your active filters.'
                  : 'Upload a vendor invoice PDF to run the 8-stage verification pipeline.'
              }
              action={
                q || decision !== 'ALL' || procStatus !== 'ALL' || reviewStatus !== 'ALL' ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setQ('');
                      setSearchParams(new URLSearchParams());
                    }}
                  >
                    Clear All Filters
                  </Button>
                ) : (
                  <RoleGate capability="operate_pipeline">
                    <Button variant="primary" onClick={() => navigate('/upload')}>
                      Upload Invoice
                    </Button>
                  </RoleGate>
                )
              }
            />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="px-4 py-2.5 text-[11px] font-semibold tracking-wide text-slate-500 dark:text-slate-400 uppercase whitespace-nowrap">
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={allSelected}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          const next: Record<string, boolean> = {};
                          if (checked) {
                            items.forEach((i) => {
                              next[i.id] = true;
                            });
                          }
                          setSelectedIds(next);
                        }}
                        className="rounded border-slate-300"
                      />
                    </th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold tracking-wide text-slate-500 dark:text-slate-400 uppercase whitespace-nowrap">
                      Invoice
                    </th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold tracking-wide text-slate-500 dark:text-slate-400 uppercase whitespace-nowrap">
                      Vendor
                    </th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold tracking-wide text-slate-500 dark:text-slate-400 uppercase whitespace-nowrap">
                      PO #
                    </th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold tracking-wide text-slate-500 dark:text-slate-400 uppercase whitespace-nowrap">
                      Date
                    </th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold tracking-wide text-slate-500 dark:text-slate-400 uppercase whitespace-nowrap text-right">
                      Total
                    </th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold tracking-wide text-slate-500 dark:text-slate-400 uppercase whitespace-nowrap text-right">
                      Conf.
                    </th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold tracking-wide text-slate-500 dark:text-slate-400 uppercase whitespace-nowrap">
                      Processing
                    </th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold tracking-wide text-slate-500 dark:text-slate-400 uppercase whitespace-nowrap">
                      Decision
                    </th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold tracking-wide text-slate-500 dark:text-slate-400 uppercase whitespace-nowrap">
                      Review
                    </th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {items.map((inv) => {
                    const confPct =
                      typeof inv.overall_confidence === 'number'
                        ? Math.round(inv.overall_confidence * 100)
                        : null;
                    return (
                      <tr
                        key={inv.id}
                        onClick={() => navigate(`/invoices/${inv.id}`)}
                        className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
                      >
                        <td className="px-4 py-3 align-middle">
                          <input
                            type="checkbox"
                            aria-label="Select invoice"
                            checked={Boolean(selectedIds[inv.id])}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) =>
                              setSelectedIds((prev) => ({ ...prev, [inv.id]: e.target.checked }))
                            }
                            className="rounded border-slate-300"
                          />
                        </td>
                        <td className="px-4 py-3 align-middle">
                          <div className="min-w-0">
                            <div className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">
                              {inv.invoice_number || '—'}
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-[190px]">
                              {inv.original_filename}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 align-middle">
                          <div className="text-xs">
                            <div className="font-medium text-slate-800 dark:text-slate-200">
                              {inv.vendor_canonical_name || inv.extracted_vendor_name || 'Pending…'}
                            </div>
                            {inv.vendor_verification_status && (
                              <span className="text-[11px] text-slate-400">{inv.vendor_verification_status}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 align-middle">
                          <span className="font-mono text-xs text-slate-600 dark:text-slate-300">
                            {inv.matched_po_number || inv.extracted_po_number || '—'}
                          </span>
                        </td>
                        <td className="px-4 py-3 align-middle">
                          <span className="font-mono tabular-nums text-xs text-slate-600 dark:text-slate-400">
                            {formatShortDate(inv.invoice_date || inv.created_at)}
                          </span>
                        </td>
                        <td className="px-4 py-3 align-middle text-right font-mono tabular-nums text-xs font-semibold text-slate-900 dark:text-slate-100">
                          {formatCurrency(inv.total_amount, inv.currency || 'USD')}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {confPct === null ? (
                            <div className="text-right text-xs text-slate-400">—</div>
                          ) : (
                            <div
                              className={`text-right font-mono tabular-nums text-xs font-medium ${
                                confPct < 85
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-slate-700 dark:text-slate-300'
                              }`}
                            >
                              {confPct}%
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          <ProcessingBadge status={inv.processing_status} />
                        </td>
                        <td className="px-4 py-3 align-middle">
                          <div className="space-y-0.5">
                            <DecisionBadge outcome={inv.business_decision} />
                            {inv.primary_reason_code && (
                              <div className="font-mono text-[10px] text-slate-500 dark:text-slate-400 truncate max-w-[160px]">
                                {inv.primary_reason_code}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 align-middle">
                          <ReviewBadge status={inv.review_status} />
                        </td>
                        <td className="px-4 py-3 align-middle">
                          <div
                            className="flex items-center justify-end gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <RoleGate
                              capability="operate_pipeline"
                              when={inv.processing_status === 'QUEUED' && !inv.run_started_at}
                            >
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => startMutation.mutate(inv.id)}
                              >
                                <Play className="w-3 h-3" />
                                Start
                              </Button>
                            </RoleGate>
                            <RoleGate
                              capability="operate_pipeline"
                              when={inv.processing_status === 'FAILED'}
                            >
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => retryMutation.mutate(inv.id)}
                              >
                                <RefreshCw className="w-3 h-3" />
                                Retry
                              </Button>
                            </RoleGate>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => navigate(`/invoices/${inv.id}`)}
                            >
                              Inspect
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500">
              <span className="font-mono tabular-nums">
                Showing {items.length} of {data?.total ?? 0} invoices
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => updateParam('page', String(page - 1))}
                >
                  Previous
                </Button>
                <span className="font-mono tabular-nums">Page {page}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page * (data?.page_size ?? 20) >= (data?.total ?? 0)}
                  onClick={() => updateParam('page', String(page + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
