import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Download,
  FileUp,
  Film,
  ListChecks,
  Loader2,
  Lock,
  Play,
  Trash2,
  UploadCloud,
  X,
  XCircle,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useRole } from '../hooks/useRole';
import { ApiError, apiFetch } from '../lib/api';
import {
  Button,
  Card,
  DecisionBadge,
  ErrorBanner,
  ProcessingBadge,
} from '../components/ui/Primitives';

interface DuplicateMatchWarning {
  is_duplicate: boolean;
  warning_severity?: 'HIGH' | 'MEDIUM' | null;
  match_type?: 'FILE_SHA256' | 'VENDOR_INVOICE_KEY' | 'VENDOR_DATE_REDUNDANCY' | 'INTRA_BATCH_DUPLICATE' | 'NONE';
  matched_fields?: string[];
  reason?: string | null;
  extracted_preview?: {
    vendor_name: string | null;
    invoice_number: string | null;
    invoice_date: string | null;
    total_amount: string | null;
  } | null;
  existing_invoice_id?: string | null;
  existing_filename?: string | null;
  existing_invoice_number?: string | null;
  existing_vendor_name?: string | null;
  existing_invoice_date?: string | null;
  existing_decision?: string | null;
  batch_peer_filename?: string | null;
}

interface QueuedFile {
  clientId: string;
  file: File;
  sha256: string | null;
  valid: boolean;
  validationError?: string;
  extractedPreview?: {
    vendor_name: string | null;
    invoice_number: string | null;
    invoice_date: string | null;
    total_amount: string | null;
  } | null;
  duplicateMatch?: DuplicateMatchWarning | null;
  checkingDuplicates?: boolean;
  uploadStatus: 'ready' | 'uploading' | 'queued' | 'error';
  invoiceId?: string;
  runId?: string;
  autoStarted?: boolean;
  processingStatus?: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  businessDecision?: 'PENDING' | 'APPROVE' | 'REVIEW' | 'REJECT';
  reviewStatus?: string;
  currentStage?: number;
  primaryReasonCode?: string | null;
  errorMessage?: string | null;
}

const MAX_UPLOAD_CHUNK = 10;

async function computeSha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hasPdfMagicHeader(file: File): Promise<boolean> {
  const slice = await file.slice(0, 1024).text();
  return slice.includes('%PDF-');
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function UploadPage() {
  const { canOperate } = useRole();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);

  const [dragActive, setDragActive] = useState(false);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [autoStart, setAutoStart] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [startingIds, setStartingIds] = useState<Record<string, boolean>>({});
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [runningFixtureKey, setRunningFixtureKey] = useState<string | null>(null);
  const [showOverviewVideo, setShowOverviewVideo] = useState(false);
  const [suiteProgress, setSuiteProgress] = useState<{
    running: boolean;
    currentIndex: number;
    total: number;
    currentTitle: string;
    results: Array<{ key: string; title: string; invoiceId: string; decision: string; reason: string | null }>;
  } | null>(null);

  const { data: fixturesData } = useQuery({
    queryKey: ['fixtures'],
    queryFn: () => apiFetch<{ items: any[] }>('/fixtures'),
    enabled: canOperate,
  });

  // Poll live pipeline status for any queued/running uploaded invoices in the queue
  useEffect(() => {
    const activeItems = queue.filter(
      (q) =>
        q.uploadStatus === 'queued' &&
        q.invoiceId &&
        q.autoStarted !== false &&
        q.processingStatus !== 'COMPLETED' &&
        q.processingStatus !== 'FAILED'
    );

    if (activeItems.length === 0) return;

    let cancelled = false;
    const poll = async () => {
      const updates = await Promise.allSettled(
        activeItems.map(async (item) => {
          const detail = await apiFetch<any>(`/invoices/${item.invoiceId}`);
          return {
            clientId: item.clientId,
            processingStatus: detail.invoice?.processing_status as QueuedFile['processingStatus'],
            businessDecision: detail.invoice?.business_decision as QueuedFile['businessDecision'],
            reviewStatus: detail.invoice?.review_status as string | undefined,
            currentStage: detail.active_run?.current_stage as number | undefined,
            primaryReasonCode: (detail.decision?.primary_reason_code ?? null) as string | null,
            errorMessage: (detail.active_run?.error_message ?? null) as string | null,
          };
        })
      );

      if (cancelled) return;

      let anyFinished = false;
      setQueue((prev) =>
        prev.map((q) => {
          const idx = activeItems.findIndex((a) => a.clientId === q.clientId);
          if (idx === -1) return q;
          const res = updates[idx];
          if (res.status !== 'fulfilled') return q;
          const u = res.value;
          if (
            (u.processingStatus === 'COMPLETED' || u.processingStatus === 'FAILED') &&
            q.processingStatus !== u.processingStatus
          ) {
            anyFinished = true;
          }
          return {
            ...q,
            processingStatus: u.processingStatus ?? q.processingStatus,
            businessDecision: u.businessDecision ?? q.businessDecision,
            reviewStatus: u.reviewStatus ?? q.reviewStatus,
            currentStage: typeof u.currentStage === 'number' ? u.currentStage : q.currentStage,
            primaryReasonCode: u.primaryReasonCode ?? q.primaryReasonCode,
            errorMessage: u.errorMessage ?? q.errorMessage,
          };
        })
      );

      if (anyFinished) {
        void queryClient.invalidateQueries({ queryKey: ['invoices'] });
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
        void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      }
    };

    const timer = window.setInterval(() => {
      void poll();
    }, 1800);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [queue, queryClient]);

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setGlobalError(null);
    setQueueNotice(null);

    const existingReadyFingerprints = new Set(
      queue
        .filter((q) => q.uploadStatus === 'ready')
        .map((q) => `${q.file.name}::${q.file.size}::${q.file.lastModified}`)
    );

    const incomingRaw = Array.from(fileList);
    const incoming: File[] = [];
    let skippedDuplicateDrops = 0;

    for (const file of incomingRaw) {
      const fp = `${file.name}::${file.size}::${file.lastModified}`;
      if (existingReadyFingerprints.has(fp)) {
        skippedDuplicateDrops += 1;
        continue;
      }
      existingReadyFingerprints.add(fp);
      incoming.push(file);
    }

    if (skippedDuplicateDrops > 0) {
      setQueueNotice(
        `Skipped ${skippedDuplicateDrops} file${skippedDuplicateDrops === 1 ? '' : 's'} already staged in the queue.`
      );
    }

    if (incoming.length === 0) return;

    const prepared: QueuedFile[] = await Promise.all(
      incoming.map(async (file) => {
        const clientId = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`;
        if (file.size === 0) {
          return {
            clientId,
            file,
            sha256: null,
            valid: false,
            validationError: 'File is empty.',
            uploadStatus: 'ready' as const,
          };
        }
        if (file.size > 25 * 1024 * 1024) {
          return {
            clientId,
            file,
            sha256: null,
            valid: false,
            validationError: 'Exceeds 25 MB limit.',
            uploadStatus: 'ready' as const,
          };
        }
        const isPdf = await hasPdfMagicHeader(file);
        if (!isPdf) {
          return {
            clientId,
            file,
            sha256: null,
            valid: false,
            validationError: 'Invalid PDF header (%PDF- missing).',
            uploadStatus: 'ready' as const,
          };
        }
        const sha256 = await computeSha256Hex(file);
        return {
          clientId,
          file,
          sha256,
          valid: true,
          uploadStatus: 'ready' as const,
        };
      })
    );

    const validForCheck = prepared.filter((p) => p.valid && p.sha256);
    if (validForCheck.length > 0) {
      validForCheck.forEach((v) => {
        v.checkingDuplicates = true;
      });
    }

    setQueue((prev) => [...prev, ...prepared]);

    if (validForCheck.length > 0) {
      const matchMap = new Map<string, DuplicateMatchWarning & { client_id: string }>();

      for (let offset = 0; offset < validForCheck.length; offset += MAX_UPLOAD_CHUNK) {
        const chunk = validForCheck.slice(offset, offset + MAX_UPLOAD_CHUNK);
        try {
          const formData = new FormData();
          formData.append('client_ids', JSON.stringify(chunk.map((c) => c.clientId)));
          chunk.forEach((c) => formData.append('files', c.file, c.file.name));

          const res = await apiFetch<{ matches: Array<DuplicateMatchWarning & { client_id: string }> }>(
            '/invoices/precheck-duplicates',
            {
              method: 'POST',
              body: formData,
            }
          );
          for (const m of res.matches || []) {
            matchMap.set(m.client_id, m);
          }
        } catch {
          // Fallback to SHA-256 precheck if multipart precheck fails
          try {
            const res = await apiFetch<{ matches: any[] }>('/invoices/precheck-hash', {
              method: 'POST',
              body: JSON.stringify({
                hashes: chunk.map((v) => ({ client_id: v.clientId, sha256: v.sha256 })),
              }),
            });
            for (const m of res.matches || []) {
              if (m.is_duplicate) {
                matchMap.set(m.client_id, {
                  ...m,
                  warning_severity: 'HIGH',
                  match_type: 'FILE_SHA256',
                  matched_fields: ['FILE_SHA256'],
                  reason: `Hash matches previously uploaded file ${m.existing_filename} (${m.existing_invoice_number || 'Unnumbered'}).`,
                });
              }
            }
          } catch {
            // non-blocking precheck
          }
        }
      }

      const normToken = (s: string | null | undefined) =>
        (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const normVend = (s: string | null | undefined) =>
        (s || '')
          .toLowerCase()
          .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|gmbh|plc|pty)\b\.?/g, '')
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      setQueue((prev) => {
        const priorReady = prev.filter((q) => q.uploadStatus === 'ready' && !matchMap.has(q.clientId));
        return prev.map((q) => {
          if (!matchMap.has(q.clientId)) {
            return q.checkingDuplicates ? { ...q, checkingDuplicates: false } : q;
          }
          const m = matchMap.get(q.clientId)!;
          let dupMatch: DuplicateMatchWarning | null = m.is_duplicate ? m : null;

          // Also cross-check against files already staged in earlier drops
          if (!dupMatch) {
            const currPreview = m.extracted_preview;
            const currNormInv = normToken(currPreview?.invoice_number);
            const currNormVendor = normVend(currPreview?.vendor_name);
            for (const peer of priorReady) {
              if (q.sha256 && peer.sha256 && q.sha256 === peer.sha256) {
                dupMatch = {
                  is_duplicate: true,
                  warning_severity: 'HIGH',
                  match_type: 'INTRA_BATCH_DUPLICATE',
                  matched_fields: ['FILE_SHA256'],
                  reason: `Identical PDF content to already-staged file '${peer.file.name}'.`,
                  batch_peer_filename: peer.file.name,
                };
                break;
              }
              const peerNormVendor = normVend(peer.extractedPreview?.vendor_name);
              const peerNormInv = normToken(peer.extractedPreview?.invoice_number);
              const sameVendor = Boolean(currNormVendor && peerNormVendor && currNormVendor === peerNormVendor);
              if (sameVendor && currNormInv && peerNormInv && currNormInv === peerNormInv) {
                const fields = ['VENDOR', 'INVOICE_NUMBER'];
                if (currPreview?.invoice_date && peer.extractedPreview?.invoice_date === currPreview.invoice_date) {
                  fields.push('INVOICE_DATE');
                }
                dupMatch = {
                  is_duplicate: true,
                  warning_severity: 'HIGH',
                  match_type: 'INTRA_BATCH_DUPLICATE',
                  matched_fields: fields,
                  reason: `Duplicates already-staged file '${peer.file.name}' (${currPreview?.vendor_name} · ${currPreview?.invoice_number}).`,
                  batch_peer_filename: peer.file.name,
                };
                break;
              }
              if (
                sameVendor &&
                currPreview?.invoice_date &&
                peer.extractedPreview?.invoice_date === currPreview.invoice_date
              ) {
                dupMatch = {
                  is_duplicate: true,
                  warning_severity: 'MEDIUM',
                  match_type: 'INTRA_BATCH_DUPLICATE',
                  matched_fields: ['VENDOR', 'INVOICE_DATE'],
                  reason: `Same vendor and invoice date (${currPreview.invoice_date}) as staged file '${peer.file.name}'.`,
                  batch_peer_filename: peer.file.name,
                };
                break;
              }
            }
          }

          return {
            ...q,
            checkingDuplicates: false,
            extractedPreview: m.extracted_preview ?? q.extractedPreview ?? null,
            duplicateMatch: dupMatch,
          };
        });
      });
    }
  };

  const uploadValidFiles = async () => {
    const validFiles = queue.filter((q) => q.valid && q.uploadStatus === 'ready');
    if (validFiles.length === 0) return;

    const hadOtherQueueItems = queue.length > validFiles.length;
    setUploading(true);
    setGlobalError(null);
    setQueueNotice(null);

    const targetIds = new Set(validFiles.map((v) => v.clientId));
    setQueue((prev) =>
      prev.map((q) => (targetIds.has(q.clientId) ? { ...q, uploadStatus: 'uploading', errorMessage: null } : q))
    );

    const acceptedResultsByClientId = new Map<string, any>();
    const rejectedErrorsByClientId = new Map<string, string>();
    let totalAccepted = 0;

    try {
      for (let offset = 0; offset < validFiles.length; offset += MAX_UPLOAD_CHUNK) {
        const chunk = validFiles.slice(offset, offset + MAX_UPLOAD_CHUNK);
        const formData = new FormData();
        formData.append('auto_start', autoStart ? 'true' : 'false');
        chunk.forEach((vf) => formData.append('files', vf.file, vf.file.name));

        try {
          const res = await apiFetch<{ accepted: any[]; rejected_files: Array<{ filename: string; reason: string }> }>(
            '/invoices/upload',
            {
              method: 'POST',
              body: formData,
            }
          );

          const consumedAccepted = new Set<number>();
          const consumedRejected = new Set<number>();

          for (const qItem of chunk) {
            let matchIdx = res.accepted.findIndex(
              (a, idx) => !consumedAccepted.has(idx) && qItem.sha256 && a.file_sha256 === qItem.sha256
            );
            if (matchIdx === -1) {
              matchIdx = res.accepted.findIndex(
                (a, idx) => !consumedAccepted.has(idx) && a.original_filename === qItem.file.name
              );
            }
            if (matchIdx !== -1) {
              consumedAccepted.add(matchIdx);
              acceptedResultsByClientId.set(qItem.clientId, res.accepted[matchIdx]);
              totalAccepted += 1;
              continue;
            }

            const rejIdx = (res.rejected_files || []).findIndex(
              (r, idx) => !consumedRejected.has(idx) && r.filename === qItem.file.name
            );
            if (rejIdx !== -1) {
              consumedRejected.add(rejIdx);
              rejectedErrorsByClientId.set(
                qItem.clientId,
                res.rejected_files[rejIdx].reason || 'Rejected during server validation.'
              );
            } else {
              rejectedErrorsByClientId.set(qItem.clientId, 'File was not accepted by the upload endpoint.');
            }
          }
        } catch (chunkErr) {
          const msg = chunkErr instanceof Error ? chunkErr.message : 'Upload failed.';
          const rejectedFromDetails =
            chunkErr instanceof ApiError && Array.isArray(chunkErr.details?.rejected_files)
              ? (chunkErr.details.rejected_files as Array<{ filename: string; reason: string }>)
              : null;

          for (const qItem of chunk) {
            const detailMatch = rejectedFromDetails?.find((r) => r.filename === qItem.file.name);
            rejectedErrorsByClientId.set(qItem.clientId, detailMatch?.reason || msg);
          }
          setGlobalError(msg);
        }
      }

      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });

      if (
        validFiles.length === 1 &&
        totalAccepted === 1 &&
        !hadOtherQueueItems &&
        autoStart &&
        rejectedErrorsByClientId.size === 0
      ) {
        const onlyEntry = acceptedResultsByClientId.get(validFiles[0].clientId);
        if (onlyEntry?.invoice_id) {
          navigate(`/invoices/${onlyEntry.invoice_id}?live=true`);
          return;
        }
      }

      setQueue((prev) =>
        prev.map((q) => {
          const accepted = acceptedResultsByClientId.get(q.clientId);
          if (accepted) {
            return {
              ...q,
              uploadStatus: 'queued',
              invoiceId: accepted.invoice_id,
              runId: accepted.run_id,
              autoStarted: autoStart,
              processingStatus: accepted.processing_status || 'QUEUED',
              businessDecision: 'PENDING',
              currentStage: 0,
            };
          }
          const errMsg = rejectedErrorsByClientId.get(q.clientId);
          if (errMsg) {
            return {
              ...q,
              uploadStatus: 'error',
              errorMessage: errMsg,
            };
          }
          return q;
        })
      );
    } finally {
      setUploading(false);
    }
  };

  const startQueuedRun = async (clientId: string, invoiceId: string) => {
    setStartingIds((prev) => ({ ...prev, [clientId]: true }));
    setGlobalError(null);
    try {
      await apiFetch(`/invoices/${invoiceId}/start`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setQueue((prev) =>
        prev.map((q) =>
          q.clientId === clientId
            ? { ...q, autoStarted: true, processingStatus: 'QUEUED', errorMessage: null }
            : q
        )
      );
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to start queued run.');
    } finally {
      setStartingIds((prev) => ({ ...prev, [clientId]: false }));
    }
  };

  const startAllQueued = async () => {
    const targets = queue.filter(
      (q) =>
        q.uploadStatus === 'queued' &&
        q.invoiceId &&
        q.autoStarted === false &&
        q.processingStatus === 'QUEUED'
    );
    for (const target of targets) {
      if (target.invoiceId) {
        await startQueuedRun(target.clientId, target.invoiceId);
      }
    }
  };

  const runSampleFixture = async (fixtureKey: string) => {
    setRunningFixtureKey(fixtureKey);
    setGlobalError(null);
    try {
      const res = await apiFetch<{ accepted: any[] }>('/invoices/upload-fixture', {
        method: 'POST',
        body: JSON.stringify({ fixture_key: fixtureKey }),
      });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      if (res.accepted?.[0]) {
        navigate(`/invoices/${res.accepted[0].invoice_id}?live=true`);
      }
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to run sample fixture.');
    } finally {
      setRunningFixtureKey(null);
    }
  };

  const runFullSampleSuite = async () => {
    const items = fixturesData?.items || [];
    if (items.length === 0) return;
    setGlobalError(null);
    const results: Array<{ key: string; title: string; invoiceId: string; decision: string; reason: string | null }> = [];
    setSuiteProgress({
      running: true,
      currentIndex: 0,
      total: items.length,
      currentTitle: items[0].title,
      results: [],
    });

    try {
      for (let i = 0; i < items.length; i++) {
        const fx = items[i];
        setSuiteProgress({
          running: true,
          currentIndex: i + 1,
          total: items.length,
          currentTitle: fx.title,
          results: [...results],
        });

        const res = await apiFetch<{ accepted: any[] }>('/invoices/upload-fixture', {
          method: 'POST',
          body: JSON.stringify({ fixture_key: fx.key }),
        });
        const invId = res.accepted?.[0]?.invoice_id;
        if (!invId) continue;

        let finalDecision = 'PENDING';
        let finalReason: string | null = null;
        for (let attempt = 0; attempt < 25; attempt++) {
          const detail = await apiFetch<any>(`/invoices/${invId}`);
          const proc = detail.invoice?.processing_status;
          if (proc === 'COMPLETED' || proc === 'FAILED') {
            finalDecision = detail.invoice?.business_decision || proc;
            finalReason = detail.decision?.primary_reason_code || null;
            break;
          }
          await new Promise((r) => setTimeout(r, 1200));
        }

        results.push({
          key: fx.key,
          title: fx.title,
          invoiceId: invId,
          decision: finalDecision,
          reason: finalReason,
        });
      }

      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });

      setSuiteProgress({
        running: false,
        currentIndex: items.length,
        total: items.length,
        currentTitle: 'Completed',
        results,
      });
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Sample suite execution interrupted.');
      setSuiteProgress((prev) => (prev ? { ...prev, running: false } : null));
    }
  };

  const readyValidCount = queue.filter((q) => q.valid && q.uploadStatus === 'ready').length;
  const uploadingCount = queue.filter((q) => q.uploadStatus === 'uploading').length;
  const activeRunCount = queue.filter(
    (q) =>
      q.uploadStatus === 'queued' &&
      (q.processingStatus === 'QUEUED' || q.processingStatus === 'RUNNING')
  ).length;
  const completedCount = queue.filter(
    (q) => q.uploadStatus === 'queued' && q.processingStatus === 'COMPLETED'
  ).length;
  const issueCount = queue.filter(
    (q) => !q.valid || q.uploadStatus === 'error' || q.processingStatus === 'FAILED'
  ).length;
  const duplicateWarningCount = queue.filter(
    (q) => q.uploadStatus === 'ready' && Boolean(q.duplicateMatch?.is_duplicate)
  ).length;
  const unstartedCount = queue.filter(
    (q) =>
      q.uploadStatus === 'queued' &&
      q.autoStarted === false &&
      q.processingStatus === 'QUEUED'
  ).length;
  const clearableDoneCount = queue.filter(
    (q) =>
      !q.valid ||
      q.uploadStatus === 'error' ||
      (q.uploadStatus === 'queued' &&
        (q.processingStatus === 'COMPLETED' || q.processingStatus === 'FAILED'))
  ).length;

  if (!canOperate) {
    return (
      <Card className="p-10 text-center max-w-lg mx-auto mt-10 space-y-3">
        <div className="w-10 h-10 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto">
          <Lock className="w-5 h-5" />
        </div>
        <h1 className="text-lg font-display font-semibold text-slate-900 dark:text-slate-100">
          Read-Only Compliance Access
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          The <span className="font-mono font-medium">AUDITOR</span> role has read-only access to invoices,
          analytics, and the immutable Audit Trail and cannot upload files or initiate processing runs.
        </p>
        <div className="pt-2 flex items-center justify-center gap-2">
          <Link to="/invoices">
            <Button variant="secondary" size="sm">
              Browse Invoices
            </Button>
          </Link>
          <Link to="/audit">
            <Button variant="primary" size="sm">
              Open Audit Trail
            </Button>
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-display font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Upload Vendor Invoices
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Drag and drop one or multiple PDF invoices (native text or scanned images) to queue and execute the 8-stage pipeline
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => setShowOverviewVideo(true)}>
            <Film className="w-3.5 h-3.5" />
            Overview Video
          </Button>
          <a
            href="/invoicedesk-overview.mp4"
            download="invoicedesk-overview.mp4"
            className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            Download MP4
          </a>
        </div>
      </div>

      {showOverviewVideo && (
        <Card className="overflow-hidden border-slate-300 dark:border-slate-700">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                InvoiceDesk Product Overview (720p MP4)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                32s architectural & edge-case summary teaser
              </p>
            </div>
            <button
              onClick={() => setShowOverviewVideo(false)}
              className="p-1.5 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
              aria-label="Close video preview"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="bg-slate-950">
            <video
              src="/invoicedesk-overview.mp4"
              controls
              autoPlay
              playsInline
              className="w-full max-h-[420px] mx-auto"
            />
          </div>
        </Card>
      )}

      {globalError && <ErrorBanner message={globalError} />}

      {queueNotice && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg border border-blue-200 dark:border-blue-900/70 bg-blue-50/70 dark:bg-blue-950/30 text-xs text-blue-800 dark:text-blue-200">
          <span>{queueNotice}</span>
          <button
            onClick={() => setQueueNotice(null)}
            className="text-blue-600 dark:text-blue-300 hover:underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Drag & Drop Dropzone */}
      <Card className="p-6">
        <div
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dragDepthRef.current += 1;
            setDragActive(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) {
              e.dataTransfer.dropEffect = 'copy';
            }
            if (!dragActive) setDragActive(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) {
              setDragActive(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dragDepthRef.current = 0;
            setDragActive(false);
            void handleFilesSelected(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg py-10 px-6 text-center transition-colors cursor-pointer ${
            dragActive
              ? 'border-blue-500 bg-blue-50/80 dark:bg-blue-950/40'
              : 'border-slate-300 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-600'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files;
              void handleFilesSelected(files);
              e.target.value = '';
            }}
          />
          <div
            className={`w-11 h-11 rounded-lg flex items-center justify-center mx-auto mb-3 transition-colors ${
              dragActive
                ? 'bg-blue-600 text-white'
                : 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400'
            }`}
          >
            <UploadCloud className="w-5 h-5" />
          </div>
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {dragActive
              ? 'Drop PDF files here to add them to Queued Uploads'
              : 'Drag & drop multiple vendor invoice PDFs here, or click to browse'}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            PDF only (%PDF- magic header verified) · Max 25 MB per file · Automatically batched in chunks of up to 10
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={autoStart}
              onChange={(e) => setAutoStart(e.target.checked)}
              className="rounded border-slate-300"
            />
            Start 8-stage processing immediately upon upload
          </label>
          {readyValidCount > 0 && (
            <Button variant="primary" onClick={() => void uploadValidFiles()} loading={uploading}>
              <FileUp className="w-4 h-4" />
              {autoStart ? `Upload & Process (${readyValidCount})` : `Upload & Queue (${readyValidCount})`}
            </Button>
          )}
        </div>
      </Card>

      {/* Queued Uploads */}
      {queue.length > 0 && (
        <Card className="overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Queued Uploads ({queue.length})
              </h2>
              <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {readyValidCount > 0 && (
                  <span className="text-slate-700 dark:text-slate-300 font-medium">
                    {readyValidCount} ready
                  </span>
                )}
                {uploadingCount > 0 && (
                  <span className="text-blue-600 dark:text-blue-400 font-medium">
                    {uploadingCount} uploading
                  </span>
                )}
                {activeRunCount > 0 && (
                  <span className="text-blue-600 dark:text-blue-400 font-medium">
                    {activeRunCount} in pipeline
                  </span>
                )}
                {completedCount > 0 && (
                  <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                    {completedCount} completed
                  </span>
                )}
                {issueCount > 0 && (
                  <span className="text-rose-600 dark:text-rose-400 font-medium">
                    {issueCount} invalid/failed
                  </span>
                )}
                {duplicateWarningCount > 0 && (
                  <span className="text-amber-700 dark:text-amber-400 font-medium">
                    {duplicateWarningCount} potential duplicate{duplicateWarningCount === 1 ? '' : 's'}
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {unstartedCount > 0 && (
                <Button size="sm" variant="secondary" onClick={() => void startAllQueued()}>
                  <Play className="w-3.5 h-3.5" />
                  Start All ({unstartedCount})
                </Button>
              )}
              {clearableDoneCount > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setQueue((prev) =>
                      prev.filter(
                        (q) =>
                          q.valid &&
                          q.uploadStatus !== 'error' &&
                          !(
                            q.uploadStatus === 'queued' &&
                            (q.processingStatus === 'COMPLETED' || q.processingStatus === 'FAILED')
                          )
                      )
                    )
                  }
                >
                  Clear Completed
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={uploading}
                onClick={() => setQueue([])}
              >
                Clear All
              </Button>
            </div>
          </div>

          {duplicateWarningCount > 0 && (
            <div className="px-5 py-2.5 bg-amber-50/90 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-800/60 flex items-center gap-2 text-xs text-amber-900 dark:text-amber-200">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <span>
                <strong>Duplicate Detection Warning:</strong> {duplicateWarningCount} staged file
                {duplicateWarningCount === 1 ? '' : 's'} match existing invoices or another file in this queue by vendor, invoice number, invoice date, or file hash. Review below before uploading or proceed intentionally to run full pipeline verification.
              </span>
            </div>
          )}

          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {queue.map((item) => {
              const isUploading = item.uploadStatus === 'uploading';
              const isQueuedOrRunning =
                item.uploadStatus === 'queued' &&
                (item.processingStatus === 'QUEUED' || item.processingStatus === 'RUNNING');
              const isCompleted =
                item.uploadStatus === 'queued' && item.processingStatus === 'COMPLETED';
              const isFailed =
                item.uploadStatus === 'error' ||
                (item.uploadStatus === 'queued' && item.processingStatus === 'FAILED');

              const dup = item.duplicateMatch?.is_duplicate ? item.duplicateMatch : null;
              const fieldLabel = (code: string) => {
                switch (code) {
                  case 'FILE_SHA256':
                    return 'Exact File SHA-256';
                  case 'VENDOR':
                    return 'Vendor';
                  case 'INVOICE_NUMBER':
                    return 'Invoice #';
                  case 'INVOICE_DATE':
                    return 'Invoice Date';
                  case 'AMOUNT':
                    return 'Amount';
                  default:
                    return code;
                }
              };

              return (
                <div
                  key={item.clientId}
                  className={`px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                    dup && item.uploadStatus === 'ready'
                      ? 'bg-amber-50/40 dark:bg-amber-950/15 hover:bg-amber-50/70 dark:hover:bg-amber-950/25'
                      : 'hover:bg-slate-50/70 dark:hover:bg-slate-800/30'
                  }`}
                >
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      {!item.valid || isFailed ? (
                        <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                      ) : isUploading || (item.uploadStatus === 'queued' && item.processingStatus === 'RUNNING') ? (
                        <Loader2 className="w-4 h-4 text-blue-600 animate-spin shrink-0" />
                      ) : isCompleted ? (
                        item.businessDecision === 'REVIEW' ? (
                          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                        ) : item.businessDecision === 'REJECT' ? (
                          <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                        ) : (
                          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                        )
                      ) : item.uploadStatus === 'queued' ? (
                        <Clock className="w-4 h-4 text-slate-500 shrink-0" />
                      ) : dup ? (
                        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      )}

                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                        {item.file.name}
                      </span>
                      <span className="font-mono tabular-nums text-xs text-slate-400">
                        {formatBytes(item.file.size)}
                      </span>
                      {item.sha256 && (
                        <span className="font-mono text-[11px] text-slate-400 hidden md:inline">
                          SHA256:{item.sha256.slice(0, 10)}…
                        </span>
                      )}
                    </div>

                    {item.checkingDuplicates && (
                      <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>Scanning vendor, invoice number, and date for duplicates…</span>
                      </div>
                    )}

                    {item.extractedPreview &&
                      (item.extractedPreview.vendor_name ||
                        item.extractedPreview.invoice_number ||
                        item.extractedPreview.invoice_date) &&
                      item.uploadStatus === 'ready' && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
                          {item.extractedPreview.vendor_name && (
                            <span>
                              Vendor: <strong className="font-medium text-slate-700 dark:text-slate-300">{item.extractedPreview.vendor_name}</strong>
                            </span>
                          )}
                          {item.extractedPreview.invoice_number && (
                            <span>
                              Inv #: <strong className="font-mono font-medium text-slate-700 dark:text-slate-300">{item.extractedPreview.invoice_number}</strong>
                            </span>
                          )}
                          {item.extractedPreview.invoice_date && (
                            <span>
                              Date: <strong className="font-mono font-medium text-slate-700 dark:text-slate-300">{item.extractedPreview.invoice_date}</strong>
                            </span>
                          )}
                        </div>
                      )}

                    {!item.valid && (
                      <p className="text-xs text-rose-600 dark:text-rose-400">{item.validationError}</p>
                    )}

                    {item.errorMessage && (
                      <p className="text-xs text-rose-600 dark:text-rose-400">{item.errorMessage}</p>
                    )}

                    {dup && (
                      <div
                        className={`rounded-md border px-3 py-2 text-xs space-y-1.5 ${
                          dup.warning_severity === 'HIGH'
                            ? 'border-rose-200 dark:border-rose-800/60 bg-rose-50/70 dark:bg-rose-950/30 text-rose-900 dark:text-rose-200'
                            : 'border-amber-200 dark:border-amber-800/60 bg-amber-50/80 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5 font-medium">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span>
                              {dup.match_type === 'INTRA_BATCH_DUPLICATE'
                                ? 'Batch Duplicate Warning'
                                : dup.warning_severity === 'HIGH'
                                  ? 'Potential Duplicate Invoice'
                                  : 'Possible Redundant Invoice'}
                            </span>
                            {dup.matched_fields && dup.matched_fields.length > 0 && (
                              <span className="font-normal text-[11px] opacity-85">
                                ({dup.matched_fields.map(fieldLabel).join(' + ')})
                              </span>
                            )}
                          </div>
                          {dup.existing_invoice_id && (
                            <button
                              type="button"
                              onClick={() => navigate(`/invoices/${dup.existing_invoice_id}`)}
                              className="inline-flex items-center gap-1 text-[11px] font-medium underline hover:no-underline cursor-pointer"
                            >
                              Inspect existing invoice <ArrowRight className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                        <p className="text-[11.5px] leading-relaxed">
                          {dup.reason ||
                            `Matches ${dup.existing_filename} (${dup.existing_invoice_number || 'Unnumbered'}).`}{' '}
                          {item.uploadStatus === 'ready' &&
                            'You can remove this file or upload intentionally to verify pipeline duplicate controls.'}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {item.uploadStatus === 'ready' && item.valid && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                        Ready
                      </span>
                    )}

                    {item.uploadStatus === 'ready' && !item.valid && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60">
                        Invalid PDF
                      </span>
                    )}

                    {isUploading && (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/60">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Uploading
                      </span>
                    )}

                    {item.uploadStatus === 'queued' && (
                      <>
                        {item.processingStatus === 'RUNNING' && typeof item.currentStage === 'number' && (
                          <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                            Stage {item.currentStage}/8
                          </span>
                        )}
                        <ProcessingBadge status={item.processingStatus || 'QUEUED'} />
                        {isCompleted && item.businessDecision && (
                          <DecisionBadge outcome={item.businessDecision} />
                        )}
                      </>
                    )}

                    {item.uploadStatus === 'queued' &&
                      item.invoiceId &&
                      item.autoStarted === false &&
                      item.processingStatus === 'QUEUED' && (
                        <Button
                          size="sm"
                          variant="primary"
                          loading={Boolean(startingIds[item.clientId])}
                          onClick={() => void startQueuedRun(item.clientId, item.invoiceId!)}
                        >
                          <Play className="w-3.5 h-3.5" />
                          Start
                        </Button>
                      )}

                    {item.uploadStatus === 'queued' && item.invoiceId ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          navigate(
                            isQueuedOrRunning
                              ? `/invoices/${item.invoiceId}?live=true`
                              : `/invoices/${item.invoiceId}`
                          )
                        }
                      >
                        {isQueuedOrRunning ? 'Open Live Workspace' : 'View Invoice'}{' '}
                        <ArrowRight className="w-3.5 h-3.5" />
                      </Button>
                    ) : null}

                    {!isUploading && (
                      <button
                        onClick={() =>
                          setQueue((prev) => prev.filter((q) => q.clientId !== item.clientId))
                        }
                        className="p-1.5 rounded text-slate-400 hover:text-rose-600 cursor-pointer"
                        aria-label="Remove file"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Real Generated Demo & Edge-Case PDF Fixtures */}
      <Card className="overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Sample & Edge-Case PDF Test Suite
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Authentic generated PDFs (including a zero-text rasterized scan for E1). Download to inspect or run live through the pipeline.
            </p>
          </div>
          <Button
            size="sm"
            variant="primary"
            loading={Boolean(suiteProgress?.running)}
            disabled={!fixturesData?.items?.length || Boolean(runningFixtureKey)}
            onClick={() => void runFullSampleSuite()}
          >
            <ListChecks className="w-3.5 h-3.5" />
            {suiteProgress?.running
              ? `Running ${suiteProgress.currentIndex}/${suiteProgress.total}…`
              : 'Run Full Suite'}
          </Button>
        </div>

        {suiteProgress && (
          <div className="px-5 py-3 bg-slate-50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-800 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-800 dark:text-slate-200">
                {suiteProgress.running
                  ? `Running (${suiteProgress.currentIndex}/${suiteProgress.total}): ${suiteProgress.currentTitle}`
                  : `Suite completed (${suiteProgress.results.length}/${suiteProgress.total})`}
              </span>
              {!suiteProgress.running && (
                <button
                  onClick={() => navigate('/invoices')}
                  className="text-blue-600 dark:text-blue-400 font-medium hover:underline cursor-pointer"
                >
                  Open Invoices Ledger →
                </button>
              )}
            </div>
            {suiteProgress.results.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {suiteProgress.results.map((r) => (
                  <button
                    key={r.invoiceId}
                    onClick={() => navigate(`/invoices/${r.invoiceId}`)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] hover:border-blue-400 cursor-pointer"
                  >
                    <span className="font-mono font-semibold">{r.decision}</span>
                    <span className="text-slate-500 truncate max-w-[160px]">{r.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {(fixturesData?.items || []).map((fx) => (
            <div
              key={fx.key}
              className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/40"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{fx.title}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {fx.scenario} · <span className="font-mono text-slate-700 dark:text-slate-300">{fx.expectedOutcome}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={`/api/v1/fixtures/${fx.key}.pdf`}
                  download={fx.filename}
                  className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  PDF
                </a>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={runningFixtureKey === fx.key}
                  onClick={() => void runSampleFixture(fx.key)}
                >
                  <Play className="w-3.5 h-3.5" />
                  Run Live
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
