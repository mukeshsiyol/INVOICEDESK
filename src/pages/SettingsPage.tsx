import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  CheckCircle2,
  Cpu,
  ExternalLink,
  Eye,
  Gauge,
  Lock,
  Mail,
  Monitor,
  Moon,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Sliders,
  Sun,
  Users,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useRole } from '../hooks/useRole';
import { useTheme, type ThemeMode } from '../context/ThemeContext';
import { apiFetch, formatDateTime, type UserRole } from '../lib/api';
import {
  buildSampleRejectionContext,
  DEFAULT_REJECTION_BODY_TEMPLATE,
  DEFAULT_REJECTION_SUBJECT_TEMPLATE,
  REJECTION_PLACEHOLDER_TOKENS,
  renderRejectionTemplate,
} from '../lib/rejectionTemplate';
import { Button, Card, ErrorBanner, Modal } from '../components/ui/Primitives';

type SettingsTab =
  | 'general'
  | 'processing'
  | 'rules'
  | 'confidence'
  | 'templates'
  | 'notifications'
  | 'users'
  | 'appearance';

export function SettingsPage() {
  const { user, refreshUser } = useAuth();
  const { isAdmin, RoleGate } = useRole();
  const { theme, setTheme } = useTheme();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [templatePreviewOpen, setTemplatePreviewOpen] = useState(false);
  const [activeTemplateField, setActiveTemplateField] = useState<'subject' | 'body'>('body');
  const subjectTemplateRef = useRef<HTMLInputElement | null>(null);
  const bodyTemplateRef = useRef<HTMLTextAreaElement | null>(null);

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
    reviewer_approval_limit: '10000.00',
    enforce_separation_of_duties: true,
    notify_on_upload: true,
    notify_on_review: true,
    notify_on_failure: true,
    rejection_email_subject_template: DEFAULT_REJECTION_SUBJECT_TEMPLATE,
    rejection_email_body_template: DEFAULT_REJECTION_BODY_TEMPLATE,
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
        reviewer_approval_limit:
          settingsData.reviewer_approval_limit != null
            ? String(Number(settingsData.reviewer_approval_limit).toFixed(2))
            : '',
        enforce_separation_of_duties: settingsData.enforce_separation_of_duties !== 0,
        notify_on_upload: settingsData.notify_on_upload !== 0,
        notify_on_review: Boolean(settingsData.notify_on_review),
        notify_on_failure: Boolean(settingsData.notify_on_failure),
        rejection_email_subject_template:
          settingsData.rejection_email_subject_template || DEFAULT_REJECTION_SUBJECT_TEMPLATE,
        rejection_email_body_template:
          settingsData.rejection_email_body_template || DEFAULT_REJECTION_BODY_TEMPLATE,
      });
    }
  }, [settingsData]);

  const insertPlaceholderIntoTemplate = (token: string) => {
    if (!isAdmin) return;
    if (activeTemplateField === 'subject') {
      const el = subjectTemplateRef.current;
      const cur = form.rejection_email_subject_template;
      const start = el?.selectionStart ?? cur.length;
      const end = el?.selectionEnd ?? cur.length;
      const next = cur.slice(0, start) + token + cur.slice(end);
      setForm((prev) => ({ ...prev, rejection_email_subject_template: next }));
      window.requestAnimationFrame(() => {
        if (el) {
          el.focus();
          el.setSelectionRange(start + token.length, start + token.length);
        }
      });
      return;
    }
    const el = bodyTemplateRef.current;
    const cur = form.rejection_email_body_template;
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + token + cur.slice(end);
    setForm((prev) => ({ ...prev, rejection_email_body_template: next }));
    window.requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      }
    });
  };

  const saveSettings = useMutation({
    mutationFn: () =>
      apiFetch('/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          ...form,
          auto_approve_max_amount: form.auto_approve_max_amount.trim() === '' ? null : form.auto_approve_max_amount,
          reviewer_approval_limit: form.reviewer_approval_limit.trim() === '' ? null : form.reviewer_approval_limit,
        }),
      }),
    onSuccess: () => {
      setErrorMsg(null);
      setSavedMsg('Workspace settings updated and logged to the Audit Trail.');
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
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

  const resetDemo = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; message: string }>('/demo/reset', {
        method: 'POST',
      }),
    onSuccess: (res) => {
      setErrorMsg(null);
      setSavedMsg(res.message || 'Demo baseline restored cleanly.');
      void queryClient.invalidateQueries();
    },
    onError: (err: any) => {
      setSavedMsg(null);
      setErrorMsg(err?.message || 'Failed to reset demo baseline.');
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
      void queryClient.invalidateQueries({ queryKey: ['switchable-users'] });
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
      setErrorMsg(null);
      setSavedMsg('User permissions updated.');
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      void queryClient.invalidateQueries({ queryKey: ['switchable-users'] });
    },
    onError: (err: any) => {
      setSavedMsg(null);
      setErrorMsg(err?.message || 'Unable to update user.');
    },
  });

  const tabs: Array<{ id: SettingsTab; label: string; icon: React.ComponentType<{ className?: string }>; adminOnly?: boolean }> = [
    { id: 'general', label: 'General', icon: Sliders },
    { id: 'processing', label: 'Processing & OCR', icon: Cpu },
    { id: 'rules', label: 'Approval Rules & Tolerance', icon: ShieldCheck },
    { id: 'confidence', label: 'Confidence Threshold', icon: Gauge },
    { id: 'templates', label: 'Email Templates', icon: Mail },
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

                    {(user?.demo_mode || isAdmin) && (
                      <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                            Demo Baseline Maintenance
                          </div>
                          <p className="text-xs text-slate-500 mt-0.5">
                            Restore the clean 3-invoice starting state and reset PO-104 / PO-205 / PO-300 balances before a live presentation.
                          </p>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={resetDemo.isPending}
                          onClick={() => resetDemo.mutate()}
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          Reset Demo Baseline
                        </Button>
                      </div>
                    )}
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
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Reviewer Override Limit ($)
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          min={0}
                          disabled={!isAdmin}
                          value={form.reviewer_approval_limit}
                          onChange={(e) => setForm({ ...form, reviewer_approval_limit: e.target.value })}
                          placeholder="Leave blank for no cap"
                          className={`${inputClass} font-mono tabular-nums`}
                        />
                        <p className="text-[11px] text-slate-400 mt-1">
                          Invoices above this amount require an ADMIN to confirm human approval.
                        </p>
                      </div>
                      <div className="flex items-start gap-3 pt-6">
                        <input
                          id="enforce-sod"
                          type="checkbox"
                          disabled={!isAdmin}
                          checked={form.enforce_separation_of_duties}
                          onChange={(e) =>
                            setForm({ ...form, enforce_separation_of_duties: e.target.checked })
                          }
                          className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600"
                        />
                        <label htmlFor="enforce-sod" className="text-sm text-slate-700 dark:text-slate-200">
                          <span className="font-medium block">Enforce Separation of Duties</span>
                          <span className="text-xs text-slate-500">
                            Prevent users from approving or rejecting invoices they uploaded themselves.
                          </span>
                        </label>
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

                {activeTab === 'templates' && (
                  <div className="space-y-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                          Rejection Email Template Editor
                        </h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Customize the default vendor rejection email template and placeholders used when generating AI rejection notices
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => setTemplatePreviewOpen(true)}
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Preview
                        </Button>
                        <RoleGate roles={['ADMIN']}>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setForm((prev) => ({
                                ...prev,
                                rejection_email_subject_template: DEFAULT_REJECTION_SUBJECT_TEMPLATE,
                                rejection_email_body_template: DEFAULT_REJECTION_BODY_TEMPLATE,
                              }))
                            }
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            Reset Default
                          </Button>
                        </RoleGate>
                      </div>
                    </div>

                    <div className="p-3.5 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 space-y-2">
                      <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        Available Placeholders{' '}
                        <span className="font-normal text-slate-500">
                          (click to insert into {activeTemplateField === 'subject' ? 'Subject' : 'Email Body'})
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {REJECTION_PLACEHOLDER_TOKENS.map((item) => (
                          <button
                            key={item.token}
                            type="button"
                            disabled={!isAdmin}
                            title={item.description}
                            onClick={() => insertPlaceholderIntoTemplate(item.token)}
                            className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] font-mono text-blue-700 dark:text-blue-300 hover:border-blue-400 disabled:opacity-50 cursor-pointer"
                          >
                            {item.token}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Subject Template
                        </label>
                        <input
                          ref={subjectTemplateRef}
                          type="text"
                          disabled={!isAdmin}
                          maxLength={300}
                          onFocus={() => setActiveTemplateField('subject')}
                          value={form.rejection_email_subject_template}
                          onChange={(e) =>
                            setForm({ ...form, rejection_email_subject_template: e.target.value })
                          }
                          className={`${inputClass} font-mono text-xs`}
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Email Body Template
                        </label>
                        <textarea
                          ref={bodyTemplateRef}
                          rows={11}
                          disabled={!isAdmin}
                          maxLength={4000}
                          onFocus={() => setActiveTemplateField('body')}
                          value={form.rejection_email_body_template}
                          onChange={(e) =>
                            setForm({ ...form, rejection_email_body_template: e.target.value })
                          }
                          className="w-full p-3 text-xs font-mono leading-relaxed rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
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
                        Controls which workspace events surface in real-time alert toasts and the topbar notification tray
                      </p>
                    </div>
                    <div className="space-y-3">
                      <label className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          disabled={!isAdmin}
                          checked={form.notify_on_upload}
                          onChange={(e) => setForm({ ...form, notify_on_upload: e.target.checked })}
                          className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600"
                        />
                        <div>
                          <div className="text-sm font-medium text-slate-800 dark:text-slate-200">
                            Alert on new invoice uploads
                          </div>
                          <div className="text-xs text-slate-500">
                            Broadcast real-time workspace notifications whenever a new invoice PDF is ingested.
                          </div>
                        </div>
                      </label>
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
                            Surface invoices routed to REVIEW in real-time toasts and the notification tray.
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
                                  disabled={u.id === user?.id}
                                  title={u.id === user?.id ? 'You cannot change your own active admin role' : undefined}
                                  onChange={(e) =>
                                    updateUser.mutate({ id: u.id, role: e.target.value as UserRole })
                                  }
                                  className="h-7 px-2 text-xs font-mono rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-60"
                                >
                                  <option value="OPERATOR">OPERATOR</option>
                                  <option value="REVIEWER">REVIEWER</option>
                                  <option value="AUDITOR">AUDITOR</option>
                                  <option value="ADMIN">ADMIN</option>
                                </select>
                              </td>
                              <td className="py-2.5 px-4">
                                <button
                                  disabled={u.id === user?.id}
                                  title={u.id === user?.id ? 'You cannot deactivate your own active account' : undefined}
                                  onClick={() => updateUser.mutate({ id: u.id, is_active: !u.is_active })}
                                  className={`px-2 py-0.5 rounded text-xs font-medium cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed ${
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

                <RoleGate roles={['ADMIN']} when={activeTab !== 'users' && activeTab !== 'appearance'}>
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
                </RoleGate>
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
              <option value="AUDITOR">AUDITOR</option>
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

      <Modal
        open={templatePreviewOpen}
        onClose={() => setTemplatePreviewOpen(false)}
        title="Rejection Email Template Preview (Sample Data)"
      >
        {(() => {
          const sampleCtx = buildSampleRejectionContext(form.workspace_name);
          const renderedSubj = renderRejectionTemplate(
            form.rejection_email_subject_template,
            sampleCtx
          );
          const renderedBody = renderRejectionTemplate(
            form.rejection_email_body_template,
            sampleCtx
          );
          const unresolved = Array.from(
            new Set([...renderedSubj.unresolvedTokens, ...renderedBody.unresolvedTokens])
          );
          return (
            <div className="space-y-4">
              {unresolved.length > 0 && (
                <div className="p-2.5 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-xs text-amber-800 dark:text-amber-200">
                  Unrecognized placeholders: <span className="font-mono">{unresolved.join(', ')}</span>
                </div>
              )}
              <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
                <div className="px-3.5 py-2.5 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 space-y-1 text-xs">
                  <div>
                    <span className="text-slate-500">To:</span>{' '}
                    <span className="font-medium text-slate-900 dark:text-slate-100">
                      {sampleCtx.vendorName} Billing Team
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">Subject:</span>{' '}
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      {renderedSubj.rendered}
                    </span>
                  </div>
                </div>
                <div className="p-3.5 bg-white dark:bg-slate-900 text-xs text-slate-800 dark:text-slate-200 whitespace-pre-wrap leading-relaxed max-h-[360px] overflow-y-auto">
                  {renderedBody.rendered}
                </div>
              </div>
              <div className="flex justify-end">
                <Button variant="secondary" onClick={() => setTemplatePreviewOpen(false)}>
                  Close Preview
                </Button>
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
