import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileText,
  Plus,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useRole } from '../hooks/useRole';
import { apiFetch, formatCurrency, formatDateTime } from '../lib/api';
import {
  Button,
  Card,
  DecisionBadge,
  EmptyState,
  ErrorBanner,
  ProcessingBadge,
} from '../components/ui/Primitives';

const DECISION_COLORS: Record<string, string> = {
  APPROVE: '#10b981',
  REVIEW: '#f59e0b',
  REJECT: '#f43f5e',
};

export function OverviewPage() {
  const { RoleGate } = useRole();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [windowRange, setWindowRange] = useState<'7d' | '30d' | '90d' | 'all'>('30d');

  const {
    data: overview,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['overview', windowRange],
    queryFn: () => apiFetch<any>(`/analytics/overview?window=${windowRange}`),
  });

  const { data: attentionData } = useQuery({
    queryKey: ['invoices', 'attention'],
    queryFn: () => apiFetch<{ items: any[] }>('/invoices?attention=true&page_size=6'),
  });

  const { data: poData } = useQuery({
    queryKey: ['purchase-orders', 'top'],
    queryFn: () => apiFetch<{ items: any[] }>('/purchase-orders?sort=utilization_desc'),
  });

  const retryMutation = useMutation({
    mutationFn: (invoiceId: string) =>
      apiFetch(`/invoices/${invoiceId}/retry`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (_data, invoiceId) => {
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      navigate(`/invoices/${invoiceId}?live=true`);
    },
  });

  const kpis = overview?.kpis;
  const donutData = (overview?.decision_distribution || []).filter((d: any) => d.value > 0);
  const totalDecided = donutData.reduce((acc: number, d: any) => acc + d.value, 0);

  return (
    <div className="space-y-6">
      {/* Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Accounts Payable Overview
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Live database-derived invoice throughput, automated decisions, and PO commitments
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center p-1 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
            {(['7d', '30d', '90d', 'all'] as const).map((w) => (
              <button
                key={w}
                onClick={() => setWindowRange(w)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  windowRange === w
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {w === 'all' ? 'All Time' : w.toUpperCase()}
              </button>
            ))}
          </div>
          <RoleGate capability="operate_pipeline">
            <Button variant="primary" onClick={() => navigate('/upload')}>
              <Plus className="w-4 h-4" />
              Upload Invoice
            </Button>
          </RoleGate>
        </div>
      </div>

      {isError && (
        <ErrorBanner
          message="Failed to load overview metrics from database."
          onRetry={() => void refetch()}
        />
      )}

      {/* 5 KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="p-5 animate-pulse space-y-3">
              <div className="h-3 bg-slate-200 dark:bg-slate-800 rounded w-1/2" />
              <div className="h-7 bg-slate-200 dark:bg-slate-800 rounded w-2/3" />
              <div className="h-3 bg-slate-200 dark:bg-slate-800 rounded w-1/3" />
            </Card>
          ))
        ) : (
          <>
            <button
              onClick={() => navigate('/invoices')}
              className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 rounded-lg p-5 transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
                <span>Total Processed</span>
                <FileText className="w-4 h-4 text-slate-400" />
              </div>
              <div className="mt-2 text-2xl font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-50">
                {kpis?.total_processed ?? 0}
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                {kpis?.total_invoices ?? 0} total ingested
              </div>
            </button>

            <button
              onClick={() => navigate('/invoices?decision=APPROVE')}
              className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-emerald-300 dark:hover:border-emerald-800 rounded-lg p-5 transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
                <span>Approved Invoices</span>
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              </div>
              <div className="mt-2 text-2xl font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-50">
                {kpis?.approved_count ?? 0}
              </div>
              <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-400 font-mono tabular-nums">
                {formatCurrency(kpis?.approved_amount)} cleared
              </div>
            </button>

            <button
              onClick={() => navigate('/reviews')}
              className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-amber-300 dark:hover:border-amber-800 rounded-lg p-5 transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
                <span>Pending Reviews</span>
                <AlertTriangle className="w-4 h-4 text-amber-600" />
              </div>
              <div className="mt-2 text-2xl font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-50">
                {kpis?.pending_reviews ?? 0}
              </div>
              <div className="mt-1 text-xs text-amber-700 dark:text-amber-400 font-mono tabular-nums">
                {formatCurrency(kpis?.pending_review_amount)} awaiting triage
              </div>
            </button>

            <button
              onClick={() => navigate('/invoices?decision=REJECT')}
              className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-rose-300 dark:hover:border-rose-800 rounded-lg p-5 transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
                <span>Rejected Invoices</span>
                <XCircle className="w-4 h-4 text-rose-600" />
              </div>
              <div className="mt-2 text-2xl font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-50">
                {kpis?.rejected_count ?? 0}
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Policy / Duplicate blocked
              </div>
            </button>

            <button
              onClick={() => navigate('/invoices?processing_status=FAILED')}
              className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 rounded-lg p-5 transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
                <span>Processing Failures</span>
                <ShieldAlert className="w-4 h-4 text-rose-500" />
              </div>
              <div className="mt-2 text-2xl font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-50">
                {kpis?.failed_count ?? 0}
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Retryable pipeline runs
              </div>
            </button>
          </>
        )}
      </div>

      {/* Middle Analytics Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <Card className="lg:col-span-8 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Invoice Volume & Decision Trend
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">Daily automated pipeline outcomes</p>
            </div>
          </div>
          <div className="h-64 w-full">
            {!overview?.volume_trend?.length ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-400">
                No invoice activity in selected date window.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={overview.volume_trend} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748b' }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--bg-surface-elevated)',
                      borderColor: 'var(--border-default)',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <Bar dataKey="APPROVE" stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="REVIEW" stackId="a" fill="#f59e0b" />
                  <Bar dataKey="REJECT" stackId="a" fill="#f43f5e" />
                  <Bar dataKey="FAILED" stackId="a" fill="#64748b" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card className="lg:col-span-4 p-5 flex flex-col">
          <div className="mb-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Decision Distribution</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">Share of automated outcomes</p>
          </div>
          <div className="flex-1 min-h-[190px]">
            {totalDecided === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-400">
                No completed decisions yet.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={donutData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={52}
                    outerRadius={76}
                    paddingAngle={2}
                  >
                    {donutData.map((entry: any) => (
                      <Cell key={entry.name} fill={DECISION_COLORS[entry.name] || '#64748b'} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--bg-surface-elevated)',
                      borderColor: 'var(--border-default)',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs">
            {(overview?.decision_distribution || []).map((d: any) => (
              <div key={d.name}>
                <div className="text-slate-500 dark:text-slate-400">{d.name}</div>
                <div className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                  {d.value} ({totalDecided > 0 ? Math.round((d.value / totalDecided) * 100) : 0}%)
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Bottom Operational Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Attention Required */}
        <Card className="lg:col-span-6 flex flex-col">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Attention Required</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Exceptions awaiting review and failed pipeline runs
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => navigate('/reviews')}>
              Review Queue <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {!attentionData?.items?.length ? (
              <div className="p-6">
                <EmptyState
                  icon={CheckCircle2}
                  title="Queue is clear"
                  description="No pending human reviews or failed processing runs."
                />
              </div>
            ) : (
              attentionData.items.map((item) => (
                <div
                  key={item.id}
                  className="px-5 py-3.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                        {item.invoice_number || item.original_filename}
                      </span>
                      {item.processing_status === 'FAILED' ? (
                        <ProcessingBadge status="FAILED" />
                      ) : (
                        <DecisionBadge outcome={item.business_decision} />
                      )}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5 truncate">
                      <span>{item.vendor_canonical_name || item.extracted_vendor_name || 'Unknown Vendor'}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono text-[11px]">
                        {item.primary_reason_code || 'EXTRACTION_FAILED'}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono tabular-nums text-xs font-medium text-slate-700 dark:text-slate-300">
                      {formatCurrency(item.total_amount, item.currency)}
                    </span>
                    <RoleGate
                      capability="operate_pipeline"
                      when={item.processing_status === 'FAILED'}
                      fallback={
                        <Button size="sm" variant="secondary" onClick={() => navigate(`/invoices/${item.id}`)}>
                          Inspect
                        </Button>
                      }
                    >
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => retryMutation.mutate(item.id)}
                        loading={retryMutation.isPending}
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Retry
                      </Button>
                    </RoleGate>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        {/* PO Utilization & Recent Activity */}
        <div className="lg:col-span-6 space-y-4">
          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">PO Utilization</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Cumulative approved spend vs. purchase order caps
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => navigate('/purchase-orders')}>
                All POs <ArrowRight className="w-3.5 h-3.5" />
              </Button>
            </div>
            <div className="space-y-3.5">
              {(poData?.items || []).slice(0, 4).map((po) => (
                <button
                  key={po.id}
                  onClick={() => navigate(`/purchase-orders?po=${po.id}`)}
                  className="w-full text-left group cursor-pointer"
                >
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-medium text-slate-800 dark:text-slate-200 group-hover:text-blue-600">
                      <span className="font-mono">{po.po_number}</span> · {po.vendor_name}
                    </span>
                    <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {formatCurrency(po.consumed_amount)} / {formatCurrency(po.original_amount)} ({po.utilization_pct}%)
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        po.utilization_pct >= 95
                          ? 'bg-amber-500'
                          : 'bg-blue-600 dark:bg-blue-500'
                      }`}
                      style={{ width: `${Math.min(100, po.utilization_pct)}%` }}
                    />
                  </div>
                </button>
              ))}
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Recent Activity</h2>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {(overview?.recent_activity || []).slice(0, 4).map((act: any) => (
                <div key={act.id} className="py-2 flex items-center justify-between gap-2 text-xs">
                  <div className="min-w-0 truncate">
                    <span className="font-mono font-medium text-slate-800 dark:text-slate-200">{act.action}</span>
                    <span className="text-slate-400 mx-1.5">·</span>
                    <span className="text-slate-500 dark:text-slate-400">
                      {act.actor_name || 'System Engine'}
                    </span>
                  </div>
                  <span className="font-mono tabular-nums text-slate-400 shrink-0">
                    {formatDateTime(act.created_at)}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
