import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  Loader2,
  Mail,
  Play,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  UserCheck,
  UserX,
  XCircle,
} from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useRunEventStream } from '../hooks/useRunEventStream';
import {
  apiFetch,
  formatCurrency,
  formatDateTime,
  formatDurationMs,
} from '../lib/api';
import {
  DEFAULT_REJECTION_BODY_TEMPLATE,
  DEFAULT_REJECTION_SUBJECT_TEMPLATE,
  REJECTION_PLACEHOLDER_TOKENS,
  renderRejectionTemplate,
  type RejectionTemplateContext,
} from '../lib/rejectionTemplate';
import { PdfViewer } from '../components/pdf/PdfViewer';
import {
  Button,
  Card,
  DecisionBadge,
  ErrorBanner,
  Modal,
  ProcessingBadge,
  ReviewBadge,
} from '../components/ui/Primitives';

const EIGHT_STAGES = [
  { num: 1, label: 'Ingestion & PDF Integrity' },
  { num: 2, label: 'Text / OCR & AI Extraction' },
  { num: 3, label: 'Structural & Arithmetic Validation' },
  { num: 4, label: 'Vendor Verification' },
  { num: 5, label: 'Duplicate Detection' },
  { num: 6, label: 'Purchase Order Matching' },
  { num: 7, label: 'Tolerance & Balance Verification' },
  { num: 8, label: 'Decision Generation & Ledger Update' },
];

export function ProcessingWorkspacePage() {
  const { invoiceId = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const selectedRunId = searchParams.get('runId') || '';
  const [activeTab, setActiveTab] = useState<'extracted' | 'reconciliation' | 'history'>('extracted');
  const [mobilePane, setMobilePane] = useState<'pipeline' | 'pdf'>('pipeline');
  const [expandedStages, setExpandedStages] = useState<Record<number, boolean>>({});
  const [reviewModal, setReviewModal] = useState<'APPROVE_OVERRIDE' | 'REJECT_OVERRIDE' | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [rejectionTone, setRejectionTone] = useState<'formal' | 'collaborative' | 'concise'>('formal');
  const [customDraftPrompt, setCustomDraftPrompt] = useState('');
  const [draftSubject, setDraftSubject] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [customReasonText, setCustomReasonText] = useState('');
  const [editingExplanation, setEditingExplanation] = useState(false);
  const [activeTemplateField, setActiveTemplateField] = useState<'explanation' | 'subject' | 'body'>('body');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [reviewDraftExpanded, setReviewDraftExpanded] = useState(false);

  const explanationRef = useRef<HTMLTextAreaElement | null>(null);
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['invoice', invoiceId, selectedRunId],
    queryFn: () =>
      apiFetch<any>(`/invoices/${invoiceId}${selectedRunId ? `?run_id=${selectedRunId}` : ''}`),
    enabled: Boolean(invoiceId),
    refetchInterval: (query) => {
      const st = query.state.data?.active_run?.status;
      return st === 'QUEUED' || st === 'RUNNING' ? 2500 : false;
    },
  });

  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiFetch<any>('/settings'),
  });

  const activeRun = data?.active_run;
  const invoice = data?.invoice;
  const isRunActive = activeRun?.status === 'QUEUED' || activeRun?.status === 'RUNNING';

  const { liveEvents, streamStatus } = useRunEventStream({
    runId: activeRun?.id,
    invoiceId,
    isActive: Boolean(isRunActive),
  });

  // Merge persisted stage_events with live SSE stage events cleanly
  const mergedEventsByStage = useMemo(() => {
    const all = [...(data?.stage_events || []), ...liveEvents];
    const map = new Map<number, any>();
    for (const ev of all) {
      const prev = map.get(ev.stage_number);
      // Prefer terminal event (COMPLETED/WARNING/FAILED) over STARTED, or newer id
      if (!prev || ev.id >= prev.id) {
        map.set(ev.stage_number, ev);
      }
    }
    return map;
  }, [data?.stage_events, liveEvents]);

  const startMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ run_id: string }>(`/invoices/${invoiceId}/start`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
  });

  const retryMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ run_id: string }>(`/invoices/${invoiceId}/retry`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Operator manual retry' }),
      }),
    onSuccess: (res) => {
      const next = new URLSearchParams(searchParams);
      next.set('runId', res.run_id);
      setSearchParams(next);
      void queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
  });

  const reviewMutation = useMutation({
    mutationFn: (payload: { action: 'APPROVE_OVERRIDE' | 'REJECT_OVERRIDE'; note: string }) =>
      apiFetch(`/invoices/${invoiceId}/review`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setReviewModal(null);
      setReviewNote('');
      setReviewError(null);
      void queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (err: any) => {
      setReviewError(err?.message || 'Unable to submit review decision.');
    },
  });

  const persistedRejectionNotice = data?.decision?.evidence_snapshot?.ai_rejection_notice || null;

  useEffect(() => {
    if (persistedRejectionNotice) {
      setDraftSubject((prev) => prev || persistedRejectionNotice.email_subject || '');
      setDraftBody((prev) => prev || persistedRejectionNotice.email_body || '');
      setCustomReasonText((prev) => prev || persistedRejectionNotice.plain_english_summary || '');
      if (
        persistedRejectionNotice.tone === 'formal' ||
        persistedRejectionNotice.tone === 'collaborative' ||
        persistedRejectionNotice.tone === 'concise'
      ) {
        setRejectionTone(persistedRejectionNotice.tone);
      }
      return;
    }

    if (data?.decision && !draftSubject && !draftBody) {
      setDraftSubject(
        settingsData?.rejection_email_subject_template || DEFAULT_REJECTION_SUBJECT_TEMPLATE
      );
      setDraftBody(
        settingsData?.rejection_email_body_template || DEFAULT_REJECTION_BODY_TEMPLATE
      );
      setCustomReasonText(data.decision.explanation || '');
    }
  }, [
    persistedRejectionNotice?.generated_at,
    persistedRejectionNotice?.email_subject,
    persistedRejectionNotice?.email_body,
    persistedRejectionNotice?.plain_english_summary,
    persistedRejectionNotice?.tone,
    data?.decision?.id,
    settingsData?.rejection_email_subject_template,
    settingsData?.rejection_email_body_template,
  ]);

  const rejectionDraftMutation = useMutation({
    mutationFn: (payload: {
      tone: 'formal' | 'collaborative' | 'concise';
      custom_instructions?: string;
      subject_template?: string;
      body_template?: string;
    }) =>
      apiFetch<{ draft: any }>(`/invoices/${invoiceId}/rejection-draft`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (res) => {
      setDraftError(null);
      if (res?.draft) {
        setDraftSubject(res.draft.email_subject || '');
        setDraftBody(res.draft.email_body || '');
        setCustomReasonText(res.draft.plain_english_summary || '');
      }
      void queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    },
    onError: (err: any) => {
      setDraftError(err?.message || 'Unable to generate AI rejection explanation and email draft.');
    },
  });

  const insertRejectionPlaceholder = (token: string) => {
    if (activeTemplateField === 'explanation') {
      setEditingExplanation(true);
      const el = explanationRef.current;
      const cur = customReasonText;
      const start = el?.selectionStart ?? cur.length;
      const end = el?.selectionEnd ?? cur.length;
      setCustomReasonText(cur.slice(0, start) + token + cur.slice(end));
      window.requestAnimationFrame(() => {
        if (explanationRef.current) {
          explanationRef.current.focus();
          explanationRef.current.setSelectionRange(start + token.length, start + token.length);
        }
      });
      return;
    }

    if (activeTemplateField === 'subject') {
      const el = subjectRef.current;
      const cur = draftSubject;
      const start = el?.selectionStart ?? cur.length;
      const end = el?.selectionEnd ?? cur.length;
      setDraftSubject(cur.slice(0, start) + token + cur.slice(end));
      window.requestAnimationFrame(() => {
        if (el) {
          el.focus();
          el.setSelectionRange(start + token.length, start + token.length);
        }
      });
      return;
    }

    const el = bodyRef.current;
    const cur = draftBody;
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    setDraftBody(cur.slice(0, start) + token + cur.slice(end));
    window.requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      }
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-12 bg-slate-200 dark:bg-slate-800 rounded-lg" />
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-6 h-[640px] bg-slate-200 dark:bg-slate-800 rounded-lg" />
          <div className="lg:col-span-6 h-[640px] bg-slate-200 dark:bg-slate-800 rounded-lg" />
        </div>
      </div>
    );
  }

  if (isError || !invoice) {
    return (
      <ErrorBanner
        message="Unable to load invoice workspace."
        onRetry={() => void refetch()}
      />
    );
  }

  const decision = data.decision;
  const rawExtracted = activeRun?.raw_extracted;
  const evidenceSnapshot = decision?.evidence_snapshot || {};
  const validationSnap = evidenceSnapshot.validation;
  const vendorSnap = evidenceSnapshot.vendor;
  const dupSnap = evidenceSnapshot.duplicate;
  const poSnap = evidenceSnapshot.poMatch;
  const tolSnap = evidenceSnapshot.tolerance;

  const canDecide = user?.role === 'REVIEWER' || user?.role === 'ADMIN';
  const showReviewActions = invoice.review_status === 'PENDING_REVIEW';

  const getFieldConfBadge = (fieldKey: string) => {
    const conf = rawExtracted?.field_confidence?.[fieldKey];
    if (conf === undefined || conf === null) return null;
    if (conf === 0) {
      return (
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60">
          MISSING
        </span>
      );
    }
    const pct = Math.round(conf * 100);
    const low = pct < 85;
    return (
      <span
        className={`font-mono tabular-nums text-[10px] px-1.5 py-0.5 rounded border ${
          low
            ? 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800/60'
            : 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60'
        }`}
      >
        {pct}%
      </span>
    );
  };

  const getSnippet = (fieldKey: string) =>
    rawExtracted?.extraction_evidence?.find((e: any) => e.field === fieldKey)?.snippet;

  return (
    <div className="space-y-4">
      {/* Top Workspace Header */}
      <Card className="p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          <button
            onClick={() => navigate('/invoices')}
            className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 cursor-pointer"
            title="Back to Invoices"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-lg font-display font-semibold text-slate-900 dark:text-slate-50 truncate">
                {invoice.invoice_number || invoice.original_filename}
              </h1>
              <ProcessingBadge status={activeRun?.status || invoice.processing_status} />
              <DecisionBadge outcome={decision?.outcome || invoice.business_decision} />
              <ReviewBadge status={invoice.review_status} />
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span>{invoice.vendor_canonical_name || invoice.extracted_vendor_name || 'Vendor Extracting…'}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">{invoice.original_filename}</span>
              {activeRun?.extraction_mode && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{activeRun.extraction_mode}</span>
                </>
              )}
              {activeRun?.duration_ms && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{formatDurationMs(activeRun.duration_ms)}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {/* Run Selector */}
          {data.runs_history?.length > 0 && (
            <select
              value={activeRun?.id || ''}
              onChange={(e) => {
                const next = new URLSearchParams(searchParams);
                next.set('runId', e.target.value);
                setSearchParams(next);
              }}
              aria-label="Select processing run"
              className="h-8 px-2.5 text-xs font-mono rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
            >
              {data.runs_history.map((r: any) => (
                <option key={r.id} value={r.id}>
                  Run #{r.run_number} ({r.trigger_type} · {r.status})
                </option>
              ))}
            </select>
          )}

          {activeRun?.status === 'QUEUED' && !activeRun?.started_at ? (
            <Button
              size="sm"
              variant="primary"
              loading={startMutation.isPending}
              onClick={() => startMutation.mutate()}
            >
              <Play className="w-3.5 h-3.5" />
              Start Processing
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={isRunActive || retryMutation.isPending}
              loading={retryMutation.isPending}
              onClick={() => retryMutation.mutate()}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Re-run Pipeline
            </Button>
          )}

          {showReviewActions && (
            <>
              <Button
                size="sm"
                variant="approve"
                disabled={!canDecide}
                title={canDecide ? 'Approve with mandatory note' : 'Reviewer or Admin role required'}
                onClick={() => setReviewModal('APPROVE_OVERRIDE')}
              >
                <UserCheck className="w-3.5 h-3.5" />
                Approve
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={!canDecide}
                title={canDecide ? 'Reject with mandatory note' : 'Reviewer or Admin role required'}
                onClick={() => setReviewModal('REJECT_OVERRIDE')}
              >
                <UserX className="w-3.5 h-3.5" />
                Reject
              </Button>
            </>
          )}
        </div>
      </Card>

      {/* Mobile Pane Toggle */}
      <div className="lg:hidden flex p-1 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
        <button
          onClick={() => setMobilePane('pipeline')}
          className={`flex-1 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
            mobilePane === 'pipeline' ? 'bg-white dark:bg-slate-900 shadow-xs' : 'text-slate-500'
          }`}
        >
          Pipeline & Decision
        </button>
        <button
          onClick={() => setMobilePane('pdf')}
          className={`flex-1 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
            mobilePane === 'pdf' ? 'bg-white dark:bg-slate-900 shadow-xs' : 'text-slate-500'
          }`}
        >
          Document PDF
        </button>
      </div>

      {/* Split-Screen Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* Left: PDF Viewer */}
        <div
          className={`lg:col-span-6 lg:sticky lg:top-20 h-[680px] ${
            mobilePane === 'pdf' ? 'block' : 'hidden lg:block'
          }`}
        >
          <PdfViewer
            invoiceId={invoice.id}
            filename={invoice.original_filename}
            extractionMode={activeRun?.extraction_mode}
          />
        </div>

        {/* Right: Decision + 8-Stage Timeline + Tabs */}
        <div
          className={`lg:col-span-6 space-y-4 ${
            mobilePane === 'pipeline' ? 'block' : 'hidden lg:block'
          }`}
        >
          {/* Decision Banner */}
          {activeRun?.status === 'FAILED' ? (
            <Card className="p-4 border-rose-300 dark:border-rose-900 bg-rose-50/70 dark:bg-rose-950/30">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <ShieldAlert className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-semibold text-rose-900 dark:text-rose-200">
                      Pipeline Failed at Stage {activeRun.error_stage}
                    </div>
                    <p className="text-xs text-rose-800 dark:text-rose-300 mt-1">
                      {activeRun.error_message || 'Unexpected execution error.'}
                    </p>
                  </div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => retryMutation.mutate()}>
                  Retry Run
                </Button>
              </div>
            </Card>
          ) : decision ? (
            <Card
              className={`p-4 ${
                decision.outcome === 'APPROVE'
                  ? 'border-emerald-200 dark:border-emerald-900/70 bg-emerald-50/50 dark:bg-emerald-950/20'
                  : decision.outcome === 'REJECT'
                    ? 'border-rose-200 dark:border-rose-900/70 bg-rose-50/50 dark:bg-rose-950/20'
                    : 'border-amber-200 dark:border-amber-900/70 bg-amber-50/50 dark:bg-amber-950/20'
              }`}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <DecisionBadge outcome={decision.outcome} />
                  <span className="font-mono text-xs font-semibold text-slate-800 dark:text-slate-200">
                    {decision.primary_reason_code}
                  </span>
                </div>
                <span className="text-[11px] font-mono text-slate-500">
                  {decision.triggered_rules?.map((r: any) => r.rule_id).join(', ')}
                </span>
              </div>
              <p className="text-sm text-slate-800 dark:text-slate-200 mt-2 leading-relaxed">
                {decision.explanation}
              </p>

              {decision.evidence_snapshot?.ai_reviewer_brief && (
                <div className="mt-3 p-3 rounded-md bg-white/80 dark:bg-slate-900/70 border border-slate-200/80 dark:border-slate-700/80 space-y-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-slate-900 dark:text-slate-100">
                      <Sparkles className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                      AI Reviewer Brief
                    </span>
                    {decision.evidence_snapshot.ai_reviewer_brief.suggested_po_number && (
                      <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                        Suggested PO: {decision.evidence_snapshot.ai_reviewer_brief.suggested_po_number}
                      </span>
                    )}
                  </div>
                  <p className="text-slate-700 dark:text-slate-300 leading-relaxed">
                    {decision.evidence_snapshot.ai_reviewer_brief.summary}
                  </p>
                  <div className="text-slate-800 dark:text-slate-200">
                    <span className="font-medium">Next step:</span>{' '}
                    {decision.evidence_snapshot.ai_reviewer_brief.recommended_action}
                  </div>
                  {decision.evidence_snapshot.ai_reviewer_brief.verification_checks?.length > 0 && (
                    <ul className="list-disc pl-4 text-slate-600 dark:text-slate-400 space-y-0.5 pt-0.5">
                      {decision.evidence_snapshot.ai_reviewer_brief.verification_checks.map((chk: string, idx: number) => (
                        <li key={idx}>{chk}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Preserved Original Decision + Human Override */}
              {invoice.review_status !== 'NOT_REQUIRED' && invoice.review_status !== 'PENDING_REVIEW' && (
                <div className="mt-3 pt-3 border-t border-slate-200/80 dark:border-slate-700/80 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-500">Original Automated Decision:</span>
                    <span className="font-mono font-semibold">{decision.outcome}</span>
                    <span aria-hidden="true">→</span>
                    <ReviewBadge status={invoice.review_status} />
                  </div>
                  {data.review_actions?.[0]?.note && (
                    <p className="w-full text-xs text-slate-600 dark:text-slate-300 mt-1">
                      Note ({data.review_actions[0].reviewer_name}): "{data.review_actions[0].note}"
                    </p>
                  )}
                </div>
              )}

              {showReviewActions && !canDecide && (
                <div className="mt-3 pt-2 border-t border-amber-200/60 dark:border-amber-800/40 text-xs text-amber-800 dark:text-amber-300">
                  Signed in as <strong>{user?.role}</strong>. Switch to <strong>REVIEWER</strong> or{' '}
                  <strong>ADMIN</strong> in the top-right menu to approve or reject this exception.
                </div>
              )}
            </Card>
          ) : (
            <Card className="p-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    Executing Automated Pipeline…
                  </div>
                  <div className="text-xs text-slate-500">
                    Streaming persisted stage events ({streamStatus})
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* AI Rejection Explanation & Vendor Email Template Editor */}
          {decision &&
            (decision.outcome === 'REJECT' ||
              invoice.business_decision === 'REJECT' ||
              invoice.review_status === 'REJECTED_BY_HUMAN' ||
              (decision.outcome === 'REVIEW' && invoice.review_status === 'PENDING_REVIEW')) && (() => {
              const baseTemplateCtx: RejectionTemplateContext = {
                vendorName: invoice.vendor_canonical_name || invoice.extracted_vendor_name || 'Vendor',
                invoiceNumber: invoice.invoice_number || invoice.original_filename,
                detailedExplanation:
                  persistedRejectionNotice?.detailed_explanation || decision.explanation,
                remediationSteps: persistedRejectionNotice?.remediation_steps || null,
                primaryReasonCode: decision.primary_reason_code,
                poNumber: invoice.matched_po_number || invoice.extracted_po_number || 'N/A',
                invoiceAmount: invoice.total_amount
                  ? formatCurrency(invoice.total_amount, invoice.currency || 'USD')
                  : 'N/A',
                invoiceDate: invoice.invoice_date || 'N/A',
                workspaceName: settingsData?.workspace_name || 'InvoiceDesk',
              };

              const resolvedExplanation = renderRejectionTemplate(
                customReasonText ||
                  persistedRejectionNotice?.plain_english_summary ||
                  decision.explanation ||
                  '',
                baseTemplateCtx
              );
              const fullTemplateCtx: RejectionTemplateContext = {
                ...baseTemplateCtx,
                reasonForRejection: resolvedExplanation.rendered,
              };
              const resolvedSubject = renderRejectionTemplate(draftSubject, fullTemplateCtx);
              const resolvedBody = renderRejectionTemplate(draftBody, fullTemplateCtx);

              return (
                <Card className="p-4 space-y-3 border-slate-200 dark:border-slate-800">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-md bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center">
                        <Mail className="w-4 h-4" />
                      </div>
                      <div>
                        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                          {decision.outcome === 'REJECT' ||
                          invoice.business_decision === 'REJECT' ||
                          invoice.review_status === 'REJECTED_BY_HUMAN'
                            ? 'AI Rejection Explanation & Email Template Editor'
                            : 'AI Vendor Rejection / Exception Template Editor'}
                        </h2>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">
                          Customize placeholders like [Vendor Name], [Invoice Number], and [Reason for Rejection], then Preview
                        </p>
                      </div>
                    </div>

                    {decision.outcome === 'REVIEW' &&
                      invoice.review_status === 'PENDING_REVIEW' &&
                      !persistedRejectionNotice &&
                      !reviewDraftExpanded && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setReviewDraftExpanded(true)}
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          Draft Rejection Notice
                        </Button>
                      )}
                  </div>

                  {(decision.outcome === 'REJECT' ||
                    invoice.business_decision === 'REJECT' ||
                    invoice.review_status === 'REJECTED_BY_HUMAN' ||
                    Boolean(persistedRejectionNotice) ||
                    reviewDraftExpanded) && (
                    <div className="space-y-3 pt-1">
                      {draftError && <ErrorBanner message={draftError} />}

                      {/* Controls Bar */}
                      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                        <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 p-0.5 shrink-0">
                          {(['formal', 'collaborative', 'concise'] as const).map((t) => (
                            <button
                              key={t}
                              type="button"
                              onClick={() => setRejectionTone(t)}
                              className={`px-2.5 py-1 text-xs font-medium rounded capitalize cursor-pointer transition-colors ${
                                rejectionTone === t
                                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                                  : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                              }`}
                            >
                              {t}
                            </button>
                          ))}
                        </div>

                        <input
                          type="text"
                          value={customDraftPrompt}
                          onChange={(e) => setCustomDraftPrompt(e.target.value)}
                          placeholder="Optional AI instruction (e.g. ask vendor to reference PO-2025-1001)…"
                          maxLength={300}
                          className="flex-1 h-8 px-2.5 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />

                        <Button
                          size="sm"
                          variant="primary"
                          loading={rejectionDraftMutation.isPending}
                          onClick={() =>
                            rejectionDraftMutation.mutate({
                              tone: rejectionTone,
                              custom_instructions: customDraftPrompt.trim() || undefined,
                              subject_template: draftSubject.trim() || undefined,
                              body_template: draftBody.trim() || undefined,
                            })
                          }
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          {persistedRejectionNotice ? 'Regenerate with AI' : 'Explain & Draft Email'}
                        </Button>
                      </div>

                      {/* Plain-English Rejection Breakdown (supports placeholders inside [Reason for Rejection]) */}
                      <div className="p-3 rounded-md bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 space-y-2 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-slate-900 dark:text-slate-100">
                            {persistedRejectionNotice
                              ? 'Generated Explanation ([Reason for Rejection])'
                              : 'Rule Explanation ([Reason for Rejection])'}
                          </span>
                          <div className="flex items-center gap-2">
                            {persistedRejectionNotice && (
                              <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
                                {persistedRejectionNotice.generated_by_model} · {persistedRejectionNotice.tone}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setEditingExplanation((v) => !v);
                                setActiveTemplateField('explanation');
                              }}
                              className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                            >
                              {editingExplanation ? 'Done Editing' : 'Customize Placeholders'}
                            </button>
                          </div>
                        </div>

                        {editingExplanation ? (
                          <div className="space-y-1.5">
                            <textarea
                              ref={explanationRef}
                              rows={3}
                              value={customReasonText}
                              onFocus={() => setActiveTemplateField('explanation')}
                              onChange={(e) => setCustomReasonText(e.target.value)}
                              placeholder="Customize the explanation or insert placeholders like [Vendor Name], [Invoice Number], [PO Number]..."
                              className="w-full p-2 text-xs font-mono rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                            <p className="text-[11px] text-slate-500">
                              Preview resolves placeholders inside this explanation and fills{' '}
                              <span className="font-mono">[Reason for Rejection]</span>.
                            </p>
                          </div>
                        ) : (
                          <p className="font-medium text-slate-800 dark:text-slate-200">
                            {resolvedExplanation.rendered}
                          </p>
                        )}

                        {persistedRejectionNotice?.detailed_explanation && (
                          <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                            {persistedRejectionNotice.detailed_explanation}
                          </p>
                        )}

                        {persistedRejectionNotice?.remediation_steps?.length > 0 && (
                          <div className="pt-1">
                            <div className="font-medium text-slate-700 dark:text-slate-300 mb-1">
                              Required Remediation Steps ([Remediation Steps]):
                            </div>
                            <ul className="list-disc pl-4 space-y-0.5 text-slate-600 dark:text-slate-400">
                              {persistedRejectionNotice.remediation_steps.map((step: string, idx: number) => (
                                <li key={idx}>{step}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>

                      {/* Placeholder Toolbar */}
                      <div className="p-2.5 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/30 space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                          <span className="font-medium text-slate-700 dark:text-slate-300">
                            Insert Placeholder into{' '}
                            <span className="font-mono text-blue-600 dark:text-blue-400">
                              {activeTemplateField === 'explanation'
                                ? 'Explanation'
                                : activeTemplateField === 'subject'
                                  ? 'Subject'
                                  : 'Email Body'}
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setDraftSubject(
                                settingsData?.rejection_email_subject_template ||
                                  DEFAULT_REJECTION_SUBJECT_TEMPLATE
                              );
                              setDraftBody(
                                settingsData?.rejection_email_body_template ||
                                  DEFAULT_REJECTION_BODY_TEMPLATE
                              );
                            }}
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer"
                          >
                            <FileText className="w-3 h-3" />
                            Load Workspace Template
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {REJECTION_PLACEHOLDER_TOKENS.map((item) => (
                            <button
                              key={item.token}
                              type="button"
                              title={item.description}
                              onClick={() => insertRejectionPlaceholder(item.token)}
                              className="px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] font-mono text-blue-700 dark:text-blue-300 hover:border-blue-400 cursor-pointer"
                            >
                              {item.token}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Editable Email Template / Draft */}
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label
                            htmlFor="rejection-email-subject"
                            className="text-xs font-semibold text-slate-800 dark:text-slate-200"
                          >
                            Rejection Email Template / Draft
                          </label>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              onClick={() => setPreviewOpen(true)}
                            >
                              <Eye className="w-3.5 h-3.5" />
                              Preview
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                const fullText = `Subject: ${resolvedSubject.rendered}\n\n${resolvedBody.rendered}`;
                                void navigator.clipboard.writeText(fullText);
                                setCopiedEmail(true);
                                window.setTimeout(() => setCopiedEmail(false), 2000);
                              }}
                            >
                              {copiedEmail ? (
                                <>
                                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                                  Copied
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3.5 h-3.5" />
                                  Copy Email
                                </>
                              )}
                            </Button>
                            <a
                              href={`mailto:?subject=${encodeURIComponent(resolvedSubject.rendered)}&body=${encodeURIComponent(resolvedBody.rendered)}`}
                              className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                            >
                              <Mail className="w-3.5 h-3.5" />
                              Open in Mail App
                            </a>
                          </div>
                        </div>

                        <input
                          ref={subjectRef}
                          id="rejection-email-subject"
                          type="text"
                          value={draftSubject}
                          onFocus={() => setActiveTemplateField('subject')}
                          onChange={(e) => setDraftSubject(e.target.value)}
                          className="w-full h-8 px-2.5 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder="Email subject (supports [Vendor Name], [Invoice Number], etc.)"
                        />
                        <textarea
                          ref={bodyRef}
                          rows={8}
                          value={draftBody}
                          onFocus={() => setActiveTemplateField('body')}
                          onChange={(e) => setDraftBody(e.target.value)}
                          className="w-full p-2.5 text-xs leading-relaxed rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder="Vendor rejection email template or body"
                        />
                      </div>

                      {/* Preview Modal */}
                      <Modal
                        open={previewOpen}
                        onClose={() => setPreviewOpen(false)}
                        title="Final Rejection Email Preview"
                      >
                        <div className="space-y-4">
                          {Array.from(
                            new Set([
                              ...resolvedSubject.unresolvedTokens,
                              ...resolvedBody.unresolvedTokens,
                            ])
                          ).length > 0 && (
                            <div className="p-2.5 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-xs text-amber-800 dark:text-amber-200">
                              Unrecognized placeholders:{' '}
                              <span className="font-mono">
                                {Array.from(
                                  new Set([
                                    ...resolvedSubject.unresolvedTokens,
                                    ...resolvedBody.unresolvedTokens,
                                  ])
                                ).join(', ')}
                              </span>
                            </div>
                          )}

                          <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
                            <div className="px-3.5 py-2.5 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 space-y-1 text-xs">
                              <div>
                                <span className="text-slate-500">From:</span>{' '}
                                <span className="font-medium text-slate-900 dark:text-slate-100">
                                  {fullTemplateCtx.workspaceName} Accounts Payable
                                </span>
                              </div>
                              <div>
                                <span className="text-slate-500">To:</span>{' '}
                                <span className="font-medium text-slate-900 dark:text-slate-100">
                                  {fullTemplateCtx.vendorName} Billing Team
                                </span>
                              </div>
                              <div>
                                <span className="text-slate-500">Subject:</span>{' '}
                                <span className="font-semibold text-slate-900 dark:text-slate-100">
                                  {resolvedSubject.rendered}
                                </span>
                              </div>
                            </div>
                            <div className="p-3.5 bg-white dark:bg-slate-900 text-xs text-slate-800 dark:text-slate-200 whitespace-pre-wrap leading-relaxed max-h-[360px] overflow-y-auto">
                              {resolvedBody.rendered}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center justify-end gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                const fullText = `Subject: ${resolvedSubject.rendered}\n\n${resolvedBody.rendered}`;
                                void navigator.clipboard.writeText(fullText);
                                setCopiedEmail(true);
                                window.setTimeout(() => setCopiedEmail(false), 2000);
                              }}
                            >
                              {copiedEmail ? (
                                <>
                                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                                  Copied
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3.5 h-3.5" />
                                  Copy Final Email
                                </>
                              )}
                            </Button>
                            <a
                              href={`mailto:?subject=${encodeURIComponent(resolvedSubject.rendered)}&body=${encodeURIComponent(resolvedBody.rendered)}`}
                              className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap"
                            >
                              <Mail className="w-3.5 h-3.5" />
                              Open in Mail App
                            </a>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setPreviewOpen(false)}
                            >
                              Close
                            </Button>
                          </div>
                        </div>
                      </Modal>
                    </div>
                  )}
                </Card>
              );
            })()}

          {/* 8-Stage Execution Timeline */}
          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                8-Stage Execution Timeline
              </h2>
              <span className="text-xs font-mono text-slate-500">
                Run #{activeRun?.run_number ?? 1}
              </span>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {EIGHT_STAGES.map((stage) => {
                const ev = mergedEventsByStage.get(stage.num);
                const status = ev?.status || 'PENDING';
                const expanded = Boolean(expandedStages[stage.num]);
                return (
                  <div key={stage.num} className="px-4 py-2.5">
                    <button
                      onClick={() =>
                        ev &&
                        setExpandedStages((prev) => ({ ...prev, [stage.num]: !prev[stage.num] }))
                      }
                      className="w-full flex items-center justify-between gap-3 text-left cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {status === 'STARTED' ? (
                          <Loader2 className="w-4 h-4 text-blue-600 animate-spin shrink-0" />
                        ) : status === 'COMPLETED' ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                        ) : status === 'WARNING' ? (
                          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                        ) : status === 'FAILED' ? (
                          <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                        ) : (
                          <Clock className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                            {stage.num}. {stage.label}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                            {ev?.summary || 'Waiting for prior stage…'}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {typeof ev?.duration_ms === 'number' && (
                          <span className="font-mono tabular-nums text-[11px] text-slate-400">
                            {formatDurationMs(ev.duration_ms)}
                          </span>
                        )}
                        {ev &&
                          (expanded ? (
                            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                          ))}
                      </div>
                    </button>
                    {expanded && ev?.evidence && (
                      <pre className="mt-2 p-2.5 rounded bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-[11px] font-mono text-slate-700 dark:text-slate-300 overflow-x-auto">
                        {JSON.stringify(ev.evidence, null, 2)}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Inspection Tabs */}
          <Card className="overflow-hidden">
            <div className="flex border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 px-2">
              {[
                { id: 'extracted', label: 'Extracted Data & Lines' },
                { id: 'reconciliation', label: 'Verification & PO Math' },
                { id: 'history', label: `Audit & Reviews (${data.review_actions?.length || 0})` },
              ].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id as any)}
                  className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
                    activeTab === t.id
                      ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="p-4">
              {activeTab === 'extracted' && (
                <div className="space-y-5">
                  {/* Header Fields Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {[
                      { label: 'Vendor Name', val: invoice.extracted_vendor_name, key: 'vendor_name' },
                      { label: 'Invoice Number', val: invoice.invoice_number, key: 'invoice_number' },
                      { label: 'PO Reference', val: invoice.extracted_po_number, key: 'po_number' },
                      { label: 'Invoice Date', val: invoice.invoice_date, key: 'invoice_date', mono: true },
                      { label: 'Due Date', val: invoice.due_date, key: 'due_date', mono: true },
                      { label: 'Document Type', val: invoice.document_type, key: 'document_type', mono: true },
                      {
                        label: 'Subtotal',
                        val: invoice.subtotal_amount ? formatCurrency(invoice.subtotal_amount, invoice.currency) : null,
                        key: 'subtotal',
                        mono: true,
                      },
                      {
                        label: 'Tax',
                        val: invoice.tax_amount ? formatCurrency(invoice.tax_amount, invoice.currency) : null,
                        key: 'tax_amount',
                        mono: true,
                      },
                      {
                        label: 'Total Amount',
                        val: invoice.total_amount ? formatCurrency(invoice.total_amount, invoice.currency) : null,
                        key: 'total_amount',
                        mono: true,
                        bold: true,
                      },
                    ].map((f) => {
                      const snippet = getSnippet(f.key);
                      return (
                        <div
                          key={f.key}
                          className="p-2.5 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30"
                        >
                          <div className="flex items-center justify-between gap-1 mb-1">
                            <span className="text-[11px] text-slate-500 dark:text-slate-400">{f.label}</span>
                            {getFieldConfBadge(f.key)}
                          </div>
                          <div
                            className={`text-xs truncate ${f.mono ? 'font-mono tabular-nums' : ''} ${
                              f.bold ? 'font-semibold text-slate-900 dark:text-slate-50' : 'text-slate-800 dark:text-slate-200'
                            } ${!f.val ? 'text-rose-600 dark:text-rose-400 italic' : ''}`}
                            title={f.val || 'Missing'}
                          >
                            {f.val || 'null (Missing)'}
                          </div>
                          {snippet && (
                            <div className="text-[10px] font-mono text-slate-400 truncate mt-1" title={snippet}>
                              "{snippet}"
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Line Items */}
                  <div>
                    <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                      Line Items ({data.line_items?.length || 0})
                    </h3>
                    {!data.line_items?.length ? (
                      <div className="text-xs text-slate-400 py-3">No line items extracted.</div>
                    ) : (
                      <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-md">
                        <table className="w-full text-xs text-left">
                          <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-500">
                            <tr>
                              <th className="px-3 py-2">#</th>
                              <th className="px-3 py-2">Description</th>
                              <th className="px-3 py-2 text-right">Qty</th>
                              <th className="px-3 py-2 text-right">Unit</th>
                              <th className="px-3 py-2 text-right">Total</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {data.line_items.map((l: any) => (
                              <tr key={l.id}>
                                <td className="px-3 py-2 font-mono text-slate-400">{l.line_number}</td>
                                <td className="px-3 py-2 text-slate-800 dark:text-slate-200">
                                  {l.description}
                                  {l.is_bundled ? (
                                    <span className="ml-1.5 text-[10px] font-mono text-slate-400">(bundled)</span>
                                  ) : null}
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums">{l.quantity ?? '—'}</td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums">
                                  {l.unit_price ? formatCurrency(l.unit_price, invoice.currency) : '—'}
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums font-medium">
                                  {formatCurrency(l.line_total, invoice.currency)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'reconciliation' && (
                <div className="space-y-4 text-xs">
                  {/* Arithmetic Proof */}
                  <div className="p-3.5 rounded-md border border-slate-200 dark:border-slate-800 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">Arithmetic Proof</span>
                      <span
                        className={`font-mono font-medium ${
                          validationSnap?.arithmeticValid !== false
                            ? 'text-emerald-600'
                            : 'text-rose-600'
                        }`}
                      >
                        {validationSnap?.arithmeticValid !== false ? 'VERIFIED' : 'MISMATCH'}
                      </span>
                    </div>
                    <div className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {validationSnap?.taxMode === 'EMBEDDED' ? (
                        <>
                          Tax-Inclusive Subtotal ({formatCurrency(invoice.subtotal_amount, invoice.currency)}, incl.{' '}
                          {formatCurrency(invoice.tax_amount ?? 0, invoice.currency)} tax) = Expected{' '}
                        </>
                      ) : (
                        <>
                          Subtotal ({formatCurrency(invoice.subtotal_amount, invoice.currency)}) + Tax (
                          {formatCurrency(invoice.tax_amount ?? 0, invoice.currency)}) = Expected{' '}
                        </>
                      )}
                      {validationSnap?.expectedTotal
                        ? formatCurrency(validationSnap.expectedTotal, invoice.currency)
                        : '—'}{' '}
                      vs. Stated {formatCurrency(invoice.total_amount, invoice.currency)}
                      {validationSnap?.taxMode && (
                        <span className="text-slate-400 ml-1.5">[{validationSnap.taxMode}]</span>
                      )}
                      {validationSnap?.arithmeticDelta && validationSnap.arithmeticDelta !== '0.00' && (
                        <span className="text-rose-600 font-semibold ml-1.5">
                          (Delta: {validationSnap.arithmeticDelta})
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Vendor Verification */}
                  <div className="p-3.5 rounded-md border border-slate-200 dark:border-slate-800 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">Vendor Verification</span>
                      <span className="font-mono text-slate-600 dark:text-slate-300">
                        {vendorSnap?.matchMethod || '—'} · {vendorSnap?.vendorStatus || 'UNMATCHED'}
                      </span>
                    </div>
                    <div className="text-slate-600 dark:text-slate-300">
                      Extracted: "{invoice.extracted_vendor_name || '—'}" → Canonical:{' '}
                      <strong>{invoice.vendor_canonical_name || 'No Verified Match'}</strong>
                    </div>
                  </div>

                  {/* Duplicate Detection */}
                  <div className="p-3.5 rounded-md border border-slate-200 dark:border-slate-800 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">Duplicate Detection</span>
                      <span
                        className={`font-mono font-medium ${
                          dupSnap?.isBusinessDuplicate
                            ? 'text-rose-600'
                            : dupSnap?.isNearDuplicate
                              ? 'text-amber-600'
                              : 'text-emerald-600'
                        }`}
                      >
                        {dupSnap?.isBusinessDuplicate
                          ? `DUPLICATE (${dupSnap.matchType})`
                          : dupSnap?.isNearDuplicate
                            ? 'NEAR DUPLICATE'
                            : 'UNIQUE'}
                      </span>
                    </div>
                    {dupSnap?.conflictingInvoiceId ? (
                      <div className="flex items-center justify-between gap-2 text-rose-700 dark:text-rose-300">
                        <span>
                          Conflicts with {dupSnap.conflictingInvoiceNumber || 'record'} (
                          {dupSnap.conflictingFilename})
                        </span>
                        <Link
                          to={`/invoices/${dupSnap.conflictingInvoiceId}`}
                          className="inline-flex items-center gap-1 font-medium underline shrink-0"
                        >
                          Open Original <ExternalLink className="w-3 h-3" />
                        </Link>
                      </div>
                    ) : (
                      <div className="text-slate-500">No file-hash or business-key conflict found.</div>
                    )}
                  </div>

                  {/* PO Reconciliation & Split Invoices */}
                  <div className="p-3.5 rounded-md border border-slate-200 dark:border-slate-800 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        Purchase Order Reconciliation
                      </span>
                      <span className="font-mono text-slate-600 dark:text-slate-300">
                        {invoice.matched_po_number || poSnap?.matchStatus || 'NO PO'}
                      </span>
                    </div>

                    {poSnap?.matchedPoId ? (
                      <div className="space-y-2">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono tabular-nums">
                          <div>
                            <div className="text-[10px] text-slate-400">PO Original</div>
                            <div className="font-semibold">{formatCurrency(poSnap.poOriginalAmount, poSnap.poCurrency)}</div>
                          </div>
                          <div>
                            <div className="text-[10px] text-slate-400">Prior Consumed</div>
                            <div>{formatCurrency(poSnap.priorConsumedAmount, poSnap.poCurrency)}</div>
                          </div>
                          <div>
                            <div className="text-[10px] text-slate-400">Remaining Before</div>
                            <div>{formatCurrency(tolSnap?.remainingBefore, poSnap.poCurrency)}</div>
                          </div>
                          <div>
                            <div className="text-[10px] text-slate-400">Tolerance Cap</div>
                            <div>{formatCurrency(tolSnap?.allowedCap, poSnap.poCurrency)}</div>
                          </div>
                        </div>

                        {data.prior_po_invoices?.length > 0 && (
                          <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                            <div className="text-[11px] font-medium text-slate-500 mb-1">
                              Prior Approved Invoices on {invoice.matched_po_number}:
                            </div>
                            <div className="space-y-1">
                              {data.prior_po_invoices.map((pi: any) => (
                                <Link
                                  key={pi.id}
                                  to={`/invoices/${pi.id}`}
                                  className="flex items-center justify-between text-xs text-blue-600 dark:text-blue-400 hover:underline"
                                >
                                  <span className="font-mono">
                                    {pi.invoice_number || pi.original_filename}
                                  </span>
                                  <span className="font-mono tabular-nums">
                                    {formatCurrency(pi.total_amount, pi.currency)}
                                  </span>
                                </Link>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-slate-500">
                        No exact PO matched.{' '}
                        {poSnap?.candidatePos?.length
                          ? `Candidate open POs: ${poSnap.candidatePos.map((c: any) => c.po_number).join(', ')}`
                          : ''}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'history' && (
                <div className="space-y-3">
                  {!data.review_actions?.length ? (
                    <div className="text-xs text-slate-500 py-4 text-center">
                      No human review actions recorded for this invoice yet.
                    </div>
                  ) : (
                    data.review_actions.map((ra: any) => (
                      <div
                        key={ra.id}
                        className="p-3 rounded-md border border-slate-200 dark:border-slate-800 space-y-1 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-slate-900 dark:text-slate-100">
                            {ra.reviewer_name} ({ra.reviewer_role}) ·{' '}
                            <span className="font-mono">{ra.action}</span>
                          </span>
                          <span className="font-mono tabular-nums text-slate-400">
                            {formatDateTime(ra.created_at)}
                          </span>
                        </div>
                        <p className="text-slate-600 dark:text-slate-300">{ra.note}</p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Review Override Modal */}
      <Modal
        open={Boolean(reviewModal)}
        onClose={() => {
          setReviewModal(null);
          setReviewError(null);
        }}
        title={
          reviewModal === 'APPROVE_OVERRIDE'
            ? 'Approve Exception (Human Override)'
            : 'Reject Invoice (Human Override)'
        }
      >
        <div className="space-y-4">
          <div className="p-3 rounded-md bg-slate-50 dark:bg-slate-800 text-xs text-slate-600 dark:text-slate-300">
            Original Automated Decision: <strong className="font-mono">{decision?.outcome}</strong> (
            <span className="font-mono">{decision?.primary_reason_code}</span>). Your override will be
            recorded in the immutable Audit Trail while preserving the original decision.
          </div>

          {reviewError && <ErrorBanner message={reviewError} />}

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Mandatory Justification Note (min 10 characters)
            </label>
            <textarea
              rows={3}
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              placeholder="Explain why this exception is being approved or rejected for audit compliance..."
              className="w-full p-2.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReviewModal(null)}>
              Cancel
            </Button>
            <Button
              variant={reviewModal === 'APPROVE_OVERRIDE' ? 'approve' : 'destructive'}
              loading={reviewMutation.isPending}
              disabled={reviewNote.trim().length < 10}
              onClick={() =>
                reviewModal &&
                reviewMutation.mutate({ action: reviewModal, note: reviewNote.trim() })
              }
            >
              Confirm {reviewModal === 'APPROVE_OVERRIDE' ? 'Approval' : 'Rejection'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
