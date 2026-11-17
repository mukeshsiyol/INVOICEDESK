import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, ShoppingCart } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiFetch, formatCurrency, formatShortDate } from '../lib/api';
import {
  Button,
  Card,
  DecisionBadge,
  Drawer,
  EmptyState,
  ErrorBanner,
  Modal,
  TableSkeleton,
} from '../components/ui/Primitives';

export function PurchaseOrdersPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [selectedPoId, setSelectedPoId] = useState<string | null>(searchParams.get('po'));
  const [createOpen, setCreateOpen] = useState(false);

  const [newPoNo, setNewPoNo] = useState('');
  const [newVendorId, setNewVendorId] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const p = searchParams.get('po');
    if (p) setSelectedPoId(p);
  }, [searchParams]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['purchase-orders', q, statusFilter],
    queryFn: () =>
      apiFetch<{ items: any[] }>(`/purchase-orders?q=${encodeURIComponent(q)}&status=${statusFilter}`),
  });

  const { data: vendorsData } = useQuery({
    queryKey: ['vendors', 'all'],
    queryFn: () => apiFetch<{ items: any[] }>('/vendors'),
  });

  const { data: detailData } = useQuery({
    queryKey: ['purchase-order-detail', selectedPoId],
    queryFn: () => apiFetch<any>(`/purchase-orders/${selectedPoId}`),
    enabled: Boolean(selectedPoId),
  });

  const createPoMutation = useMutation({
    mutationFn: () =>
      apiFetch('/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          po_number: newPoNo,
          vendor_id: newVendorId,
          original_amount: newAmount,
          notes: newNotes,
        }),
      }),
    onSuccess: () => {
      setCreateOpen(false);
      setNewPoNo('');
      setNewAmount('');
      setNewNotes('');
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
    onError: (err: any) => setFormError(err?.message || 'Unable to create PO.'),
  });

  const togglePoStatusMutation = useMutation({
    mutationFn: ({ poId, status }: { poId: string; status: string }) =>
      apiFetch(`/purchase-orders/${poId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      void queryClient.invalidateQueries({ queryKey: ['purchase-order-detail', selectedPoId] });
    },
  });

  const isAdmin = user?.role === 'ADMIN';

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Purchase Orders
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Procurement budget commitments, cumulative invoice drawdowns, and remaining balances
          </p>
        </div>
        {isAdmin && (
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4" />
            Create PO
          </Button>
        )}
      </div>

      <Card className="p-3.5 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by PO number or vendor..."
            className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 px-3 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
        >
          <option value="ALL">Status: All</option>
          <option value="OPEN">Open</option>
          <option value="PARTIALLY_CONSUMED">Partially Consumed</option>
          <option value="FULLY_CONSUMED">Fully Consumed</option>
          <option value="CLOSED">Closed</option>
        </select>
      </Card>

      {isError && <ErrorBanner message="Failed to load purchase orders." onRetry={() => void refetch()} />}

      <Card className="overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={5} />
        ) : !data?.items?.length ? (
          <div className="p-6">
            <EmptyState
              icon={ShoppingCart}
              title="No purchase orders found"
              description="Adjust your search filter or create a new purchase order."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">PO Number</th>
                  <th className="px-4 py-2.5">Vendor</th>
                  <th className="px-4 py-2.5 text-right">Original</th>
                  <th className="px-4 py-2.5 text-right">Consumed</th>
                  <th className="px-4 py-2.5 text-right">Remaining</th>
                  <th className="px-4 py-2.5 w-36">Utilization</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Invoices</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.items.map((po) => (
                  <tr
                    key={po.id}
                    onClick={() => setSelectedPoId(po.id)}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                  >
                    <td className="px-4 py-3 font-mono font-semibold text-slate-900 dark:text-slate-100">
                      {po.po_number}
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-200">
                      {po.vendor_name}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {formatCurrency(po.original_amount, po.currency)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {formatCurrency(po.consumed_amount, po.currency)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">
                      {formatCurrency(po.remaining_amount, po.currency)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                          <div
                            className="h-full bg-blue-600 dark:bg-blue-500 rounded-full"
                            style={{ width: `${Math.min(100, po.utilization_pct)}%` }}
                          />
                        </div>
                        <span className="font-mono tabular-nums text-[11px] w-10 text-right">
                          {po.utilization_pct}%
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px]">{po.status}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{po.linked_invoice_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* PO Detail Slide-Over Drawer */}
      <Drawer
        open={Boolean(selectedPoId)}
        onClose={() => {
          setSelectedPoId(null);
          searchParams.delete('po');
          setSearchParams(searchParams);
        }}
        title={detailData?.purchase_order?.po_number || 'Purchase Order'}
        subtitle={detailData?.purchase_order?.vendor_name}
      >
        {detailData?.purchase_order && (
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-3 p-4 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 font-mono tabular-nums">
              <div>
                <div className="text-[11px] text-slate-500">Original</div>
                <div className="text-sm font-semibold mt-0.5">
                  {formatCurrency(detailData.purchase_order.original_amount, detailData.purchase_order.currency)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500">Consumed</div>
                <div className="text-sm font-semibold mt-0.5">
                  {formatCurrency(detailData.purchase_order.consumed_amount, detailData.purchase_order.currency)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500">Remaining</div>
                <div className="text-sm font-semibold text-emerald-700 dark:text-emerald-400 mt-0.5">
                  {formatCurrency(detailData.purchase_order.remaining_amount, detailData.purchase_order.currency)}
                </div>
              </div>
            </div>

            {isAdmin && (
              <div className="flex items-center justify-between p-3 rounded-md border border-slate-200 dark:border-slate-800 text-xs">
                <span>
                  Status: <strong className="font-mono">{detailData.purchase_order.status}</strong>
                </span>
                {detailData.purchase_order.status !== 'CLOSED' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      togglePoStatusMutation.mutate({ poId: detailData.purchase_order.id, status: 'CLOSED' })
                    }
                  >
                    Close PO
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      togglePoStatusMutation.mutate({ poId: detailData.purchase_order.id, status: 'OPEN' })
                    }
                  >
                    Reopen PO
                  </Button>
                )}
              </div>
            )}

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                PO Line Items ({detailData.lines?.length || 0})
              </h4>
              <div className="border border-slate-200 dark:border-slate-800 rounded-md divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {(detailData.lines || []).map((l: any) => (
                  <div key={l.id} className="px-3 py-2 flex items-center justify-between gap-2">
                    <span>
                      {l.line_number}. {l.description}
                    </span>
                    <span className="font-mono tabular-nums font-medium">
                      {formatCurrency(l.line_total, detailData.purchase_order.currency)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                Associated Invoices ({detailData.invoices?.length || 0})
              </h4>
              {!detailData.invoices?.length ? (
                <p className="text-xs text-slate-500">No invoices matched to this PO yet.</p>
              ) : (
                <div className="border border-slate-200 dark:border-slate-800 rounded-md divide-y divide-slate-100 dark:divide-slate-800">
                  {detailData.invoices.map((inv: any) => (
                    <button
                      key={inv.id}
                      onClick={() => navigate(`/invoices/${inv.id}`)}
                      className="w-full px-3 py-2.5 flex items-center justify-between text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                    >
                      <div>
                        <div className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">
                          {inv.invoice_number || inv.original_filename}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono">
                          {formatShortDate(inv.created_at)} · {inv.po_consumed_applied ? 'Debited' : 'Not debited'}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono tabular-nums text-xs font-medium">
                          {formatCurrency(inv.total_amount, inv.currency)}
                        </span>
                        <DecisionBadge outcome={inv.business_decision} />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>

      {/* Create PO Modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create Purchase Order">
        <div className="space-y-4">
          {formError && <ErrorBanner message={formError} />}
          <div>
            <label className="block text-xs font-medium mb-1">PO Number</label>
            <input
              value={newPoNo}
              onChange={(e) => setNewPoNo(e.target.value)}
              placeholder="e.g. PO-2026-500"
              className="w-full h-9 px-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Vendor</label>
            <select
              value={newVendorId}
              onChange={(e) => setNewVendorId(e.target.value)}
              className="w-full h-9 px-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
            >
              <option value="">Select vendor...</option>
              {(vendorsData?.items || []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.canonical_name} ({v.verification_status})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Original Amount (USD)</label>
            <input
              type="number"
              step="0.01"
              value={newAmount}
              onChange={(e) => setNewAmount(e.target.value)}
              placeholder="10000.00"
              className="w-full h-9 px-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Notes</label>
            <input
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              placeholder="Q4 Software Services"
              className="w-full h-9 px-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={createPoMutation.isPending}
              onClick={() => createPoMutation.mutate()}
            >
              Create PO
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
