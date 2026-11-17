import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiFetch, formatDateTime, formatDurationMs } from '../lib/api';
import {
  Button,
  Card,
  DecisionBadge,
  EmptyState,
  ErrorBanner,
  ProcessingBadge,
  TableSkeleton,
} from '../components/ui/Primitives';

export function RunsPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('ALL');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['runs', statusFilter],
    queryFn: () => apiFetch<{ items: any[]; total: number }>(`/runs?status=${statusFilter}`),
    refetchInterval: 4000,
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Processing Runs
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Execution history across initial uploads and pipeline retries
          </p>
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 px-3 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
        >
          <option value="ALL">Status: All</option>
          <option value="RUNNING">Running</option>
          <option value="COMPLETED">Completed</option>
          <option value="FAILED">Failed</option>
        </select>
      </div>

      {isError && <ErrorBanner message="Unable to load processing runs." onRetry={() => void refetch()} />}

      <Card className="overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={6} />
        ) : !data?.items?.length ? (
          <div className="p-6">
            <EmptyState
              icon={Activity}
              title="No processing runs recorded"
              description="Upload an invoice PDF to initiate a processing run."
              action={
                <Button variant="primary" onClick={() => navigate('/upload')}>
                  Upload Invoice
                </Button>
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Invoice</th>
                  <th className="px-4 py-2.5">Run # / Trigger</th>
                  <th className="px-4 py-2.5">Stage</th>
                  <th className="px-4 py-2.5">Mode</th>
                  <th className="px-4 py-2.5">Run Status</th>
                  <th className="px-4 py-2.5">Decision</th>
                  <th className="px-4 py-2.5 text-right">Duration</th>
                  <th className="px-4 py-2.5 text-right">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.items.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => navigate(`/invoices/${r.invoice_id}?runId=${r.id}`)}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                        {r.invoice_number || r.original_filename}
                      </div>
                      <div className="text-slate-500">{r.vendor_name || '—'}</div>
                    </td>
                    <td className="px-4 py-3 font-mono">
                      #{r.run_number} · {r.trigger_type}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums">{r.current_stage} / 8</td>
                    <td className="px-4 py-3 font-mono">{r.extraction_mode || '—'}</td>
                    <td className="px-4 py-3">
                      <ProcessingBadge status={r.status} />
                    </td>
                    <td className="px-4 py-3">
                      <DecisionBadge outcome={r.business_decision} />
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {formatDurationMs(r.duration_ms)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-500">
                      {formatDateTime(r.started_at || r.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
