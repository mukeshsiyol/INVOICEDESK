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
import { apiFetch, getDemoAuthHeaders } from '../../lib/api';
import { Button, Modal } from '../ui/Primitives';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const PdfViewer = React.memo(function PdfViewer({
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
  const lastObservedSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
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

  const zoomIn = useCallback(() => {
    setFitMode('manual');
    setScale((s) => Math.min(2.5, Number((s + 0.15).toFixed(2))));
  }, []);

  const zoomOut = useCallback(() => {
    setFitMode('manual');
    setScale((s) => Math.max(0.4, Number((s - 0.15).toFixed(2))));
  }, []);

  const computeFitScale = useCallback(async () => {
    if (!pdfDoc || !viewportRef.current) return;
    try {
      const page = await pdfDoc.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1, rotation });
      const containerWidth = viewportRef.current.offsetWidth || viewportRef.current.clientWidth;
      const containerHeight = viewportRef.current.offsetHeight || viewportRef.current.clientHeight;
      if (containerWidth <= 0 || baseViewport.width <= 0) return;
      // Viewport uses p-4 pb-16 (32px horizontal, 80px vertical padding)
      const availableWidth = Math.max(240, containerWidth - 40);
      const widthScale = availableWidth / baseViewport.width;
      const availableHeight = containerHeight > 140 ? containerHeight - 92 : Infinity;
      const heightScale =
        Number.isFinite(availableHeight) && baseViewport.height > 0
          ? availableHeight / baseViewport.height
          : widthScale;
      const optimal = Math.min(1.0, Math.max(0.4, Number(Math.min(widthScale, heightScale).toFixed(2))));
      setScale((prev) => (Math.abs(prev - optimal) < 0.01 ? prev : optimal));
    } catch {
      // ignore page measurement errors while switching docs
    }
  }, [pdfDoc, pageNum, rotation]);

  const resetFitView = useCallback(() => {
    setFitMode('fit');
    void computeFitScale();
    viewportRef.current?.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
  }, [computeFitScale]);

  useEffect(() => {
    let cancelled = false;
    let loadedDoc: pdfjsLib.PDFDocumentProxy | null = null;
    setLoading(true);
    setError(null);
    setPageNum(1);
    setFitMode('fit');

    const load = async () => {
      try {
        const headers = getDemoAuthHeaders();
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
    const container = viewportRef.current;
    if (!container) return;

    lastObservedSizeRef.current = {
      w: container.offsetWidth,
      h: container.offsetHeight,
    };
    void computeFitScale();

    if (typeof ResizeObserver === 'undefined') return;
    let rafId = 0;
    const observer = new ResizeObserver(() => {
      const nextW = container.offsetWidth;
      const nextH = container.offsetHeight;
      if (
        Math.abs(nextW - lastObservedSizeRef.current.w) < 4 &&
        Math.abs(nextH - lastObservedSizeRef.current.h) < 4
      ) {
        return;
      }
      lastObservedSizeRef.current = { w: nextW, h: nextH };
      if (rafId) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        void computeFitScale();
      });
    });
    observer.observe(container);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [fitMode, pdfDoc, pageNum, rotation, computeFitScale]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (ocrModalOpen) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"]')) return;

      const hasCtrlOrMeta = e.ctrlKey || e.metaKey;
      const viewerFocused = viewportRef.current?.contains(document.activeElement) ?? false;
      if (e.altKey) return;
      if (hasCtrlOrMeta && !viewerFocused) return;

      if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0' || e.code === 'Numpad0' || (!hasCtrlOrMeta && e.key.toLowerCase() === 'f')) {
        e.preventDefault();
        resetFitView();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ocrModalOpen, zoomIn, zoomOut, resetFitView]);

  useEffect(() => {
    if (loading || !pdfDoc || !canvasRef.current) return;
    let renderTask: pdfjsLib.RenderTask | null = null;
    let cancelled = false;

    const renderPage = async () => {
      try {
        const page = await pdfDoc.getPage(pageNum);
        if (cancelled || !canvasRef.current) return;
        const viewport = page.getViewport({ scale, rotation });
        const dpr = window.devicePixelRatio || 1;
        const pixelWidth = Math.max(1, Math.floor(viewport.width * dpr));
        const pixelHeight = Math.max(1, Math.floor(viewport.height * dpr));
        const cssWidth = `${Math.floor(viewport.width)}px`;
        const cssHeight = `${Math.floor(viewport.height)}px`;

        // Double-buffer onto an offscreen canvas so the visible canvas never flashes blank mid-render
        const offscreen = document.createElement('canvas');
        offscreen.width = pixelWidth;
        offscreen.height = pixelHeight;
        const offCtx = offscreen.getContext('2d');
        if (!offCtx) return;
        offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

        renderTask = page.render({ canvasContext: offCtx, viewport, canvas: offscreen });
        await renderTask.promise;
        if (cancelled || !canvasRef.current) return;

        const targetCanvas = canvasRef.current;
        targetCanvas.width = pixelWidth;
        targetCanvas.height = pixelHeight;
        targetCanvas.style.width = cssWidth;
        targetCanvas.style.height = cssHeight;
        const targetCtx = targetCanvas.getContext('2d');
        if (targetCtx) {
          targetCtx.setTransform(1, 0, 0, 1, 0, 0);
          targetCtx.drawImage(offscreen, 0, 0);
        }
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
  }, [pdfDoc, loading, pageNum, scale, rotation]);

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
      {/* Top Toolbar */}
      <div className="h-11 px-3 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1">
          <button
            type="button"
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
            type="button"
            onClick={() => setPageNum((p) => Math.min(numPages, p + 1))}
            disabled={pageNum >= numPages}
            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
            title="Next page"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500">
          <span>Shortcuts:</span>
          <kbd className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono text-[10px] text-slate-600 dark:text-slate-300">
            -
          </kbd>
          <kbd className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono text-[10px] text-slate-600 dark:text-slate-300">
            +
          </kbd>
          <kbd className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono text-[10px] text-slate-600 dark:text-slate-300">
            0
          </kbd>
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

      {/* Relative Viewport Wrapper + Floating Zoom Toolbar */}
      <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
        <div
          ref={viewportRef}
          tabIndex={0}
          aria-label="Invoice PDF viewport"
          className={`flex-1 p-4 pb-16 flex justify-center items-start focus:outline-none ${
            fitMode === 'fit' ? 'overflow-hidden' : 'overflow-auto'
          }`}
        >
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

        {/* Floating Zoom & Fit Toolbar */}
        {!loading && !error && (
          <div
            role="toolbar"
            aria-label="Invoice zoom controls"
            className="absolute bottom-3.5 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 px-2 py-1.5 rounded-lg bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border border-slate-200 dark:border-slate-700 shadow-lg"
          >
            <button
              type="button"
              onClick={zoomOut}
              disabled={scale <= 0.4}
              className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer text-slate-700 dark:text-slate-200"
              title="Zoom out (-)"
              aria-label="Zoom out"
            >
              <ZoomOut className="w-4 h-4" />
            </button>

            <span
              className="font-mono tabular-nums text-xs font-medium w-12 text-center text-slate-700 dark:text-slate-200 select-none"
              title="Current zoom level"
            >
              {Math.round(scale * 100)}%
            </span>

            <button
              type="button"
              onClick={zoomIn}
              disabled={scale >= 2.5}
              className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer text-slate-700 dark:text-slate-200"
              title="Zoom in (+)"
              aria-label="Zoom in"
            >
              <ZoomIn className="w-4 h-4" />
            </button>

            <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-0.5" />

            <button
              type="button"
              onClick={resetFitView}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-colors whitespace-nowrap ${
                fitMode === 'fit'
                  ? 'bg-blue-50 dark:bg-blue-950/70 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800'
                  : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
              title="Reset view to fit screen (0 or F)"
              aria-label="Reset view to fit screen"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              Fit
            </button>

            <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-0.5" />

            <button
              type="button"
              onClick={() => setRotation((r) => (r + 90) % 360)}
              className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer text-slate-700 dark:text-slate-200"
              title="Rotate 90°"
              aria-label="Rotate page 90 degrees"
            >
              <RotateCw className="w-4 h-4" />
            </button>
          </div>
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
});
