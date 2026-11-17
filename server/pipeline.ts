import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import Decimal from 'decimal.js';
import { writeAuditLog } from './auth.ts';
import { config } from './config.ts';
import { getDb, isoNow } from './db.ts';
import { fallbackDecisionExplanation, generateDecisionExplanation, type ExplanationInput } from './explanation.ts';
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
import {
  defaultExtractionProvider,
  generateReviewerBrief,
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

function enqueueWork(fn: () => Promise<void>): void {
  pendingQueue.push(fn);
  void drainQueue();
}

async function drainQueue(): Promise<void> {
  if (activeWorkers >= MAX_CONCURRENT_RUNS) return;
  const next = pendingQueue.shift();
  if (!next) return;
  activeWorkers++;
  try {
    await next();
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

function persistAndEmitStageEvent(params: {
  runId: string;
  stageNumber: number;
  status: 'STARTED' | 'COMPLETED' | 'WARNING' | 'FAILED';
  summary: string;
  durationMs?: number | null;
  evidence?: Record<string, unknown>;
}): number {
  const db = getDb();
  const stageMeta = STAGE_NAMES[params.stageNumber];
  const now = isoNow();
  const result = db
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
    await executeProcessingRun(runId);
    return;
  }
  enqueueWork(async () => {
    await executeProcessingRun(runId);
  });
}

export async function executeProcessingRun(runId: string): Promise<void> {
  const db = getDb();
  const runRow = db
    .prepare('SELECT id, invoice_id, run_number, trigger_type FROM processing_runs WHERE id = ?')
    .get(runId) as { id: string; invoice_id: string; run_number: number; trigger_type: string } | undefined;

  if (!runRow) return;

  const invoiceRow = db
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

  const settings = db
    .prepare('SELECT * FROM application_settings WHERE id = 1')
    .get() as unknown as ApplicationSettingsRow;

  const runStartMs = Date.now();
  const startedAt = isoNow();
  let currentStage = 1;

  try {
    db.prepare(
      `UPDATE processing_runs SET status = 'RUNNING', current_stage = 1, started_at = ? WHERE id = ?`
    ).run(startedAt, runId);
    db.prepare(`UPDATE invoices SET processing_status = 'RUNNING', updated_at = ? WHERE id = ?`).run(
      startedAt,
      invoiceRow.id
    );

    // ==================== STAGE 1: INGESTION ====================
    currentStage = 1;
    const s1Start = Date.now();
    persistAndEmitStageEvent({
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
    const nativeInspection = await inspectPdfNativeText(pdfBuffer);
    db.prepare(`UPDATE invoices SET page_count = ?, updated_at = ? WHERE id = ?`).run(
      nativeInspection.pageCount,
      isoNow(),
      invoiceRow.id
    );

    persistAndEmitStageEvent({
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
    db.prepare(`UPDATE processing_runs SET current_stage = 2 WHERE id = ?`).run(runId);
    const s2Start = Date.now();
    const minChars = settings.ocr_min_chars_per_page ?? 50;
    const useOcr = Boolean(settings.force_ocr) || nativeInspection.avgCharsPerPage < minChars;
    const extractionMode: 'NATIVE_TEXT' | 'OCR' = useOcr ? 'OCR' : 'NATIVE_TEXT';

    persistAndEmitStageEvent({
      runId,
      stageNumber: 2,
      status: 'STARTED',
      summary: useOcr
        ? `Low native text (${nativeInspection.avgCharsPerPage.toFixed(0)} chars/page < ${minChars}); engaging Vision OCR fallback...`
        : `Extracting structured fields from native PDF text (${nativeInspection.avgCharsPerPage.toFixed(0)} chars/page)...`,
    });

    const { payload: extracted, latencyMs, modelUsed } = await defaultExtractionProvider.extractInvoice({
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

    db.prepare(
      `UPDATE processing_runs SET extraction_mode = ?, raw_extracted_json = ? WHERE id = ?`
    ).run(extractionMode, JSON.stringify(extracted), runId);

    db.prepare(
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

    db.prepare('DELETE FROM invoice_lines WHERE run_id = ?').run(runId);
    const insertLine = db.prepare(
      `INSERT INTO invoice_lines (id, invoice_id, run_id, line_number, description, is_bundled, quantity, unit_price, tax_amount, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const line of extracted.line_items) {
      insertLine.run(
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

    persistAndEmitStageEvent({
      runId,
      stageNumber: 2,
      status: 'COMPLETED',
      durationMs: Date.now() - s2Start,
      summary: `${extractionMode === 'OCR' ? 'OCR Vision fallback' : 'Native text'} extracted ${extracted.line_items.length} line item(s) · Mean confidence ${Math.round(overallConf * 100)}%`,
      evidence: {
        extraction_mode: extractionMode,
        provider: `${defaultExtractionProvider.providerName}:${modelUsed}`,
        llm_latency_ms: latencyMs,
        overall_confidence: overallConf,
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
    db.prepare(`UPDATE processing_runs SET current_stage = 3 WHERE id = ?`).run(runId);
    const s3Start = Date.now();
    persistAndEmitStageEvent({
      runId,
      stageNumber: 3,
      status: 'STARTED',
      summary: 'Validating required fields, decimal arithmetic, and confidence thresholds...',
    });

    const validation = runStage3Validation(extracted, settings);
    persistAndEmitStageEvent({
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
    db.prepare(`UPDATE processing_runs SET current_stage = 4 WHERE id = ?`).run(runId);
    const s4Start = Date.now();
    persistAndEmitStageEvent({
      runId,
      stageNumber: 4,
      status: 'STARTED',
      summary: `Verifying vendor '${extracted.vendor.name ?? 'Unknown'}' against approved supplier directory...`,
    });

    const vendorResult = runStage4VendorVerification(db, extracted);
    if (vendorResult.matchedVendorId) {
      db.prepare('UPDATE invoices SET vendor_id = ?, updated_at = ? WHERE id = ?').run(
        vendorResult.matchedVendorId,
        isoNow(),
        invoiceRow.id
      );
    }

    persistAndEmitStageEvent({
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
    db.prepare(`UPDATE processing_runs SET current_stage = 5 WHERE id = ?`).run(runId);
    const s5Start = Date.now();
    persistAndEmitStageEvent({
      runId,
      stageNumber: 5,
      status: 'STARTED',
      summary: 'Checking SHA-256 fingerprint, vendor, normalized invoice number, and invoice date uniqueness...',
    });

    const dupResult = runStage5DuplicateDetection(
      db,
      invoiceRow.id,
      invoiceRow.file_sha256,
      vendorResult,
      extracted
    );

    persistAndEmitStageEvent({
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
    db.prepare(`UPDATE processing_runs SET current_stage = 6 WHERE id = ?`).run(runId);
    const s6Start = Date.now();
    persistAndEmitStageEvent({
      runId,
      stageNumber: 6,
      status: 'STARTED',
      summary: extracted.po_number
        ? `Matching purchase order ${extracted.po_number}...`
        : 'No explicit PO number; checking open vendor POs for candidates...',
    });

    const poMatch = runStage6PoMatching(db, extracted, vendorResult);
    if (poMatch.matchedPoId && poMatch.matchStatus === 'EXACT') {
      db.prepare('UPDATE invoices SET purchase_order_id = ?, updated_at = ? WHERE id = ?').run(
        poMatch.matchedPoId,
        isoNow(),
        invoiceRow.id
      );
    }

    persistAndEmitStageEvent({
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
    db.prepare(`UPDATE processing_runs SET current_stage = 7 WHERE id = ?`).run(runId);
    const s7Start = Date.now();
    persistAndEmitStageEvent({
      runId,
      stageNumber: 7,
      status: 'STARTED',
      summary: 'Computing cumulative PO remaining balance and policy tolerance caps...',
    });

    const tolerance = runStage7ToleranceVerification(poMatch, extracted, settings);
    persistAndEmitStageEvent({
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
    db.prepare(`UPDATE processing_runs SET current_stage = 8 WHERE id = ?`).run(runId);
    const s8Start = Date.now();
    persistAndEmitStageEvent({
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

    const aiReviewerBrief =
      decisionResult.outcome === 'APPROVE'
        ? null
        : await generateReviewerBrief({
            outcome: decisionResult.outcome,
            primaryReasonCode: decisionResult.primaryReasonCode,
            explanation: decisionResult.explanation,
            triggeredRules: decisionResult.triggeredRules,
            extracted,
            candidatePos: poMatch.candidatePos || [],
          });

    const explanationInput: ExplanationInput = {
      outcome: decisionResult.outcome,
      primaryReasonCode: decisionResult.primaryReasonCode,
      triggeredRules: decisionResult.triggeredRules,
      evidenceSnapshot: {
        ...decisionResult.evidenceSnapshot,
        ...(aiReviewerBrief ? { ai_reviewer_brief: aiReviewerBrief } : {}),
      } as unknown as Record<string, unknown>,
      invoice: {
        filename: invoiceRow.original_filename,
        vendor: extracted.vendor.name,
        invoiceNumber: extracted.invoice_number,
        currency: extracted.currency,
        subtotal: extracted.subtotal,
        tax: extracted.tax_amount,
        total: extracted.total_amount,
        purchaseOrder: extracted.po_number,
      },
    };
    // Gemini explains the fixed result; only the deterministic engine sets the outcome.
    let explanation = await generateDecisionExplanation(explanationInput);

    const decisionId = crypto.randomUUID();
    const completedAt = isoNow();
    const totalDurationMs = Date.now() - runStartMs;
    const reviewStatus = decisionResult.outcome === 'REVIEW' ? 'PENDING_REVIEW' : 'NOT_REQUIRED';

    db.exec('BEGIN IMMEDIATE;');
    try {
      // Re-verify PO balance under exclusive write lock if auto-approving
      let finalOutcome = decisionResult.outcome;
      let finalReasonCode = decisionResult.primaryReasonCode;
      let finalExplanation = explanation.decision_explanation;
      let finalReviewStatus = reviewStatus;
      let finalTriggered = decisionResult.triggeredRules;

      const latestInv = db
        .prepare('SELECT po_consumed_applied FROM invoices WHERE id = ?')
        .get(invoiceRow.id) as { po_consumed_applied: number };

      const totalDec = parseDecimalSafe(extracted.total_amount);

      if (
        finalOutcome === 'APPROVE' &&
        poMatch.matchedPoId &&
        totalDec &&
        latestInv.po_consumed_applied === 0
      ) {
        const lockedPo = db
          .prepare('SELECT id, original_amount, consumed_amount, status FROM purchase_orders WHERE id = ?')
          .get(poMatch.matchedPoId) as {
          id: string;
          original_amount: string;
          consumed_amount: string;
          status: string;
        };

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
          explanation = fallbackDecisionExplanation(
            {
              ...explanationInput,
              outcome: finalOutcome,
              primaryReasonCode: finalReasonCode,
              triggeredRules: finalTriggered,
              evidenceSnapshot: {
                ...explanationInput.evidenceSnapshot,
                tolerance: {
                  ...tolerance,
                  remainingBefore: remBefore.toFixed(2),
                  overrunAmount: overrun.toFixed(2),
                  withinTolerance: false,
                },
              },
            },
            'Concurrent PO balance changed during processing; explanation was generated deterministically from the final locked result.'
          );
          explanation.decision_explanation = finalExplanation;
        } else {
          const newConsumed = consumed.plus(totalDec);
          const newStatus = newConsumed.gte(orig) ? 'FULLY_CONSUMED' : 'PARTIALLY_CONSUMED';
          db.prepare(
            `UPDATE purchase_orders SET consumed_amount = ?, status = ?, updated_at = ? WHERE id = ?`
          ).run(newConsumed.toFixed(4), newStatus, completedAt, lockedPo.id);
          db.prepare(`UPDATE invoices SET po_consumed_applied = 1 WHERE id = ?`).run(invoiceRow.id);
        }
      }

      const fullEvidenceSnapshot = {
        ...decisionResult.evidenceSnapshot,
        ...(aiReviewerBrief ? { ai_reviewer_brief: aiReviewerBrief } : {}),
      };

      db.prepare(
        `INSERT INTO decisions (
          id, run_id, invoice_id, outcome, primary_reason_code, triggered_rules, explanation, evidence_snapshot,
          explanation_source, explanation_provider, explanation_model, explanation_prompt_version, explanation_status,
          explanation_generated_at, explanation_input_tokens, explanation_output_tokens, explanation_fallback_reason,
          explanation_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        decisionId,
        runId,
        invoiceRow.id,
        finalOutcome,
        finalReasonCode,
        JSON.stringify(finalTriggered),
        finalExplanation,
        JSON.stringify(fullEvidenceSnapshot),
        explanation.explanation_source,
        explanation.explanation_provider,
        explanation.explanation_model,
        explanation.prompt_version,
        explanation.generation_status,
        explanation.generated_at,
        explanation.token_usage.input,
        explanation.token_usage.output,
        explanation.fallback_reason,
        JSON.stringify(explanation),
        completedAt
      );

      db.prepare(
        `UPDATE invoices SET
          processing_status = 'COMPLETED',
          business_decision = ?,
          review_status = ?,
          latest_run_id = ?,
          latest_decision_id = ?,
          updated_at = ?
         WHERE id = ?`
      ).run(finalOutcome, finalReviewStatus, runId, decisionId, completedAt, invoiceRow.id);

      db.prepare(
        `UPDATE processing_runs SET
          status = 'COMPLETED',
          current_stage = 8,
          completed_at = ?,
          duration_ms = ?
         WHERE id = ?`
      ).run(completedAt, totalDurationMs, runId);

      writeAuditLog({
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
          explanation_source: explanation.explanation_source,
          explanation_model: explanation.explanation_model,
          explanation_status: explanation.generation_status,
        },
      });

      db.exec('COMMIT;');

      if (finalReviewStatus === 'PENDING_REVIEW') {
        const displayRef = extracted.invoice_number || invoiceRow.original_filename;
        const vendorLabel = vendorResult.canonicalName || extracted.vendor.name;
        const amtLabel =
          extracted.total_amount && extracted.currency
            ? ` · ${extracted.currency} ${extracted.total_amount}`
            : '';
        createWorkspaceNotification({
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

      const finalEventId = persistAndEmitStageEvent({
        runId,
        stageNumber: 8,
        status: 'COMPLETED',
        durationMs: Date.now() - s8Start,
        summary: `Final Decision: ${finalOutcome} (${finalReasonCode}) · Explanation ${explanation.explanation_source}`,
        evidence: {
          outcome: finalOutcome,
          primary_reason_code: finalReasonCode,
          triggered_rules: finalTriggered,
          explanation_source: explanation.explanation_source,
          explanation_provider: explanation.explanation_provider,
          explanation_model: explanation.explanation_model,
          explanation_status: explanation.generation_status,
          explanation_fallback_reason: explanation.fallback_reason,
          token_usage: explanation.token_usage,
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
    } catch (txErr) {
      db.exec('ROLLBACK;');
      throw txErr;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const failedAt = isoNow();
    const durationMs = Date.now() - runStartMs;

    db.prepare(
      `UPDATE processing_runs SET status = 'FAILED', error_stage = ?, error_message = ?, completed_at = ?, duration_ms = ? WHERE id = ?`
    ).run(currentStage, errMsg, failedAt, durationMs, runId);

    db.prepare(
      `UPDATE invoices SET processing_status = 'FAILED', latest_run_id = ?, updated_at = ? WHERE id = ?`
    ).run(runId, failedAt, invoiceRow.id);

    const failEventId = persistAndEmitStageEvent({
      runId,
      stageNumber: currentStage,
      status: 'FAILED',
      durationMs,
      summary: `Stage ${currentStage} failed: ${errMsg}`,
      evidence: { error_stage: currentStage, error_message: errMsg },
    });

    createWorkspaceNotification({
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
  }
}

export function recoverStaleRuns(): void {
  const db = getDb();
  const now = isoNow();
  const stale = db
    .prepare("SELECT id, invoice_id, current_stage FROM processing_runs WHERE status = 'RUNNING'")
    .all() as Array<{ id: string; invoice_id: string; current_stage: number }>;

  for (const r of stale) {
    const stage = r.current_stage || 2;
    const msg = 'Processing interrupted by server restart. Click Retry to re-run.';
    db.prepare(
      `UPDATE processing_runs SET status = 'FAILED', error_stage = ?, error_message = ?, completed_at = ? WHERE id = ?`
    ).run(stage, msg, now, r.id);
    db.prepare(
      `UPDATE invoices SET processing_status = 'FAILED', updated_at = ? WHERE id = ? AND latest_run_id = ?`
    ).run(now, r.invoice_id, r.id);
    persistAndEmitStageEvent({
      runId: r.id,
      stageNumber: stage,
      status: 'FAILED',
      summary: msg,
      evidence: { recovered_on_boot: true },
    });
  }
}
