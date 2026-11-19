import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import Decimal from 'decimal.js';
import { writeAuditLog } from './auth.ts';
import { config } from './config.ts';
import { getDb, isoNow } from './db.ts';
import {
  normalizeDocNumber,
  parseDecimalSafe,
  runStage3Validation,
  runStage4VendorVerification,
  runStage5DuplicateDetection,
  runStage6PoMatching,
  runStage7ToleranceVerification,
  runStage8DecisionGeneration,
  type ApplicationSettingsRow,
} from './engine.ts';
import { buildExplanationRecord } from './explanation.ts';
import {
  defaultExtractionProvider,
  generateDecisionExplanation,
  inspectPdfNativeText,
  readStoredPdf,
  validatePdfBuffer,
} from './extraction.ts';
import { createWorkspaceNotification } from './notifications.ts';

export interface SseEventPayload {
  id: number;
  event: 'stage_started' | 'stage_completed' | 'stage_failed' | 'run_completed' | 'run_failed';
  data: Record<string, unknown>;
}

class RunEventBroker extends EventEmitter {
  publish(runId: string, payload: SseEventPayload): void {
    this.emit(`run:${runId}`, payload);
  }
}

export const sseBroker = new RunEventBroker();
sseBroker.setMaxListeners(100);

const MAX_CONCURRENT_RUNS = 4;
let activeWorkers = 0;
const pendingQueue: Array<() => Promise<void>> = [];
const queuedOrRunningIds = new Set<string>();

function enqueueWork(runId: string, fn: () => Promise<void>): void {
  if (queuedOrRunningIds.has(runId)) return;
  queuedOrRunningIds.add(runId);
  pendingQueue.push(async () => {
    try {
      await fn();
    } finally {
      queuedOrRunningIds.delete(runId);
    }
  });
  void drainQueue();
}

async function drainQueue(): Promise<void> {
  if (activeWorkers >= MAX_CONCURRENT_RUNS) return;
  const next = pendingQueue.shift();
  if (!next) return;
  activeWorkers++;
  try {
    await next();
  } catch (err) {
    // A background run must never take the whole server down.
    console.error('[invoicedesk] Background processing run crashed:', err);
  } finally {
    activeWorkers--;
    void drainQueue();
  }
}

const STAGE_NAMES: Record<number, { code: string; label: string }> = {
  1: { code: 'STAGE_1_INGESTION', label: 'Ingestion & PDF Integrity' },
  2: { code: 'STAGE_2_EXTRACTION', label: 'Text / OCR & AI Extraction' },
  3: { code: 'STAGE_3_VALIDATION', label: 'Structural & Arithmetic Validation' },
  4: { code: 'STAGE_4_VENDOR_VERIFICATION', label: 'Vendor Verification' },
  5: { code: 'STAGE_5_DUPLICATE_DETECTION', label: 'Duplicate Detection' },
  6: { code: 'STAGE_6_PO_MATCHING', label: 'Purchase Order Matching' },
  7: { code: 'STAGE_7_TOLERANCE_VERIFICATION', label: 'Tolerance & Balance Verification' },
  8: { code: 'STAGE_8_DECISION_GENERATION', label: 'Decision Generation & Ledger Update' },
};

async function persistAndEmitStageEvent(params: {
  runId: string;
  stageNumber: number;
  status: 'STARTED' | 'COMPLETED' | 'WARNING' | 'FAILED';
  summary: string;
  durationMs?: number | null;
  evidence?: Record<string, unknown>;
}): Promise<number> {
  const db = getDb();
  const stageMeta = STAGE_NAMES[params.stageNumber];
  const now = isoNow();
  const result = await db
    .prepare(
      `INSERT INTO stage_events (run_id, stage_number, stage_code, status, summary, duration_ms, evidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.runId,
      params.stageNumber,
      stageMeta.code,
      params.status,
      params.summary,
      params.durationMs ?? null,
      JSON.stringify(params.evidence ?? {}),
      now
    );

  const eventId = Number(result.lastInsertRowid);
  const eventType =
    params.status === 'STARTED'
      ? 'stage_started'
      : params.status === 'FAILED'
        ? 'stage_failed'
        : 'stage_completed';

  sseBroker.publish(params.runId, {
    id: eventId,
    event: eventType,
    data: {
      id: eventId,
      run_id: params.runId,
      stage_number: params.stageNumber,
      stage_code: stageMeta.code,
      stage_label: stageMeta.label,
      status: params.status,
      summary: params.summary,
      duration_ms: params.durationMs ?? null,
      evidence: params.evidence ?? {},
      timestamp: now,
    },
  });

  return eventId;
}

export async function startProcessingRun(runId: string): Promise<void> {
  if (config.isServerless) {
    if (queuedOrRunningIds.has(runId)) return;
    queuedOrRunningIds.add(runId);
    try {
      await executeProcessingRun(runId);
    } finally {
      queuedOrRunningIds.delete(runId);
    }
    return;
  }
  enqueueWork(runId, async () => {
    await executeProcessingRun(runId);
  });
}

export async function executeProcessingRun(runId: string): Promise<void> {
  const db = getDb();
  const runRow = await db
    .prepare('SELECT id, invoice_id, run_number, trigger_type, status FROM processing_runs WHERE id = ?')
    .get(runId) as
    | { id: string; invoice_id: string; run_number: number; trigger_type: string; status: string }
    | undefined;

  if (!runRow || runRow.status !== 'QUEUED') return;

  const invoiceRow = await db
    .prepare('SELECT id, original_filename, storage_key, file_sha256, file_size_bytes, po_consumed_applied FROM invoices WHERE id = ?')
    .get(runRow.invoice_id) as
    | {
        id: string;
        original_filename: string;
        storage_key: string;
        file_sha256: string;
        file_size_bytes: number;
        po_consumed_applied: number;
      }
    | undefined;

  if (!invoiceRow) return;

  const settings = await db
    .prepare('SELECT * FROM application_settings WHERE id = 1')
    .get() as unknown as ApplicationSettingsRow;

  const runStartMs = Date.now();
  const startedAt = isoNow();
  let currentStage = 1;

  // Atomically claim the QUEUED run so concurrent callers cannot double-execute it
  const claimed = await db
    .prepare(`UPDATE processing_runs SET status = 'RUNNING', current_stage = 1, started_at = ? WHERE id = ? AND status = 'QUEUED'`)
    .run(startedAt, runId);
  if (claimed.changes === 0) return;

  try {
    await db.prepare(`UPDATE invoices SET processing_status = 'RUNNING', updated_at = ? WHERE id = ?`).run(
      startedAt,
      invoiceRow.id
    );

    // ==================== STAGE 1: INGESTION ====================
    currentStage = 1;
    const s1Start = Date.now();
    await persistAndEmitStageEvent({
      runId,
      stageNumber: 1,
      status: 'STARTED',
      summary: `Verifying PDF structure and content fingerprint for ${invoiceRow.original_filename}...`,
    });

    const pdfBuffer = await readStoredPdf(invoiceRow.storage_key);
    const pdfCheck = validatePdfBuffer(pdfBuffer);
    if (!pdfCheck.valid) {
      throw new Error(pdfCheck.reason || 'PDF validation failed.');
    }
    const nativeInspection = await inspectPdfNativeText(pdfBuffer, { maxPages: 25, timeoutMs: 8000 });
    await db.prepare(`UPDATE invoices SET page_count = ?, updated_at = ? WHERE id = ?`).run(
      nativeInspection.pageCount,
      isoNow(),
      invoiceRow.id
    );

    await persistAndEmitStageEvent({
      runId,
      stageNumber: 1,
      status: 'COMPLETED',
      durationMs: Date.now() - s1Start,
      summary: `Validated ${nativeInspection.pageCount}-page PDF (${(invoiceRow.file_size_bytes / 1024).toFixed(1)} KB, SHA-256 ${invoiceRow.file_sha256.slice(0, 12)}…)`,
      evidence: {
        page_count: nativeInspection.pageCount,
        file_size_bytes: invoiceRow.file_size_bytes,
        file_sha256: invoiceRow.file_sha256,
        native_avg_chars_per_page: Number(nativeInspection.avgCharsPerPage.toFixed(1)),
      },
    });

    // ==================== STAGE 2: EXTRACTION ====================
    currentStage = 2;
    await db.prepare(`UPDATE processing_runs SET current_stage = 2 WHERE id = ?`).run(runId);
    const s2Start = Date.now();
    const minChars = settings.ocr_min_chars_per_page ?? 50;
    const useOcr = Boolean(settings.force_ocr) || nativeInspection.avgCharsPerPage < minChars;
    const extractionMode: 'NATIVE_TEXT' | 'OCR' = useOcr ? 'OCR' : 'NATIVE_TEXT';

    await persistAndEmitStageEvent({
      runId,
      stageNumber: 2,
      status: 'STARTED',
      summary: useOcr
        ? `Low native text (${nativeInspection.avgCharsPerPage.toFixed(0)} chars/page < ${minChars}); engaging Vision OCR fallback...`
        : `Extracting structured fields from native PDF text (${nativeInspection.avgCharsPerPage.toFixed(0)} chars/page)...`,
    });

    const {
      payload: extracted,
      latencyMs,
      modelUsed,
      fallbackUsed,
      fallbackReason,
    } = await defaultExtractionProvider.extractInvoice({
      pdfBuffer,
      nativeInspection,
      extractionMode,
    });

    const confValues = [
      extracted.field_confidence.vendor_name,
      extracted.field_confidence.invoice_number,
      extracted.field_confidence.invoice_date,
      extracted.field_confidence.currency,
      extracted.field_confidence.total_amount,
    ];
    const overallConf = Number((confValues.reduce((a, b) => a + b, 0) / confValues.length).toFixed(4));
    const normInvNo = normalizeDocNumber(extracted.invoice_number);

    await db.prepare(
      `UPDATE processing_runs SET extraction_mode = ?, raw_extracted_json = ? WHERE id = ?`
    ).run(extractionMode, JSON.stringify(extracted), runId);

    await db.prepare(
      `UPDATE invoices SET
        document_type = ?,
        extracted_vendor_name = ?,
        extracted_po_number = ?,
        invoice_number = ?,
        normalized_invoice_number = ?,
        invoice_date = ?,
        due_date = ?,
        currency = ?,
        subtotal_amount = ?,
        tax_amount = ?,
        discount_amount = ?,
        total_amount = ?,
        overall_confidence = ?,
        updated_at = ?
       WHERE id = ?`
    ).run(
      extracted.document_type,
      extracted.vendor.name,
      extracted.po_number,
      extracted.invoice_number,
      normInvNo,
      extracted.invoice_date,
      extracted.due_date,
      extracted.currency,
      extracted.subtotal,
      extracted.tax_amount,
      extracted.discount_amount,
      extracted.total_amount,
      overallConf,
      isoNow(),
      invoiceRow.id
    );

    await db.prepare('DELETE FROM invoice_lines WHERE run_id = ?').run(runId);
    const insertLine = db.prepare(
      `INSERT INTO invoice_lines (id, invoice_id, run_id, line_number, description, is_bundled, quantity, unit_price, tax_amount, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const line of extracted.line_items) {
      await insertLine.run(
        crypto.randomUUID(),
        invoiceRow.id,
        runId,
        line.line_number,
        line.description,
        line.is_bundled ? 1 : 0,
        line.quantity,
        line.unit_price,
        line.tax_amount,
        line.line_total
      );
    }

    await persistAndEmitStageEvent({
      runId,
      stageNumber: 2,
      status: fallbackUsed ? 'WARNING' : 'COMPLETED',
      durationMs: Date.now() - s2Start,
      summary: fallbackUsed
        ? `Deterministic native-text fallback extracted ${extracted.line_items.length} line item(s) after AI timeout · Mean confidence ${Math.round(overallConf * 100)}%`
        : `${extractionMode === 'OCR' ? 'OCR Vision fallback' : 'Native text'} extracted ${extracted.line_items.length} line item(s) · Mean confidence ${Math.round(overallConf * 100)}%`,
      evidence: {
        extraction_mode: extractionMode,
        provider: `${defaultExtractionProvider.providerName}:${modelUsed}`,
        llm_latency_ms: latencyMs,
        overall_confidence: overallConf,
        fallback_used: Boolean(fallbackUsed),
        ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
        extracted_fields_summary: {
          vendor: extracted.vendor.name,
          invoice_number: extracted.invoice_number,
          po_number: extracted.po_number,
          total_amount: extracted.total_amount,
          currency: extracted.currency,
        },
      },
    });

    // ==================== STAGE 3: VALIDATION ====================
    currentStage = 3;
    await db.prepare(`UPDATE processing_runs SET current_stage = 3 WHERE id = ?`).run(runId);
    const s3Start = Date.now();
    await persistAndEmitStageEvent({
      runId,
      stageNumber: 3,
      status: 'STARTED',
      summary: 'Validating required fields, decimal arithmetic, and confidence thresholds...',
    });

    const validation = runStage3Validation(extracted, settings);
    await persistAndEmitStageEvent({
      runId,
      stageNumber: 3,
      status: validation.passed ? 'COMPLETED' : 'WARNING',
      durationMs: Date.now() - s3Start,
      summary: validation.passed
        ? `All required fields present; decimal arithmetic verified ($0.00 delta).`
        : [
            validation.missingFields.length > 0 ? `${validation.missingFields.length} missing field(s)` : null,
            !validation.arithmeticValid ? `arithmetic delta ${validation.arithmeticDelta ?? validation.lineSumDelta}` : null,
            validation.lowConfidenceFields.length > 0 ? `${validation.lowConfidenceFields.length} low-confidence field(s)` : null,
            validation.isCreditNote ? 'Credit Note detected' : null,
          ]
            .filter(Boolean)
            .join(' · '),
      evidence: validation as unknown as Record<string, unknown>,
    });

    // ==================== STAGE 4: VENDOR VERIFICATION ====================
    currentStage = 4;
    await db.prepare(`UPDATE processing_runs SET current_stage = 4 WHERE id = ?`).run(runId);
    const s4Start = Date.now();
    await persistAndEmitStageEvent({
      runId,
      stageNumber: 4,
      status: 'STARTED',
      summary: `Verifying vendor '${extracted.vendor.name ?? 'Unknown'}' against approved supplier directory...`,
    });

    const vendorResult = await runStage4VendorVerification(db, extracted);
    if (vendorResult.matchedVendorId) {
      await db.prepare('UPDATE invoices SET vendor_id = ?, updated_at = ? WHERE id = ?').run(
        vendorResult.matchedVendorId,
        isoNow(),
        invoiceRow.id
      );
    }

    await persistAndEmitStageEvent({
      runId,
      stageNumber: 4,
      status:
        vendorResult.matchedVendorId &&
        vendorResult.matchMethod !== 'FUZZY' &&
        vendorResult.vendorStatus === 'APPROVED'
          ? 'COMPLETED'
          : 'WARNING',
      durationMs: Date.now() - s4Start,
      summary: vendorResult.matchedVendorId
        ? `Matched '${vendorResult.canonicalName}' via ${vendorResult.matchMethod} (${vendorResult.vendorStatus})`
        : `No verified vendor match found for '${extracted.vendor.name ?? 'Unknown'}'`,
      evidence: vendorResult as unknown as Record<string, unknown>,
    });

    // ==================== STAGE 5: DUPLICATE DETECTION ====================
    currentStage = 5;
    await db.prepare(`UPDATE processing_runs SET current_stage = 5 WHERE id = ?`).run(runId);
    const s5Start = Date.now();
    await persistAndEmitStageEvent({
      runId,
      stageNumber: 5,
      status: 'STARTED',
      summary: 'Checking SHA-256 fingerprint, vendor, normalized invoice number, and invoice date uniqueness...',
    });

    const dupResult = await runStage5DuplicateDetection(
      db,
      invoiceRow.id,
      invoiceRow.file_sha256,
      vendorResult,
      extracted
    );

    await persistAndEmitStageEvent({
      runId,
      stageNumber: 5,
      status: dupResult.isExactFileDuplicate || dupResult.isBusinessDuplicate || dupResult.isNearDuplicate ? 'WARNING' : 'COMPLETED',
      durationMs: Date.now() - s5Start,
      summary: dupResult.isBusinessDuplicate
        ? `Duplicate detected (${dupResult.matchedFields.join(' + ') || dupResult.matchType}) matching ${dupResult.conflictingInvoiceNumber ?? dupResult.conflictingFilename}`
        : dupResult.isNearDuplicate
          ? `Redundancy warning (${dupResult.matchedFields.join(' + ') || 'VENDOR + DATE'}) matching ${dupResult.conflictingInvoiceNumber ?? dupResult.conflictingFilename}`
          : 'No prior duplicate or redundant invoices found.',
      evidence: dupResult as unknown as Record<string, unknown>,
    });

    // ==================== STAGE 6: PO MATCHING ====================
    currentStage = 6;
    await db.prepare(`UPDATE processing_runs SET current_stage = 6 WHERE id = ?`).run(runId);
    const s6Start = Date.now();
    await persistAndEmitStageEvent({
      runId,
      stageNumber: 6,
      status: 'STARTED',
      summary: extracted.po_number
        ? `Matching purchase order ${extracted.po_number}...`
        : 'No explicit PO number; checking open vendor POs for candidates...',
    });

    const poMatch = await runStage6PoMatching(db, extracted, vendorResult);
    if (poMatch.matchedPoId && poMatch.matchStatus === 'EXACT') {
      await db.prepare('UPDATE invoices SET purchase_order_id = ?, updated_at = ? WHERE id = ?').run(
        poMatch.matchedPoId,
        isoNow(),
        invoiceRow.id
      );
    }

    await persistAndEmitStageEvent({
      runId,
      stageNumber: 6,
      status: poMatch.matchStatus === 'EXACT' && poMatch.poStatus !== 'CLOSED' ? 'COMPLETED' : 'WARNING',
      durationMs: Date.now() - s6Start,
      summary:
        poMatch.matchStatus === 'EXACT'
          ? `Matched ${poMatch.matchedPoNumber} (${poMatch.poStatus}, ${poMatch.priorApprovedInvoices.length} prior invoice(s) applied)`
          : `PO status: ${poMatch.matchStatus}${poMatch.candidatePos.length > 0 ? ` (${poMatch.candidatePos.length} candidate POs)` : ''}`,
      evidence: poMatch as unknown as Record<string, unknown>,
    });

    // ==================== STAGE 7: TOLERANCE VERIFICATION ====================
    currentStage = 7;
    await db.prepare(`UPDATE processing_runs SET current_stage = 7 WHERE id = ?`).run(runId);
    const s7Start = Date.now();
    await persistAndEmitStageEvent({
      runId,
      stageNumber: 7,
      status: 'STARTED',
      summary: 'Computing cumulative PO remaining balance and policy tolerance caps...',
    });

    const tolerance = runStage7ToleranceVerification(poMatch, extracted, settings);
    await persistAndEmitStageEvent({
      runId,
      stageNumber: 7,
      status: tolerance.evaluated && tolerance.withinTolerance && tolerance.currencyMatch ? 'COMPLETED' : 'WARNING',
      durationMs: Date.now() - s7Start,
      summary: !tolerance.evaluated
        ? 'Tolerance check skipped (no unambiguous PO + total amount to reconcile).'
        : !tolerance.currencyMatch
          ? `Currency mismatch (${extracted.currency} vs PO ${poMatch.poCurrency})`
          : Number(tolerance.overrunAmount) > 0
            ? `Overrun $${tolerance.overrunAmount} vs allowed cap $${tolerance.allowedCap} (${tolerance.withinTolerance ? 'within tolerance' : 'EXCEEDED'})`
            : `Sufficient PO balance: $${tolerance.remainingBefore} available, $${tolerance.remainingAfter} remaining after invoice`,
      evidence: tolerance as unknown as Record<string, unknown>,
    });

    // ==================== STAGE 8: DECISION GENERATION (ATOMIC) ====================
    currentStage = 8;
    await db.prepare(`UPDATE processing_runs SET current_stage = 8 WHERE id = ?`).run(runId);
    const s8Start = Date.now();
    await persistAndEmitStageEvent({
      runId,
      stageNumber: 8,
      status: 'STARTED',
      summary: 'Evaluating deterministic rules (R-00..R-16) and committing decision...',
    });

    const decisionResult = runStage8DecisionGeneration({
      validation,
      vendor: vendorResult,
      duplicate: dupResult,
      poMatch,
      tolerance,
      extracted,
      settings,
    });

    let aiDecisionExplanation: Awaited<ReturnType<typeof generateDecisionExplanation>> | null = null;
    let aiExplanationError: string | null = null;
    try {
      aiDecisionExplanation = await generateDecisionExplanation({
        outcome: decisionResult.outcome,
        primaryReasonCode: decisionResult.primaryReasonCode,
        deterministicSummary: decisionResult.explanation,
        triggeredRules: decisionResult.triggeredRules,
        invoice: {
          vendor_name: vendorResult.canonicalName || extracted.vendor.name,
          invoice_number: extracted.invoice_number,
          invoice_date: extracted.invoice_date,
          po_number: poMatch.matchedPoNumber || extracted.po_number,
          currency: extracted.currency,
          subtotal_amount: extracted.subtotal,
          tax_amount: extracted.tax_amount,
          total_amount: extracted.total_amount,
        },
        evidenceSummary: {
          vendor_match: vendorResult.matchMethod,
          vendor_status: vendorResult.vendorStatus,
          duplicate_match: dupResult.matchType,
          po_match_status: poMatch.matchStatus,
          po_remaining_before: tolerance.remainingBefore,
          po_remaining_after: tolerance.remainingAfter,
          overrun_amount: tolerance.overrunAmount,
          allowed_cap: tolerance.allowedCap,
        },
        candidatePos: poMatch.candidatePos || [],
        throwOnError: false,
      });
    } catch (err) {
      aiExplanationError = err instanceof Error ? err.message : String(err);
      console.warn('[Pipeline Stage 8] Gemini Flash explanation skipped:', aiExplanationError);
    }

    const aiReviewerBrief =
      decisionResult.outcome !== 'APPROVE' && aiDecisionExplanation
        ? {
            summary: aiDecisionExplanation.explanation,
            recommended_action: aiDecisionExplanation.recommended_action,
            verification_checks: aiDecisionExplanation.verification_checks,
            suggested_po_number: aiDecisionExplanation.suggested_po_number,
            generated_by_model: aiDecisionExplanation.generated_by_model,
          }
        : null;

    const decisionId = crypto.randomUUID();
    const completedAt = isoNow();
    const totalDurationMs = Date.now() - runStartMs;
    const reviewStatus = decisionResult.outcome === 'REVIEW' ? 'PENDING_REVIEW' : 'NOT_REQUIRED';

    const { finalOutcome, finalReasonCode, finalExplanation, finalReviewStatus, finalTriggered } = await db.transaction(async () => {
      // Re-verify PO balance under exclusive write lock if auto-approving
      let finalOutcome = decisionResult.outcome;
      let finalReasonCode = decisionResult.primaryReasonCode;
      let finalExplanation = aiDecisionExplanation?.explanation || decisionResult.explanation;
      let finalReviewStatus = reviewStatus;
      let finalTriggered = decisionResult.triggeredRules;

      const latestInv = await db
        .prepare('SELECT po_consumed_applied FROM invoices WHERE id = ?')
        .get(invoiceRow.id) as { po_consumed_applied: number } | undefined;

      const totalDec = parseDecimalSafe(extracted.total_amount);

      if (
        finalOutcome === 'APPROVE' &&
        poMatch.matchedPoId &&
        totalDec &&
        latestInv &&
        latestInv.po_consumed_applied === 0
      ) {
        const lockedPo = await db
          .prepare('SELECT id, original_amount, consumed_amount, status FROM purchase_orders WHERE id = ?')
          .get(poMatch.matchedPoId) as
          | {
              id: string;
              original_amount: string;
              consumed_amount: string;
              status: string;
            }
          | undefined;

        if (!lockedPo || lockedPo.status === 'CLOSED' || lockedPo.status === 'CANCELLED') {
          finalOutcome = 'REJECT';
          finalReasonCode = 'PO_CLOSED';
          finalReviewStatus = 'NOT_REQUIRED';
          finalExplanation = `Referenced purchase order ${poMatch.matchedPoNumber} is ${lockedPo?.status ?? 'unavailable'} and cannot accept new charges.`;
          finalTriggered = [
            ...finalTriggered,
            {
              rule_id: 'R-03',
              reason_code: 'PO_CLOSED',
              decision: 'REJECT',
              severity: 'CRITICAL',
              message: finalExplanation,
              evidence: { po_id: poMatch.matchedPoId, po_status: lockedPo?.status ?? 'MISSING' },
            },
          ];
        } else {
          const orig = new Decimal(lockedPo.original_amount);
          const consumed = new Decimal(lockedPo.consumed_amount);
          const remBefore = Decimal.max(new Decimal(0), orig.minus(consumed));
          const allowedCap = new Decimal(tolerance.allowedCap || '0');
          const overrun = totalDec.minus(remBefore);

          if (overrun.gt(allowedCap)) {
            // Concurrent run exhausted PO while we were extracting!
            finalOutcome = 'REVIEW';
            finalReasonCode = 'TOLERANCE_EXCEEDED';
            finalReviewStatus = 'PENDING_REVIEW';
            finalExplanation = `Concurrent approval updated PO ${poMatch.matchedPoNumber} remaining balance to $${remBefore.toFixed(2)}. Invoice overrun ($${overrun.toFixed(2)}) exceeds cap ($${allowedCap.toFixed(2)}).`;
            finalTriggered = [
              ...finalTriggered,
              {
                rule_id: 'R-11',
                reason_code: 'TOLERANCE_EXCEEDED',
                decision: 'REVIEW',
                severity: 'HIGH',
                message: finalExplanation,
                evidence: { rem_before: remBefore.toFixed(2), overrun: overrun.toFixed(2) },
              },
            ];
          } else {
            const newConsumed = consumed.plus(totalDec);
            const newStatus = newConsumed.gte(orig) ? 'FULLY_CONSUMED' : 'PARTIALLY_CONSUMED';
            await db.prepare(
              `UPDATE purchase_orders SET consumed_amount = ?, status = ?, updated_at = ? WHERE id = ?`
            ).run(newConsumed.toFixed(4), newStatus, completedAt, lockedPo.id);
            await db.prepare(`UPDATE invoices SET po_consumed_applied = 1 WHERE id = ?`).run(invoiceRow.id);
          }
        }
      }

      const explanationChangedUnderLock = finalOutcome !== decisionResult.outcome;
      const explanationRecord = buildExplanationRecord({
        input: {
          outcome: finalOutcome,
          primaryReasonCode: finalReasonCode,
          triggeredRules: finalTriggered,
          evidenceSnapshot: decisionResult.evidenceSnapshot,
          invoice: {
            filename: invoiceRow.original_filename,
            vendor: vendorResult.canonicalName || extracted.vendor.name,
            invoiceNumber: extracted.invoice_number,
            currency: extracted.currency,
            subtotal: extracted.subtotal,
            tax: extracted.tax_amount,
            total: extracted.total_amount,
            purchaseOrder: poMatch.matchedPoNumber || extracted.po_number,
          },
        },
        aiExplanation: explanationChangedUnderLock ? null : aiDecisionExplanation,
        fallbackReason: explanationChangedUnderLock
          ? finalExplanation
          : aiExplanationError || undefined,
      });

      const fullEvidenceSnapshot = {
        ...decisionResult.evidenceSnapshot,
        deterministic_rule_summary: decisionResult.explanation,
        ...(aiDecisionExplanation && !explanationChangedUnderLock
          ? { ai_decision_explanation: aiDecisionExplanation }
          : aiExplanationError
            ? { ai_explanation_error: aiExplanationError }
            : {}),
        ...(aiReviewerBrief && !explanationChangedUnderLock ? { ai_reviewer_brief: aiReviewerBrief } : {}),
      };

      await db.prepare(
        `INSERT INTO decisions (
           id, run_id, invoice_id, outcome, primary_reason_code, triggered_rules, explanation, evidence_snapshot,
           explanation_source, explanation_provider, explanation_model, explanation_prompt_version,
           explanation_status, explanation_generated_at, explanation_input_tokens, explanation_output_tokens,
           explanation_fallback_reason, explanation_json, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        decisionId,
        runId,
        invoiceRow.id,
        finalOutcome,
        finalReasonCode,
        JSON.stringify(finalTriggered),
        finalExplanation,
        JSON.stringify(fullEvidenceSnapshot),
        explanationRecord.explanation_source,
        explanationRecord.explanation_provider,
        explanationRecord.explanation_model,
        explanationRecord.prompt_version,
        explanationRecord.generation_status,
        explanationRecord.generated_at,
        explanationRecord.token_usage.input,
        explanationRecord.token_usage.output,
        explanationRecord.fallback_reason,
        JSON.stringify(explanationRecord),
        completedAt
      );

      await db.prepare(
        `UPDATE invoices SET
          processing_status = 'COMPLETED',
          business_decision = ?,
          review_status = ?,
          latest_run_id = ?,
          latest_decision_id = ?,
          updated_at = ?
         WHERE id = ?`
      ).run(finalOutcome, finalReviewStatus, runId, decisionId, completedAt, invoiceRow.id);

      await db.prepare(
        `UPDATE processing_runs SET
          status = 'COMPLETED',
          current_stage = 8,
          completed_at = ?,
          duration_ms = ?
         WHERE id = ?`
      ).run(completedAt, totalDurationMs, runId);

      await writeAuditLog({
        actorId: null,
        actorType: 'SYSTEM',
        actorRole: 'ENGINE',
        action: 'DECISION_GENERATED',
        resourceType: 'INVOICE',
        resourceId: invoiceRow.id,
        originalDecision: finalOutcome,
        newDecision: finalOutcome,
        details: {
          run_id: runId,
          run_number: runRow.run_number,
          primary_reason_code: finalReasonCode,
          explanation: finalExplanation,
          explanation_model: explanationRecord.explanation_model,
          explanation_source: explanationRecord.explanation_source,
        },
      });

      return { finalOutcome, finalReasonCode, finalExplanation, finalReviewStatus, finalTriggered };
    });

    if (finalReviewStatus === 'PENDING_REVIEW') {
      const displayRef = extracted.invoice_number || invoiceRow.original_filename;
      const vendorLabel = vendorResult.canonicalName || extracted.vendor.name;
      const amtLabel =
        extracted.total_amount && extracted.currency
          ? ` · ${extracted.currency} ${extracted.total_amount}`
          : '';
      await createWorkspaceNotification({
        eventType: 'MANUAL_REVIEW_REQUIRED',
        severity: 'WARNING',
        title: 'Manual Review Required',
        message: `${displayRef}${vendorLabel ? ` (${vendorLabel})` : ''}${amtLabel} routed for human review (${finalReasonCode}).`,
        invoiceId: invoiceRow.id,
        runId,
        metadata: {
          primary_reason_code: finalReasonCode,
          business_decision: finalOutcome,
          vendor_name: vendorLabel,
          total_amount: extracted.total_amount,
          currency: extracted.currency,
        },
      });
    }

    const finalEventId = await persistAndEmitStageEvent({
      runId,
      stageNumber: 8,
      status: 'COMPLETED',
      durationMs: Date.now() - s8Start,
      summary: `Final Decision: ${finalOutcome} (${finalReasonCode})`,
      evidence: {
        outcome: finalOutcome,
        primary_reason_code: finalReasonCode,
        triggered_rules: finalTriggered,
      },
    });

    sseBroker.publish(runId, {
      id: finalEventId,
      event: 'run_completed',
      data: {
        run_id: runId,
        invoice_id: invoiceRow.id,
        processing_status: 'COMPLETED',
        business_decision: finalOutcome,
        review_status: finalReviewStatus,
        primary_reason_code: finalReasonCode,
        duration_ms: totalDurationMs,
      },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const failedAt = isoNow();
    const durationMs = Date.now() - runStartMs;

    try {
      await db.prepare(
        `UPDATE processing_runs SET status = 'FAILED', error_stage = ?, error_message = ?, completed_at = ?, duration_ms = ? WHERE id = ?`
      ).run(currentStage, errMsg, failedAt, durationMs, runId);

      await db.prepare(
        `UPDATE invoices SET processing_status = 'FAILED', latest_run_id = ?, updated_at = ? WHERE id = ?`
      ).run(runId, failedAt, invoiceRow.id);

      const failEventId = await persistAndEmitStageEvent({
        runId,
        stageNumber: currentStage,
        status: 'FAILED',
        durationMs,
        summary: `Stage ${currentStage} failed: ${errMsg}`,
        evidence: { error_stage: currentStage, error_message: errMsg },
      });

      await createWorkspaceNotification({
        eventType: 'PIPELINE_FAILED',
        severity: 'CRITICAL',
        title: `Pipeline Failed (Stage ${currentStage})`,
        message: `${invoiceRow.original_filename}: ${errMsg}`,
        invoiceId: invoiceRow.id,
        runId,
        metadata: { error_stage: currentStage, error_message: errMsg },
      });

      sseBroker.publish(runId, {
        id: failEventId,
        event: 'run_failed',
        data: {
          run_id: runId,
          invoice_id: invoiceRow.id,
          processing_status: 'FAILED',
          error_stage: currentStage,
          error_message: errMsg,
        },
      });
    } catch (secondaryErr) {
      console.error(`[Pipeline] Failed while recording failure for run ${runId}:`, secondaryErr);
    }
  }
}

export async function recoverStaleRuns(): Promise<void> {
  const db = getDb();
  const now = isoNow();
  // With a shared database another instance may be processing a run right now, so only
  // recover runs that have been RUNNING far longer than any function can live.
  // With a local single-process database every RUNNING run at boot is orphaned.
  const cutoff = config.usesSharedDatabase
    ? new Date(Date.now() - 15 * 60_000).toISOString()
    : '9999-12-31T00:00:00.000Z';
  const stale = await db
    .prepare(
      "SELECT id, invoice_id, current_stage FROM processing_runs WHERE status = 'RUNNING' AND (started_at IS NULL OR started_at < ?)"
    )
    .all(cutoff) as Array<{ id: string; invoice_id: string; current_stage: number }>;

  for (const r of stale) {
    const stage = r.current_stage || 2;
    const msg = 'Processing interrupted by server restart. Click Retry to re-run.';
    await db.prepare(
      `UPDATE processing_runs SET status = 'FAILED', error_stage = ?, error_message = ?, completed_at = ? WHERE id = ?`
    ).run(stage, msg, now, r.id);
    await db.prepare(
      `UPDATE invoices SET processing_status = 'FAILED', updated_at = ? WHERE id = ? AND latest_run_id = ?`
    ).run(now, r.invoice_id, r.id);
    await persistAndEmitStageEvent({
      runId: r.id,
      stageNumber: stage,
      status: 'FAILED',
      summary: msg,
      evidence: { recovered_on_boot: true },
    });
  }
}
