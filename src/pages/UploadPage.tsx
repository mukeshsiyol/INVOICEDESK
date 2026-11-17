import React, { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  FileUp,
  Play,
  Trash2,
  UploadCloud,
  XCircle,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { Button, Card, ErrorBanner } from '../components/ui/Primitives';

interface QueuedFile {
  clientId: string;
  file: File;
  sha256: string | null;
  valid: boolean;
  validationError?: string;
  duplicateMatch?: {
    existing_invoice_id: string;
    existing_filename: string;
    existing_invoice_number: string | null;
  } | null;
  uploadStatus: 'ready' | 'uploading' | 'queued' | 'error';
  invoiceId?: string;
  runId?: string;
}

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

export function UploadPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [dragActive, setDragActive] = useState(false);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [autoStart, setAutoStart] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [runningFixtureKey, setRunningFixtureKey] = useState<string | null>(null);

  const { data: fixturesData } = useQuery({
    queryKey: ['fixtures'],
    queryFn: () => apiFetch<{ items: any[] }>('/fixtures'),
  });

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setGlobalError(null);
    const incoming = Array.from(fileList).slice(0, 10 - queue.length);

    const prepared: QueuedFile[] = [];
    for (const file of incoming) {
      const clientId = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`;
      if (file.size === 0) {
        prepared.push({ clientId, file, sha256: null, valid: false, validationError: 'File is empty.', uploadStatus: 'ready' });
        continue;
      }
      if (file.size > 25 * 1024 * 1024) {
        prepared.push({
          clientId,
          file,
          sha256: null,
          valid: false,
          validationError: 'Exceeds 25 MB limit.',
          uploadStatus: 'ready',
        });
        continue;
      }
      const isPdf = await hasPdfMagicHeader(file);
      if (!isPdf) {
        prepared.push({
          clientId,
          file,
          sha256: null,
          valid: false,
          validationError: 'Invalid PDF header (%PDF- missing).',
          uploadStatus: 'ready',
        });
        continue;
      }
      const sha256 = await computeSha256Hex(file);
      prepared.push({ clientId, file, sha256, valid: true, uploadStatus: 'ready' });
    }

    const validForCheck = prepared.filter((p) => p.valid && p.sha256);
    if (validForCheck.length > 0) {
      try {
        const res = await apiFetch<{ matches: any[] }>('/invoices/precheck-hash', {
          method: 'POST',
          body: JSON.stringify({
            hashes: validForCheck.map((v) => ({ client_id: v.clientId, sha256: v.sha256 })),
          }),
        });
        for (const m of res.matches || []) {
          if (m.is_duplicate) {
            const target = prepared.find((p) => p.clientId === m.client_id);
            if (target) target.duplicateMatch = m;
          }
        }
      } catch {
        // non-blocking precheck
      }
    }

    setQueue((prev) => [...prev, ...prepared]);
  };

  const uploadValidFiles = async () => {
    const validFiles = queue.filter((q) => q.valid && q.uploadStatus === 'ready');
    if (validFiles.length === 0) return;

    setUploading(true);
    setGlobalError(null);

    try {
      const formData = new FormData();
      formData.append('auto_start', autoStart ? 'true' : 'false');
      validFiles.forEach((vf) => formData.append('files', vf.file, vf.file.name));

      setQueue((prev) =>
        prev.map((q) => (q.valid && q.uploadStatus === 'ready' ? { ...q, uploadStatus: 'uploading' } : q))
      );

      const res = await apiFetch<{ accepted: any[]; rejected_files: any[] }>('/invoices/upload', {
        method: 'POST',
        body: formData,
      });

      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });

      if (res.accepted.length === 1 && validFiles.length === 1) {
        navigate(`/invoices/${res.accepted[0].invoice_id}?live=true`);
        return;
      }

      setQueue((prev) =>
        prev.map((q) => {
          const match = res.accepted.find((a) => a.original_filename === q.file.name);
          if (match) {
            return {
              ...q,
              uploadStatus: 'queued',
              invoiceId: match.invoice_id,
              runId: match.run_id,
            };
          }
          return q;
        })
      );
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Upload failed.');
      setQueue((prev) =>
        prev.map((q) => (q.uploadStatus === 'uploading' ? { ...q, uploadStatus: 'error' } : q))
      );
    } finally {
      setUploading(false);
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
      if (res.accepted?.[0]) {
        navigate(`/invoices/${res.accepted[0].invoice_id}?live=true`);
      }
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to run sample fixture.');
    } finally {
      setRunningFixtureKey(null);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-display font-semibold tracking-tight text-slate-900 dark:text-slate-50">
          Upload Vendor Invoices
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
          Upload real PDF invoices (native text or scanned images) to execute the 8-stage pipeline live
        </p>
      </div>

      {globalError && <ErrorBanner message={globalError} />}

      {/* Drag & Drop Dropzone */}
      <Card className="p-6">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            void handleFilesSelected(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg py-10 px-6 text-center transition-colors cursor-pointer ${
            dragActive
              ? 'border-blue-500 bg-blue-50/70 dark:bg-blue-950/30'
              : 'border-slate-300 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-600'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => void handleFilesSelected(e.target.files)}
          />
          <div className="w-11 h-11 rounded-lg bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center mx-auto mb-3">
            <UploadCloud className="w-5 h-5" />
          </div>
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Drag & drop vendor invoice PDFs here, or click to browse
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            PDF only (%PDF- magic header verified) · Max 25 MB per file · Up to 10 files per batch
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
          {queue.some((q) => q.valid && q.uploadStatus === 'ready') && (
            <Button variant="primary" onClick={() => void uploadValidFiles()} loading={uploading}>
              <FileUp className="w-4 h-4" />
              Upload & Process ({queue.filter((q) => q.valid && q.uploadStatus === 'ready').length})
            </Button>
          )}
        </div>
      </Card>

      {/* Queued Files */}
      {queue.length > 0 && (
        <Card className="divide-y divide-slate-100 dark:divide-slate-800">
          <div className="px-5 py-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Upload Queue ({queue.length})
            </h2>
            <Button size="sm" variant="ghost" onClick={() => setQueue([])}>
              Clear Queue
            </Button>
          </div>
          {queue.map((item) => (
            <div key={item.clientId} className="px-5 py-3.5 flex items-center justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  {item.valid ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  )}
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                    {item.file.name}
                  </span>
                  <span className="font-mono tabular-nums text-xs text-slate-400">
                    {(item.file.size / 1024).toFixed(1)} KB
                  </span>
                  {item.sha256 && (
                    <span className="font-mono text-[11px] text-slate-400 hidden sm:inline">
                      SHA256:{item.sha256.slice(0, 10)}…
                    </span>
                  )}
                </div>

                {!item.valid && (
                  <p className="text-xs text-rose-600 dark:text-rose-400">{item.validationError}</p>
                )}

                {item.duplicateMatch && (
                  <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      Hash matches previously uploaded file{' '}
                      <strong>{item.duplicateMatch.existing_filename}</strong> (
                      {item.duplicateMatch.existing_invoice_number || 'Unnumbered'}). You may still upload to test duplicate rejection.
                    </span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {item.uploadStatus === 'queued' && item.invoiceId ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => navigate(`/invoices/${item.invoiceId}?live=true`)}
                  >
                    Open Live Workspace <ArrowRight className="w-3.5 h-3.5" />
                  </Button>
                ) : (
                  <button
                    onClick={() => setQueue((prev) => prev.filter((q) => q.clientId !== item.clientId))}
                    className="p-1.5 rounded text-slate-400 hover:text-rose-600 cursor-pointer"
                    aria-label="Remove file"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* Real Generated Demo & Edge-Case PDF Fixtures */}
      <Card className="overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Sample & Edge-Case PDF Test Suite
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Authentic generated PDFs (including a zero-text rasterized scan for E1). Download to inspect or run live through the pipeline.
          </p>
        </div>
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
