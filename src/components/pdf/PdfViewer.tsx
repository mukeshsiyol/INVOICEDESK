import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  Maximize2,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { apiFetch, DEMO_ROLE_STORAGE_KEY } from '../../lib/api';
import { Button, Modal } from '../ui/Primitives';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export function PdfViewer({
  invoiceId,
  filename,
  extractionMode,
}: {
  invoiceId: string;
  filename: string;
  extractionMode?: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [fitMode, setFitMode] = useState<'fit' | 'manual'>('fit');
  const [scale, setScale] = useState(0.85);
  const [rotation, setRotation] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ocrModalOpen, setOcrModalOpen] = useState(false);
  const [ocrPages, setOcrPages] = useState<Array<{ page: number; text: string; ocr_confidence: number }>>([]);
  const [ocrLoading, setOcrLoading] = useState(false);

  const computeFitScale = useCallback(async () => {
    if (!pdfDoc || !viewportRef.current) return;
    try {
      const page = await pdfDoc.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1, rotation });
      const containerWidth = viewportRef.current.clientWidth;
      if (containerWidth <= 0 || baseViewport.width <= 0) return;
      const availableWidth = Math.max(260, containerWidth - 36);
      const widthScale = availableWidth / baseViewport.width;
      const optimal = Math.min(0.95, Math.max(0.55, Number(widthScale.toFixed(2))));
      setScale(optimal);
    } catch {
      // ignore page measurement errors while switching docs
    }
  }, [pdfDoc, pageNum, rotation]);

  useEffect(() => {
    let cancelled = false;
    let loadedDoc: pdfjsLib.PDFDocumentProxy | null = null;
    setLoading(true);
    setError(null);
    setPageNum(1);
    setFitMode('fit');

    const load = async () => {
      try {
        const storedRole = window.localStorage.getItem(DEMO_ROLE_STORAGE_KEY);
        const headers: Record<string, string> = {};
        if (storedRole === 'OPERATOR' || storedRole === 'REVIEWER' || storedRole === 'ADMIN') {
          headers['X-Demo-Role'] = storedRole;
        }
        const res = await fetch(`/api/v1/invoices/${invoiceId}/document`, {
          credentials: 'include',
          headers,
        });
        if (!res.ok) throw new Error('Unable to load PDF document.');
        const buf = await res.arrayBuffer();
        const task = pdfjsLib.getDocument({ data: new Uint8Array(buf) });
        loadedDoc = await task.promise;
        if (cancelled) {
          await (loadedDoc as unknown as { destroy?: () => Promise<void> }).destroy?.();
          return;
        }
        setPdfDoc(loadedDoc);
        setNumPages(loadedDoc.numPages);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'PDF rendering failed.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (loadedDoc) void (loadedDoc as unknown as { destroy?: () => Promise<void> }).destroy?.();
    };
  }, [invoiceId]);

  useEffect(() => {
    if (fitMode !== 'fit' || !pdfDoc) return;
    void computeFitScale();

    const container = viewportRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      void computeFitScale();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [fitMode, pdfDoc, pageNum, rotation, computeFitScale]);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    let renderTask: pdfjsLib.RenderTask | null = null;
    let cancelled = false;

    const renderPage = async () => {
      try {
        const page = await pdfDoc.getPage(pageNum);
        if (cancelled || !canvasRef.current) return;
        const viewport = page.getViewport({ scale, rotation });
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        renderTask = page.render({ canvasContext: ctx, viewport, canvas });
        await renderTask.promise;
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException' && !cancelled) {
          setError('Failed to render PDF page.');
        }
      }
    };

    void renderPage();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDoc, pageNum, scale, rotation]);

  const openOcrInspect = async () => {
    setOcrModalOpen(true);
    setOcrLoading(true);
    try {
      const data = await apiFetch<{ pages: Array<{ page: number; text: string; ocr_confidence: number }> }>(
        `/invoices/${invoiceId}/ocr-text`
      );
      setOcrPages(data.pages || []);
    } catch {
      setOcrPages([]);
    } finally {
      setOcrLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
      {/* Toolbar */}
      <div className="h-11 px-3 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPageNum((p) => Math.max(1, p - 1))}
            disabled={pageNum <= 1}
            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
            title="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="font-mono tabular-nums text-xs px-1.5 text-slate-600 dark:text-slate-300">
            {numPages > 0 ? `${pageNum} / ${numPages}` : '—'}
          </span>
          <button
            onClick={() => setPageNum((p) => Math.min(numPages, p + 1))}
            disabled={pageNum >= numPages}
            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
            title="Next page"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              setFitMode('manual');
              setScale((s) => Math.max(0.5, Number((s - 0.15).toFixed(2))));
            }}
            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            title="Zoom out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="font-mono tabular-nums text-xs w-11 text-center text-slate-600 dark:text-slate-300">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => {
              setFitMode('manual');
              setScale((s) => Math.min(2.2, Number((s + 0.15).toFixed(2))));
            }}
            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            title="Zoom in"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={() => {
              setFitMode('fit');
              void computeFitScale();
            }}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium cursor-pointer transition-colors ${
              fitMode === 'fit'
                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
            title="Fit invoice width to pane"
          >
            <Maximize2 className="w-3 h-3" />
            Fit
          </button>
          <button
            onClick={() => setRotation((r) => (r + 90) % 360)}
            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            title="Rotate 90°"
          >
            <RotateCw className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={openOcrInspect}>
            <FileText className="w-3.5 h-3.5" />
            <span className="hidden xl:inline">{extractionMode === 'OCR' ? 'OCR Text' : 'Text Layer'}</span>
          </Button>
          <a
            href={`/api/v1/invoices/${invoiceId}/document`}
            download={filename}
            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
            title="Download original PDF"
          >
            <Download className="w-4 h-4" />
          </a>
        </div>
      </div>

      {/* Canvas Viewport */}
      <div ref={viewportRef} className="flex-1 overflow-auto p-4 flex justify-center items-start min-h-[460px]">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-500 text-sm gap-2">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Loading PDF document…</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
            <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
            <a
              href={`/api/v1/invoices/${invoiceId}/document`}
              download={filename}
              className="text-xs font-medium text-blue-600 hover:underline"
            >
              Download PDF directly
            </a>
          </div>
        ) : (
          <canvas ref={canvasRef} className="shadow-md bg-white rounded-sm" />
        )}
      </div>

      {/* Raw Text / OCR Layer Modal */}
      <Modal
        open={ocrModalOpen}
        onClose={() => setOcrModalOpen(false)}
        title={extractionMode === 'OCR' ? 'OCR Transcribed Text Layer' : 'Extracted PDF Text Layer'}
      >
        {ocrLoading ? (
          <div className="py-8 text-center text-sm text-slate-500">Loading extracted text…</div>
        ) : ocrPages.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-500">
            Text transcription not yet available for this run.
          </div>
        ) : (
          <div className="space-y-4 max-h-96 overflow-y-auto">
            {ocrPages.map((p) => (
              <div key={p.page} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span className="font-semibold">Page {p.page}</span>
                  <span className="font-mono tabular-nums">
                    OCR Confidence: {Math.round(p.ocr_confidence * 100)}%
                  </span>
                </div>
                <pre className="p-3 rounded-md bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-mono whitespace-pre-wrap text-slate-800 dark:text-slate-200">
                  {p.text || '(No text extracted)'}
                </pre>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
