import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck, ExternalLink, UserCheck, UserX } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiFetch, formatCurrency, formatDateTime } from '../lib/api';
import {
  Button,
  Card,
  DecisionBadge,
  EmptyState,
  ErrorBanner,
  ReviewBadge,
  TableSkeleton,
} from '../components/ui/Primitives';

export function ReviewQueuePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [tab, setTab] = useState<'PENDING_REVIEW' | 'RESOLVED'>('PENDING_REVIEW');
  const [category, setCategory] = useState('ALL');
  const [selected, setSelected] = useState<any | null>(null);
  const [note, setNote] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['reviews', tab, category],
    queryFn: () => apiFetch<{ items: any[]; total: number }>(`/reviews?status=${tab}&category=${category}`),
  });

  const decideMutation = useMutation({
    mutationFn: ({ invoiceId, action, reviewNote }: { invoiceId: string; action: string; reviewNote: string }) =>
      apiFetch(`/invoices/${invoiceId}/review`, {
        method: 'POST',
        body: JSON.stringify({ action, note: reviewNote }),
      }),
    onSuccess: () => {
      setSelected(null);
      setNote('');
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (err: any) => {
      setActionError(err?.message || 'Unable to save review decision.');
    },
  });

  const canDecide = user?.role === 'REVIEWER' || user?.role === 'ADMIN';

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Exception Review Queue
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Triage flagged invoices with supporting evidence and mandatory audit justification notes
          </p>
        </div>

        <div className="flex items-center p-1 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shrink-0">
          <button
            onClick={() => {
              setTab('PENDING_REVIEW');
              setSelected(null);
            }}
            className={`px-3 py-1 text-xs font-medium rounded-md cursor-pointer ${
              tab === 'PENDING_REVIEW'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-500'
            }`}
          >
            Pending Review
          </button>
          <button
            onClick={() => {
              setTab('RESOLVED');
              setSelected(null);
            }}
            className={`px-3 py-1 text-xs font-medium rounded-md cursor-pointer ${
              tab === 'RESOLVED'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-500'
            }`}
          >
            Resolved History
          </button>
        </div>
      </div>

      {/* Category Filter */}
      <div className="flex flex-wrap items-center gap-2">
        {[
          { id: 'ALL', label: 'All Exceptions' },
          { id: 'VARIANCE', label: 'Tolerance / Cap' },
          { id: 'CONFIDENCE_MISSING', label: 'Confidence / Missing / Math' },
          { id: 'VENDOR_PO', label: 'Vendor / PO Ambiguity' },
        ].map((c) => (
          <button
            key={c.id}
            onClick={() => setCategory(c.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
              category === c.id
                ? 'bg-blue-50 dark:bg-blue-950/60 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300'
                : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {isError && <ErrorBanner message="Failed to load review queue." onRetry={() => void refetch()} />}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        <Card className={`${selected ? 'lg:col-span-7' : 'lg:col-span-12'} overflow-hidden`}>
          {isLoading ? (
            <TableSkeleton rows={6} />
          ) : !data?.items?.length ? (
            <div className="p-6">
              <EmptyState
                icon={tab === 'PENDING_REVIEW' ? CheckCircle2 : ClipboardCheck}
                title={tab === 'PENDING_REVIEW' ? 'Review queue clear' : 'No resolved reviews yet'}
                description={
                  tab === 'PENDING_REVIEW'
                    ? 'All flagged invoice exceptions have been resolved.'
                    : 'Resolved human overrides will appear here with original automated decisions preserved.'
                }
              />
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.items.map((item) => (
                <div
                  key={item.id}
                  onClick={() => {
                    setSelected(item);
                    setActionError(null);
                  }}
                  className={`p-4 flex items-center justify-between gap-4 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer transition-colors ${
                    selected?.id === item.id ? 'bg-blue-50/50 dark:bg-blue-950/20' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {item.invoice_number || item.original_filename}
                      </span>
                      <DecisionBadge outcome={item.original_decision || item.business_decision} />
                      <ReviewBadge status={item.review_status} />
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                      <span>{item.vendor_name || 'Unknown Vendor'}</span>
                      <span className="mx-1.5">·</span>
                      <span className="font-mono text-amber-700 dark:text-amber-300">
                        {item.primary_reason_code}
                      </span>
                      <span className="mx-1.5">·</span>
                      <span className="font-mono tabular-nums">{formatDateTime(item.created_at)}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono tabular-nums text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {formatCurrency(item.total_amount, item.currency)}
                    </div>
                    <div className="font-mono text-[11px] text-slate-400">
                      {item.matched_po_number || 'No PO'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {selected && (
          <Card className="lg:col-span-5 p-5 space-y-4 lg:sticky lg:top-20">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  {selected.invoice_number || selected.original_filename}
                </h2>
                <p className="text-xs text-slate-500">{selected.vendor_name || 'Unknown Vendor'}</p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => navigate(`/invoices/${selected.id}`)}
              >
                Full Workspace <ExternalLink className="w-3.5 h-3.5" />
              </Button>
            </div>

            <div className="p-3 rounded-md bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 text-xs space-y-1.5">
              <div className="font-mono font-semibold text-amber-800 dark:text-amber-300">
                {selected.primary_reason_code}
              </div>
              <p className="text-slate-700 dark:text-slate-200 leading-relaxed">
                {selected.explanation_details?.executive_summary || selected.explanation}
              </p>
              <div className="text-[10px] font-medium text-slate-600 dark:text-slate-300">
                {selected.explanation_source === 'GEMINI'
                  ? `AI-generated · Based on system validation results · ${selected.explanation_model || 'Google Gemini'}`
                  : `Deterministic fallback${selected.explanation_fallback_reason ? ` · ${selected.explanation_fallback_reason}` : ''}`}
              </div>
              {selected.explanation_details?.recommended_actions?.length > 0 && (
                <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                  <strong>Suggested next step:</strong> {selected.explanation_details.recommended_actions.join(' ')}
                </p>
              )}
            </div>

            {selected.matched_po_number && (
              <div className="p-3 rounded-md border border-slate-200 dark:border-slate-800 text-xs space-y-1 font-mono tabular-nums">
                <div className="flex justify-between">
                  <span className="text-slate-500">PO Original ({selected.matched_po_number}):</span>
                  <span>{formatCurrency(selected.po_original_amount, selected.currency)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Prior Consumed:</span>
                  <span>{formatCurrency(selected.po_consumed_amount, selected.currency)}</span>
                </div>
                <div className="flex justify-between font-semibold text-slate-900 dark:text-slate-100 pt-1 border-t border-slate-100 dark:border-slate-800">
                  <span>Current Invoice:</span>
                  <span>{formatCurrency(selected.total_amount, selected.currency)}</span>
                </div>
              </div>
            )}

            {tab === 'PENDING_REVIEW' && (
              <div className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
                {actionError && <ErrorBanner message={actionError} />}
                {!canDecide && (
                  <div className="text-xs text-amber-700 dark:text-amber-300">
                    Active role <strong>{user?.role}</strong> is read-only. Switch to{' '}
                    <strong>REVIEWER</strong> or <strong>ADMIN</strong> to submit a decision.
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Mandatory Reviewer Note (min 10 chars)
                  </label>
                  <textarea
                    rows={3}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    disabled={!canDecide}
                    placeholder="Document your verification reasoning for the audit trail..."
                    className="w-full p-2.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="approve"
                    disabled={!canDecide || note.trim().length < 10}
                    loading={decideMutation.isPending}
                    onClick={() =>
                      decideMutation.mutate({
                        invoiceId: selected.id,
                        action: 'APPROVE_OVERRIDE',
                        reviewNote: note.trim(),
                      })
                    }
                  >
                    <UserCheck className="w-4 h-4" />
                    Approve Override
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={!canDecide || note.trim().length < 10}
                    loading={decideMutation.isPending}
                    onClick={() =>
                      decideMutation.mutate({
                        invoiceId: selected.id,
                        action: 'REJECT_OVERRIDE',
                        reviewNote: note.trim(),
                      })
                    }
                  >
                    <UserX className="w-4 h-4" />
                    Reject Override
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
