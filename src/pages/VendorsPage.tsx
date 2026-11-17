import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, Search, X } from 'lucide-react';
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

export function VendorsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(searchParams.get('vendor'));
  const [createOpen, setCreateOpen] = useState(false);

  const [newName, setNewName] = useState('');
  const [newTaxId, setNewTaxId] = useState('');
  const [newAliases, setNewAliases] = useState('');
  const [newStatus, setNewStatus] = useState<'APPROVED' | 'UNVERIFIED'>('APPROVED');
  const [aliasInput, setAliasInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const v = searchParams.get('vendor');
    if (v) setSelectedVendorId(v);
  }, [searchParams]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['vendors', q, statusFilter],
    queryFn: () => apiFetch<{ items: any[] }>(`/vendors?q=${encodeURIComponent(q)}&status=${statusFilter}`),
  });

  const { data: detailData } = useQuery({
    queryKey: ['vendor-detail', selectedVendorId],
    queryFn: () => apiFetch<any>(`/vendors/${selectedVendorId}`),
    enabled: Boolean(selectedVendorId),
  });

  const createVendorMutation = useMutation({
    mutationFn: () =>
      apiFetch('/vendors', {
        method: 'POST',
        body: JSON.stringify({
          canonical_name: newName,
          tax_id: newTaxId,
          aliases: newAliases.split(',').map((s) => s.trim()).filter(Boolean),
          verification_status: newStatus,
        }),
      }),
    onSuccess: () => {
      setCreateOpen(false);
      setNewName('');
      setNewTaxId('');
      setNewAliases('');
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['vendors'] });
    },
    onError: (err: any) => setFormError(err?.message || 'Unable to create vendor.'),
  });

  const updateVendorMutation = useMutation({
    mutationFn: ({ vendorId, body }: { vendorId: string; body: Record<string, unknown> }) =>
      apiFetch(`/vendors/${vendorId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['vendors'] });
      void queryClient.invalidateQueries({ queryKey: ['vendor-detail', selectedVendorId] });
    },
  });

  const isAdmin = user?.role === 'ADMIN';
  const canVerify = user?.role === 'ADMIN' || user?.role === 'REVIEWER';

  const statusBadge = (status: string) => {
    if (status === 'APPROVED')
      return <span className="font-mono text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">APPROVED</span>;
    if (status === 'BLOCKED')
      return <span className="font-mono text-[11px] font-semibold text-rose-700 dark:text-rose-400">BLOCKED</span>;
    return <span className="font-mono text-[11px] font-semibold text-amber-700 dark:text-amber-400">UNVERIFIED</span>;
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Vendors Directory
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Supplier master records, invoice header aliases, tax IDs, and verification status
          </p>
        </div>
        {isAdmin && (
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4" />
            Add Vendor
          </Button>
        )}
      </div>

      <Card className="p-3.5 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search vendor name, alias, code, or tax ID..."
            className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 px-3 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
        >
          <option value="ALL">Verification: All</option>
          <option value="APPROVED">Approved</option>
          <option value="UNVERIFIED">Unverified</option>
          <option value="BLOCKED">Blocked</option>
        </select>
      </Card>

      {isError && <ErrorBanner message="Unable to load vendors." onRetry={() => void refetch()} />}

      <Card className="overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={5} />
        ) : !data?.items?.length ? (
          <div className="p-6">
            <EmptyState
              icon={Building2}
              title="No vendors found"
              description="No suppliers matched your search filter."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Code</th>
                  <th className="px-4 py-2.5">Canonical Name</th>
                  <th className="px-4 py-2.5">Aliases</th>
                  <th className="px-4 py-2.5">Tax ID</th>
                  <th className="px-4 py-2.5">Verification</th>
                  <th className="px-4 py-2.5 text-right">Open POs</th>
                  <th className="px-4 py-2.5 text-right">Invoices</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.items.map((v) => (
                  <tr
                    key={v.id}
                    onClick={() => setSelectedVendorId(v.id)}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                  >
                    <td className="px-4 py-3 font-mono text-slate-500">{v.vendor_code}</td>
                    <td className="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">
                      {v.canonical_name}
                    </td>
                    <td className="px-4 py-3 text-slate-500 max-w-[240px] truncate">
                      {v.aliases?.length ? v.aliases.join(', ') : '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-500">{v.tax_id || '—'}</td>
                    <td className="px-4 py-3">{statusBadge(v.verification_status)}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{v.open_po_count}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{v.invoice_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Drawer
        open={Boolean(selectedVendorId)}
        onClose={() => {
          setSelectedVendorId(null);
          searchParams.delete('vendor');
          setSearchParams(searchParams);
        }}
        title={detailData?.vendor?.canonical_name || 'Vendor Profile'}
        subtitle={`${detailData?.vendor?.vendor_code || ''} · Tax ID: ${detailData?.vendor?.tax_id || 'None'}`}
      >
        {detailData?.vendor && (
          <div className="space-y-6">
            <div className="flex items-center justify-between p-3.5 rounded-md border border-slate-200 dark:border-slate-800 text-xs">
              <div>
                <span className="text-slate-500 mr-2">Verification Status:</span>
                {statusBadge(detailData.vendor.verification_status)}
              </div>
              {canVerify && (
                <select
                  value={detailData.vendor.verification_status}
                  onChange={(e) =>
                    updateVendorMutation.mutate({
                      vendorId: detailData.vendor.id,
                      body: { verification_status: e.target.value },
                    })
                  }
                  className="h-8 px-2 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                >
                  <option value="APPROVED">APPROVED</option>
                  <option value="UNVERIFIED">UNVERIFIED</option>
                  <option value="BLOCKED">BLOCKED</option>
                </select>
              )}
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                Known Header Aliases ({detailData.vendor.aliases?.length || 0})
              </h4>
              <div className="flex flex-wrap gap-2 mb-3">
                {(detailData.vendor.aliases || []).map((a: string) => (
                  <span
                    key={a}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-100 dark:bg-slate-800 text-xs text-slate-700 dark:text-slate-200"
                  >
                    {a}
                    {isAdmin && (
                      <button
                        onClick={() =>
                          updateVendorMutation.mutate({
                            vendorId: detailData.vendor.id,
                            body: {
                              aliases: detailData.vendor.aliases.filter((x: string) => x !== a),
                            },
                          })
                        }
                        className="text-slate-400 hover:text-rose-600 cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
              {isAdmin && (
                <div className="flex gap-2">
                  <input
                    value={aliasInput}
                    onChange={(e) => setAliasInput(e.target.value)}
                    placeholder="Add invoice header alias..."
                    className="flex-1 h-8 px-2.5 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!aliasInput.trim()}
                    onClick={() => {
                      updateVendorMutation.mutate({
                        vendorId: detailData.vendor.id,
                        body: { aliases: [...(detailData.vendor.aliases || []), aliasInput.trim()] },
                      });
                      setAliasInput('');
                    }}
                  >
                    Add Alias
                  </Button>
                </div>
              )}
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                Purchase Orders ({detailData.purchase_orders?.length || 0})
              </h4>
              <div className="border border-slate-200 dark:border-slate-800 rounded-md divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {(detailData.purchase_orders || []).map((po: any) => (
                  <button
                    key={po.id}
                    onClick={() => navigate(`/purchase-orders?po=${po.id}`)}
                    className="w-full px-3 py-2 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                  >
                    <span className="font-mono font-semibold">{po.po_number}</span>
                    <span className="font-mono tabular-nums">
                      {formatCurrency(po.consumed_amount)} / {formatCurrency(po.original_amount)}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                Invoice History ({detailData.invoices?.length || 0})
              </h4>
              <div className="border border-slate-200 dark:border-slate-800 rounded-md divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {(detailData.invoices || []).map((inv: any) => (
                  <button
                    key={inv.id}
                    onClick={() => navigate(`/invoices/${inv.id}`)}
                    className="w-full px-3 py-2 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                  >
                    <div className="text-left">
                      <div className="font-mono font-semibold">{inv.invoice_number || inv.original_filename}</div>
                      <div className="text-[11px] text-slate-400">{formatShortDate(inv.created_at)}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono tabular-nums">{formatCurrency(inv.total_amount, inv.currency)}</span>
                      <DecisionBadge outcome={inv.business_decision} />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </Drawer>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Add Vendor">
        <div className="space-y-4">
          {formError && <ErrorBanner message={formError} />}
          <div>
            <label className="block text-xs font-medium mb-1">Canonical Legal Name</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Acme Cloud Services LLC"
              className="w-full h-9 px-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Tax ID (Optional)</label>
            <input
              value={newTaxId}
              onChange={(e) => setNewTaxId(e.target.value)}
              placeholder="US-94-3829104"
              className="w-full h-9 px-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Aliases (Comma-separated)</label>
            <input
              value={newAliases}
              onChange={(e) => setNewAliases(e.target.value)}
              placeholder="Acme Cloud Inc., ACME CLOUD"
              className="w-full h-9 px-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Verification Status</label>
            <select
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value as any)}
              className="w-full h-9 px-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
            >
              <option value="APPROVED">APPROVED</option>
              <option value="UNVERIFIED">UNVERIFIED</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={createVendorMutation.isPending}
              onClick={() => createVendorMutation.mutate()}
            >
              Save Vendor
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
