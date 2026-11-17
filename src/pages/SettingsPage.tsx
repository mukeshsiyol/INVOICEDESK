import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  CheckCircle2,
  Cpu,
  ExternalLink,
  Gauge,
  Lock,
  Monitor,
  Moon,
  Plus,
  Save,
  ShieldCheck,
  Sliders,
  Sun,
  Users,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme, type ThemeMode } from '../context/ThemeContext';
import { apiFetch, formatDateTime, type UserRole } from '../lib/api';
import { Button, Card, ErrorBanner, Modal } from '../components/ui/Primitives';

type SettingsTab =
  | 'general'
  | 'processing'
  | 'rules'
  | 'confidence'
  | 'notifications'
  | 'users'
  | 'appearance';

export function SettingsPage() {
  const { user, refreshUser } = useAuth();
  const { theme, setTheme } = useTheme();
  const queryClient = useQueryClient();
  const isAdmin = user?.role === 'ADMIN';

  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [form, setForm] = useState({
    workspace_name: 'InvoiceDesk',
    default_currency: 'USD',
    ocr_min_chars_per_page: 50,
    force_ocr: false,
    tolerance_pct: '2.00',
    tolerance_abs: '25.00',
    tolerance_mode: 'MIN',
    confidence_threshold: '0.80',
    auto_approve_max_amount: '25000.00',
    notify_on_review: true,
    notify_on_failure: true,
  });

  const [addUserOpen, setAddUserOpen] = useState(false);
  const [newUser, setNewUser] = useState({
    email: '',
    full_name: '',
    role: 'OPERATOR' as UserRole,
    password: 'InvoiceDesk2026!',
  });

  const { data: settingsData, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiFetch<any>('/settings'),
  });

  const { data: usersData } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => apiFetch<{ items: any[] }>('/users'),
    enabled: isAdmin,
  });

  useEffect(() => {
    if (settingsData) {
      setForm({
        workspace_name: settingsData.workspace_name ?? 'InvoiceDesk',
        default_currency: settingsData.default_currency ?? 'USD',
        ocr_min_chars_per_page: Number(settingsData.ocr_min_chars_per_page ?? 50),
        force_ocr: Boolean(settingsData.force_ocr),
        tolerance_pct: String(Number(settingsData.tolerance_pct ?? 2).toFixed(2)),
        tolerance_abs: String(Number(settingsData.tolerance_abs ?? 25).toFixed(2)),
        tolerance_mode: settingsData.tolerance_mode ?? 'MIN',
        confidence_threshold: String(Number(settingsData.confidence_threshold ?? 0.8).toFixed(2)),
        auto_approve_max_amount:
          settingsData.auto_approve_max_amount != null
            ? String(Number(settingsData.auto_approve_max_amount).toFixed(2))
            : '',
        notify_on_review: Boolean(settingsData.notify_on_review),
        notify_on_failure: Boolean(settingsData.notify_on_failure),
      });
    }
  }, [settingsData]);

  const saveSettings = useMutation({
    mutationFn: () =>
      apiFetch('/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          ...form,
          auto_approve_max_amount: form.auto_approve_max_amount.trim() === '' ? null : form.auto_approve_max_amount,
        }),
      }),
    onSuccess: () => {
      setErrorMsg(null);
      setSavedMsg('Workspace settings updated and logged to the Audit Trail.');
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err: any) => {
      setSavedMsg(null);
      setErrorMsg(err?.message || 'Failed to update settings.');
    },
  });

  const saveThemePref = useMutation({
    mutationFn: (nextTheme: ThemeMode) =>
      apiFetch('/users/me/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ theme_preference: nextTheme }),
      }),
    onSuccess: (_, nextTheme) => {
      setTheme(nextTheme);
      setSavedMsg(`Appearance preference saved (${nextTheme}).`);
      void refreshUser();
    },
  });

  const createUser = useMutation({
    mutationFn: () =>
      apiFetch('/users', {
        method: 'POST',
        body: JSON.stringify(newUser),
      }),
    onSuccess: () => {
      setAddUserOpen(false);
      setNewUser({ email: '', full_name: '', role: 'OPERATOR', password: 'InvoiceDesk2026!' });
      setSavedMsg('New user account created.');
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err: any) => {
      setErrorMsg(err?.message || 'Failed to create user.');
    },
  });

  const updateUser = useMutation({
    mutationFn: ({ id, role, is_active }: { id: string; role?: UserRole; is_active?: boolean }) =>
      apiFetch(`/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role, is_active }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  const tabs: Array<{ id: SettingsTab; label: string; icon: React.ComponentType<{ className?: string }>; adminOnly?: boolean }> = [
    { id: 'general', label: 'General', icon: Sliders },
    { id: 'processing', label: 'Processing & OCR', icon: Cpu },
    { id: 'rules', label: 'Approval Rules & Tolerance', icon: ShieldCheck },
    { id: 'confidence', label: 'Confidence Threshold', icon: Gauge },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'users', label: 'Security & Users', icon: Users, adminOnly: true },
    { id: 'appearance', label: 'Appearance', icon: Sun },
  ];

  const inputClass =
    'w-full h-9 px-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 disabled:opacity-60 disabled:bg-slate-50 dark:disabled:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Settings
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Configure OCR routing, deterministic PO tolerances, confidence thresholds, and user access
          </p>
        </div>

        {!isAdmin && activeTab !== 'appearance' && (
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300">
            <Lock className="w-3.5 h-3.5" />
            Read-only policy view ({user?.role})
          </div>
        )}
      </div>

      {savedMsg && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 text-sm">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {savedMsg}
          </span>
          <button onClick={() => setSavedMsg(null)} className="text-xs underline cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {errorMsg && <ErrorBanner message={errorMsg} />}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <aside className="lg:col-span-3 space-y-1">
          {tabs
            .filter((t) => !t.adminOnly || isAdmin)
            .map((t) => {
              const Icon = t.icon;
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => {
                    setActiveTab(t.id);
                    setSavedMsg(null);
                    setErrorMsg(null);
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                    active
                      ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{t.label}</span>
                </button>
              );
            })}
        </aside>

        <div className="lg:col-span-9">
          <Card className="p-6 space-y-6">
            {isLoading ? (
              <div className="text-sm text-slate-500">Loading settings…</div>
            ) : (
              <>
                {activeTab === 'general' && (
                  <div className="space-y-4">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">General Workspace</h2>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Organization display identity and default functional currency for AP validation
                      </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Workspace Name
                        </label>
                        <input
                          disabled={!isAdmin}
                          value={form.workspace_name}
                          onChange={(e) => setForm({ ...form, workspace_name: e.target.value })}
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Default Currency
                        </label>
                        <select
                          disabled={!isAdmin}
                          value={form.default_currency}
                          onChange={(e) => setForm({ ...form, default_currency: e.target.value })}
                          className={inputClass}
                        >
                          <option value="USD">USD — US Dollar</option>
                          <option value="EUR">EUR — Euro</option>
                          <option value="GBP">GBP — British Pound</option>
                          <option value="CAD">CAD — Canadian Dollar</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'processing' && (
                  <div className="space-y-5">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        Processing & OCR Routing
                      </h2>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Controls when PDFs automatically switch from native text parsing to Vision OCR
                      </p>
                    </div>

                    <div className="p-4 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                          Active Extraction Provider (Server-Side)
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5 font-mono">
                          {settingsData?.active_extraction_provider || 'Gemini'} · OpenAPI 3.1 Ready
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          href="/api/v1/openapi.json"
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <ExternalLink className="w-3 h-3" />
                          OpenAPI 3.1 Spec
                        </a>
                        <span
                          className={`inline-flex px-2.5 py-1 rounded text-xs font-medium ${
                            settingsData?.gemini_configured
                              ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60'
                              : 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60'
                          }`}
                        >
                          {settingsData?.gemini_configured ? 'Runtime Environment Configured' : 'API Key Missing in Environment'}
                        </span>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          OCR Fallback Threshold (Min chars / page)
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={1000}
                          disabled={!isAdmin}
                          value={form.ocr_min_chars_per_page}
                          onChange={(e) => setForm({ ...form, ocr_min_chars_per_page: Number(e.target.value) })}
                          className={`${inputClass} font-mono tabular-nums`}
                        />
                        <p className="text-[11px] text-slate-400 mt-1">
                          PDFs averaging fewer characters per page trigger multimodal Vision OCR.
                        </p>
                      </div>

                      <div className="flex items-start gap-3 pt-6">
                        <input
                          id="force-ocr"
                          type="checkbox"
                          disabled={!isAdmin}
                          checked={form.force_ocr}
                          onChange={(e) => setForm({ ...form, force_ocr: e.target.checked })}
                          className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600"
                        />
                        <label htmlFor="force-ocr" className="text-sm text-slate-700 dark:text-slate-200">
                          <span className="font-medium block">Force Vision OCR on all uploads</span>
                          <span className="text-xs text-slate-500">
                            Bypass embedded PDF text layer and inspect page PDFs visually.
                          </span>
                        </label>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'rules' && (
                  <div className="space-y-5">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        Approval Rules & Tolerance Policy
                      </h2>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Deterministic financial rules evaluated using exact Decimal arithmetic during Stage 6
                      </p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Tolerance Evaluation Mode
                        </label>
                        <select
                          disabled={!isAdmin}
                          value={form.tolerance_mode}
                          onChange={(e) => setForm({ ...form, tolerance_mode: e.target.value })}
                          className={inputClass}
                        >
                          <option value="MIN">MIN (Strictest of % or $ cap)</option>
                          <option value="MAX">MAX (Most permissive of % or $ cap)</option>
                          <option value="PCT_ONLY">Percentage Only</option>
                          <option value="ABS_ONLY">Absolute Amount Only</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Auto-Approve Max Amount ($)
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          disabled={!isAdmin}
                          value={form.auto_approve_max_amount}
                          onChange={(e) => setForm({ ...form, auto_approve_max_amount: e.target.value })}
                          placeholder="Leave blank for no cap"
                          className={`${inputClass} font-mono tabular-nums`}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          PO Variance Tolerance (%)
                        </label>
                        <input
                          type="number"
                          step="0.1"
                          min={0}
                          max={25}
                          disabled={!isAdmin}
                          value={form.tolerance_pct}
                          onChange={(e) => setForm({ ...form, tolerance_pct: e.target.value })}
                          className={`${inputClass} font-mono tabular-nums`}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          PO Variance Tolerance ($)
                        </label>
                        <input
                          type="number"
                          step="1"
                          min={0}
                          disabled={!isAdmin}
                          value={form.tolerance_abs}
                          onChange={(e) => setForm({ ...form, tolerance_abs: e.target.value })}
                          className={`${inputClass} font-mono tabular-nums`}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'confidence' && (
                  <div className="space-y-4">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        Extraction Confidence Threshold
                      </h2>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Invoices below this threshold automatically route to REVIEW with reason code{' '}
                        <span className="font-mono">LOW_EXTRACTION_CONFIDENCE</span>
                      </p>
                    </div>
                    <div className="max-w-md space-y-3">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600 dark:text-slate-300">Minimum Required Confidence</span>
                        <span className="font-mono tabular-nums font-semibold text-blue-600 dark:text-blue-400">
                          {Math.round(Number(form.confidence_threshold) * 100)}% ({form.confidence_threshold})
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0.50"
                        max="0.98"
                        step="0.01"
                        disabled={!isAdmin}
                        value={form.confidence_threshold}
                        onChange={(e) => setForm({ ...form, confidence_threshold: e.target.value })}
                        className="w-full accent-blue-600"
                      />
                    </div>
                  </div>
                )}

                {activeTab === 'notifications' && (
                  <div className="space-y-4">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        Operational Alerts
                      </h2>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Controls which pipeline exceptions surface in the topbar notification tray
                      </p>
                    </div>
                    <div className="space-y-3">
                      <label className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          disabled={!isAdmin}
                          checked={form.notify_on_review}
                          onChange={(e) => setForm({ ...form, notify_on_review: e.target.checked })}
                          className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600"
                        />
                        <div>
                          <div className="text-sm font-medium text-slate-800 dark:text-slate-200">
                            Alert on pending human review
                          </div>
                          <div className="text-xs text-slate-500">
                            Surface invoices routed to REVIEW in the notification indicator.
                          </div>
                        </div>
                      </label>
                      <label className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          disabled={!isAdmin}
                          checked={form.notify_on_failure}
                          onChange={(e) => setForm({ ...form, notify_on_failure: e.target.checked })}
                          className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600"
                        />
                        <div>
                          <div className="text-sm font-medium text-slate-800 dark:text-slate-200">
                            Alert on pipeline extraction failures
                          </div>
                          <div className="text-xs text-slate-500">
                            Surface failed runs requiring retry or upstream API attention.
                          </div>
                        </div>
                      </label>
                    </div>
                  </div>
                )}

                {activeTab === 'users' && isAdmin && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                          Security & User Access
                        </h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Manage RBAC roles across AP Operators, Reviewers, and Administrators
                        </p>
                      </div>
                      <Button variant="primary" size="sm" onClick={() => setAddUserOpen(true)}>
                        <Plus className="w-3.5 h-3.5" />
                        Add User
                      </Button>
                    </div>

                    <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-md">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                            <th className="py-2.5 px-4">Name</th>
                            <th className="py-2.5 px-4">Email</th>
                            <th className="py-2.5 px-4">Role</th>
                            <th className="py-2.5 px-4">Status</th>
                            <th className="py-2.5 px-4">Created</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                          {(usersData?.items || []).map((u) => (
                            <tr key={u.id}>
                              <td className="py-2.5 px-4 font-medium text-slate-900 dark:text-slate-100">
                                {u.full_name}
                              </td>
                              <td className="py-2.5 px-4 font-mono text-xs text-slate-500">{u.email}</td>
                              <td className="py-2.5 px-4">
                                <select
                                  value={u.role}
                                  onChange={(e) =>
                                    updateUser.mutate({ id: u.id, role: e.target.value as UserRole })
                                  }
                                  className="h-7 px-2 text-xs font-mono rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                                >
                                  <option value="OPERATOR">OPERATOR</option>
                                  <option value="REVIEWER">REVIEWER</option>
                                  <option value="ADMIN">ADMIN</option>
                                </select>
                              </td>
                              <td className="py-2.5 px-4">
                                <button
                                  onClick={() => updateUser.mutate({ id: u.id, is_active: !u.is_active })}
                                  className={`px-2 py-0.5 rounded text-xs font-medium cursor-pointer ${
                                    u.is_active
                                      ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300'
                                      : 'bg-slate-100 dark:bg-slate-800 text-slate-500'
                                  }`}
                                >
                                  {u.is_active ? 'Active' : 'Disabled'}
                                </button>
                              </td>
                              <td className="py-2.5 px-4 font-mono text-xs text-slate-400">
                                {formatDateTime(u.created_at)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {activeTab === 'appearance' && (
                  <div className="space-y-4">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Appearance</h2>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Personal interface theme preference. Light mode is the workspace default.
                      </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {[
                        { id: 'light' as ThemeMode, label: 'Light Mode', icon: Sun, desc: 'Default crisp workspace' },
                        { id: 'dark' as ThemeMode, label: 'Dark Mode', icon: Moon, desc: 'Low-glare night mode' },
                        { id: 'system' as ThemeMode, label: 'System', icon: Monitor, desc: 'Match OS setting' },
                      ].map((opt) => {
                        const Icon = opt.icon;
                        const selected = theme === opt.id;
                        return (
                          <button
                            key={opt.id}
                            onClick={() => saveThemePref.mutate(opt.id)}
                            className={`p-4 rounded-lg border text-left transition-colors cursor-pointer ${
                              selected
                                ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/40'
                                : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                            }`}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <Icon className={`w-4 h-4 ${selected ? 'text-blue-600' : 'text-slate-500'}`} />
                              {selected && (
                                <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">Active</span>
                              )}
                            </div>
                            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{opt.label}</div>
                            <div className="text-xs text-slate-500 mt-0.5">{opt.desc}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {isAdmin && activeTab !== 'users' && activeTab !== 'appearance' && (
                  <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end">
                    <Button
                      variant="primary"
                      loading={saveSettings.isPending}
                      onClick={() => saveSettings.mutate()}
                    >
                      <Save className="w-3.5 h-3.5" />
                      Save Policy Settings
                    </Button>
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      </div>

      <Modal open={addUserOpen} onClose={() => setAddUserOpen(false)} title="Create Workspace User">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createUser.mutate();
          }}
          className="space-y-4"
        >
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Full Name</label>
            <input
              required
              value={newUser.full_name}
              onChange={(e) => setNewUser({ ...newUser, full_name: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Work Email</label>
            <input
              type="email"
              required
              value={newUser.email}
              onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Role</label>
            <select
              value={newUser.role}
              onChange={(e) => setNewUser({ ...newUser, role: e.target.value as UserRole })}
              className={inputClass}
            >
              <option value="OPERATOR">OPERATOR</option>
              <option value="REVIEWER">REVIEWER</option>
              <option value="ADMIN">ADMIN</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Initial Password
            </label>
            <input
              type="password"
              required
              value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
              className={inputClass}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setAddUserOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={createUser.isPending}>
              Create User
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
