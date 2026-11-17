import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, HelpCircle } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiFetch, downloadCsv, formatCurrency, formatDurationMs } from '../lib/api';
import { Button, Card, ErrorBanner } from '../components/ui/Primitives';

export function AnalyticsPage() {
  const [windowRange, setWindowRange] = useState<'7d' | '30d' | '90d' | 'all'>('30d');
  const [vendorId, setVendorId] = useState('ALL');
  const [exportingType, setExportingType] = useState<'vendors' | 'invoices' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const { data: metrics, isLoading, isError, refetch } = useQuery({
    queryKey: ['analytics-metrics', windowRange, vendorId],
    queryFn: () => apiFetch<any>(`/analytics/metrics?window=${windowRange}&vendor_id=${vendorId}`),
  });

  const { data: vendorsData } = useQuery({
    queryKey: ['vendors', 'filter'],
    queryFn: () => apiFetch<{ items: any[] }>('/vendors'),
  });

  const { data: vendorReportData } = useQuery({
    queryKey: ['vendors-report', windowRange, vendorId],
    queryFn: () =>
      apiFetch<{ items: any[] }>(`/vendors/report?window=${windowRange}&vendor_id=${vendorId}`),
  });

  const handleExport = async (kind: 'vendors' | 'invoices') => {
    setExportError(null);
    setExportingType(kind);
    try {
      if (kind === 'vendors') {
        await downloadCsv(
          `/vendors/export?window=${windowRange}&vendor_id=${vendorId}`,
          'invoicedesk_vendor_report.csv'
        );
      } else {
        await downloadCsv(
          `/invoices/export?window=${windowRange}&vendor_id=${vendorId}`,
          'invoicedesk_invoices.csv'
        );
      }
    } catch (err: any) {
      setExportError(err?.message || 'Unable to export CSV report.');
    } finally {
      setExportingType(null);
    }
  };

  const metricCards = [
    {
      label: 'Automated Approval Rate',
      value: `${metrics?.approval_rate ?? 0}%`,
      formula: 'APPROVE decisions / All completed decisions (APPROVE + REVIEW + REJECT)',
    },
    {
      label: 'Human Review Rate',
      value: `${metrics?.review_rate ?? 0}%`,
      formula: 'REVIEW decisions / All completed decisions',
    },
    {
      label: 'Rejection Rate',
      value: `${metrics?.rejection_rate ?? 0}%`,
      formula: 'REJECT decisions / All completed decisions',
    },
    {
      label: 'Median Processing Time',
      value: formatDurationMs(metrics?.median_duration_ms),
      formula: `P95 latency: ${formatDurationMs(metrics?.p95_duration_ms)} across completed runs`,
    },
    {
      label: 'Mean Extraction Confidence',
      value: `${metrics?.mean_confidence ?? 0}%`,
      formula: 'Mean of critical header confidences across completed extractions',
    },
    {
      label: 'Aggregate PO Utilization',
      value: `${metrics?.po_utilization_pct ?? 0}%`,
      formula: `${formatCurrency(metrics?.po_consumed_total)} consumed / ${formatCurrency(metrics?.po_original_total)} committed`,
    },
    {
      label: 'Human Override Resolution',
      value: `${metrics?.human_override_rate ?? 0}%`,
      formula: 'Human-resolved REVIEW items / Total REVIEW decisions in window',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Analytics & Reports
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Transparent AP automation KPIs with documented denominators and exception drivers
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            className="h-9 px-3 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
          >
            <option value="ALL">All Vendors</option>
            {(vendorsData?.items || []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.canonical_name}
              </option>
            ))}
          </select>
          <div className="flex items-center p-1 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
            {(['7d', '30d', '90d', 'all'] as const).map((w) => (
              <button
                key={w}
                onClick={() => setWindowRange(w)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer ${
                  windowRange === w ? 'bg-white dark:bg-slate-900 shadow-xs' : 'text-slate-500'
                }`}
              >
                {w === 'all' ? 'ALL' : w.toUpperCase()}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="secondary"
            loading={exportingType === 'invoices'}
            onClick={() => void handleExport('invoices')}
          >
            <Download className="w-3.5 h-3.5" />
            Export Invoices CSV
          </Button>
          <Button
            size="sm"
            variant="secondary"
            loading={exportingType === 'vendors'}
            onClick={() => void handleExport('vendors')}
          >
            <Download className="w-3.5 h-3.5" />
            Export Vendor Report CSV
          </Button>
        </div>
      </div>

      {exportError && <ErrorBanner message={exportError} />}
      {isError && <ErrorBanner message="Failed to load analytics metrics." onRetry={() => void refetch()} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {metricCards.map((m) => (
          <Card key={m.label} className="p-4 space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
              <span>{m.label}</span>
              <span title={m.formula} className="text-slate-400 hover:text-slate-600 cursor-help">
                <HelpCircle className="w-3.5 h-3.5" />
              </span>
            </div>
            <div className="text-2xl font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-50">
              {isLoading ? '—' : m.value}
            </div>
            <div className="text-[11px] text-slate-400 leading-snug">{m.formula}</div>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
            Exception Distribution by Reason Code
          </h2>
          <p className="text-xs text-slate-500 mb-4">Primary reason codes driving REVIEW and REJECT outcomes</p>
          <div className="h-64">
            {!metrics?.exception_distribution?.length ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-400">
                No exceptions recorded in window.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={metrics.exception_distribution} layout="vertical" margin={{ left: 30, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} />
                  <YAxis type="category" dataKey="reason_code" width={150} tick={{ fontSize: 10, fill: '#64748b' }} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#f59e0b" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
            Extraction Confidence Distribution
          </h2>
          <p className="text-xs text-slate-500 mb-4">Mean field confidence buckets across extracted invoices</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={metrics?.confidence_distribution || []} margin={{ left: -15 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: '#64748b' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} />
                <Tooltip />
                <Bar dataKey="count" fill="#2563eb" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">
          Pipeline Latency by Extraction Mode
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {(metrics?.latency_by_mode || []).map((row: any) => (
            <div
              key={row.mode}
              className="p-4 rounded-md border border-slate-200 dark:border-slate-800 flex items-center justify-between"
            >
              <div>
                <div className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">
                  {row.mode}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">{row.count} completed runs</div>
              </div>
              <div className="font-mono tabular-nums text-lg font-semibold text-slate-900 dark:text-slate-100">
                {formatDurationMs(row.avg_duration_ms)}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Vendor Spend & Exception Report
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Per-vendor PO utilization, invoice volume, exception rate, and approved spend for the selected window
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            loading={exportingType === 'vendors'}
            onClick={() => void handleExport('vendors')}
          >
            <Download className="w-3.5 h-3.5" />
            Export Vendor Report CSV
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2.5">Vendor</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Open POs</th>
                <th className="px-4 py-2.5 text-right">PO Consumed / Committed</th>
                <th className="px-4 py-2.5 text-right">Invoices</th>
                <th className="px-4 py-2.5 text-right">Exception Rate</th>
                <th className="px-4 py-2.5 text-right">Approved Spend</th>
                <th className="px-4 py-2.5 text-right">Mean Conf.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {(vendorReportData?.items || []).map((row) => (
                <tr key={row.vendor_id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900 dark:text-slate-100">{row.canonical_name}</div>
                    <div className="font-mono text-[11px] text-slate-400">{row.vendor_code}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] font-semibold">
                    <span
                      className={
                        row.verification_status === 'APPROVED'
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : row.verification_status === 'BLOCKED'
                            ? 'text-rose-700 dark:text-rose-400'
                            : 'text-amber-700 dark:text-amber-400'
                      }
                    >
                      {row.verification_status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">{row.open_po_count}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                    {formatCurrency(row.po_consumed_amount, row.default_currency)} /{' '}
                    {formatCurrency(row.po_committed_amount, row.default_currency)} ({row.po_utilization_pct}%)
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">{row.total_invoices}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {row.exception_rate_pct}%
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                    {formatCurrency(row.approved_spend_amount, row.default_currency)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-500">
                    {row.mean_confidence_pct ? `${row.mean_confidence_pct}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
